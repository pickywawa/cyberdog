// HTTP CONNECT and SOCKS5 proxies for WebDAV (http and https) and FTP (control and data connections).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const https = require('https')
const path = require('path')
const FtpSrv = require('ftp-srv')
const bunyan = require('bunyan')
const { open } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const listen = (server, host = '127.0.0.1') => new Promise(ok => server.listen(0, host, () => ok(server.address().port)))
const fixtures = path.join(__dirname, 'fixtures')

// Proxies that count the tunnels they open
function connectProxy(creds) {
  const stats = { tunnels: 0, targets: [] }
  const server = http.createServer()
  server.on('connect', (req, client, head) => {
    if (creds && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(creds).toString('base64')) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
    const [host, port] = req.url.split(':')
    const up = net.connect(+port, host, () => { stats.tunnels++; stats.targets.push(req.url); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up) })
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy())
  })
  return { server, stats }
}
function socksProxy(creds) {
  const stats = { tunnels: 0, targets: [] }
  const server = net.createServer(client => {
    let stage = 0, buf = Buffer.alloc(0)
    client.on('error', () => {})
    client.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk])
      if (stage === 0 && buf.length >= 2 + buf[1]) {
        const method = creds ? 2 : 0
        assert(buf.subarray(2, 2 + buf[1]).includes(method))
        client.write(Buffer.from([5, method])); buf = buf.subarray(2 + buf[1]); stage = creds ? 1 : 2
      }
      if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const u = buf.subarray(2, 2 + buf[1]).toString(), p = buf.subarray(3 + buf[1], 3 + buf[1] + buf[2 + buf[1]]).toString()
        const good = `${u}:${p}` === creds
        client.write(Buffer.from([1, good ? 0 : 1]))
        if (!good) return client.end()
        buf = buf.subarray(3 + buf[1] + buf[2 + buf[1]]); stage = 2
      }
      if (stage === 2 && buf.length >= 5) {
        const atyp = buf[3], len = atyp === 3 ? buf[4] : 4, headLen = atyp === 3 ? 5 + len : 4 + len
        if (buf.length < headLen + 2) return
        const host = atyp === 3 ? buf.subarray(5, 5 + len).toString() : [...buf.subarray(4, 8)].join('.'), port = buf.readUInt16BE(headLen)
        stage = 3; client.removeListener('data', onData)
        const up = net.connect(port, host, () => { stats.tunnels++; stats.targets.push(`${host}:${port}`); client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(client); client.pipe(up) })
        up.on('error', () => client.destroy()); client.on('error', () => up.destroy())
      }
    })
  })
  return { server, stats }
}

async function ftpServer(root) {
  const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
  const pasv = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
  const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: pasv, pasv_max: pasv + 20, anonymous: false, log: bunyan.createLogger({ name: 'ftp', level: bunyan.FATAL + 1 }) })
  server.on('login', ({ username, password }, resolve, reject) => username === 'me' && password === 'pw' ? resolve({ root }) : reject(new Error('bad')))
  await server.listen()
  return { port, stop: () => server.close() }
}

;(async () => {
  // WebDAV target over plain http and over https (untrusted certificate accepted explicitly)
  const handler = (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('me:pw').toString('base64')) { res.statusCode = 401; return res.end() }
    res.statusCode = 207
    res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>')
  }
  const plain = http.createServer(handler), secure = https.createServer({ key: fs.readFileSync(path.join(fixtures, 'test-key.pem')), cert: fs.readFileSync(path.join(fixtures, 'test-cert.pem')) }, handler)
  const plainPort = await listen(plain), securePort = await listen(secure)

  for (const [kind, make, creds] of [['http', connectProxy, null], ['http+auth', connectProxy, 'pu:pp'], ['socks5', socksProxy, null], ['socks5+auth', socksProxy, 'pu:pp']]) {
    const proxy = make(creds), proxyPort = await listen(proxy.server)
    const [user, pass] = (creds || ':').split(':')
    const via = { proxyType: kind.startsWith('http') ? 'http' : 'socks5', proxyHost: '127.0.0.1', proxyPort, proxyUser: user, }
    const dav = (url, extra = {}) => open({ type: 'webdav', url, user: 'me', ...via, ...extra }, 'pw', { proxyPass: pass })
    await dav(`http://127.0.0.1:${plainPort}`)
    await dav(`https://127.0.0.1:${securePort}`, { insecureTls: true })
    assert.deepStrictEqual([...new Set(proxy.stats.targets)], [`127.0.0.1:${plainPort}`, `127.0.0.1:${securePort}`], kind)
    await assert.rejects(dav(`https://127.0.0.1:${securePort}`), /self.signed|certificate/i, 'untrusted certificates are refused unless accepted')
    if (creds) await assert.rejects(open({ type: 'webdav', url: `http://127.0.0.1:${plainPort}`, user: 'me', ...via }, 'pw', { proxyPass: 'wrong' }), /Proxy authentication required/)
    proxy.server.close()

    // FTP: control connection and passive data connections are both tunnelled
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ftp-proxy-'))
    const ftp = await ftpServer(root), proxy2 = make(creds), proxy2Port = await listen(proxy2.server)
    const s = await open({ type: 'ftp', host: '127.0.0.1', port: ftp.port, security: 'none', user: 'me', ...via, proxyPort: proxy2Port }, 'pw', { proxyPass: pass })
    await call(s, 'mkdir', '/d')
    await call(s, 'writeFile', '/d/a.txt', 'hello')
    assert.deepStrictEqual((await call(s, 'readdir', '/d')).map(e => e.filename), ['a.txt'])
    const chunks = []; for await (const c of s.createReadStream('/d/a.txt')) chunks.push(c)
    assert.strictEqual(Buffer.concat(chunks).toString(), 'hello')
    assert(proxy2.stats.tunnels >= 3, `${kind}: control + data connections went through the proxy (${proxy2.stats.tunnels})`)
    s.end(); ftp.stop(); proxy2.server.close(); fs.rmSync(root, { recursive: true, force: true })
  }
  plain.closeAllConnections(); plain.close(); secure.closeAllConnections(); secure.close()
  console.log('proxy ok')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
