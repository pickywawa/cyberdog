// Dropbox, OneDrive (Microsoft Graph) and Google Drive behind the same backend interface as the other protocols
// (ping, stat, list, mkdir, remove, move, put, putFile, get). Sign-in is OAuth 2.0 (see oauth.js).
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const posix = path.posix
const { request, readAll, partsOf } = require('./object-storage')
const { agentFor } = require('./proxy')

// Application registrations are the maintainer's to make (public clients, PKCE): fill these in, or let each user
// enter the client ID of their own application in the server form. Dropbox needs http://localhost:53682/callback registered.
const BUILT_IN = { dropbox: { clientId: '' }, onedrive: { clientId: '' }, gdrive: { clientId: '', clientSecret: '' } }
const PROVIDERS = {
  dropbox: { authUrl: 'https://www.dropbox.com/oauth2/authorize', tokenUrl: 'https://api.dropboxapi.com/oauth2/token', scope: '', params: { token_access_type: 'offline' }, port: 53682 },
  onedrive: tenant => ({ authUrl: `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/token`, scope: 'Files.ReadWrite offline_access', refreshScope: 'Files.ReadWrite offline_access' }),
  gdrive: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/drive', params: { access_type: 'offline', prompt: 'consent' } },
}
const providerFor = (server, override) => ({ ...(typeof PROVIDERS[server.type] === 'function' ? PROVIDERS[server.type](server.tenant) : PROVIDERS[server.type]), ...override })

const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const encPath = p => p.split('/').map(enc).join('/')
const notFound = p => Object.assign(new Error('No such file: ' + p), { code: 'ENOENT', status: 404 })
const exists = p => Object.assign(new Error('File exists: ' + p), { code: 'EEXIST' })
const ascii = s => s.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

function apiError(status, text) {
  let j = {}
  try { j = JSON.parse(text) } catch {}
  const msg = j.error_summary || j.error?.message || (typeof j.error === 'string' ? j.error : '') || 'HTTP ' + status
  const e = new Error(status === 401 ? 'Authentication failure: ' + msg : msg)
  e.status = status
  e.code = status === 404 || /not_found/.test(msg) ? 'ENOENT' : status === 401 ? 'EACCES' : 'EIO'
  return e
}

// Authenticated HTTP for the drive APIs: bearer token, JSON bodies, one retry on throttling.
function client(token, agent) {
  async function send(method, url, { headers = {}, body, file, range, auth = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const h = { ...headers }
      if (auth) h.authorization = 'Bearer ' + await token.get()
      let data = body
      if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') { data = JSON.stringify(body); h['content-type'] ??= 'application/json' }
      if (file) h['content-length'] = String(range ? range.end - range.start + 1 : (await fs.promises.stat(file)).size)
      else if (data !== undefined) h['content-length'] = String(Buffer.byteLength(data))
      else if (method === 'POST' || method === 'PUT' || method === 'PATCH') h['content-length'] = '0'
      const res = await request(method, url, h, file ? fs.createReadStream(file, range ? { start: range.start, end: range.end } : {}) : data, agent)
      if ((res.statusCode === 429 || res.statusCode === 503) && attempt < 3) { res.resume(); await new Promise(r => setTimeout(r, Math.min(+res.headers['retry-after'] || 1, 5) * 1000)); continue }
      return res
    }
  }
  // JSON (or empty) response
  async function json(res, codes = [200]) {
    const text = (await readAll(res)).toString()
    if (!codes.includes(res.statusCode)) throw apiError(res.statusCode, text)
    return text ? JSON.parse(text) : null
  }
  const ok = async (res, codes) => { if (codes.includes(res.statusCode)) return res; throw apiError(res.statusCode, (await readAll(res)).toString()) }
  return { send, json, ok }
}

