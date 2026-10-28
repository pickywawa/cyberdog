// OAuth 2.0 for the cloud drives: authorization code with PKCE through a loopback redirect, then refresh tokens.
// Only the refresh token is ever stored (encrypted by the caller); access tokens live in memory.
const http = require('http')
const crypto = require('crypto')
const { request, readAll } = require('./object-storage')

const b64url = b => b.toString('base64url')
const form = o => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''))).toString()

async function postForm(url, params, agent) {
  const body = form(params)
  const res = await request('POST', url, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), accept: 'application/json' }, body, agent)
  let j
  try { j = JSON.parse((await readAll(res)).toString()) } catch { j = {} }
  if (res.statusCode !== 200) {
    const e = new Error('Authentication failure: ' + (j.error_description || j.error || 'HTTP ' + res.statusCode).split('\r\n')[0])
    e.code = 'EACCES'; e.oauth = j.error
    throw e
  }
  return j
}

// Listens on the loopback interfaces for the single redirect of the sign-in and resolves with { code, redirectUri }.
function waitForCode(port, state, onListening) {
  return new Promise((resolve, reject) => {
    const servers = []
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => servers.forEach(s => { s.closeAllConnections?.(); s.close() }), 200) // let the browser receive the page
      err ? reject(err) : resolve(value)
    }
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      if (u.pathname !== '/callback') { res.statusCode = 404; return res.end() }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      const ok = u.searchParams.get('code') && u.searchParams.get('state') === state
      res.end(`<!doctype html><meta charset="utf-8"><title>Cyberdog</title><body style="font:16px system-ui;text-align:center;margin-top:20vh">${ok ? 'Signed in. You can close this tab and return to Cyberdog.' : 'Sign-in failed. You can close this tab.'}</body>`)
      if (ok) finish(null, { code: u.searchParams.get('code'), redirectUri: `http://localhost:${actualPort}/callback` })
      else finish(new Error('Authentication failure: ' + (u.searchParams.get('error_description') || u.searchParams.get('error') || 'sign-in cancelled')))
    }
    let actualPort = port
    const timer = setTimeout(() => finish(new Error('Authentication failure: sign-in timed out')), 5 * 60 * 1000)
    const first = http.createServer(handler)
    first.on('error', e => finish(e))
    first.listen(port, '127.0.0.1', () => {
      servers.push(first)
      actualPort = first.address().port
      const v6 = http.createServer(handler) // browsers may resolve "localhost" to ::1
      v6.on('error', () => {})
      v6.listen(actualPort, '::1', () => servers.push(v6))
      onListening(actualPort)
    })
  })
}

// provider: { authUrl, tokenUrl, scope, port?, params? }; app: { clientId, clientSecret? }
// open(url): shows the sign-in page to the user. Resolves with { refreshToken, accessToken, expires }.
async function authorize(provider, app, open, agent) {
  if (!app.clientId) throw new Error('No application (client) ID: register an application with the provider and enter its client ID')
  const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(16))
  const result = await waitForCode(provider.port || 0, state, port => {
    const url = new URL(provider.authUrl)
    const params = { response_type: 'code', client_id: app.clientId, redirect_uri: `http://localhost:${port}/callback`, scope: provider.scope, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...provider.params }
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
    open(url.href)
  })
  const j = await postForm(provider.tokenUrl, { grant_type: 'authorization_code', code: result.code, redirect_uri: result.redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: verifier }, agent)
  if (!j.refresh_token) throw new Error('Authentication failure: the provider returned no refresh token')
  return { refreshToken: j.refresh_token, accessToken: j.access_token, expires: Date.now() + (+j.expires_in || 3600) * 1000 }
}

// Access tokens from a refresh token. onRefreshToken(newToken) is called when the provider rotates it.
// first: optional { accessToken, expires } already obtained by authorize().
function tokenSource(provider, app, refreshToken, { onRefreshToken, first, agent } = {}) {
  let current = first && { token: first.accessToken, expires: first.expires }, pending
  return {
    get() {
      if (current && current.expires - 60000 > Date.now()) return Promise.resolve(current.token)
      pending ??= postForm(provider.tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret, scope: provider.refreshScope }, agent)
        .then(j => {
          current = { token: j.access_token, expires: Date.now() + (+j.expires_in || 3600) * 1000 }
          if (j.refresh_token && j.refresh_token !== refreshToken) { refreshToken = j.refresh_token; onRefreshToken?.(refreshToken) }
          return current.token
        })
        .finally(() => { pending = null })
      return pending
    },
  }
}

module.exports = { authorize, tokenSource }
