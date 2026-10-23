const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, nativeTheme, nativeImage, shell } = require('electron')
const { Client } = require('ssh2')
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { parseDuck } = require('./duck')
const { exportZip, readZip } = require('./share')
const i18n = require('./i18n')
const { HEALTH_SCRIPT, parseHealth, SERVICES_CMD, parseServices, UNIT_RE, SVC_ACTIONS } = require('./health')

const posix = path.posix
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
let win
let servers = []
let actions = []
const conns = new Map() // id -> { client, sftp?, stream?, server?, connectMs?, tmp: [dirs] }

// ---------- stockage : un fichier JSON par élément (userData/servers/, userData/actions/) ----------
function createStore(name) {
  const dir = () => path.join(app.getPath('userData'), name)
  return {
    load() {
      const items = []
      if (fs.existsSync(dir())) for (const f of fs.readdirSync(dir()).filter(f => f.endsWith('.json'))) {
        try { items.push(JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'))) } catch {}
      }
      return items.sort((a, b) => a.order - b.order)
    },
    save(items) {
      fs.mkdirSync(dir(), { recursive: true })
      const keep = new Set(items.map(s => s.id + '.json'))
      for (const f of fs.readdirSync(dir())) if (f.endsWith('.json') && !keep.has(f)) fs.rmSync(path.join(dir(), f))
      items.forEach((s, i) => fs.writeFileSync(path.join(dir(), s.id + '.json'), JSON.stringify({ ...s, order: i }, null, 2), { mode: 0o600 }))
    },
  }
}
const serverStore = createStore('servers')
const actionStore = createStore('actions')
const persist = () => serverStore.save(servers)
function load() {
  const legacy = path.join(app.getPath('userData'), 'servers.json')
  if (fs.existsSync(legacy)) {
    servers = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    persist()
    fs.renameSync(legacy, legacy + '.migrated')
  } else servers = serverStore.load()
  actions = actionStore.load()
}
// ---------- réglages (langue, thème) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
let settings = { lang: 'en', theme: 'system' }
function loadSettings() {
  const sys = app.getLocale().slice(0, 2)
  settings = { lang: sys in i18n.LANGS ? sys : 'en', theme: 'system' }
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))) } catch {}
  applyNativeTheme()
}
// thèmes clairs : seul 'light' ; les autres sont sombres (dialogues natifs, barres, champs)
const applyNativeTheme = () => { nativeTheme.themeSource = settings.theme === 'system' ? 'system' : settings.theme === 'light' ? 'light' : 'dark' }
const t = (k, v) => i18n.t(settings.lang, k, v)
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:set', (_, patch) => {
  if (patch.lang in i18n.LANGS) settings.lang = patch.lang
  if (typeof patch.theme === 'string') settings.theme = patch.theme
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  applyNativeTheme()
})

const pub = s => ({ id: s.id, name: s.name, host: s.host, port: s.port, user: s.user, hasPass: !!s.pass })
const list = () => servers.map(pub)
const secret = s => (s.pass ? safeStorage.decryptString(Buffer.from(s.pass, 'base64')) : undefined)
const find = id => servers.find(s => s.id === id) ?? (() => { throw new Error(t('err.server_not_found')) })()

