// FTP / FTPS backend against an in-process ftp-srv server (plain and explicit TLS).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const FtpSrv = require('ftp-srv')
const bunyan = require('bunyan')
const { open } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const fixtures = path.join(__dirname, 'fixtures')

async function serve(root, tls) {
  const port = await freePort(), pasv = await freePort()
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: pasv, pasv_max: pasv + 20, anonymous: false,
    log: bunyan.createLogger({ name: 'ftp', level: bunyan.FATAL + 1 }),
    ...(tls ? { tls: { key: fs.readFileSync(path.join(fixtures, 'test-key.pem')), cert: fs.readFileSync(path.join(fixtures, 'test-cert.pem')) } } : {}),
  })
  server.on('login', ({ username, password }, resolve, reject) => username === 'me' && password === 'pw' ? resolve({ root }) : reject(Object.assign(new Error('Bad credentials'), { code: 530 })))
  await server.listen()
  return { port, stop: () => server.close() }
}

async function exercise(security, insecureTls) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ftp-')), tmp = path.join(os.tmpdir(), 'cd-ftp-file-' + process.pid)
  const srv = await serve(root, security !== 'none')
  const server = { type: 'ftp', host: '127.0.0.1', port: srv.port, security, insecureTls, user: 'me' }
  let s
  try {
    await assert.rejects(open(server, 'bad'), /Authentication failure/)
    if (security === 'explicit') await assert.rejects(open({ ...server, insecureTls: false }, 'pw'), /self.signed|certificate|unable to verify/i)
    s = await open(server, 'pw')
    await call(s, 'mkdir', '/d')
    await call(s, 'writeFile', '/d/a b.txt', 'hello')
    assert.deepStrictEqual((await call(s, 'readdir', '/d')).map(e => e.filename), ['a b.txt'])
    assert.strictEqual((await call(s, 'stat', '/d/a b.txt')).size, 5)
    assert.strictEqual((await call(s, 'stat', '/d')).isDirectory(), true)
    await assert.rejects(call(s, 'stat', '/nope'), /No such file/)

    // permissions: SITE CHMOD then read back from the listing
    assert.strictEqual(typeof s.chmod, 'function')
    await call(s, 'chmod', '/d/a b.txt', 0o600)
    const [entry] = await call(s, 'readdir', '/d')
    assert.strictEqual(entry.attrs.mode & 0o777, 0o600, 'mode ' + (entry.attrs.mode & 0o777).toString(8))
    assert(entry.attrs.isFile())

    // streamed upload (no staging file), parallel listing while a transfer runs, download, rename
    fs.writeFileSync(tmp, Buffer.alloc(3 * 1024 * 1024, 'y'))
    await Promise.all([
      new Promise((ok, ko) => { const w = s.createWriteStream('/d/big'); w.on('finish', ok).on('error', ko); fs.createReadStream(tmp).pipe(w) }),
      call(s, 'readdir', '/'), call(s, 'readdir', '/'),
    ])
    assert.strictEqual(fs.statSync(path.join(root, 'd', 'big')).size, 3 * 1024 * 1024)
    await call(s, 'fastGet', '/d/big', tmp + '2')
    assert.strictEqual(fs.statSync(tmp + '2').size, 3 * 1024 * 1024)
    await call(s, 'rename', '/d/big', '/d/big2')
    const chunks = []
    for await (const c of s.createReadStream('/d/a b.txt')) chunks.push(c)
    assert.strictEqual(Buffer.concat(chunks).toString(), 'hello')
    // resume: read from an offset (REST) and append to a partial upload (APPE)
    const tailChunks = []; for await (const c of s.createReadStream('/d/a b.txt', { start: 2 })) tailChunks.push(c)
    assert.strictEqual(Buffer.concat(tailChunks).toString(), 'llo')
    assert.deepStrictEqual(s.canResume, { read: true, write: true })
    await new Promise((ok, ko) => { const w = s.createWriteStream('/d/a b.txt', { start: 5 }); w.on('finish', ok).on('error', ko); w.end('!!') })
    assert.strictEqual(fs.readFileSync(path.join(root, 'd', 'a b.txt'), 'utf8'), 'hello!!')
    await assert.rejects(new Promise((ok, ko) => { const r = s.createReadStream('/missing'); r.on('error', ko).on('end', ok).resume() }), /./)

    for (const f of ['/d/big2', '/d/a b.txt']) await call(s, 'unlink', f)
    await call(s, 'rmdir', '/d')
    assert.strictEqual((await call(s, 'readdir', '/')).length, 0)
  } finally { s?.end(); srv.stop(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + '2', { force: true }) }
}

;(async () => {
  await exercise('none', false)
  await exercise('explicit', true)
  console.log('ftp ok')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
