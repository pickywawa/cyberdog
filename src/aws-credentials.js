// AWS credentials from a named profile of ~/.aws/config and ~/.aws/credentials, or from the environment ("env"):
// static keys, credential_process, IAM Identity Center (SSO, after `aws sso login`) and role assumption (STS).
// Temporary credentials are cached and renewed shortly before they expire. Secrets are never written anywhere.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { exec } = require('child_process')
const { request, readAll, sign, blocks, val, sha } = require('./object-storage')

const MARGIN = 5 * 60 * 1000

function parseIni(text) {
  const out = Object.create(null)
  let cur
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '#' || line[0] === ';') continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) { cur = out[sec[1].trim()] = out[sec[1].trim()] || Object.create(null); continue }
    const kv = cur && line.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (kv) cur[kv[1].toLowerCase()] = kv[2]
  }
  return out
}
const read = f => { try { return parseIni(fs.readFileSync(f, 'utf8')) } catch { return {} } }

function loadProfiles(home, env) {
  const dir = path.join(home, '.aws')
  const config = read(env.AWS_CONFIG_FILE || path.join(dir, 'config')), creds = read(env.AWS_SHARED_CREDENTIALS_FILE || path.join(dir, 'credentials'))
  const profiles = Object.create(null), sessions = Object.create(null)
  for (const [k, v] of Object.entries(config)) {
    if (k === 'default') profiles.default = { ...v }
    else if (k.startsWith('profile ')) profiles[k.slice(8).trim()] = { ...v }
    else if (k.startsWith('sso-session ')) sessions[k.slice(12).trim()] = v
  }
  for (const [k, v] of Object.entries(creds)) profiles[k] = { ...profiles[k], ...v }
  return { profiles, sessions }
}

const fromEnv = env => {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS environment variables are not set')
  return { accessKey: env.AWS_ACCESS_KEY_ID, secret: env.AWS_SECRET_ACCESS_KEY, token: env.AWS_SESSION_TOKEN || undefined }
}

function runProcess(command) {
  return new Promise((ok, ko) => exec(command, { timeout: 30000, maxBuffer: 1e6, windowsHide: true }, (e, out) => {
    if (e) return ko(new Error('credential_process failed: ' + e.message.split('\n')[0]))
    try {
      const j = JSON.parse(out)
      if (j.Version !== 1 || !j.AccessKeyId || !j.SecretAccessKey) throw 0
      ok({ accessKey: j.AccessKeyId, secret: j.SecretAccessKey, token: j.SessionToken, expires: j.Expiration ? Date.parse(j.Expiration) : undefined })
    } catch { ko(new Error('credential_process returned invalid JSON')) }
  }))
}

async function sso(p, sessions, home, ssoUrl) {
  const session = p.sso_session ? sessions[p.sso_session] : null
  if (p.sso_session && !session) throw new Error(`AWS sso-session "${p.sso_session}" not found`)
  const startUrl = session?.sso_start_url || p.sso_start_url, region = session?.sso_region || p.sso_region
  if (!startUrl || !region || !p.sso_account_id || !p.sso_role_name) throw new Error('Incomplete AWS SSO profile')
  const file = path.join(home, '.aws', 'sso', 'cache', crypto.createHash('sha1').update(p.sso_session || startUrl).digest('hex') + '.json')
  let cache
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error('AWS SSO login required: run "aws sso login"') }
  if (!cache.accessToken || Date.parse(cache.expiresAt) < Date.now() + 60000) throw new Error('AWS SSO session expired: run "aws sso login"')
  const url = `${ssoUrl || `https://portal.sso.${region}.amazonaws.com`}/federation/credentials?role_name=${encodeURIComponent(p.sso_role_name)}&account_id=${encodeURIComponent(p.sso_account_id)}`
  const res = await request('GET', url, { 'x-amz-sso_bearer_token': cache.accessToken })
  const body = (await readAll(res)).toString()
  if (res.statusCode !== 200) throw new Error(res.statusCode === 401 ? 'AWS SSO session rejected: run "aws sso login"' : 'AWS SSO error: HTTP ' + res.statusCode)
  const c = JSON.parse(body).roleCredentials
  return { accessKey: c.accessKeyId, secret: c.secretAccessKey, token: c.sessionToken, expires: c.expiration }
}

async function assumeRole(p, source, stsUrl) {
  if (p.mfa_serial) throw new Error('Profiles that require MFA are not supported')
  const region = p.region || 'us-east-1'
  const url = stsUrl || (region === 'us-east-1' ? 'https://sts.amazonaws.com/' : `https://sts.${region}.amazonaws.com/`)
  const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: p.role_arn, RoleSessionName: p.role_session_name || 'cyberdog', ...(p.external_id ? { ExternalId: p.external_id } : {}) }).toString()
  const headers = sign({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: sha(body), region, accessKey: source.accessKey, secret: source.secret, token: source.token, service: 'sts' })
  headers['content-length'] = String(Buffer.byteLength(body))
  const res = await request('POST', url, headers, body)
  const xml = (await readAll(res)).toString()
  if (res.statusCode !== 200) throw new Error('AWS STS: ' + (val(xml, 'Message') || 'HTTP ' + res.statusCode))
  const c = blocks(xml, 'Credentials')[0]
  return { accessKey: val(c, 'AccessKeyId'), secret: val(c, 'SecretAccessKey'), token: val(c, 'SessionToken'), expires: Date.parse(val(c, 'Expiration')) }
}

// opts: { home, env, stsUrl, ssoUrl } (overrides are used by tests)
function awsCredentials(profile, opts = {}) {
  const home = opts.home || os.homedir(), env = opts.env || process.env
  const cache = new Map()
  async function resolve(name, seen = []) {
    if (name === 'env') return fromEnv(env)
    if (seen.includes(name)) throw new Error('AWS profile loop: ' + [...seen, name].join(' > '))
    const hit = cache.get(name)
    if (hit && (!hit.expires || hit.expires - MARGIN > Date.now())) return hit
    const { profiles, sessions } = loadProfiles(home, env)
    const p = profiles[name || 'default']
    if (!p) throw new Error(`AWS profile "${name || 'default'}" not found`)
    let c
    if (p.role_arn) {
      const source = p.source_profile ? await resolve(p.source_profile, [...seen, name]) : p.credential_source === 'Environment' ? fromEnv(env) : null
      if (!source) throw new Error(`AWS profile "${name}" has no source_profile`)
      c = await assumeRole(p, source, opts.stsUrl)
    } else if (p.sso_session || p.sso_start_url) c = await sso(p, sessions, home, opts.ssoUrl)
    else if (p.credential_process) c = await runProcess(p.credential_process)
    else if (p.aws_access_key_id && p.aws_secret_access_key) c = { accessKey: p.aws_access_key_id, secret: p.aws_secret_access_key, token: p.aws_session_token || undefined }
    else throw new Error(`AWS profile "${name || 'default'}" has no credentials`)
    cache.set(name, c)
    return c
  }
  return { get: () => resolve(profile) }
}

module.exports = { awsCredentials, parseIni }
