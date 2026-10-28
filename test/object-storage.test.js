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

  assert.deepStrictEqual(storageFields({ type: 's3', region: 'eu-west-1' }), { type: 's3', url: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: '', preset: '', virtualHost: false, profile: '', proxyType: 'none', proxyHost: '', proxyPort: '', proxyUser: '', host: 's3.eu-west-1.amazonaws.com', port: 443 })
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
  srv.closeAllConnections(); srv.close() // pooled keep-alive sockets must not leak into a later server on a reused port

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
  s3srv.closeAllConnections(); s3srv.close() // pooled keep-alive sockets must not leak into a later server on a reused port

  // storage presets and new types
  assert.strictEqual(storageFields({ type: 's3', preset: 'scaleway' }).url, 'https://s3.fr-par.scw.cloud')
  assert.strictEqual(storageFields({ type: 's3', preset: 'gcs' }).region, 'auto')
  assert.strictEqual(storageFields({ type: 's3', preset: 'do', region: 'ams3' }).url, 'https://ams3.digitaloceanspaces.com')
  assert.strictEqual(storageFields({ type: 's3', preset: 'wasabi', url: 'https://custom.example.com', virtualHost: true }).virtualHost, true)
  assert.throws(() => storageFields({ type: 's3', preset: 'nope' }), /invalid_server/)
  assert.deepStrictEqual(storageFields({ type: 'ftp', host: 'ftp.example.com' }), { type: 'ftp', host: 'ftp.example.com', port: 21, security: 'explicit', insecureTls: false, proxyType: 'none', proxyHost: '', proxyPort: '', proxyUser: '' })
  assert.strictEqual(storageFields({ type: 'ftp', host: 'h', security: 'implicit' }).port, 990)
  assert.throws(() => storageFields({ type: 'ftp', host: 'h', port: 70000 }), /invalid_server/)
  assert.throws(() => storageFields({ type: 'ftp', host: 'h', security: 'x' }), /invalid_server/)
  assert.strictEqual(storageFields({ type: 'azure', user: 'MyAcct' }).url, 'https://myacct.blob.core.windows.net')
  assert.strictEqual(storageFields({ type: 'azurefiles', user: 'MyAcct' }).url, 'https://myacct.file.core.windows.net')
  assert.deepStrictEqual(storageFields({ type: 'smb', host: 'nas', bucket: 'docs' }), { type: 'smb', host: 'nas', port: 445, bucket: 'docs', domain: '' })
  assert.throws(() => storageFields({ type: 'smb', host: 'nas' }), /invalid_server/, 'a share is required')
  assert.strictEqual(storageFields({ type: 'dropbox', clientId: 'abc123' }).clientId, 'abc123')
  assert.strictEqual(storageFields({ type: 'onedrive', tenant: 'contoso.com' }).tenant, 'contoso.com')
  assert.throws(() => storageFields({ type: 'gdrive', clientId: 'a b' }), /invalid_server/)
  assert.deepStrictEqual(storageFields({ type: 'webdav', url: 'https://d.example.com/dav' }).authMethod, 'auto')
  assert.strictEqual(storageFields({ type: 'webdav', url: 'https://d.example.com', authMethod: 'digest', insecureTls: true }).insecureTls, true)
  assert.strictEqual(storageFields({ type: 'webdav', url: 'http://d.example.com', insecureTls: true }).insecureTls, false, 'only meaningful over https')
  assert.throws(() => storageFields({ type: 'webdav', url: 'https://d.example.com', authMethod: 'ntlm' }), /invalid_server/)
  assert.deepStrictEqual(storageFields({ type: 'ftp', host: 'h', proxyType: 'socks5', proxyHost: 'p.example.com', proxyUser: 'u' }).proxyPort, 1080)
  assert.strictEqual(storageFields({ type: 's3', proxyType: 'http', proxyHost: 'p', proxyPort: '3128' }).proxyPort, 3128)
  assert.throws(() => storageFields({ type: 's3', proxyType: 'http' }), /invalid_server/, 'a proxy needs a host')
  assert.throws(() => storageFields({ type: 's3', proxyType: 'ftp', proxyHost: 'p' }), /invalid_server/)
  assert.strictEqual(storageFields({ type: 'smb', host: 'nas', bucket: 'docs', proxyType: 'http', proxyHost: 'p' }).proxyType, undefined, 'SMB goes through the operating system')
  assert.throws(() => storageFields({ type: 'azure', user: 'a/b' }), /invalid_server/)

  // Presigned URL: reference vector from the AWS documentation
  const { presign, s3: s3backend } = require('../src/object-storage')
  assert(presign({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires: 86400, date: new Date('2013-05-24T00:00:00Z') }).endsWith('Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'))
  const linkBe = s3backend({ url: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: 'bkt' }, { accessKey: 'ak', secret: 'sk', token: 'tok' })
  const link = new URL(await linkBe.link('/a b.txt', 999999999))
  assert.strictEqual(link.pathname, '/bkt/a%20b.txt')
  assert.strictEqual(link.searchParams.get('X-Amz-Expires'), '604800')
  assert.strictEqual(link.searchParams.get('X-Amz-Security-Token'), 'tok')

  // AWS profiles: static keys, credential_process, role assumption (STS), IAM Identity Center (SSO), environment
  const { awsCredentials } = require('../src/aws-credentials')
  const crypto = require('crypto')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-aws-'))
  fs.mkdirSync(path.join(home, '.aws', 'sso', 'cache'), { recursive: true })
  const proc = path.join(home, 'proc.js')
  fs.writeFileSync(proc, `console.log(JSON.stringify({ Version: 1, AccessKeyId: 'PA', SecretAccessKey: 'PS', SessionToken: 'PT', Expiration: new Date(Date.now() + 3600e3).toISOString() }))`)
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AK1\naws_secret_access_key = S1\n\n[tmp]\naws_access_key_id = AK2\naws_secret_access_key = S2\naws_session_token = T2\n')
  fs.writeFileSync(path.join(home, '.aws', 'config'), `[default]\nregion = eu-west-1\n\n[profile proc]\ncredential_process = "${process.execPath}" "${proc}"\n\n[profile role]\nrole_arn = arn:aws:iam::123456789012:role/dev\nsource_profile = default\nregion = us-east-1\n\n[profile sso]\nsso_session = corp\nsso_account_id = 111122223333\nsso_role_name = Admin\n\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = eu-west-1\n\n[profile loop]\nrole_arn = arn:aws:iam::1:role/x\nsource_profile = loop\n`)
  let stsCalls = 0
  const cloud = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      if (req.method === 'POST') { // STS AssumeRole
        stsCalls++
        const body = new URLSearchParams(Buffer.concat(chunks).toString())
        assert.strictEqual(body.get('Action'), 'AssumeRole'); assert.strictEqual(body.get('RoleArn'), 'arn:aws:iam::123456789012:role/dev')
        assert(/Credential=AK1\/\d{8}\/us-east-1\/sts\/aws4_request/.test(req.headers.authorization), req.headers.authorization)
        return res.end(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>RA</AccessKeyId><SecretAccessKey>RS</SecretAccessKey><SessionToken>RT</SessionToken><Expiration>${new Date(Date.now() + 3600e3).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`)
      }
      const u = new URL(req.url, 'http://x') // SSO portal
      if (req.headers['x-amz-sso_bearer_token'] !== 'sso-token' || u.searchParams.get('role_name') !== 'Admin' || u.searchParams.get('account_id') !== '111122223333') { res.statusCode = 401; return res.end('{}') }
      res.end(JSON.stringify({ roleCredentials: { accessKeyId: 'SA', secretAccessKey: 'SS', sessionToken: 'ST', expiration: Date.now() + 3600e3 } }))
    })
  }).listen(0)
  await new Promise(r => cloud.on('listening', r))
  const cloudUrl = `http://127.0.0.1:${cloud.address().port}`
  const aws = (name, opts = {}) => awsCredentials(name, { home, env: {}, stsUrl: cloudUrl, ssoUrl: cloudUrl, ...opts }).get()
  assert.deepStrictEqual(await aws('default'), { accessKey: 'AK1', secret: 'S1', token: undefined })
  assert.deepStrictEqual(await aws(''), { accessKey: 'AK1', secret: 'S1', token: undefined })
  assert.strictEqual((await aws('tmp')).token, 'T2')
  assert.strictEqual((await aws('proc')).accessKey, 'PA')
  const role = awsCredentials('role', { home, env: {}, stsUrl: cloudUrl })
  assert.strictEqual((await role.get()).token, 'RT'); await role.get()
  assert.strictEqual(stsCalls, 1, 'temporary credentials are cached until shortly before expiry')
  await assert.rejects(aws('sso'), /SSO login required/)
  fs.writeFileSync(path.join(home, '.aws', 'sso', 'cache', crypto.createHash('sha1').update('corp').digest('hex') + '.json'), JSON.stringify({ accessToken: 'sso-token', expiresAt: new Date(Date.now() + 3600e3).toISOString() }))
  assert.strictEqual((await aws('sso')).accessKey, 'SA')
  fs.writeFileSync(path.join(home, '.aws', 'sso', 'cache', crypto.createHash('sha1').update('corp').digest('hex') + '.json'), JSON.stringify({ accessToken: 'sso-token', expiresAt: new Date(Date.now() - 1000).toISOString() }))
  await assert.rejects(aws('sso', {}), /expired/) // new resolver: no cache
  await assert.rejects(aws('missing'), /not found/)
  await assert.rejects(aws('loop'), /loop/)
  assert.strictEqual((await aws('env', { env: { AWS_ACCESS_KEY_ID: 'EK', AWS_SECRET_ACCESS_KEY: 'ES', AWS_SESSION_TOKEN: 'ET' } })).token, 'ET')
  await assert.rejects(aws('env'), /environment/)
  cloud.closeAllConnections(); cloud.close(); fs.rmSync(home, { recursive: true, force: true })

  // wrong region: the bucket's real region (x-amz-bucket-region) is followed once, then remembered
  const scopes = []
  const redirecting = http.createServer((req, res) => {
    scopes.push(/Credential=[^/]+\/\d+\/([^/]+)\//.exec(req.headers.authorization)[1])
    if (scopes.length === 1) { res.statusCode = 301; res.setHeader('x-amz-bucket-region', 'eu-west-3'); return res.end('<Error><Code>PermanentRedirect</Code></Error>') }
    res.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
  }).listen(0)
  await new Promise(r => redirecting.on('listening', r))
  const rbe = s3backend({ url: `http://127.0.0.1:${redirecting.address().port}`, region: 'us-east-1', bucket: 'bkt' }, { accessKey: 'a', secret: 'b' })
  await rbe.ping(); await rbe.ping()
  assert.deepStrictEqual(scopes, ['us-east-1', 'eu-west-3', 'eu-west-3'])
  redirecting.closeAllConnections(); redirecting.close() // pooled keep-alive sockets must not leak into a later server on a reused port
  console.log('object-storage ok')
})().catch(e => { console.error(e); process.exit(1) })