// ---------- Dropbox ----------
function dropbox(cfg, token) {
  const { send, json, ok } = client(token, agentFor({ proxy: cfg.proxy }, 'https:'))
  const api = cfg.api || 'https://api.dropboxapi.com', content = cfg.content || 'https://content.dropboxapi.com'
  const CHUNK = cfg.partSize || 32 * 1024 * 1024, SINGLE = cfg.singleMax || 100 * 1024 * 1024
  const rpc = async (name, args) => json(await send('POST', `${api}/2/${name}`, { body: args }))
  const dp = p => p === '/' ? '' : p
  const arg = a => ({ 'dropbox-api-arg': ascii(JSON.stringify(a)), 'content-type': 'application/octet-stream' })
  const entry = e => ({ name: e.name, dir: e['.tag'] === 'folder', size: e.size || 0, mtime: Date.parse(e.server_modified || e.client_modified) || 0 })
  const commit = p => ({ path: dp(p), mode: 'overwrite', mute: true })
  async function upload(p, opts) {
    await json(await send('POST', `${content}/2/files/upload`, { headers: arg(commit(p)), ...opts }))
  }
  return {
    ping: () => rpc('users/get_current_account').then(() => {}),
    async stat(p) {
      if (p === '/') return { dir: true }
      try { return entry(await rpc('files/get_metadata', { path: dp(p) })) } catch (e) { throw e.code === 'ENOENT' ? notFound(p) : e }
    },
    async list(p) {
      const out = []
      let r = await rpc('files/list_folder', { path: dp(p), limit: 2000 })
      for (;;) {
        out.push(...r.entries.map(entry))
        if (!r.has_more) return out
        r = await rpc('files/list_folder/continue', { cursor: r.cursor })
      }
    },
    mkdir: p => rpc('files/create_folder_v2', { path: dp(p), autorename: false }).then(() => {}),
    remove: p => rpc('files/delete_v2', { path: dp(p) }).then(() => {}),
    move: (a, b) => rpc('files/move_v2', { from_path: dp(a), to_path: dp(b), autorename: false }).then(() => {}),
    put: (p, body) => upload(p, { body: Buffer.from(body) }),
    async putFile(p, file) {
      const size = (await fs.promises.stat(file)).size
      if (size <= SINGLE) return upload(p, { file })
      const start = await json(await send('POST', `${content}/2/files/upload_session/start`, { headers: arg({ close: false }), body: Buffer.alloc(0) }))
      const parts = partsOf(size, CHUNK)
      for (const part of parts) {
        const cursor = { session_id: start.session_id, offset: part.start }
        if (part === parts.at(-1)) await json(await send('POST', `${content}/2/files/upload_session/finish`, { headers: arg({ cursor, commit: commit(p) }), file, range: part }))
        else await ok(await send('POST', `${content}/2/files/upload_session/append_v2`, { headers: arg({ cursor, close: false }), file, range: part }), [200]).then(r => r.resume())
      }
    },
    async get(p, start = 0) {
      const res = await send('POST', `${content}/2/files/download`, { headers: { ...arg({ path: dp(p) }), ...(start ? { range: `bytes=${start}-` } : {}) } })
      return ok(res, [200, 206])
    },
  }
}

