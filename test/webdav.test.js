// WebDAV authentication (Basic, Digest, Bearer) and redirects.
const assert = require('assert')
const http = require('http')
const crypto = require('crypto')
const { open, digestHeader, parseDigest } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)))

// RFC 2617 example
assert(digestHeader({ realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41', qop: 'auth,auth-int' }, { user: 'Mufasa', pass: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: '00000001', cnonce: '0a4f113b' }).includes('response="6629fae49393a05397450978507c4ef1"'))
assert.strictEqual(parseDigest(['Basic realm="x"', 'Digest realm="r", nonce="a", algorithm=MD5', 'Digest realm="r", nonce="b", algorithm=SHA-256, qop="auth"']).nonce, 'b', 'SHA-256 is preferred')
assert.strictEqual(parseDigest(['Basic realm="x"']), null)

const MULTISTATUS = href => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`

;(async () => {
  const log = { requests: [], other: 0 }
  // another origin that a redirect must never reach with credentials
  const other = http.createServer((req, res) => { log.other++; res.end() }), otherPort = await listen(other)

  let nonceCount = 0
  const nonces = new Set()
  const dav = http.createServer((req, res) => {
    log.requests.push(`${req.method} ${req.url} ${(req.headers.authorization || '').split(' ')[0]}`)
    req.resume()
    const mode = req.headers['x-test-mode'] || new URL(req.url, 'http://x').searchParams.get('mode')
    const auth = req.headers.authorization || ''
    if (req.url.startsWith('/redirect-away')) { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${otherPort}/`); return res.end() }
    if (req.url === '/slash') { res.statusCode = 301; res.setHeader('location', '/slash/'); return res.end() }
    if (req.url.startsWith('/bearer')) { if (auth !== 'Bearer tok123') { res.statusCode = 401; return res.end() } }
    else if (req.url.startsWith('/digest')) {
      const challenge = () => { const n = crypto.randomBytes(8).toString('hex'); nonces.add(n); res.statusCode = 401; res.setHeader('www-authenticate', [`Digest realm="dav", nonce="${n}", qop="auth", algorithm=MD5`, `Digest realm="dav", nonce="${n}", qop="auth", algorithm=SHA-256`]); res.end() }
      if (!auth.startsWith('Digest ')) return challenge()
      const p = Object.fromEntries([...auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map(m => [m[1], m[2] ?? m[3]]))
      const expect = digestHeader({ realm: 'dav', nonce: p.nonce, qop: 'auth', algorithm: p.algorithm }, { user: 'me', pass: 'pw', method: req.method, uri: req.url, nc: p.nc, cnonce: p.cnonce })
      if (!nonces.has(p.nonce) || auth !== expect || p.algorithm !== 'SHA-256') return challenge()
      nonceCount++
    } else if (auth !== 'Basic ' + Buffer.from('me:pw').toString('base64')) { res.setHeader('www-authenticate', 'Basic realm="dav"'); res.statusCode = 401; return res.end() }
    res.statusCode = 207
    res.end(MULTISTATUS(req.url.replace(/\/?$/, '/')))
  })
  const port = await listen(dav), url = p => `http://127.0.0.1:${port}${p}`

  // Basic: preemptive when chosen, after the first 401 with auto
  let s = await open({ type: 'webdav', url: url('/basic'), user: 'me', authMethod: 'basic' }, 'pw')
  assert(log.requests.every(r => r.endsWith('Basic')), log.requests.join())
  log.requests.length = 0
  s = await open({ type: 'webdav', url: url('/basic'), user: 'me' }, 'pw')
  assert.deepStrictEqual(log.requests.map(r => r.split(' ').at(-1)), ['', 'Basic'], 'auto sends no credential before the server asks')
  await assert.rejects(open({ type: 'webdav', url: url('/basic'), user: 'me' }, 'wrong'), /Authentication failure/)

  // Digest: challenge, then every request carries a fresh nonce count; the strongest algorithm is used
  s = await open({ type: 'webdav', url: url('/digest'), user: 'me' }, 'pw')
  assert.strictEqual(nonceCount, 1)
  await call(s, 'stat', '/')
  assert.strictEqual(nonceCount, 2, 'the nonce is reused with an increasing counter')
  await assert.rejects(open({ type: 'webdav', url: url('/digest'), user: 'me' }, 'bad'), /Authentication failure/)
  await open({ type: 'webdav', url: url('/digest'), user: 'me', authMethod: 'digest' }, 'pw')

  // Bearer token
  s = await open({ type: 'webdav', url: url('/bearer'), authMethod: 'bearer' }, 'tok123')
  await assert.rejects(open({ type: 'webdav', url: url('/bearer'), authMethod: 'bearer' }, 'nope'), /Authentication failure/)

  // Redirects: same origin followed, other origins refused
  await open({ type: 'webdav', url: url('/slash'), user: 'me', authMethod: 'basic' }, 'pw')
  await assert.rejects(open({ type: 'webdav', url: url('/redirect-away'), user: 'me', authMethod: 'basic' }, 'pw'), /HTTP 302|EIO|302/)
  assert.strictEqual(log.other, 0, 'credentials never follow a redirect to another origin')

  for (const srv of [dav, other]) { srv.closeAllConnections(); srv.close() }
  console.log('webdav ok')
})().catch(e => { console.error(e); process.exit(1) })