// ---------- SSH ----------
const P = (o, m, ...a) => new Promise((res, rej) => o[m](...a, (e, r) => (e ? rej(e) : res(r))))
const q = p => `'${p.replace(/'/g, `'\\''`)}'`
const send = (...a) => win && !win.isDestroyed() && win.webContents.send(...a)

function connect(s) {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let mismatch = false
    const t0 = Date.now()
    c.on('ready', () => { c.connectMs = Date.now() - t0; resolve(c) })
    c.on('error', e => reject(mismatch ? new Error(t('err.hostkey')) : e))
    c.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => secret(s) ?? '')))
    c.connect({
      host: s.host,
      port: s.port,
      username: s.user,
      password: secret(s),
      privateKey: s.key && fs.existsSync(s.key) ? fs.readFileSync(s.key) : undefined,
      agent: process.env.SSH_AUTH_SOCK || (isWin ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined),
      tryKeyboard: true,
      keepaliveInterval: 15000,
      readyTimeout: 15000,
      hostHash: 'sha256',
      // trust on first use
      hostVerifier: fp => {
        if (!s.fp) { s.fp = fp; persist() }
        mismatch = s.fp !== fp
        return !mismatch
      },
    })
  })
}

function drop(id) {
  const c = conns.get(id)
  if (!c) return
  conns.delete(id)
  c.tmp.forEach(d => { fs.readdirSync(d).forEach(f => fs.unwatchFile(path.join(d, f))); fs.rmSync(d, { recursive: true, force: true }) })
  send('conn:closed', id)
}

const S = id => conns.get(id)?.sftp ?? (() => { throw new Error(t('err.lost')) })()

ipcMain.handle('servers:list', list)

ipcMain.handle('servers:save', (_, d) => {
  const name = d.name?.trim(), host = d.host?.trim(), user = d.user?.trim()
  if (!host || !user) throw new Error(t('err.host_user_required'))
  let s = servers.find(x => x.id === d.id)
  if (!s) servers.push((s = { id: crypto.randomUUID() }))
  Object.assign(s, { name: name || host, host, port: +d.port || 22, user, fp: undefined })
  if (d.pass) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('err.keychain'))
    s.pass = safeStorage.encryptString(d.pass).toString('base64')
  }
  persist()
  return list()
})

ipcMain.handle('servers:delete', (_, id) => { servers = servers.filter(s => s.id !== id); persist(); return list() })

ipcMain.handle('servers:reorder', (_, ids) => {
  servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  persist()
  return list()
})

// ajoute un serveur venant d'un import (Cyberduck ou zip) sauf doublon host/port/user
function addImported(b) {
  if (typeof b?.host !== 'string' || !b.host.trim()) return false
  const s = { name: String(b.name || b.host), host: b.host.trim(), port: +b.port || 22, user: String(b.user ?? ''), key: typeof b.key === 'string' ? b.key : undefined }
  if (servers.some(x => x.host === s.host && x.port === s.port && x.user === s.user)) return false
  servers.push({ id: crypto.randomUUID(), ...s })
  return true
}

// favoris Cyberduck (.duck) : macOS (version directe puis App Store/sandbox) ou Windows (%APPDATA%)
const cyberduckDirs = () => {
  if (isWin) return [path.join(process.env.APPDATA || '', 'Cyberduck', 'Bookmarks')]
  const lib = path.join(os.homedir(), 'Library')
  return [path.join(lib, 'Application Support/duck/Bookmarks'), path.join(lib, 'Group Containers/G69SCX94XU.duck/Library/Application Support/duck/Bookmarks')]
}
// XML tel quel ; plist binaire (macOS) converti par plutil
async function readPlist(f) {
  const raw = fs.readFileSync(f)
  if (raw.includes('<plist')) return raw.toString('utf8')
  return new Promise(res => execFile('plutil', ['-convert', 'xml1', '-o', '-', f], (e, out) => res(e ? '' : out)))
}

ipcMain.handle('servers:import', async () => {
  let files = cyberduckDirs().filter(d => fs.existsSync(d)).flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.duck')).map(f => path.join(d, f)))
  if (!files.length) {
    const r = await dialog.showOpenDialog(win, {
      title: t('dlg.cyberduck_title'),
      message: t('dlg.cyberduck_msg'),
      defaultPath: app.getPath('home'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dlg.cyberduck_filter'), extensions: ['duck'] }],
    })
    files = r.filePaths
  }
  let added = 0
  for (const f of files) {
    if (addImported(parseDuck(await readPlist(f)))) added++
  }
  persist()
  return { servers: list(), added }
})

ipcMain.handle('servers:exportZip', async () => {
  if (!servers.length) throw new Error(t('err.no_export'))
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), 'cyberdog-servers.zip'), filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  await exportZip(servers, r.filePath)
  return { path: r.filePath, count: servers.length }
})

ipcMain.handle('servers:importZip', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  let added = 0
  for (const b of await readZip(r.filePaths[0])) if (addImported(b)) added++
  persist()
  return { servers: list(), added }
})

// ---------- SFTP ----------
ipcMain.handle('files:open', async (_, sid) => {
  const client = await connect(find(sid))
  const sftp = await P(client, 'sftp')
  const id = crypto.randomUUID()
  conns.set(id, { client, sftp, tmp: [], server: find(sid), connectMs: client.connectMs })
  client.on('close', () => drop(id))
  return { id, home: await P(sftp, 'realpath', '.') }
})

ipcMain.handle('conn:close', (_, id) => conns.get(id)?.client.end())

ipcMain.handle('sftp:list', async (_, id, dir) => {
  const s = S(id)
  dir = await P(s, 'realpath', dir)
  const items = (await P(s, 'readdir', dir)).filter(f => f.filename !== '.' && f.filename !== '..')
  const entries = await Promise.all(items.map(async f => {
    const a = f.attrs
    const type = a.mode & 0o170000
    const isLink = type === 0o120000
    let isDir = type === 0o040000
    if (isLink) isDir = await P(s, 'stat', posix.join(dir, f.filename)).then(x => x.isDirectory(), () => false)
    const l = f.longname.split(/\s+/)
    return { name: f.filename, size: a.size, mtime: a.mtime * 1000, mode: a.mode & 0o7777, owner: l[2] ?? a.uid, group: l[3] ?? a.gid, isDir, isLink }
  }))
  return { path: dir, entries }
})

ipcMain.handle('sftp:mkdir', (_, id, p) => P(S(id), 'mkdir', p))
// flag wx: ne jamais écraser un fichier existant
ipcMain.handle('sftp:touch', (_, id, p) => P(S(id), 'writeFile', p, '', { flag: 'wx' }))
ipcMain.handle('sftp:rename', (_, id, from, to) => P(S(id), 'rename', from, to))

async function rmr(s, p) {
  if ((await P(s, 'lstat', p)).isDirectory()) {
    for (const e of await P(s, 'readdir', p)) if (e.filename !== '.' && e.filename !== '..') await rmr(s, posix.join(p, e.filename))
    await P(s, 'rmdir', p)
  } else await P(s, 'unlink', p)
}
ipcMain.handle('sftp:rm', async (_, id, paths) => { for (const p of paths) await rmr(S(id), p) })

// budget { left } optionnel : plafonne le volume téléchargé (glisser vers le Finder)
async function dl(s, remote, local, budget) {
  const st = await P(s, 'stat', remote)
  if (st.isDirectory()) {
    fs.mkdirSync(local, { recursive: true })
    for (const e of await P(s, 'readdir', remote)) if (e.filename !== '.' && e.filename !== '..') await dl(s, posix.join(remote, e.filename), path.join(local, e.filename), budget)
  } else {
    if (budget && (budget.left -= st.size) < 0) throw new Error(t('err.drag_too_big', { size: '300 MB' }))
    await P(s, 'fastGet', remote, local)
  }
}

ipcMain.handle('sftp:download', async (_, id, paths) => {
  const s = S(id)
  const downloads = app.getPath('downloads')
  if (paths.length === 1 && !(await P(s, 'stat', paths[0])).isDirectory()) {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(downloads, posix.basename(paths[0])) })
    if (r.canceled) return null
    await P(s, 'fastGet', paths[0], r.filePath)
    return r.filePath
  }
  const r = await dialog.showOpenDialog(win, { title: t('dlg.download_into'), defaultPath: downloads, properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled) return null
  for (const p of paths) await dl(s, p, path.join(r.filePaths[0], posix.basename(p)))
  return r.filePaths[0]
})

async function ul(s, local, remote) {
  if (fs.statSync(local).isDirectory()) {
    await P(s, 'mkdir', remote).catch(() => {}) // existe déjà
    for (const f of fs.readdirSync(local)) await ul(s, path.join(local, f), posix.join(remote, f))
  } else await P(s, 'fastPut', local, remote)
}

ipcMain.handle('sftp:upload', async (_, id, locals, dir) => {
  const s = S(id)
  const clash = []
  for (const l of locals) if (await P(s, 'stat', posix.join(dir, path.basename(l))).then(() => true, () => false)) clash.push(path.basename(l))
  if (clash.length) {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [t('dlg.replace'), t('btn.cancel')], defaultId: 1, cancelId: 1, message: t('dlg.exists'), detail: clash.join('\n') })
    if (r.response) return false
  }
  for (const l of locals) await ul(s, l, posix.join(dir, path.basename(l)))
  return true
})

// Édition : téléchargement en tmp, ouverture dans l'appli, renvoi à chaque sauvegarde
ipcMain.handle('sftp:edit', async (_, id, remote, appPath) => {
  const c = conns.get(id)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-'))
  const name = posix.basename(remote)
  const local = path.join(dir, name)
  c.tmp.push(dir)
  await P(c.sftp, 'fastGet', remote, local)
  fs.watchFile(local, { interval: 700 }, async (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return
    try { await P(c.sftp, 'fastPut', local, remote); send('toast', t('t.file_sent', { name })) } catch (e) { send('toast', t('t.send_failed', { name, error: e.message }), true) }
  })
  if (!appPath) shell.openPath(local)
  else execFile(isMac ? 'open' : appPath, isMac ? ['-a', appPath, local] : [local], () => {})
})

// éditeurs proposés dans « Éditer avec… » : { label, target } (macOS : nom d'appli pour `open -a`, Windows : chemin de l'exe)
const MAC_APPS = ['Visual Studio Code', 'Cursor', 'Zed', 'Sublime Text', 'Nova', 'BBEdit', 'TextEdit']
const MAC_DIRS = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')]
const env = k => process.env[k] || ''
const WIN_APPS = [
  ['Visual Studio Code', [path.join(env('LOCALAPPDATA'), 'Programs/Microsoft VS Code/Code.exe'), path.join(env('ProgramFiles'), 'Microsoft VS Code/Code.exe')]],
  ['Cursor', [path.join(env('LOCALAPPDATA'), 'Programs/cursor/Cursor.exe')]],
  ['Notepad++', [path.join(env('ProgramFiles'), 'Notepad++/notepad++.exe'), path.join(env('ProgramFiles(x86)'), 'Notepad++/notepad++.exe')]],
  ['Sublime Text', [path.join(env('ProgramFiles'), 'Sublime Text/sublime_text.exe')]],
  ['Notepad', [path.join(env('SystemRoot'), 'System32/notepad.exe')]],
]
ipcMain.handle('apps:list', () => {
  if (!isWin) return MAC_APPS.filter(a => MAC_DIRS.some(d => fs.existsSync(`${d}/${a}.app`))).map(a => ({ label: a, target: a }))
  return WIN_APPS.map(([label, paths]) => ({ label, target: paths.find(p => fs.existsSync(p)) })).filter(a => a.target)
})
ipcMain.handle('apps:pick', async () => {
  const r = await dialog.showOpenDialog(win, isWin
    ? { defaultPath: env('ProgramFiles'), properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['exe'] }] }
    : { defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] })
  return r.filePaths[0]
})

// ---------- exécution distante ----------
function exec(client, cmd, { input, timeout = 15000, max = 2e6 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      const timer = setTimeout(() => { stream.close(); resolve({ code: 124, out }) }, timeout)
      const add = d => { if (out.length < max) out += d }
      stream.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.on('data', add)
      stream.stderr.on('data', add)
      stream.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
      stream.end(input)
    })
  })
}
const getConn = id => (conns.get(id)?.client ? conns.get(id) : (() => { throw new Error(t('err.lost')) })())

// ---------- Santé du serveur ----------
const healthOf = async (client, connectMs) => {
  const t0 = Date.now()
  await exec(client, 'true', { timeout: 10000 })
  const latencyMs = Date.now() - t0
  const r = await exec(client, 'sh -s', { input: HEALTH_SCRIPT })
  return { ...parseHealth(r.out), latencyMs, connectMs, ts: Date.now() }
}
ipcMain.handle('health:check', (_, id) => { const c = getConn(id); return healthOf(c.client, c.connectMs) })

// connexion courte, une par serveur (vue globale)
ipcMain.handle('health:overview', async (_, sid) => {
  try {
    const client = await connect(find(sid))
    try { return { ok: true, ...(await healthOf(client, client.connectMs)) } } finally { client.end() }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('svc:list', async (_, id) => {
  const list = parseServices((await exec(getConn(id).client, SERVICES_CMD)).out)
  if (!list.length) throw new Error(t('svc.unavailable'))
  return list
})

ipcMain.handle('svc:action', async (_, id, unit, action) => {
  if (!UNIT_RE.test(unit) || !SVC_ACTIONS.includes(action)) throw new Error('invalid')
  const c = getConn(id)
  const pw = c.server && secret(c.server)
  // root : direct ; sinon sudo, avec le mot de passe enregistré sur stdin (jamais en argument)
  const sudo = pw ? "sudo -S -p ''" : 'sudo -n'
  const cmd = `if [ "$(id -u)" = 0 ]; then systemctl ${action} ${q(unit)}; else ${sudo} systemctl ${action} ${q(unit)}; fi`
  const r = await exec(c.client, cmd, { input: pw ? pw + '\n' : undefined, timeout: 60000 })
  if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`)
})