// ---------- OneDrive (Microsoft Graph, personal and work accounts) ----------
function onedrive(cfg, token) {
  const agent = agentFor({ proxy: cfg.proxy }, 'https:')
  const { send, json, ok } = client(token, agent)
  const g = cfg.api || 'https://graph.microsoft.com/v1.0'
  const SMALL = 4 * 1024 * 1024, CHUNK = cfg.partSize || 10 * 1024 * 1024 // chunks must be multiples of 320 KiB
  const item = p => p === '/' ? `${g}/me/drive/root` : `${g}/me/drive/root:${encPath(p)}`
  const kids = p => p === '/' ? `${g}/me/drive/root/children` : `${item(p)}:/children`
  const SELECT = '$select=name,size,lastModifiedDateTime,folder,file'
  const entry = e => ({ name: e.name, dir: !!e.folder, size: e.size || 0, mtime: Date.parse(e.lastModifiedDateTime) || 0 })
  const check = (res, p, codes) => res.statusCode === 404 ? readAll(res).then(() => { throw notFound(p) }) : json(res, codes)
  return {
    ping: async () => void await json(await send('GET', `${g}/me/drive?$select=id`)),
    async stat(p) { return entry(await check(await send('GET', `${item(p)}?${SELECT}`), p, [200])) },
    async list(p) {
      const out = []
      let url = `${kids(p)}?$top=200&${SELECT}`
      while (url) {
        const r = await check(await send('GET', url), p, [200])
        out.push(...r.value.map(entry))
        url = r['@odata.nextLink']
      }
      return out
    },
    async mkdir(p) { await json(await send('POST', kids(posix.dirname(p)), { body: { name: posix.basename(p), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } }), [201]) },
    async remove(p) { await ok(await send('DELETE', item(p)), [204]).then(r => r.resume()) },
    async move(a, b) {
      const parent = posix.dirname(b)
      await json(await send('PATCH', item(a), { body: { name: posix.basename(b), parentReference: { path: '/drive/root:' + (parent === '/' ? '' : parent) } } }))
    },
    async put(p, body) {
      const data = Buffer.from(body)
      if (data.length <= SMALL) return void await json(await send('PUT', `${item(p)}:/content`, { body: data, headers: { 'content-type': 'application/octet-stream' } }), [200, 201])
      return this.putBuffer(p, data)
    },
    async putFile(p, file) {
      const size = (await fs.promises.stat(file)).size
      if (size <= SMALL) return void await json(await send('PUT', `${item(p)}:/content`, { file, headers: { 'content-type': 'application/octet-stream' } }), [200, 201])
      const session = await json(await send('POST', `${item(p)}:/createUploadSession`, { body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } }))
      for (const part of partsOf(size, CHUNK)) {
        const res = await send('PUT', session.uploadUrl, { auth: false, file, range: part, headers: { 'content-range': `bytes ${part.start}-${part.end}/${size}` } })
        await json(res, [200, 201, 202])
      }
    },
    async putBuffer(p, data) {
      const session = await json(await send('POST', `${item(p)}:/createUploadSession`, { body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } }))
      for (let at = 0; at < data.length; at += CHUNK) {
        const chunk = data.subarray(at, at + CHUNK)
        await json(await send('PUT', session.uploadUrl, { auth: false, body: chunk, headers: { 'content-range': `bytes ${at}-${at + chunk.length - 1}/${data.length}` } }), [200, 201, 202])
      }
    },
    // /content answers 302 to a pre-authenticated URL that must be fetched without the bearer token
    async get(p, start = 0) {
      let res = await send('GET', `${item(p)}:/content`)
      if (res.statusCode === 302 || res.statusCode === 301) { res.resume(); res = await send('GET', res.headers.location, { auth: false, headers: start ? { range: `bytes=${start}-` } : {} }) }
      else if (res.statusCode === 404) throw notFound(p)
      return ok(res, [200, 206])
    },
  }
}

