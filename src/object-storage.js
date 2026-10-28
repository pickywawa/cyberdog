// S3-compatible and WebDAV backends exposed through the callback API of an ssh2 SFTP session,
// so the file explorer, transfers and editing work unchanged. No dependencies.
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough, Writable } = require('stream')
const { pipeline } = require('stream/promises')
const posix = path.posix
const { agentFor } = require('./proxy')

const sha = d => crypto.createHash('sha256').update(d).digest('hex')
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const encPath = p => p.split('/').map(enc).join('/')
const qs = q => Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&')
const norm = p => posix.resolve('/', p)
const decodeXml = s => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ?? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1)))
const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g'))].map(m => m[1])
const val = (xml, tag) => { const b = blocks(xml, tag)[0]; return b === undefined ? undefined : decodeXml(b.replace(/^<!\[CDATA\[|\]\]>$/g, '')) }
const hashFile = (f, range = {}) => new Promise((ok, ko) => { const h = crypto.createHash('sha256'); fs.createReadStream(f, range).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', ko) })
const readAll = res => new Promise((ok, ko) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => ok(Buffer.concat(b))); res.on('error', ko) })

function request(method, url, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: 30000, agent }, resolve)
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Connection timed out')))
    if (body && typeof body.pipe === 'function') { body.on('error', e => req.destroy(e)); body.pipe(req) } else req.end(body)
  })
}

const AUTH_CODES = ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken']
function httpError(status, body, s3) {
  const code = s3 && val(body, 'Code'), msg = s3 && val(body, 'Message')
  const e = new Error(status === 401 || AUTH_CODES.includes(code) ? `Authentication failure${code ? ': ' + code : ''}` : `${code || 'HTTP ' + status}${msg ? ': ' + msg : ''}`)
  e.code = status === 404 ? 'ENOENT' : 'EIO'
  e.status = status
  return e
}
const notFound = p => Object.assign(new Error('No such file: ' + p), { code: 'ENOENT', status: 404 })

// AWS Signature V4 (S3). Returns the full header set including Authorization.
function sign({ method, url, query = {}, headers = {}, payload, region, accessKey, secret, token, service = 's3', date = new Date() }) {
  const u = new URL(url)
  const amz = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8)
  const h = { ...headers, host: u.host, 'x-amz-date': amz, ...(service === 's3' ? { 'x-amz-content-sha256': payload } : {}), ...(token ? { 'x-amz-security-token': token } : {}) }
  const names = Object.keys(h).map(k => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
  const request = [method, u.pathname, qs(query), names.map(n => `${n}:${lower[n]}\n`).join(''), names.join(';'), payload].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amz, scope, sha(request)].join('\n')).digest('hex')
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

