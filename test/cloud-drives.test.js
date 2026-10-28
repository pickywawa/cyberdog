// Dropbox, OneDrive and Google Drive backends and the OAuth (PKCE, loopback, refresh) flow against in-memory mocks of the
// parts of each API that the backends use. No real account was available: the mocks follow the providers' documentation.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { open } = require('../src/object-storage')
const { authorize, tokenSource } = require('../src/oauth')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const get = url => new Promise((ok, ko) => http.get(url, res => { const b = []; res.on('data', c => b.push(c)).on('end', () => ok({ status: res.statusCode, body: Buffer.concat(b).toString() })) }).on('error', ko))
const sha = x => crypto.createHash('sha256').update(x).digest('base64url')
const tmp = path.join(os.tmpdir(), 'cd-drive-' + process.pid)
const text = async stream => { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c).toString() }
const range = (req, buf) => { const m = /bytes=(\d+)-/.exec(req.headers.range || ''); return m ? [206, buf.subarray(+m[1])] : [200, buf] }

;(async () => {
  let ACCESS = 'access-1', refreshCount = 0, challenge = null
  const valid = new Set() // every access token issued stays valid, as with the real providers
  const rtoken = { current: 'refresh-1' }
  const read = req => new Promise(ok => { const c = []; req.on('data', x => c.push(x)).on('end', () => ok(Buffer.concat(c))) })
  const ctx = { dropbox: new Map(), onedrive: new Map(), gdrive: [] }

  // ---- one server for the token endpoint and the three APIs ----
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), body = await read(req), json = (o, status = 200, headers = {}) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(JSON.stringify(o)) }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body.toString())
      if (p.get('grant_type') === 'authorization_code') {
        if (sha(p.get('code_verifier')) !== challenge || p.get('code') !== 'the-code') return json({ error: 'invalid_grant' }, 400)
        valid.add(ACCESS); return json({ access_token: ACCESS, refresh_token: rtoken.current, expires_in: 1 })
      }
      if (p.get('refresh_token') !== rtoken.current) return json({ error: 'invalid_grant', error_description: 'bad refresh token' }, 400)
      refreshCount++; ACCESS = 'access-' + (refreshCount + 1); rtoken.current = 'refresh-' + (refreshCount + 1); valid.add(ACCESS)
      return json({ access_token: ACCESS, refresh_token: rtoken.current, expires_in: 3600 })
    }
    // pre-authenticated download/upload URLs carry no bearer token
    if (u.pathname.startsWith('/dl/')) { assert(!req.headers.authorization); const f = ctx.onedrive.get(decodeURIComponent(u.pathname.slice(4))); const [st, b] = range(req, f); res.statusCode = st; return res.end(b) }
    if (u.pathname.startsWith('/odsession/')) {
      assert(!req.headers.authorization)
      const [, a, z, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range'])
      const key = decodeURIComponent(u.pathname.slice(10)), prev = ctx.onedrive.get(key) || Buffer.alloc(0)
      assert.strictEqual(prev.length, +a); assert.strictEqual(body.length, +z - +a + 1)
      ctx.onedrive.set(key, Buffer.concat([prev, body]))
      return json({}, +z + 1 === +total ? 201 : 202)
    }
    if (u.pathname.startsWith('/gsession')) {
      assert(!req.headers.authorization)
      const [, a, z, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range'])
      const s = ctx.gsession; assert.strictEqual(s.data.length, +a); s.data = Buffer.concat([s.data, body])
      if (+z + 1 < +total) { res.statusCode = 308; return res.end() }
      return json(ctx.gfinish(s))
    }
    if (!valid.has((req.headers.authorization || '').replace('Bearer ', ''))) return json({ error_summary: 'expired_access_token/', error: { message: 'bad token' } }, 401)

    // ---------------- Dropbox ----------------
    if (u.pathname.startsWith('/dbx/')) {
      const fsx = ctx.dropbox, name = u.pathname.slice(7), arg = req.headers['dropbox-api-arg'] ? JSON.parse(req.headers['dropbox-api-arg']) : body.length ? JSON.parse(body) : {}
      const meta = (p, v) => ({ '.tag': v === null ? 'folder' : 'file', name: path.posix.basename(p), path_display: p, size: v?.length, server_modified: '2026-10-28T10:00:00Z' })
      const conflict = () => json({ error_summary: 'path/not_found/..' }, 409)
      const kids = p => [...fsx].filter(([k]) => path.posix.dirname(k) === (p || '/') && k !== '/')
      switch (name) {
        case 'users/get_current_account': return json({ account_id: 'x' })
        case 'files/list_folder': { const all = kids(arg.path); ctx.dbxPending = all.slice(2); return json({ entries: all.slice(0, 2).map(([k, v]) => meta(k, v)), cursor: 'c1', has_more: all.length > 2 }) }
        case 'files/list_folder/continue': return json({ entries: ctx.dbxPending.map(([k, v]) => meta(k, v)), cursor: 'c2', has_more: false })
        case 'files/get_metadata': return fsx.has(arg.path) ? json(meta(arg.path, fsx.get(arg.path))) : conflict()
        case 'files/create_folder_v2': fsx.set(arg.path, null); return json({ metadata: {} })
        case 'files/delete_v2': for (const k of [...fsx.keys()]) if (k === arg.path || k.startsWith(arg.path + '/')) fsx.delete(k); return json({ metadata: {} })
        case 'files/move_v2': for (const k of [...fsx.keys()]) if (k === arg.from_path || k.startsWith(arg.from_path + '/')) { fsx.set(arg.to_path + k.slice(arg.from_path.length), fsx.get(k)); fsx.delete(k) } return json({ metadata: {} })
        case 'files/upload': assert.strictEqual(arg.mode, 'overwrite'); fsx.set(arg.path, body); return json(meta(arg.path, body))
        case 'files/upload_session/start': ctx.dbxSession = Buffer.alloc(0); return json({ session_id: 's1' })
        case 'files/upload_session/append_v2': assert.strictEqual(arg.cursor.offset, ctx.dbxSession.length); ctx.dbxSession = Buffer.concat([ctx.dbxSession, body]); return json(null)
        case 'files/upload_session/finish': assert.strictEqual(arg.cursor.offset, ctx.dbxSession.length); fsx.set(arg.commit.path, Buffer.concat([ctx.dbxSession, body])); return json(meta(arg.commit.path, body))
        case 'files/download': { const f = fsx.get(arg.path); if (!Buffer.isBuffer(f)) return conflict(); const [st, b] = range(req, f); res.statusCode = st; return res.end(b) }
      }
      return json({ error_summary: 'unknown ' + name }, 400)
    }

    // ---------------- OneDrive ----------------
    if (u.pathname.startsWith('/graph/')) {
      const fsx = ctx.onedrive, rest = decodeURIComponent(u.pathname.slice(6))
      if (rest === '/me/drive') return json({ id: 'drive' })
      const mm = /^\/me\/drive\/root(?::(\/[^:]*))?(:?)(\/children|\/content|\/createUploadSession)?$/.exec(rest)
      assert(mm, rest)
      const p = mm[1] || '/', op = mm[3] || '', v = fsx.get(p)
      const info = (k, val) => ({ name: path.posix.basename(k), size: val?.length || 0, lastModifiedDateTime: '2026-10-28T10:00:00Z', ...(val === null ? { folder: {} } : { file: {} }) })
      const notFound = () => json({ error: { code: 'itemNotFound', message: 'not found' } }, 404)
      if (op === '/children' && req.method === 'GET') {
        const all = [...fsx].filter(([k]) => k !== '/' && path.posix.dirname(k) === p)
        const page = +(u.searchParams.get('page') || 0)
        return json({ value: all.slice(page * 2, page * 2 + 2).map(([k, val]) => info(k, val)), ...(all.length > (page + 1) * 2 ? { '@odata.nextLink': `http://${req.headers.host}${u.pathname}?page=${page + 1}` } : {}) })
      }
      if (op === '/children' && req.method === 'POST') { const b = JSON.parse(body); assert.strictEqual(b['@microsoft.graph.conflictBehavior'], 'fail'); fsx.set(path.posix.join(p, b.name), null); return json({}, 201) }
      if (op === '/content' && req.method === 'GET') { if (!Buffer.isBuffer(v)) return notFound(); res.statusCode = 302; res.setHeader('location', `http://${req.headers.host}/dl/${encodeURIComponent(p)}`); return res.end() }
      if (op === '/content' && req.method === 'PUT') { assert(body.length <= 4 * 1024 * 1024); fsx.set(p, body); return json({}, 201) }
      if (op === '/createUploadSession') { fsx.set(p, Buffer.alloc(0)); return json({ uploadUrl: `http://${req.headers.host}/odsession/${encodeURIComponent(p)}` }) }
      if (req.method === 'GET') return v === undefined && p !== '/' ? notFound() : json(info(p, p === '/' ? null : v))
      if (req.method === 'DELETE') { for (const k of [...fsx.keys()]) if (k === p || k.startsWith(p + '/')) fsx.delete(k); res.statusCode = 204; return res.end() }
      if (req.method === 'PATCH') {
        const b = JSON.parse(body), parent = b.parentReference.path.replace('/drive/root:', '') || '/', to = path.posix.join(parent, b.name)
        for (const k of [...fsx.keys()]) if (k === p || k.startsWith(p + '/')) { fsx.set(to + k.slice(p.length), fsx.get(k)); fsx.delete(k) }
        return json({})
      }
    }

    // ---------------- Google Drive ----------------
    if (u.pathname.startsWith('/gd/') || u.pathname.startsWith('/gup/')) {
      const db = ctx.gdrive, n = u.pathname.replace(/^\/g(d|up)/, '')
      const view = f => ({ id: f.id, name: f.name, mimeType: f.mimeType, ...(f.data ? { size: String(f.data.length) } : {}), modifiedTime: '2026-10-28T10:00:00Z' })
      const folder = 'application/vnd.google-apps.folder'
      let nextId = db.length + 100
      const add = (meta, data) => { const f = { id: 'id' + nextId++, name: meta.name, mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || ['root'], data }; db.push(f); return f }
      ctx.gfinish = s => { if (s.existing) { s.existing.data = s.data; return view(s.existing) } return view(add(s.meta, s.data)) }
      if (n === '/about') return json({ user: {} })
      if (n === '/files' && req.method === 'GET') {
        const q = u.searchParams.get('q')
        const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)[1], nm = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1')
        assert(q.includes('trashed = false'))
        return json({ files: db.filter(f => !f.trashed && f.parents.includes(parent) && (nm === undefined || f.name === nm)).map(view) })
      }
      if (n === '/files' && req.method === 'POST' && u.searchParams.get('uploadType') === 'multipart') {
        const parts = body.toString('latin1').split(/--cd[0-9a-f]+/)
        const meta = JSON.parse(parts[1].split('\r\n\r\n')[1].trim()), data = Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, ''), 'latin1')
        return json(view(add(meta, data)))
      }
      if (n === '/files' && req.method === 'POST' && u.searchParams.get('uploadType') === 'resumable') { ctx.gsession = { meta: JSON.parse(body), data: Buffer.alloc(0) }; res.setHeader('location', `http://${req.headers.host}/gsession`); res.statusCode = 200; return res.end() }
      if (n === '/files' && req.method === 'POST') { const f = add(JSON.parse(body)); return json(view(f)) }
      const id = /^\/files\/([^/?]+)/.exec(n)?.[1], f = db.find(x => x.id === id)
      if (id && !f) return json({ error: { message: 'File not found' } }, 404)
      if (f && /\/export$/.test(n)) { assert(u.searchParams.get('mimeType').includes('wordprocessingml')); return res.end(Buffer.from('exported:' + f.name)) }
      if (f && req.method === 'GET') { const [st, b] = range(req, f.data); res.statusCode = st; return res.end(b) }
      if (f && req.method === 'PATCH' && u.searchParams.get('uploadType') === 'media') { f.data = body; return json(view(f)) }
      if (f && req.method === 'PATCH' && u.searchParams.get('uploadType') === 'resumable') { ctx.gsession = { meta: JSON.parse(body), data: Buffer.alloc(0), existing: f }; res.setHeader('location', `http://${req.headers.host}/gsession`); return res.end() }
      if (f && req.method === 'PATCH') {
        const b = JSON.parse(body)
        if (b.trashed) f.trashed = true
        if (b.name) f.name = b.name
        if (u.searchParams.get('addParents')) f.parents = [u.searchParams.get('addParents')]
        return json(view(f))
      }
    }
    json({ error: 'unhandled ' + req.method + ' ' + req.url }, 500)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  // ---- OAuth: PKCE challenge is checked by the token endpoint; the "browser" follows the redirect ----
  const provider = { authUrl: base + '/authorize', tokenUrl: base + '/token', scope: 'files.readwrite', params: { token_access_type: 'offline' } }
  let seen
  const browse = async url => {
    const u = new URL(url); seen = Object.fromEntries(u.searchParams)
    challenge = seen.code_challenge
    assert.strictEqual(seen.code_challenge_method, 'S256'); assert.strictEqual(seen.client_id, 'app-id'); assert.strictEqual(seen.response_type, 'code')
    assert(/^http:\/\/localhost:\d+\/callback$/.test(seen.redirect_uri))
    const back = new URL(seen.redirect_uri); back.hostname = '127.0.0.1'
    back.searchParams.set('code', 'the-code'); back.searchParams.set('state', seen.state)
    assert.strictEqual((await get(back.href)).status, 200)
  }
  const auth = await authorize(provider, { clientId: 'app-id' }, url => browse(url).catch(e => { console.error(e); process.exit(1) }))
  assert.strictEqual(seen.token_access_type, 'offline', 'provider parameters reach the authorization URL')
  assert.strictEqual(auth.refreshToken, 'refresh-1'); assert.strictEqual(auth.accessToken, 'access-1')
  await assert.rejects(authorize(provider, { clientId: '' }, () => {}), /client ID/)
  // a redirect with a wrong state is refused
  await assert.rejects(authorize(provider, { clientId: 'app-id' }, async url => { const u = new URL(url); const back = new URL(u.searchParams.get('redirect_uri')); back.hostname = '127.0.0.1'; back.searchParams.set('code', 'x'); back.searchParams.set('state', 'forged'); await get(back.href) }), /sign-in failed|Authentication failure/)
  // access tokens expire (1 s here, minus the safety margin): the refresh token is exchanged, and rotation is reported
  const rotated = []
  const tokens = tokenSource(provider, { clientId: 'app-id' }, 'refresh-1', { first: auth, onRefreshToken: t => rotated.push(t) })
  assert.strictEqual(await tokens.get(), 'access-2'); assert.deepStrictEqual(rotated, ['refresh-2']); refreshCount = 1
  await assert.rejects(tokenSource(provider, { clientId: 'app-id' }, 'stale').get(), /bad refresh token/)

  // ---- the backends, opened the way the application does ----
  const oauth = { authUrl: provider.authUrl, tokenUrl: provider.tokenUrl }
  const drive = { dbx: { api: base + '/dbx', content: base + '/dbx' }, od: { api: base + '/graph' }, gd: { api: base + '/gd', upload: base + '/gup' } }
  const saved = []
  const extra = d => ({ oauth, drive: { ...d, partSize: 8, singleMax: 12 }, openUrl: url => browse(url), onRefreshToken: t => saved.push(t) })
  const exercise = async (type, d, root = '/') => {
    const server = { type, clientId: 'app-id' }
    refreshCount = 0; ACCESS = 'access-1'; rtoken.current = 'refresh-1'; saved.length = 0
    const s = await open(server, undefined, extra(d))            // first use: signs in through the browser
    assert.strictEqual(saved[0], 'refresh-1', type + ': refresh token is handed over for storage (rotations follow)')
    const again = await open(server, saved.at(-1), extra(d))      // later: refresh token only, no browser
    assert(again)
    await call(s, 'mkdir', '/docs'); await call(s, 'mkdir', '/docs/sub')
    await call(s, 'writeFile', '/docs/a b.txt', 'hello world')
    await call(s, 'writeFile', '/docs/c.txt', 'third')
    assert.deepStrictEqual((await call(s, 'readdir', '/docs')).map(e => e.filename).sort(), ['a b.txt', 'c.txt', 'sub'], 'paging joins every page')
    assert.strictEqual((await call(s, 'stat', '/docs/a b.txt')).size, 11)
    assert.strictEqual((await call(s, 'stat', '/docs/sub')).isDirectory(), true)
    await assert.rejects(call(s, 'stat', '/docs/missing'), /No such file/)
    assert.strictEqual(await text(s.createReadStream('/docs/a b.txt')), 'hello world')
    fs.writeFileSync(tmp, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3) + '!')   // 79 bytes: several chunks / a session
    await call(s, 'fastPut', tmp, '/docs/big.bin')
    assert.strictEqual(await text(s.createReadStream('/docs/big.bin')), fs.readFileSync(tmp, 'utf8'))
    await call(s, 'fastPut', tmp, '/docs/big.bin')                         // overwrite
    await call(s, 'fastGet', '/docs/big.bin', tmp + '2'); assert.strictEqual(fs.readFileSync(tmp + '2', 'utf8'), fs.readFileSync(tmp, 'utf8'))
    await call(s, 'rename', '/docs/c.txt', '/docs/sub/d.txt')
    assert.deepStrictEqual((await call(s, 'readdir', '/docs/sub')).map(e => e.filename), ['d.txt'])
    await assert.rejects(call(s, 'stat', '/docs/c.txt'), /No such file/)
    await call(s, 'unlink', '/docs/sub/d.txt')
    await assert.rejects(call(s, 'stat', '/docs/sub/d.txt'), /No such file/)
    // access token expiry: the next calls refresh it transparently (sign-in tokens last 1 s in this mock)
    await new Promise(r => setTimeout(r, 50))
    assert((await call(s, 'readdir', '/docs')).length >= 2)
    assert(refreshCount >= 1, type + ': refreshed')
    return s
  }
  const named = (type, d) => exercise(type, d).catch(e => { e.message = `[${type}] ${e.message}`; throw e })
  await named('dropbox', drive.dbx)
  await named('onedrive', drive.od)
  const g = await named('gdrive', drive.gd)
  // Google-native documents are exported to Office formats; deletion goes to the trash
  ctx.gdrive.push({ id: 'native1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', parents: [ctx.gdrive.find(f => f.name === 'docs').id] })
  assert.strictEqual(await text(g.createReadStream('/docs/Plan')), 'exported:Plan')
  assert(ctx.gdrive.some(f => f.name === 'd.txt' && f.trashed), 'unlink trashes the file')

  fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + '2', { force: true })
  server.closeAllConnections(); server.close()
  console.log('cloud drives ok')
})().catch(e => { console.error(e.message); console.error(e.stack); process.exit(1) })
