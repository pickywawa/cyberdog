// Azure Blob backend against the official Azurite emulator: SharedKey, block upload, shared links (SAS) and Entra ID bearer tokens.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')
const { open, azure } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
const ACCOUNT = 'devstoreaccount1'
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const waitPort = async port => { for (let i = 0; i < 100; i++) { if (await new Promise(ok => net.connect(port, '127.0.0.1').on('connect', function () { this.destroy(); ok(true) }).on('error', () => ok(false)))) return; await new Promise(r => setTimeout(r, 200)) } throw new Error('Azurite did not start') }
const fetch = url => new Promise((ok, ko) => (url.startsWith('https') ? https : http).get(url, { rejectUnauthorized: false }, res => { const b = []; res.on('data', c => b.push(c)).on('end', () => ok({ status: res.statusCode, body: Buffer.concat(b).toString() })) }).on('error', ko))
const bin = require.resolve('azurite/package.json').replace('package.json', 'dist/src/blob/main.js')
const spawnAzurite = async (extra = []) => {
  const port = await freePort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-azurite-'))
  const proc = spawn(process.execPath, [bin, '--silent', '--blobHost', '127.0.0.1', '--blobPort', String(port), '--skipApiVersionCheck', '--inMemoryPersistence', ...extra], { stdio: 'ignore' })
  await waitPort(port)
  return { port, stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
// unsigned JWT in the shape Azurite's "basic" OAuth validation expects
const jwt = tenant => ['{"alg":"HS256","typ":"JWT"}', JSON.stringify({ aud: 'https://storage.azure.com', iss: `https://sts.windows.net/${tenant}/`, iat: Math.floor(Date.now() / 1000) - 60, nbf: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 3600 })].map(x => Buffer.from(x).toString('base64url')).join('.') + '.c2ln'

;(async () => {
  const az = await spawnAzurite()
  const srv = { type: 'azure', url: `http://127.0.0.1:${az.port}/${ACCOUNT}`, user: ACCOUNT, bucket: '' }
  const tmp = path.join(os.tmpdir(), 'cd-az-' + process.pid)
  try {
    await assert.rejects(open(srv, 'AAAA'), /Authentication failure/)
    const s = await open(srv, KEY)
    await call(s, 'mkdir', '/cont')
    assert((await call(s, 'readdir', '/')).some(e => e.filename === 'cont'))
    await call(s, 'mkdir', '/cont/dir')
    await call(s, 'writeFile', '/cont/dir/a b.txt', 'hello')
    assert.deepStrictEqual((await call(s, 'readdir', '/cont/dir')).map(e => e.filename), ['a b.txt'])
    assert.strictEqual((await call(s, 'stat', '/cont/dir')).isDirectory(), true)
    assert.strictEqual((await call(s, 'stat', '/cont/dir/a b.txt')).size, 5)
    await call(s, 'fastGet', '/cont/dir/a b.txt', tmp)
    assert.strictEqual(fs.readFileSync(tmp, 'utf8'), 'hello')
    await call(s, 'rename', '/cont/dir', '/cont/dir2')
    assert.deepStrictEqual((await call(s, 'readdir', '/cont/dir2')).map(e => e.filename), ['a b.txt'])

    // block upload with a tiny block size
    const be = azure({ url: srv.url, container: 'cont', partSize: 10 }, { account: ACCOUNT, secret: KEY })
    fs.writeFileSync(tmp, 'x'.repeat(35))
    await be.putFile('/big.bin', tmp)
    assert.strictEqual((await be.stat('/big.bin')).size, 35)
    const tail = []; for await (const c of await be.get('/big.bin', 30)) tail.push(c)
    assert.strictEqual(Buffer.concat(tail).toString(), 'xxxxx', 'ranged read (resume) is signed and honoured')

    // shared link: a service SAS signed by us must be accepted by the emulator
    const link = await be.link('/dir2/a b.txt', 600)
    const got = await fetch(link)
    assert.strictEqual(got.status, 200, got.body)
    assert.strictEqual(got.body, 'hello')
    assert.strictEqual((await fetch(link.replace(/sig=[^&]+/, 'sig=AAAA'))).status, 403)

    await call(s, 'unlink', '/cont/big.bin'); await call(s, 'unlink', '/cont/dir2/a b.txt'); await call(s, 'rmdir', '/cont/dir2'); await call(s, 'rmdir', '/cont')
  } finally { az.stop(); fs.rmSync(tmp, { force: true }) }

  // Microsoft Entra ID: client-credentials token from a fake authority, accepted by Azurite's basic OAuth (HTTPS)
  const tenant = '11111111-2222-3333-4444-555555555555'
  const authority = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c).on('end', () => {
      const p = new URLSearchParams(body)
      if (p.get('client_secret') !== 'right') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Invalid client secret' })) }
      assert.strictEqual(p.get('grant_type'), 'client_credentials'); assert.strictEqual(p.get('scope'), 'https://storage.azure.com/.default')
      res.end(JSON.stringify({ access_token: jwt(tenant), expires_in: 3600 }))
    })
  }).listen(0, '127.0.0.1')
  await new Promise(r => authority.on('listening', r))
  const fixtures = path.join(__dirname, 'fixtures')
  const secure = await spawnAzurite(['--oauth', 'basic', '--cert', path.join(fixtures, 'test-cert.pem'), '--key', path.join(fixtures, 'test-key.pem')])
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const entra = { type: 'azure', azureAuth: 'entra', url: `https://127.0.0.1:${secure.port}/${ACCOUNT}`, user: ACCOUNT, tenant, clientId: '99999999-8888-7777-6666-555555555555' }
    const login = `http://127.0.0.1:${authority.address().port}`
    await assert.rejects(open(entra, 'wrong', { azure: { login } }), /Invalid client secret/)
    const s = await open(entra, 'right', { azure: { login } })
    await call(s, 'mkdir', '/ent')
    await call(s, 'writeFile', '/ent/x.txt', 'entra')
    assert.deepStrictEqual((await call(s, 'readdir', '/ent')).map(e => e.filename), ['x.txt'])
    assert.strictEqual(typeof s.link, 'function')
    await assert.rejects(s.link('/ent/x.txt', 60), /not available/)
  } finally { process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls ?? ''; if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; secure.stop(); authority.close() }
  console.log('azure ok')
})().catch(e => { console.error(e); process.exit(1) })