// AWS Signature V4 query-string signing (presigned GET). Returns the full URL.
function presign({ url, region, accessKey, secret, token, expires = 3600, date = new Date() }) {
  const u = new URL(url)
  const amz = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8)
  const scope = `${day}/${region}/s3/aws4_request`
  const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKey}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host', ...(token ? { 'X-Amz-Security-Token': token } : {}) }
  const request = ['GET', u.pathname, qs(query), `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amz, scope, sha(request)].join('\n')).digest('hex')
  return `${u.origin}${u.pathname}?${qs(query)}&X-Amz-Signature=${signature}`
}

// Files above this size are sent in parts (S3 multipart upload / Azure block list).
const PART = 64 * 1024 * 1024
const partsOf = (size, part) => Array.from({ length: Math.ceil(size / part) }, (_, i) => ({ n: i + 1, start: i * part, end: Math.min(size, (i + 1) * part) - 1 }))

// cfg: { url, region, bucket, virtualHost, partSize }, creds: { accessKey, secret, token }
function s3(config, creds) {
  const cfg = { ...config }
  let base = new URL(cfg.url)
  const basePath = base.pathname.replace(/\/+$/, '')
  const split = p => {
    const parts = p.split('/').filter(Boolean)
    return cfg.bucket ? { bucket: cfg.bucket, key: parts.join('/') } : { bucket: parts[0] || '', key: parts.slice(1).join('/') }
  }
  const partSize = cfg.partSize || PART
  // creds is either { accessKey, secret, token } or { get(): Promise<that> } for temporary credentials
  const cred = async () => typeof creds.get === 'function' ? creds.get() : creds
  // virtual-hosted: https://bucket.host/key (bucket listing keeps the bare endpoint); path-style: https://host/bucket/key
  const urlFor = (bucket, key, query = {}) => {
    const virtual = cfg.virtualHost && bucket
    const root = virtual ? `${base.protocol}//${bucket}.${base.host}${basePath}` : `${base.origin}${basePath}`
    return `${root}/${!virtual && bucket ? bucket + (key ? '/' + encPath(key) : '') : virtual && key ? encPath(key) : ''}${Object.keys(query).length ? '?' + qs(query) : ''}`
  }
  async function call(method, bucket, key, { query = {}, headers = {}, body, file, range } = {}, retried = false) {
    const url = urlFor(bucket, key, query), c = await cred()
    const span = file && (range || {})
    const payload = file ? await hashFile(file, span) : sha(body || '')
    const h = sign({ method, url, query, headers, payload, region: cfg.region, accessKey: c.accessKey, secret: c.secret, token: c.token })
    if (file) h['content-length'] = String(range ? range.end - range.start + 1 : (await fs.promises.stat(file)).size)
    else if (method === 'PUT' || method === 'POST') h['content-length'] = String(Buffer.byteLength(body || ''))
    const res = await request(method, url, h, file ? fs.createReadStream(file, span) : body, agentFor({ proxy: cfg.proxy }, base.protocol))
    // bucket in another region: S3 names it in x-amz-bucket-region; follow it once and remember it
    const region = res.headers['x-amz-bucket-region']
    if (!retried && region && region !== cfg.region && [301, 307, 400, 403].includes(res.statusCode)) {
      res.resume()
      cfg.region = region
      if (/^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(base.host)) base = new URL(`https://s3.${region}.amazonaws.com`)
      return call(method, bucket, key, { query, headers, body, file, range }, true)
    }
    return res
  }
  const ok = async (res, codes = [200, 204]) => {
    if (codes.includes(res.statusCode)) return res
    throw httpError(res.statusCode, (await readAll(res)).toString(), true)
  }
  const text = async (res, codes) => (await readAll(await ok(res, codes))).toString()
  const DIR = { dir: true }
  async function keys(bucket, prefix) {
    const out = []
    let token
    do {
      const q = { 'list-type': '2', prefix }
      if (token) q['continuation-token'] = token
      const xml = await text(await call('GET', bucket, '', { query: q }))
      out.push(...blocks(xml, 'Contents').map(c => val(c, 'Key')))
      token = val(xml, 'IsTruncated') === 'true' ? val(xml, 'NextContinuationToken') : undefined
    } while (token)
    return out
  }
  const copy = async (b, k, b2, k2) => {
    const xml = await text(await call('PUT', b2, k2, { headers: { 'x-amz-copy-source': `/${b}/${encPath(k)}` } }), [200])
    if (/<Error[\s>]/.test(xml)) throw httpError(500, xml, true)
  }
  const del = async (b, k) => { await text(await call('DELETE', b, k), [200, 204, 404]) }
  return {
    async ping() {
      const { bucket } = split('/')
      await text(await call('GET', bucket, '', { query: bucket ? { 'list-type': '2', 'max-keys': '1' } : {} }), [200])
    },
    async stat(p) {
      const { bucket, key } = split(p)
      if (!bucket || (!key && cfg.bucket)) return DIR
      if (!key) {
        const res = await call('HEAD', bucket, '')
        res.resume()
        if (res.statusCode === 200) return DIR
        throw res.statusCode === 404 ? notFound(p) : httpError(res.statusCode, '', true)
      }
      const res = await call('HEAD', bucket, key)
      res.resume()
      if (res.statusCode === 200) return { dir: false, size: +res.headers['content-length'] || 0, mtime: Date.parse(res.headers['last-modified']) || 0 }
      if (res.statusCode !== 404) throw httpError(res.statusCode, '', true)
      const xml = await text(await call('GET', bucket, '', { query: { 'list-type': '2', prefix: key + '/', 'max-keys': '1' } }))
      if (+val(xml, 'KeyCount') > 0) return DIR
      throw notFound(p)
    },
    async list(p) {
      const { bucket, key } = split(p)
      if (!bucket) return blocks(await text(await call('GET', '', '')), 'Bucket').map(b => ({ name: val(b, 'Name'), dir: true, mtime: Date.parse(val(b, 'CreationDate')) || 0 }))
      const prefix = key ? key + '/' : ''
      const out = []
      let token
      do {
        const q = { 'list-type': '2', delimiter: '/', prefix }
        if (token) q['continuation-token'] = token
        const xml = await text(await call('GET', bucket, '', { query: q }))
        for (const c of blocks(xml, 'Contents')) {
          const k = val(c, 'Key')
          if (k !== prefix) out.push({ name: k.slice(prefix.length), dir: false, size: +val(c, 'Size') || 0, mtime: Date.parse(val(c, 'LastModified')) || 0 })
        }
        for (const c of blocks(xml, 'CommonPrefixes')) out.push({ name: val(c, 'Prefix').slice(prefix.length, -1), dir: true })
        token = val(xml, 'IsTruncated') === 'true' ? val(xml, 'NextContinuationToken') : undefined
      } while (token)
      return out
    },
    async mkdir(p) {
      const { bucket, key } = split(p)
      if (!bucket) throw new Error('Select a bucket first')
      if (key) return void await text(await call('PUT', bucket, key + '/'))
      const body = cfg.region === 'us-east-1' ? undefined : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${cfg.region}</LocationConstraint></CreateBucketConfiguration>`
      await text(await call('PUT', bucket, '', { body }))
    },
    async remove(p, dir) {
      const { bucket, key } = split(p)
      if (!bucket) throw new Error('Select a bucket first')
      if (!key) return void await text(await call('DELETE', bucket, ''))
      await del(bucket, dir ? key + '/' : key)
    },
    async move(a, b) {
      const A = split(a), B = split(b)
      if (!A.key || !B.key) throw new Error('Buckets cannot be renamed')
      const st = await this.stat(a)
      for (const k of st.dir ? await keys(A.bucket, A.key + '/') : [A.key]) {
        await copy(A.bucket, k, B.bucket, st.dir ? B.key + '/' + k.slice(A.key.length + 1) : B.key)
        await del(A.bucket, k)
      }
    },
    async put(p, body) {
      const { bucket, key } = split(p)
      if (!key) throw new Error('Select a bucket first')
      await text(await call('PUT', bucket, key, { body }))
    },
    async putFile(p, file) {
      const { bucket, key } = split(p)
      if (!key) throw new Error('Select a bucket first')
      const size = (await fs.promises.stat(file)).size
      if (size <= partSize) return void await text(await call('PUT', bucket, key, { file }))
      const uploadId = val(await text(await call('POST', bucket, key, { query: { uploads: '' } })), 'UploadId')
      try {
        const etags = []
        for (const part of partsOf(size, partSize)) {
          const res = await ok(await call('PUT', bucket, key, { query: { partNumber: String(part.n), uploadId }, file, range: part }), [200])
          res.resume()
          etags.push(res.headers.etag)
        }
        const body = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
        const xml = await text(await call('POST', bucket, key, { query: { uploadId }, body }), [200])
        if (/<Error[\s>]/.test(xml)) throw httpError(500, xml, true)
      } catch (e) {
        await call('DELETE', bucket, key, { query: { uploadId } }).then(r => r.resume(), () => {})
        throw e
      }
    },
    async get(p, start = 0) {
      const { bucket, key } = split(p)
      return ok(await call('GET', bucket, key, start ? { headers: { range: `bytes=${start}-` } } : {}), [200, 206])
    },
    // Presigned GET URL (SigV4 allows at most 7 days)
    async link(p, seconds) {
      const { bucket, key } = split(p)
      if (!key) throw new Error('Select a file first')
      const c = await cred()
      return presign({ url: urlFor(bucket, key), region: cfg.region, accessKey: c.accessKey, secret: c.secret, token: c.token, expires: Math.min(Math.max(+seconds || 3600, 1), 604800) })
    },
  }
}

const AZ_VERSION = '2021-08-06'
const azError = (status, body) => {
  const code = val(body || '', 'Code'), msg = val(body || '', 'Message')
  const e = new Error(status === 401 || status === 403 || code === 'AuthenticationFailed' ? `Authentication failure${code ? ': ' + code : ''}` : `${code || 'HTTP ' + status}${msg ? ': ' + msg.split('\n')[0] : ''}`)
  e.code = status === 404 ? 'ENOENT' : 'EIO'
  e.status = status
  return e
}

// Requests to an Azure storage service: SharedKey, SAS or bearer-token authorization, optional proxy.
// creds.secret is the account key or a SAS token (?sv=...&sig=...); creds.tokenProvider supplies Microsoft Entra ID tokens.
function azureHttp(cfg, creds, { version = AZ_VERSION, headers: fixed = {} } = {}) {
  const base = new URL(cfg.url), basePath = base.pathname.replace(/\/+$/, '')
  const agent = agentFor({ proxy: cfg.proxy }, base.protocol)
  const sas = creds.secret && /(^|[?&])sig=/.test(creds.secret) ? new URLSearchParams(creds.secret.replace(/^\?/, '')) : null
  const urlOf = (container, key, query = {}) => {
    const u = new URL(`${base.origin}${basePath}/${container ? container + (key ? '/' + encPath(key) : '') : ''}`)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    if (sas) for (const [k, v] of sas) u.searchParams.set(k, v)
    return u
  }
  async function call(method, container, key, { query = {}, headers = {}, body, file, range } = {}) {
    const u = urlOf(container, key, query)
    const length = file ? (range ? range.end - range.start + 1 : (await fs.promises.stat(file)).size) : Buffer.byteLength(body || '')
    const h = { ...fixed, ...headers, 'x-ms-version': version, 'x-ms-date': new Date().toUTCString() }
    if (method === 'PUT' || method === 'POST') h['content-length'] = String(length)
    if (creds.tokenProvider) h.authorization = 'Bearer ' + await creds.tokenProvider.get()
    else if (!sas) {
      const xms = Object.keys(h).filter(k => k.startsWith('x-ms-')).sort().map(k => `${k}:${String(h[k]).trim()}\n`).join('')
      const params = Object.keys(query).sort().map(k => `\n${k.toLowerCase()}:${query[k]}`).join('')
      const toSign = [method, '', '', length ? String(length) : '', '', h['content-type'] || '', '', '', '', '', '', h.range || '', xms + `/${creds.account}${u.pathname}${params}`].join('\n')
      h.authorization = `SharedKey ${creds.account}:${crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(toSign, 'utf8').digest('base64')}`
    }
    const span = file && (range || {})
    return request(method, u.href, h, file ? fs.createReadStream(file, span) : body, agent)
  }
  return { base, basePath, sas, urlOf, call }
}

// Azure Blob Storage.
// cfg: { url, container, partSize }, creds: { account, secret | tokenProvider }
function azure(cfg, creds) {
  const partSize = cfg.partSize || PART
  const { sas, urlOf, call } = azureHttp(cfg, creds)
  const split = p => {
    const parts = p.split('/').filter(Boolean)
    return cfg.container ? { container: cfg.container, key: parts.join('/') } : { container: parts[0] || '', key: parts.slice(1).join('/') }
  }
  const ok = async (res, codes = [200, 201, 202]) => {
    if (codes.includes(res.statusCode)) return res
    throw azError(res.statusCode, (await readAll(res)).toString())
  }
  const text = async (res, codes) => (await readAll(await ok(res, codes))).toString()
  const done = async (res, codes) => void await text(res, codes)
  const DIR = { dir: true }
  const BLOB = { 'x-ms-blob-type': 'BlockBlob' }
  async function names(container, prefix, delimiter) {
    const out = []
    let marker
    do {
      const q = { restype: 'container', comp: 'list', prefix, ...(delimiter ? { delimiter } : {}), ...(marker ? { marker } : {}) }
      const xml = await text(await call('GET', container, '', { query: q }), [200])
      out.push(xml)
      marker = val(xml, 'NextMarker') || undefined
    } while (marker)
    return out
  }
  const blobKeys = async (container, prefix) => (await names(container, prefix)).flatMap(xml => blocks(xml, 'Blob').map(b => val(b, 'Name')))
  async function copy(c, k, c2, k2) {
    const src = urlOf(c, k).href
    const res = await ok(await call('PUT', c2, k2, { headers: { 'x-ms-copy-source': src } }), [202])
    res.resume()
    let status = res.headers['x-ms-copy-status']
    for (let i = 0; status === 'pending' && i < 600; i++) {
      await new Promise(r => setTimeout(r, 500))
      const head = await call('HEAD', c2, k2)
      head.resume()
      status = head.headers['x-ms-copy-status']
    }
    if (status && status !== 'success') throw new Error('Copy failed: ' + status)
  }
  return {
    async ping() {
      const { container } = split('/')
      if (container) await done(await call('GET', container, '', { query: { restype: 'container', comp: 'list', maxresults: '1' } }), [200])
      else await done(await call('GET', '', '', { query: { comp: 'list', maxresults: '1' } }), [200])
    },
    async stat(p) {
      const { container, key } = split(p)
      if (!container || (!key && cfg.container)) return DIR
      if (!key) {
        const res = await call('GET', container, '', { query: { restype: 'container', comp: 'list', maxresults: '1' } })
        res.resume()
        if (res.statusCode === 200) return DIR
        throw res.statusCode === 404 ? notFound(p) : azError(res.statusCode, '')
      }
      const res = await call('HEAD', container, key)
      res.resume()
      if (res.statusCode === 200) return { dir: false, size: +res.headers['content-length'] || 0, mtime: Date.parse(res.headers['last-modified']) || 0 }
      if (res.statusCode !== 404) throw azError(res.statusCode, '')
      const xml = await text(await call('GET', container, '', { query: { restype: 'container', comp: 'list', prefix: key + '/', maxresults: '1' } }), [200])
      if (blocks(xml, 'Blob').length) return DIR
      throw notFound(p)
    },
    async list(p) {
      const { container, key } = split(p)
      if (!container) {
        const out = []
        let marker
        do {
          const xml = await text(await call('GET', '', '', { query: { comp: 'list', ...(marker ? { marker } : {}) } }), [200])
          out.push(...blocks(xml, 'Container').map(c => ({ name: val(c, 'Name'), dir: true, mtime: Date.parse(val(c, 'Last-Modified')) || 0 })))
          marker = val(xml, 'NextMarker') || undefined
        } while (marker)
        return out
      }
      const prefix = key ? key + '/' : ''
      const out = []
      for (const xml of await names(container, prefix, '/')) {
        for (const b of blocks(xml, 'Blob')) {
          const k = val(b, 'Name')
          if (k !== prefix) out.push({ name: k.slice(prefix.length), dir: false, size: +val(b, 'Content-Length') || 0, mtime: Date.parse(val(b, 'Last-Modified')) || 0 })
        }
        for (const b of blocks(xml, 'BlobPrefix')) out.push({ name: val(b, 'Name').slice(prefix.length, -1), dir: true })
      }
      return out
    },
    async mkdir(p) {
      const { container, key } = split(p)
      if (!container) throw new Error('Select a container first')
      if (key) return done(await call('PUT', container, key + '/', { headers: BLOB }), [201])
      await done(await call('PUT', container, '', { query: { restype: 'container' } }), [201])
    },
    async remove(p, dir) {
      const { container, key } = split(p)
      if (!container) throw new Error('Select a container first')
      if (!key) return done(await call('DELETE', container, '', { query: { restype: 'container' } }), [202])
      await done(await call('DELETE', container, dir ? key + '/' : key), [202, 404])
    },
    async move(a, b) {
      const A = split(a), B = split(b)
      if (!A.key || !B.key) throw new Error('Containers cannot be renamed')
      const st = await this.stat(a)
      for (const k of st.dir ? await blobKeys(A.container, A.key + '/') : [A.key]) {
        await copy(A.container, k, B.container, st.dir ? B.key + '/' + k.slice(A.key.length + 1) : B.key)
        await done(await call('DELETE', A.container, k), [202, 404])
      }
    },
    async put(p, body) {
      const { container, key } = split(p)
      if (!key) throw new Error('Select a container first')
      await done(await call('PUT', container, key, { headers: BLOB, body }), [201])
    },
    async putFile(p, file) {
      const { container, key } = split(p)
      if (!key) throw new Error('Select a container first')
      const size = (await fs.promises.stat(file)).size
      if (size <= partSize) return done(await call('PUT', container, key, { headers: BLOB, file }), [201])
      const ids = []
      for (const part of partsOf(size, partSize)) {
        const id = Buffer.from(String(part.n).padStart(8, '0')).toString('base64')
        await done(await call('PUT', container, key, { query: { comp: 'block', blockid: id }, file, range: part }), [201])
        ids.push(id)
      }
      const body = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map(i => `<Latest>${i}</Latest>`).join('')}</BlockList>`
      await done(await call('PUT', container, key, { query: { comp: 'blocklist' }, body }), [201])
    },
    async get(p, start = 0) {
      const { container, key } = split(p)
      return ok(await call('GET', container, key, start ? { headers: { 'x-ms-range': `bytes=${start}-` } } : {}), [200, 206])
    },
    // Service SAS (read-only) signed with the account key; a SAS-token account just returns the blob URL with its token
    async link(p, seconds) {
      const { container, key } = split(p)
      if (!key) throw new Error('Select a file first')
      if (sas) return urlOf(container, key).href
      if (creds.account && creds.secret && !creds.token) {
        const se = new Date(Date.now() + (Math.max(+seconds || 3600, 1)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
        const fields = ['r', '', se, `/blob/${creds.account}/${container}/${key}`, '', '', '', AZ_VERSION, 'b', '', '', '', '', '', '', '']
        const sig = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(fields.join('\n'), 'utf8').digest('base64')
        return urlOf(container, key, { sv: AZ_VERSION, sr: 'b', sp: 'r', se, sig }).href
      }
      throw new Error('Shared links are not available with this sign-in method')
    },
  }
}

// Azure Files (REST): shares, directories and files, written in ranges of at most 4 MiB.
// cfg: { url, container (share), partSize }, creds: as azure()
function azureFiles(cfg, creds) {
  const RANGE = cfg.partSize || 4 * 1024 * 1024
  const { call } = azureHttp(cfg, creds, { version: '2022-11-02', headers: creds.tokenProvider ? { 'x-ms-file-request-intent': 'backup' } : {} })
  const split = p => {
    const parts = p.split('/').filter(Boolean)
    return cfg.container ? { share: cfg.container, key: parts.join('/') } : { share: parts[0] || '', key: parts.slice(1).join('/') }
  }
  // headers every file or directory creation needs from 2019-02-02 on
  const CREATE = { 'x-ms-file-permission': 'inherit', 'x-ms-file-attributes': 'None', 'x-ms-file-creation-time': 'now', 'x-ms-file-last-write-time': 'now' }
  const ok = async (res, codes) => {
    if (codes.includes(res.statusCode)) return res
    throw azError(res.statusCode, (await readAll(res)).toString())
  }
  const text = async (res, codes) => (await readAll(await ok(res, codes))).toString()
  const done = async (res, codes) => void await text(res, codes)
  const DIR = { dir: true }
  const info = r => ({ mtime: Date.parse(val(r, 'LastWriteTime') || val(r, 'Last-Modified')) || 0 })
  async function create(share, key, size) {
    await done(await call('PUT', share, key, { headers: { ...CREATE, 'x-ms-type': 'file', 'x-ms-content-length': String(size) } }), [201])
  }
  async function writeRange(share, key, start, data, file) {
    const end = start + (file ? file.end - file.start : data.length - 1)
    await done(await call('PUT', share, key, { query: { comp: 'range' }, headers: { 'x-ms-range': `bytes=${start}-${end}`, 'x-ms-write': 'update' }, body: data, file: file?.path, range: file && { start: file.start, end: file.end } }), [201])
  }
  return {
    async ping() {
      const { share } = split('/')
      if (share) await done(await call('GET', share, '', { query: { restype: 'share' } }), [200])
      else await done(await call('GET', '', '', { query: { comp: 'list', maxresults: '1' } }), [200])
    },
    async stat(p) {
      const { share, key } = split(p)
      if (!share || (!key && cfg.container)) return DIR
      if (!key) {
        const res = await call('GET', share, '', { query: { restype: 'share' } })
        res.resume()
        if (res.statusCode === 200) return DIR
        throw res.statusCode === 404 ? notFound(p) : azError(res.statusCode, '')
      }
      const file = await call('HEAD', share, key)
      file.resume()
      if (file.statusCode === 200) return { dir: false, size: +file.headers['content-length'] || 0, mtime: Date.parse(file.headers['last-modified']) || 0 }
      if (file.statusCode !== 404) throw azError(file.statusCode, '')
      const dir = await call('HEAD', share, key, { query: { restype: 'directory' } })
      dir.resume()
      if (dir.statusCode === 200) return { dir: true, mtime: Date.parse(dir.headers['last-modified']) || 0 }
      throw dir.statusCode === 404 ? notFound(p) : azError(dir.statusCode, '')
    },
    async list(p) {
      const { share, key } = split(p)
      const out = []
      let marker
      do {
        const query = share ? { restype: 'directory', comp: 'list', include: 'Timestamps', ...(marker ? { marker } : {}) } : { comp: 'list', ...(marker ? { marker } : {}) }
        const xml = await text(await call('GET', share, key, { query }), [200])
        if (!share) out.push(...blocks(xml, 'Share').map(b => ({ name: val(b, 'Name'), dir: true, ...info(b) })))
        else {
          for (const b of blocks(xml, 'File')) out.push({ name: val(b, 'Name'), dir: false, size: +val(b, 'Content-Length') || 0, ...info(b) })
          for (const b of blocks(xml, 'Directory')) out.push({ name: val(b, 'Name'), dir: true, ...info(b) })
        }
        marker = val(xml, 'NextMarker') || undefined
      } while (marker)
      return out
    },
    async mkdir(p) {
      const { share, key } = split(p)
      if (!share) throw new Error('Select a share first')
      if (!key) return done(await call('PUT', share, '', { query: { restype: 'share' } }), [201])
      await done(await call('PUT', share, key, { query: { restype: 'directory' }, headers: CREATE }), [201])
    },
    async remove(p, dir) {
      const { share, key } = split(p)
      if (!share) throw new Error('Select a share first')
      if (!key) return done(await call('DELETE', share, '', { query: { restype: 'share' } }), [202])
      await done(await call('DELETE', share, key, dir ? { query: { restype: 'directory' } } : {}), [202])
    },
    async move(a, b) {
      const A = split(a), B = split(b)
      if (!A.key || !B.key || A.share !== B.share) throw new Error('Only files and folders of the same share can be moved')
      await done(await call('PUT', B.share, B.key, { query: { comp: 'rename' }, headers: { 'x-ms-file-rename-source': `/${A.share}/${encPath(A.key)}` } }), [200])
    },
    async put(p, body) {
      const { share, key } = split(p)
      if (!key) throw new Error('Select a share first')
      const data = Buffer.from(body)
      await create(share, key, data.length)
      for (let at = 0; at < data.length; at += RANGE) await writeRange(share, key, at, data.subarray(at, at + RANGE))
    },
    async putFile(p, file) {
      const { share, key } = split(p)
      if (!key) throw new Error('Select a share first')
      const size = (await fs.promises.stat(file)).size
      await create(share, key, size)
      for (const part of partsOf(size, RANGE)) await writeRange(share, key, part.start, undefined, { path: file, start: part.start, end: part.end })
    },
    async get(p, start = 0) {
      const { share, key } = split(p)
      return ok(await call('GET', share, key, start ? { headers: { 'x-ms-range': `bytes=${start}-` } } : {}), [200, 206])
    },
  }
}

// RFC 7616 / 2617 Digest response. challenge: { realm, nonce, opaque, qop, algorithm }
function digestHeader(challenge, { user, pass, method, uri, nc, cnonce }) {
  const alg = (challenge.algorithm || 'MD5').toUpperCase(), hash = alg.startsWith('SHA-256') ? 'sha256' : 'md5'
  const H = x => crypto.createHash(hash).update(x).digest('hex')
  let ha1 = H(`${user}:${challenge.realm}:${pass}`)
  if (alg.endsWith('-SESS')) ha1 = H(`${ha1}:${challenge.nonce}:${cnonce}`)
  const ha2 = H(`${method}:${uri}`)
  const qop = challenge.qop ? (challenge.qop.split(',').map(x => x.trim()).includes('auth') ? 'auth' : '') : ''
  const response = qop ? H(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${challenge.nonce}:${ha2}`)
  const q = v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`
  return `Digest username=${q(user)}, realm=${q(challenge.realm)}, nonce=${q(challenge.nonce)}, uri=${q(uri)}, algorithm=${alg}, response=${q(response)}${challenge.opaque ? `, opaque=${q(challenge.opaque)}` : ''}${qop ? `, qop=auth, nc=${nc}, cnonce=${q(cnonce)}` : ''}`
}
// Strongest Digest challenge among the WWW-Authenticate headers (SHA-256 before MD5), or null
function parseDigest(headers) {
  const found = []
  for (const h of [].concat(headers || [])) {
    if (!/^\s*Digest\s/i.test(h)) continue
    const c = {}
    for (const m of h.replace(/^\s*Digest\s+/i, '').matchAll(/(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) c[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1')
    if (c.realm && c.nonce) found.push(c)
  }
  return found.sort((x, y) => /sha-256/i.test(y.algorithm || '') - /sha-256/i.test(x.algorithm || ''))[0] || null
}

// cfg: { url, proxy, insecureTls, authMethod: 'auto' | 'basic' | 'digest' | 'bearer' }, creds: { user, secret } (secret = password or bearer token)
function dav(cfg, creds) {
  const base = new URL(cfg.url), basePath = base.pathname.replace(/\/+$/, '')
  const agent = agentFor({ proxy: cfg.proxy, insecure: cfg.insecureTls }, base.protocol)
  const baseDecoded = decodeURIComponent(basePath)
  const basic = 'Basic ' + Buffer.from(`${creds.user}:${creds.secret}`).toString('base64')
  const urlOf = p => base.origin + basePath + (p === '/' ? '' : encPath(p))
  // Scheme in use: preemptive for basic and bearer; with auto and digest the first 401 decides (credentials are never sent before the server asks)
  let scheme = cfg.authMethod === 'basic' ? 'basic' : cfg.authMethod === 'bearer' ? 'bearer' : null, challenge = null, nc = 0
  const authFor = (method, url) => {
    if (scheme === 'basic') return basic
    if (scheme === 'bearer') return 'Bearer ' + creds.secret
    if (scheme === 'digest') {
      const u = new URL(url)
      return digestHeader(challenge, { user: creds.user, pass: creds.secret, method, uri: u.pathname + u.search, nc: String(++nc).padStart(8, '0'), cnonce: crypto.randomBytes(8).toString('hex') })
    }
  }
  async function call(method, p, { headers = {}, body, file } = {}) {
    let url = urlOf(p), retried = false
    for (let hops = 0; hops < 6; hops++) {
      const h = { ...headers }
      const a = authFor(method, url)
      if (a) h.authorization = a
      if (file) h['content-length'] = String(fs.statSync(file).size)
      else if (method === 'PUT') h['content-length'] = String(Buffer.byteLength(body || ''))
      const res = await request(method, url, h, file ? fs.createReadStream(file) : body, agent)
      if (res.statusCode === 401 && !retried && cfg.authMethod !== 'bearer') {
        const offered = [].concat(res.headers['www-authenticate'] || [])
        const d = cfg.authMethod === 'basic' ? null : parseDigest(offered)
        const next = d ? 'digest' : !offered.length || offered.some(x => /^\s*Basic/i.test(x)) ? 'basic' : null // a 401 without a challenge: assume Basic
        if (next && (next !== scheme || d && (d.stale === 'true' || d.nonce !== challenge?.nonce))) {
          res.resume(); retried = true; scheme = next; challenge = d; nc = 0
          continue
        }
      }
      // same-origin redirects only: credentials must not follow a redirect to another host
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const to = new URL(res.headers.location, url)
        if (to.origin === base.origin) { res.resume(); url = to.href; continue }
      }
      return res
    }
    throw new Error('Too many redirects')
  }
  const ok = async (res, codes) => {
    if (codes.includes(res.statusCode)) return res
    await readAll(res)
    throw res.statusCode === 404 ? notFound('') : httpError(res.statusCode, '')
  }
  const PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
  async function propfind(p, depth) {
    const res = await ok(await call('PROPFIND', p, { headers: { depth, 'content-type': 'application/xml' }, body: PROPFIND }), [207])
    return blocks((await readAll(res)).toString(), 'response').map(r => {
      const href = decodeURIComponent(new URL(val(r, 'href').trim(), base).pathname)
      const rel = (href.startsWith(baseDecoded) ? href.slice(baseDecoded.length) : href).replace(/\/+$/, '') || '/'
      return { path: rel, dir: /<(?:[\w-]+:)?collection\b/.test(r), size: +val(r, 'getcontentlength') || 0, mtime: Date.parse(val(r, 'getlastmodified')) || 0 }
    })
  }
  const done = async (p, method, codes, opts) => void await readAll(await ok(await call(method, p, opts), codes))
  return {
    ping: () => propfind('/', '0').then(() => {}),
    async stat(p) {
      const e = (await propfind(p, '0'))[0]
      if (!e) throw notFound(p)
      return e
    },
    async list(p) {
      return (await propfind(p, '1')).filter(e => posix.dirname(e.path) === p && e.path !== p).map(e => ({ ...e, name: posix.basename(e.path) }))
    },
    mkdir: p => done(p, 'MKCOL', [201]),
    remove: p => done(p, 'DELETE', [200, 202, 204]),
    move: (a, b) => done(a, 'MOVE', [201, 204], { headers: { destination: urlOf(b), overwrite: 'F' } }),
    put: (p, body) => done(p, 'PUT', [200, 201, 204], { body }),
    putFile: (p, file) => done(p, 'PUT', [200, 201, 204], { file }),
    async get(p, start = 0) { return ok(await call('GET', p, start ? { headers: { range: `bytes=${start}-` } } : {}), [200, 206]) },
  }
}

const cbify = fn => (...a) => { const done = a.pop(); fn(...a).then(v => done(null, v), done) }
const attrs = e => ({ size: e.size || 0, mtime: Math.floor((e.mtime || 0) / 1000), mode: (e.dir ? 0o40000 : 0o100000) | (e.mode ?? (e.dir ? 0o755 : 0o644)), uid: 0, gid: 0, isDirectory: () => !!e.dir, isFile: () => !e.dir, isSymbolicLink: () => false })

function sftpOver(be) {
  const stat = cbify(async p => attrs(await be.stat(norm(p))))
  return {
    end: () => be.close?.(),
    realpath: cbify(async p => norm(p)),
    stat,
    lstat: stat,
    // longname follows the `ls -l` layout (owner and group in columns 3 and 4) when the server reports them
    readdir: cbify(async p => (await be.list(norm(p))).map(e => ({ filename: e.name, longname: e.user ? `${e.dir ? 'd' : '-'}--------- 1 ${e.user} ${e.group || e.user} ${e.size || 0} Jan 1 00:00 ${e.name}` : '', attrs: attrs(e) }))),
    ...(be.chmod ? { chmod: cbify((p, mode) => be.chmod(norm(p), mode)) } : {}),
    ...(be.link ? { link: (p, seconds) => be.link(norm(p), seconds) } : {}),
    mkdir: cbify(p => be.mkdir(norm(p))),
    rmdir: cbify(p => be.remove(norm(p), true)),
    unlink: cbify(p => be.remove(norm(p), false)),
    rename: cbify((a, b) => be.move(norm(a), norm(b))),
    writeFile(p, data, opts, cb) {
      if (!cb) { cb = opts; opts = {} }
      ;(async () => {
        if (opts.flag === 'wx' && await be.stat(norm(p)).then(() => true, () => false)) throw Object.assign(new Error('File exists: ' + p), { code: 'EEXIST' })
        await be.put(norm(p), Buffer.from(data))
      })().then(() => cb(null), cb)
    },
    fastGet: cbify(async (remote, local) => pipeline(await be.get(norm(remote)), fs.createWriteStream(local))),
    fastPut: cbify((local, remote) => be.putFile(norm(remote), local)),
    // opts.start: byte offset (resume). Backends that cannot start mid-file are not asked to (see canResume)
    createReadStream(p, opts = {}) {
      const out = new PassThrough()
      be.get(norm(p), opts.start || 0).then(res => { res.on('error', e => out.destroy(e)); res.pipe(out) }, e => out.destroy(e))
      return out
    },
    // continuing a transfer: reads can restart anywhere; writes only where the backend appends to a partial file
    canResume: { read: true, write: !!be.resumableWrite },
    // Backends that can stream (FTP) upload as the data arrives; the others need a known size,
    // so the stream is staged in a temp file and sent on finish.
    createWriteStream(p, opts = {}) {
      if (be.putStream) {
        const pass = new PassThrough()
        const sent = be.putStream(norm(p), pass, opts.start || 0)
        sent.catch(() => {})
        const w = new Writable({
          write: (chunk, _, next) => pass.write(chunk) ? next() : pass.once('drain', next),
          final: cb => { pass.end(); sent.then(() => cb(), cb) },
          destroy: (e, cb) => { pass.destroy(e || undefined); cb(e) },
        })
        sent.catch(e => w.destroy(e))
        return w
      }
      const tmp = path.join(os.tmpdir(), 'cyberdog-up-' + crypto.randomUUID())
      const f = fs.createWriteStream(tmp)
      const cleanup = () => fs.rm(tmp, { force: true }, () => {})
      const w = new Writable({
        write: (chunk, _, next) => f.write(chunk) ? next() : f.once('drain', next),
        final: cb => f.end(async () => { try { await be.putFile(norm(p), tmp); cb() } catch (e) { cb(e) } finally { cleanup() } }),
        destroy: (e, cb) => { f.destroy(); cleanup(); cb(e) },
      })
      f.on('error', e => w.destroy(e))
      return w
    },
  }
}

const DRIVES = ['dropbox', 'onedrive', 'gdrive']
const azureCreds = (server, secret, extra) => server.azureAuth === 'entra'
  ? { account: server.user, tokenProvider: require('./azure-credentials').entraToken({ tenant: server.tenant, clientId: server.clientId, secret, onDeviceCode: extra.onDeviceCode, ...extra.azure }) }
  : { account: server.user, secret }

async function backendFor(server, secret, extra, proxy) {
  switch (server.type) {
    case 's3': {
      const cfg = { url: server.url, region: server.region || 'us-east-1', bucket: server.bucket || '', virtualHost: !!server.virtualHost, proxy }
      return s3(cfg, server.profile ? require('./aws-credentials').awsCredentials(server.profile, extra.aws) : { accessKey: server.user, secret, token: extra.token })
    }
    case 'azure': return azure({ url: server.url, container: server.bucket || '', proxy }, azureCreds(server, secret, extra))
    case 'azurefiles': return azureFiles({ url: server.url, container: server.bucket || '', proxy }, azureCreds(server, secret, extra))
    case 'ftp': return require('./ftp-storage').ftp({ host: server.host, port: server.port, security: server.security, insecureTls: server.insecureTls, proxy }, { user: server.user, secret })
    case 'dropbox': case 'onedrive': case 'gdrive': {
      const { authorize, tokenSource } = require('./oauth'), drives = require('./cloud-drives')
      const provider = drives.providerFor(server, extra.oauth), built = drives.BUILT_IN[server.type]
      const app = { clientId: server.clientId || built.clientId, clientSecret: extra.token || built.clientSecret }
      const agent = agentFor({ proxy }, 'https:')
      let refresh = secret, first
      if (!refresh) { // first connection: sign in through the browser, then remember the refresh token
        if (!extra.openUrl) throw new Error('Authentication failure: sign-in required')
        first = await authorize(provider, app, extra.openUrl, agent)
        refresh = first.refreshToken
        extra.onRefreshToken?.(refresh)
      }
      return drives[server.type]({ proxy, ...extra.drive }, tokenSource(provider, app, refresh, { onRefreshToken: extra.onRefreshToken, first, agent }))
    }
    case 'smb': return require('./smb-storage').smb({ host: server.host, port: server.port, share: server.bucket || '', domain: server.domain, proxy }, { user: server.user, secret })
    default: return dav({ url: server.url, proxy, insecureTls: server.insecureTls, authMethod: server.authMethod }, { user: server.user, secret })
  }
}

// server: the saved server record; secret: password / secret key / account key / refresh token
// extra: { token } (S3 session token, Google client secret), { proxyPass }, { aws } (awsCredentials options),
//        { onDeviceCode, azure } (Entra ID sign-in), { openUrl, onRefreshToken, oauth, drive } (OAuth drives)
async function open(server, secret, extra = {}) {
  const keyless = (server.type === 's3' && server.profile) || ((server.type === 'azure' || server.type === 'azurefiles') && server.azureAuth === 'entra') || DRIVES.includes(server.type)
  if (!secret && !keyless) throw new Error('Authentication failure: credentials required')
  const proxy = server.proxyType && server.proxyType !== 'none' ? { type: server.proxyType, host: server.proxyHost, port: +server.proxyPort, user: server.proxyUser, pass: extra.proxyPass } : undefined
  const be = await backendFor(server, secret, extra, proxy)
  await be.ping()
  return sftpOver(be)
}

module.exports = { open, sftpOver, backendFor, partsOf, s3, azure, azureFiles, dav, sign, presign, digestHeader, parseDigest, request, readAll, blocks, val, sha }
