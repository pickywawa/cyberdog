// Azure Files REST backend against an in-memory server that enforces the protocol rules it relies on
// (required creation headers, x-ms-type/content-length, ranged writes, rename). SharedKey signing itself is shared with
// the blob backend, which the Azurite test validates; here only its presence and shape are checked.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { open } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const KEY = Buffer.from('shared-key-for-tests').toString('base64')

;(async () => {
  const shares = new Map() // share -> Map(path -> null | Buffer)
  const log = []
  const xml = (code, msg) => `<Error><Code>${code}</Code><Message>${msg}</Message></Error>`
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks), u = new URL(req.url, 'http://x'), q = u.searchParams
      const [, share, ...rest] = decodeURIComponent(u.pathname).split('/'), key = rest.join('/')
      const h = req.headers
      log.push(`${req.method} ${u.pathname}${u.search}`)
      const fail = (status, code) => { res.statusCode = status; res.end(xml(code, code)) }
      if (!/^SharedKey acct:[A-Za-z0-9+/=]+$/.test(h.authorization || '')) return fail(403, 'AuthenticationFailed')
      assert(h['x-ms-version'] && h['x-ms-date'])
      const files = shares.get(share)
      const ent = e => `<Properties><Content-Length>${e.size}</Content-Length><LastWriteTime>Wed, 28 Oct 2026 10:00:00 GMT</LastWriteTime></Properties>`
      if (!share) return res.end(`<EnumerationResults><Shares>${[...shares.keys()].map(n => `<Share><Name>${n}</Name><Properties><Last-Modified>Wed, 28 Oct 2026 10:00:00 GMT</Last-Modified></Properties></Share>`).join('')}</Shares><NextMarker/></EnumerationResults>`)
      if (q.get('restype') === 'share') {
        if (req.method === 'PUT') { shares.set(share, new Map()); res.statusCode = 201; return res.end() }
        if (!files) return fail(404, 'ShareNotFound')
        if (req.method === 'DELETE') { shares.delete(share); res.statusCode = 202; return res.end() }
        return res.end()
      }
      if (!files) return fail(404, 'ShareNotFound')
      const needCreateHeaders = () => ['x-ms-file-permission', 'x-ms-file-attributes', 'x-ms-file-creation-time', 'x-ms-file-last-write-time'].every(k => h[k])
      if (q.get('restype') === 'directory') {
        if (req.method === 'PUT') { if (!needCreateHeaders()) return fail(400, 'MissingRequiredHeader'); if (files.has(key)) return fail(409, 'ResourceAlreadyExists'); files.set(key, null); res.statusCode = 201; return res.end() }
        if (req.method === 'DELETE') { if ([...files.keys()].some(k => k.startsWith(key + '/'))) return fail(409, 'DirectoryNotEmpty'); files.delete(key); res.statusCode = 202; return res.end() }
        if (q.get('comp') === 'list') {
          const depth = key ? key.split('/').length + 1 : 1, kids = [...files].filter(([k]) => k !== key && (!key || k.startsWith(key + '/')) && k.split('/').length === depth)
          return res.end(`<EnumerationResults><Entries>${kids.map(([k, v]) => v === null ? `<Directory><Name>${k.split('/').pop()}</Name>${ent({ size: 0 })}</Directory>` : `<File><Name>${k.split('/').pop()}</Name><FileId>1</FileId>${ent(v)}</File>`).join('')}</Entries><NextMarker/></EnumerationResults>`)
        }
        return files.get(key) === null || !key ? res.end() : fail(404, 'ResourceNotFound') // HEAD on a directory
      }
      if (q.get('comp') === 'rename') {
        const src = decodeURIComponent(h['x-ms-file-rename-source']).replace(`/${share}/`, '')
        if (!files.has(src)) return fail(404, 'ResourceNotFound')
        for (const k of [...files.keys()].filter(k => k === src || k.startsWith(src + '/'))) { files.set(key + k.slice(src.length), files.get(k)); files.delete(k) }
        return res.end()
      }
      if (q.get('comp') === 'range') {
        const f = files.get(key); assert(Buffer.isBuffer(f), 'range written to a created file')
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(h['x-ms-range'])
        assert.strictEqual(h['x-ms-write'], 'update'); assert.strictEqual(body.length, +b - +a + 1)
        body.copy(f, +a); res.statusCode = 201; return res.end()
      }
      if (req.method === 'PUT') {
        assert.strictEqual(h['x-ms-type'], 'file'); if (!needCreateHeaders()) return fail(400, 'MissingRequiredHeader')
        files.set(key, Buffer.alloc(+h['x-ms-content-length'])); res.statusCode = 201; return res.end()
      }
      if (req.method === 'DELETE') { if (!files.has(key)) return fail(404, 'ResourceNotFound'); files.delete(key); res.statusCode = 202; return res.end() }
      const f = files.get(key)
      if (!Buffer.isBuffer(f)) return fail(404, 'ResourceNotFound')
      res.setHeader('last-modified', 'Wed, 28 Oct 2026 10:00:00 GMT')
      if (req.method === 'HEAD') { res.setHeader('content-length', f.length); return res.end() }
      res.end(f)
    })
  }).listen(0, '127.0.0.1')
  await new Promise(r => server.on('listening', r))
  const url = `http://127.0.0.1:${server.address().port}`
  const srv = { type: 'azurefiles', url, user: 'acct', bucket: '' }
  const tmp = path.join(os.tmpdir(), 'cd-azf-' + process.pid)
  try {
    await assert.rejects(open({ ...srv }, ''), /credentials required/)
    const s = await open(srv, KEY)
    await call(s, 'mkdir', '/docs')
    assert.deepStrictEqual((await call(s, 'readdir', '/')).map(e => e.filename), ['docs'])
    await call(s, 'mkdir', '/docs/sub')
    await call(s, 'writeFile', '/docs/a b.txt', 'hello world')
    assert.deepStrictEqual((await call(s, 'readdir', '/docs')).map(e => e.filename).sort(), ['a b.txt', 'sub'])
    assert.strictEqual((await call(s, 'stat', '/docs/a b.txt')).size, 11)
    assert.strictEqual((await call(s, 'stat', '/docs/sub')).isDirectory(), true)
    await assert.rejects(call(s, 'stat', '/docs/none'), /No such file/)
    await call(s, 'fastGet', '/docs/a b.txt', tmp)
    assert.strictEqual(fs.readFileSync(tmp, 'utf8'), 'hello world')
    fs.writeFileSync(tmp, 'x'.repeat(20)) // 8-byte ranges in the mock: 3 range writes
    const { azureFiles } = require('../src/object-storage')
    await azureFiles({ url, container: 'docs', partSize: 8 }, { account: 'acct', secret: KEY }).putFile('/big.bin', tmp)
    assert.strictEqual(shares.get('docs').get('big.bin').toString(), 'x'.repeat(20))
    assert.strictEqual(log.filter(l => l.includes('comp=range')).length, 1 + 3, 'one range for the small file, three of at most 8 bytes for the 20-byte file')
    await call(s, 'rename', '/docs/sub', '/docs/sub2')
    assert.strictEqual((await call(s, 'stat', '/docs/sub2')).isDirectory(), true)
    await call(s, 'rename', '/docs/a b.txt', '/docs/sub2/a.txt')
    await assert.rejects(call(s, 'stat', '/docs/a b.txt'), /No such file/)
    await call(s, 'unlink', '/docs/sub2/a.txt'); await call(s, 'rmdir', '/docs/sub2')
    await call(s, 'rmdir', '/docs')
    assert.strictEqual((await call(s, 'readdir', '/')).length, 0)
    await assert.rejects(open(srv, ''), /credentials required/)
  } finally { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { force: true }) }
  console.log('azurefiles ok')
})().catch(e => { console.error(e); process.exit(1) })