// ---------- Actions rapides (scripts bash enregistrés à côté des serveurs) ----------
const persistActions = () => actionStore.save(actions)
const MAX_SCRIPT = 60000 // passe dans la ligne de commande (base64)

ipcMain.handle('actions:list', () => actions)
ipcMain.handle('actions:save', (_, d) => {
  const name = d.name?.trim()
  if (!name || !d.script?.trim()) throw new Error(t('err.name_script_required'))
  if (d.script.length > MAX_SCRIPT) throw new Error(t('err.script_too_big'))
  let a = actions.find(x => x.id === d.id)
  if (!a) actions.push((a = { id: crypto.randomUUID() }))
  Object.assign(a, { name, script: d.script })
  persistActions()
  return actions
})
ipcMain.handle('actions:delete', (_, id) => { actions = actions.filter(a => a.id !== id); persistActions(); return actions })

ipcMain.handle('actions:exportZip', async () => {
  if (!actions.length) throw new Error(t('err.no_actions_export'))
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), 'cyberdog-actions.zip'), filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  await exportZip(actions, r.filePath, ['name', 'script'])
  return { path: r.filePath, count: actions.length }
})

ipcMain.handle('actions:importZip', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  let added = 0
  for (const b of await readZip(r.filePaths[0])) {
    if (typeof b?.name !== 'string' || typeof b.script !== 'string' || !b.name.trim() || !b.script.trim() || b.script.length > MAX_SCRIPT) continue
    if (actions.some(a => a.name === b.name && a.script === b.script)) continue
    actions.push({ id: crypto.randomUUID(), name: b.name.trim(), script: b.script })
    added++
  }
  persistActions()
  return { actions, added }
})

