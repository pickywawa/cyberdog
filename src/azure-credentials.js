// Microsoft Entra ID tokens for Azure Storage: service principal (client secret), device code sign-in for a
// public client app registration, or the Azure CLI (`az login`) when no application is configured.
// Tokens live in memory only and are renewed shortly before they expire.
const { exec } = require('child_process')
const { request, readAll } = require('./object-storage')

const SCOPE = 'https://storage.azure.com/.default'
const MARGIN = 5 * 60 * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function post(url, params) {
  const body = new URLSearchParams(params).toString()
  const res = await request('POST', url, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) }, body)
  let j
  try { j = JSON.parse((await readAll(res)).toString()) } catch { j = {} }
  return { status: res.statusCode, j }
}
const fail = j => new Error('Microsoft Entra ID: ' + (j.error_description || j.error || 'sign-in failed').split('\r\n')[0])
const asToken = j => ({ token: j.access_token, expires: Date.now() + (+j.expires_in || 3600) * 1000, refresh: j.refresh_token })

// opts: { tenant, clientId, secret, onDeviceCode({ userCode, url, message }), login (authority base URL, for tests), run (az runner, for tests) }
function entraToken(opts) {
  const login = opts.login || 'https://login.microsoftonline.com'
  const tenant = opts.tenant || (opts.secret ? '' : 'organizations')
  let cached, pending

  async function deviceCode() {
    if (!opts.onDeviceCode) throw new Error('Microsoft Entra ID: interactive sign-in is not available')
    const start = await post(`${login}/${tenant}/oauth2/v2.0/devicecode`, { client_id: opts.clientId, scope: SCOPE + ' offline_access' })
    if (start.status !== 200) throw fail(start.j)
    const { device_code, user_code, verification_uri, message } = start.j
    opts.onDeviceCode({ userCode: user_code, url: verification_uri, message })
    let interval = (+start.j.interval || 5) * 1000
    const until = Date.now() + (+start.j.expires_in || 900) * 1000
    while (Date.now() < until) {
      await sleep(interval)
      const r = await post(`${login}/${tenant}/oauth2/v2.0/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: opts.clientId, device_code })
      if (r.status === 200) return asToken(r.j)
      if (r.j.error === 'slow_down') interval += 5000
      else if (r.j.error !== 'authorization_pending') throw fail(r.j)
    }
    throw new Error('Microsoft Entra ID: sign-in timed out')
  }

  async function azureCli() {
    const cmd = `az account get-access-token --resource https://storage.azure.com/ --output json${opts.tenant ? ` --tenant ${opts.tenant}` : ''}`
    const out = await (opts.run || (c => new Promise((ok, ko) => exec(c, { timeout: 60000, maxBuffer: 1e6, windowsHide: true }, (e, o) => e ? ko(new Error('Azure CLI: run "az login" first (' + e.message.split('\n')[0] + ')')) : ok(o)))))(cmd)
    const j = JSON.parse(out)
    return { token: j.accessToken, expires: j.expires_on ? +j.expires_on * 1000 : Date.parse(j.expiresOn) || Date.now() + 30 * 60000 }
  }

  async function acquire() {
    if (opts.clientId && opts.secret) {
      const r = await post(`${login}/${tenant}/oauth2/v2.0/token`, { grant_type: 'client_credentials', client_id: opts.clientId, client_secret: opts.secret, scope: SCOPE })
      if (r.status !== 200) throw fail(r.j)
      return asToken(r.j)
    }
    if (opts.clientId) {
      if (cached?.refresh) {
        const r = await post(`${login}/${tenant}/oauth2/v2.0/token`, { grant_type: 'refresh_token', client_id: opts.clientId, refresh_token: cached.refresh, scope: SCOPE })
        if (r.status === 200) return asToken(r.j)
      }
      return deviceCode()
    }
    return azureCli()
  }

  return {
    async get() {
      if (cached && cached.expires - MARGIN > Date.now()) return cached.token
      pending ??= acquire().then(t => (cached = t), e => { throw e }).finally(() => { pending = null })
      return (await pending).token
    },
  }
}

module.exports = { entraToken }
