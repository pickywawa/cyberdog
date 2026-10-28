const assert = require('assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { open, sign } = require('../src/object-storage')
const { storageFields } = require('../src/server-type')

const call = (sftp, m, ...a) => new Promise((ok, ko) => sftp[m](...a, (e, v) => e ? ko(e) : ok(v)))

;(async () => {
  // AWS SigV4 reference: GET object with Range from the S3 docs
  const h = sign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, payload: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') })
  assert(h.authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), h.authorization)

  assert.deepStrictEqual(storageFields({ type: 's3', region: 'eu-west-1' }), { type: 's3', url: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: '', preset: '', virtualHost: false, host: 's3.eu-west-1.amazonaws.com', port: 443 })
  assert.strictEqual(storageFields({ type: 'ssh' }), null)
  assert.throws(() => storageFields({ type: 'webdav', url: 'ftp://x' }), /invalid_server/)
  assert.throws(() => storageFields({ type: 'webdav', url: 'https://u:p@x' }), /invalid_server/)

  // WebDAV against an in-memory server
  const files = new Map([['/dir', null], ['/dir/a.txt', Buffer.from('hello')]])
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url)
    if (req.headers.authorization !== 'Basic ' + Buffer.from('me:pw').toString('base64')) { res.statusCode = 401; return res.end() }
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      if (req.method === 'PROPFIND') {
        const kids = [...files.keys()].filter(k => p === '/' ? true : k === p || k.startsWith(p + '/'))
        if (p !== '/' && !files.has(p)) { res.statusCode = 404; return res.end() }
        const depth1 = req.headers.depth === '1'
        const hit = [p === '/' ? '/' : p, ...(depth1 ? kids.filter(k => k !== p && k.split('/').length === (p === '/' ? 2 : p.split('/').length + 1)) : [])]
        res.statusCode = 207
        return res.end(`<d:multistatus xmlns:d="DAV:">${hit.map(k => `<d:response><d:href>${k}${files.get(k) === null ? '/' : ''}</d:href><d:propstat><d:prop>${files.get(k) === null || k === '/' ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${files.get(k).length}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`)
      }
      if (req.method === 'PUT') { files.set(p, Buffer.concat(chunks)); res.statusCode = 201; return res.end() }
      if (req.method === 'GET') { if (!files.has(p)) { res.statusCode = 404; return res.end() } return res.end(files.get(p)) }
      if (req.method === 'DELETE') { files.delete(p); res.statusCode = 204; return res.end() }
      res.statusCode = 405; res.end()
    })
  }).listen(0)
  await new Promise(r => srv.on('listening', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  await assert.rejects(open({ type: 'webdav', url, user: 'me' }, 'bad'), /Authentication failure/)
  const sftp = await open({ type: 'webdav', url, user: 'me' }, 'pw')
  assert.deepStrictEqual((await call(sftp, 'readdir', '/dir')).map(e => e.filename), ['a.txt'])
  const tmp = path.join(os.tmpdir(), 'cd-test-' + process.pid)
  await call(sftp, 'fastGet', '/dir/a.txt', tmp)
  assert.strictEqual(fs.readFileSync(tmp, 'utf8'), 'hello')
  fs.writeFileSync(tmp, 'bye')
  await call(sftp, 'fastPut', tmp, '/dir/b.txt')
  assert.strictEqual(files.get('/dir/b.txt').toString(), 'bye')
  await call(sftp, 'unlink', '/dir/b.txt')
  assert(!files.has('/dir/b.txt'))
  fs.rmSync(tmp)
  srv.close()

  // S3: session token is signed, large files go through multipart upload
  const objects = new Map(), uploads = new Map()
  let tokens = 0, completed = 0
  const s3srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), key = decodeURIComponent(u.pathname).replace(/^\/bkt\//, '')
    if (req.headers['x-amz-security-token'] === 'tok' && /x-amz-security-token/.test(req.headers.authorization)) tokens++
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method === 'POST' && u.searchParams.has('uploads')) { uploads.set('u1', new Map()); return res.end('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>') }
      if (req.method === 'PUT' && u.searchParams.has('partNumber')) { uploads.get('u1').set(+u.searchParams.get('partNumber'), body); res.setHeader('etag', '"e' + u.searchParams.get('partNumber') + '"'); return res.end() }
      if (req.method === 'POST' && u.searchParams.get('uploadId')) {
        assert.deepStrictEqual([...body.toString().matchAll(/<ETag>(.*?)<\/ETag>/g)].map(m => m[1]), ['"e1"', '"e2"', '"e3"', '"e4"'])
        objects.set(key, Buffer.concat([...uploads.get('u1').keys()].sort().map(n => uploads.get('u1').get(n)))); completed++
        return res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
      }
      if (req.method === 'PUT') { objects.set(key, body); return res.end() }
      if (req.method === 'GET' && u.searchParams.has('list-type')) {
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects].map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`)
      }
      res.statusCode = 404; res.end()
    })
  }).listen(0)
  await new Promise(r => s3srv.on('listening', r))
  const s3url = `http://127.0.0.1:${s3srv.address().port}`
  const { s3 } = require('../src/object-storage')
  const be = s3({ url: s3url, region: 'us-east-1', bucket: 'bkt', partSize: 10 }, { accessKey: 'ak', secret: 'sk', token: 'tok' })
  await be.ping()
  assert(tokens > 0)
  const big = path.join(os.tmpdir(), 'cd-s3-' + process.pid)
  fs.writeFileSync(big, 'abcdefghij'.repeat(3) + 'xyz')
  await be.putFile('/big.bin', big)
  assert.strictEqual(completed, 1)
  assert.strictEqual(objects.get('big.bin').toString(), 'abcdefghij'.repeat(3) + 'xyz')
  fs.writeFileSync(big, 'small'); await be.putFile('/small.bin', big)
  assert.strictEqual(completed, 1)
  fs.rmSync(big)
  s3srv.close()

  // storage presets and new types
  assert.strictEqual(storageFields({ type: 's3', preset: 'scaleway' }).url, 'https://s3.fr-par.scw.cloud')
  assert.strictEqual(storageFields({ type: 's3', preset: 'gcs' }).region, 'auto')
  assert.strictEqual(storageFields({ type: 's3', preset: 'do', region: 'ams3' }).url, 'https://ams3.digitaloceanspaces.com')
  assert.strictEqual(storageFields({ type: 's3', preset: 'wasabi', url: 'https://custom.example.com', virtualHost: true }).virtualHost, true)
  assert.throws(() => storageFields({ type: 's3', preset: 'nope' }), /invalid_server/)
  assert.deepStrictEqual(storageFields({ type: 'ftp', host: 'ftp.example.com' }), { type: 'ftp', host: 'ftp.example.com', port: 21, security: 'explicit', insecureTls: false })
  assert.strictEqual(storageFields({ type: 'ftp', host: 'h', security: 'implicit' }).port, 990)
  assert.throws(() => storageFields({ type: 'ftp', host: 'h', port: 70000 }), /invalid_server/)
  assert.throws(() => storageFields({ type: 'ftp', host: 'h', security: 'x' }), /invalid_server/)
  assert.strictEqual(storageFields({ type: 'azure', user: 'MyAcct' }).url, 'https://myacct.blob.core.windows.net')
  assert.throws(() => storageFields({ type: 'azure', user: 'a/b' }), /invalid_server/)
  console.log('object-storage ok')
})().catch(e => { console.error(e); process.exit(1) })