// le script voyage en base64 dans la commande : stdin reste libre pour les scripts interactifs
ipcMain.handle('action:run', async (_, id, script) => {
  const c = getConn(id)
  const t0 = Date.now()
  const b64 = Buffer.from(script).toString('base64')
  const r = await exec(c.client, `bash -c "$(printf %s ${q(b64)} | base64 -d)"`, { timeout: 120000 })
  return { code: r.code, out: r.out, ms: Date.now() - t0 }
})

// ---------- Recherche de fichiers ----------
ipcMain.handle('search:find', async (_, id, base, query, scope) => {
  query = String(query).trim()
  if (!query) return []
  const root = scope === 'all' ? '/' : base
  const pat = '*' + query.replace(/[\\*?[\]]/g, '\\$&') + '*'
  const script = `T=
command -v timeout >/dev/null 2>&1 && T='timeout 8'
$T find ${q(root)} \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -iname ${q(pat)} -exec sh -c 'for f; do if [ -d "$f" ]; then echo "d $f"; else echo "f $f"; fi; done' _ {} + 2>/dev/null | head -n 80
`
  const r = await exec(getConn(id).client, 'sh -s', { input: script, timeout: 12000 })
  const lq = query.toLowerCase()
  return r.out.split('\n').filter(l => /^[df] \//.test(l)).map(l => ({ isDir: l[0] === 'd', path: l.slice(2) }))
    .filter(x => x.path !== root)
    .sort((a, b) => (posix.basename(b.path).toLowerCase().startsWith(lq) - posix.basename(a.path).toLowerCase().startsWith(lq)) || a.path.length - b.path.length)
    .slice(0, 40)
})

// ---------- Glisser vers le Finder ----------
// startDrag exige des fichiers locaux : on les prépare dans un cache temporaire (plafonné), puis on lance le drag natif.
let dragRoot
const dragCache = new Map() // "conn:chemin:mtime:taille" -> chemin local
ipcMain.handle('drag:prepare', async (_, id, paths) => {
  const s = S(id)
  const out = []
  dragRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-drag-'))
  for (const p of paths) {
    const st = await P(s, 'stat', p)
    const key = `${id}:${p}:${st.mtime}:${st.size}`
    let local = dragCache.get(key)
    if (!local || !fs.existsSync(local)) {
      local = path.join(fs.mkdtempSync(path.join(dragRoot, 'd-')), posix.basename(p))
      await dl(s, p, local, { left: 300 * 1024 * 1024 })
      dragCache.set(key, local)
    }
    out.push(local)
  }
  return out
})
ipcMain.on('drag:start', (e, files) => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/drag.png'))
  e.sender.startDrag({ file: files[0], files, icon })
})
app.on('will-quit', () => { if (dragRoot) fs.rmSync(dragRoot, { recursive: true, force: true }) })

// ---------- Terminal ----------
ipcMain.handle('term:open', async (_, id, sid, cols, rows, cwd) => {
  const client = await connect(find(sid))
  const stream = await P(client, 'shell', { term: 'xterm-256color', cols, rows })
  conns.set(id, { client, stream, tmp: [] })
  stream.on('data', d => send('term:data', id, d))
  stream.on('close', () => client.end())
  client.on('close', () => drop(id))
  if (cwd) stream.write(`cd ${q(cwd)} && clear\n`)
})
ipcMain.on('term:write', (_, id, d) => conns.get(id)?.stream?.write(d))
ipcMain.on('term:resize', (_, id, cols, rows) => conns.get(id)?.stream?.setWindow(rows, cols, 0, 0))

// ---------- Fenêtre ----------
app.setName('Cyberdog')
app.whenReady().then(() => {
  load()
  loadSettings()
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../build/icon.png'))
  if (!isMac) Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : app.isPackaged ? {} : { icon: path.join(__dirname, '../build/icon.png') }),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171d' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