// ---------- Google Drive ----------
const FOLDER = 'application/vnd.google-apps.folder'
const EXPORTS = { 'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.google-apps.drawing': 'application/pdf' }
const quote = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function gdrive(cfg, token) {
  const { send, json, ok } = client(token, agentFor({ proxy: cfg.proxy }, 'https:'))
  const api = cfg.api || 'https://www.googleapis.com/drive/v3', up = cfg.upload || 'https://www.googleapis.com/upload/drive/v3'
  const SMALL = 5 * 1024 * 1024, CHUNK = cfg.partSize || 8 * 1024 * 1024 // resumable chunks: multiples of 256 KiB
  const FIELDS = 'id,name,mimeType,size,modifiedTime'
  const cache = new Map([['/', { id: 'root', dir: true }]])
  const norm = e => ({ id: e.id, name: e.name, mime: e.mimeType, dir: e.mimeType === FOLDER, size: +e.size || 0, mtime: Date.parse(e.modifiedTime) || 0 })
  const forget = p => { for (const k of [...cache.keys()]) if (k !== '/' && (k === p || k.startsWith(p + '/'))) cache.delete(k) }
  const files = async query => {
    const out = []
    let pageToken
    do {
      const r = await json(await send('GET', `${api}/files?${new URLSearchParams({ q: query, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) })}`))
      out.push(...r.files.map(norm))
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }
  const childOf = async (parentId, name) => (await files(`name = ${quote(name)} and ${quote(parentId)} in parents and trashed = false`))[0]
  async function resolve(p) {
    if (cache.has(p)) return cache.get(p)
    const parent = await resolve(posix.dirname(p))
    const found = await childOf(parent.id, posix.basename(p))
    if (!found) throw notFound(p)
    cache.set(p, found)
    return found
  }
  async function create(p, mime, extra = {}) {
    const parent = await resolve(posix.dirname(p))
    return { parent, meta: { name: posix.basename(p), parents: [parent.id], ...(mime ? { mimeType: mime } : {}), ...extra } }
  }
  async function writeContent(p, size, media) {
    const existing = await resolve(p).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    const { meta } = existing ? { meta: {} } : await create(p)
    if (size <= SMALL) {
      const data = await media(0, size - 1)
      if (existing) return void await json(await send('PATCH', `${up}/files/${existing.id}?uploadType=media&fields=id`, { body: data, headers: { 'content-type': 'application/octet-stream' } }))
      const boundary = 'cd' + crypto.randomBytes(12).toString('hex')
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)])
      const r = await json(await send('POST', `${up}/files?uploadType=multipart&fields=${FIELDS}`, { body, headers: { 'content-type': `multipart/related; boundary=${boundary}` } }))
      return void cache.set(p, norm(r))
    }
    const start = await send(existing ? 'PATCH' : 'POST', `${up}/files${existing ? '/' + existing.id : ''}?uploadType=resumable&fields=${FIELDS}`, { body: meta, headers: { 'x-upload-content-length': String(size) } })
    await ok(start, [200]).then(r => r.resume())
    const session = start.headers.location
    for (const part of partsOf(size, CHUNK)) {
      const res = await send('PUT', session, { auth: false, body: await media(part.start, part.end), headers: { 'content-range': `bytes ${part.start}-${part.end}/${size}` } })
      if (res.statusCode === 308) { res.resume(); continue }
      const r = await json(res, [200, 201])
      if (!existing) cache.set(p, norm(r))
    }
  }
  return {
    ping: async () => void await json(await send('GET', `${api}/about?fields=user`)),
    async stat(p) { const e = await resolve(p); return { dir: e.dir, size: e.size, mtime: e.mtime } },
    async list(p) {
      const d = await resolve(p)
      if (!d.dir) throw Object.assign(new Error('Not a directory: ' + p), { code: 'ENOTDIR' })
      const out = await files(`${quote(d.id)} in parents and trashed = false`)
      for (const e of out) cache.set(posix.join(p, e.name), e)
      return out
    },
    async mkdir(p) {
      if (await resolve(p).then(() => true, () => false)) throw exists(p)
      const { meta } = await create(p, FOLDER)
      cache.set(p, norm(await json(await send('POST', `${api}/files?fields=${FIELDS}`, { body: meta }))))
    },
    async remove(p) { const e = await resolve(p); await json(await send('PATCH', `${api}/files/${e.id}?fields=id`, { body: { trashed: true } })); forget(p) },
    async move(a, b) {
      const e = await resolve(a), from = await resolve(posix.dirname(a)), to = await resolve(posix.dirname(b))
      await json(await send('PATCH', `${api}/files/${e.id}?${new URLSearchParams({ addParents: to.id, removeParents: from.id, fields: 'id' })}`, { body: { name: posix.basename(b) } }))
      forget(a); forget(b)
    },
    put: (p, body) => writeContent(p, Buffer.from(body).length, async (a, b) => Buffer.from(body).subarray(a, b + 1)),
    async putFile(p, file) {
      const size = (await fs.promises.stat(file)).size
      await writeContent(p, size, async (a, b) => {
        const fd = await fs.promises.open(file, 'r')
        try { const buf = Buffer.alloc(b - a + 1); await fd.read(buf, 0, buf.length, a); return buf } finally { await fd.close() }
      })
    },
    async get(p, start = 0) {
      const e = await resolve(p)
      if (e.dir) throw Object.assign(new Error('Is a directory: ' + p), { code: 'EISDIR' })
      const url = EXPORTS[e.mime] ? `${api}/files/${e.id}/export?mimeType=${enc(EXPORTS[e.mime])}` : `${api}/files/${e.id}?alt=media`
      return ok(await send('GET', url, { headers: start ? { range: `bytes=${start}-` } : {} }), [200, 206])
    },
  }
}

module.exports = { BUILT_IN, PROVIDERS, providerFor, dropbox, onedrive, gdrive }
