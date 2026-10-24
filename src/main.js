const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, nativeTheme, nativeImage, shell, screen, net } = require('electron')
const path = require('path')
const { hasCyberdogConfig, copyCyberdogConfig, initializeUserData } = require('./config-path')
app.setName('Cyberdog')
// Keep the data location independent of the application bundle and release version.
initializeUserData(app)
const { Client, utils: sshUtils } = require('ssh2')
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { parseDuck } = require('./duck')
const { exportZip, readZip } = require('./share')
const configTransfer = require('./config-transfer')
const clientImport = require('./client-import')
const permissions = require('./permissions')
const certificateTools = require('./certificates')
const sshKeys = require('./ssh-keys')
const keyPassphrases = new Map()
const { readList, writeList } = require('./persistent-list')
const i18n = require('./i18n')
const archive = require('./archive')
const logfmt = require('./logs')
const dockerfmt = require('./docker')
const processModel = require('./processes')
const { HEALTH_SCRIPT, parseHealth, SERVICES_CMD, parseServices, UNIT_RE, SVC_ACTIONS } = require('./health')
const { autoUpdater } = require('electron-updater')
const { isNewerVersion, selectUpdateAsset, openUpdatePackage } = require('./update-version')
const { restoreWindow } = require('./window-state')

const { Transfers } = require('./transfers')
const transfers = new Transfers((...args) => send(...args))
const posix = path.posix
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
let win
let servers = []
let actions = []
const conns = new Map() // id -> { client, sftp?, stream?, server?, connectMs?, tmp: [dirs] }

const DEFAULT_SETTINGS = { lang: 'en', theme: 'system', configPath: '', defaultEditor: 'system', autoDownload: false, restoreConnections: false }
const checkConfigRoot = () => {
  if (settings.configPath && !fs.existsSync(settings.configPath)) throw new Error(t('config.unavailable'))
}
const currentConfigRoot = () => {
  const custom = settings?.configPath?.trim()
  return custom || app.getPath('userData')
}

// ---------- stockage : un fichier JSON par élément (userData/servers/, userData/actions/) ----------
function createStore(name) {
  const dir = () => path.join(currentConfigRoot(), name)
  return {
    load() {
      const items = []
      if (fs.existsSync(dir())) for (const f of fs.readdirSync(dir()).filter(f => f.endsWith('.json'))) {
        try { items.push(JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'))) } catch {}
      }
      return items.sort((a, b) => a.order - b.order)
    },
    save(items) {
      checkConfigRoot()
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
  if (!settings.configPath && fs.existsSync(legacy)) {
    servers = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    persist()
    fs.renameSync(legacy, legacy + '.migrated')
  } else servers = serverStore.load()
  actions = actionStore.load()
}
// ---------- réglages (langue, thème) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
let settings = { ...DEFAULT_SETTINGS }
function loadSettings() {
  const sys = app.getLocale().slice(0, 2)
  settings = { ...DEFAULT_SETTINGS, lang: sys in i18n.LANGS ? sys : 'en' }
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))) } catch {}
  // Retain custom paths even when an external volume is temporarily unavailable.
  if (!settings.defaultEditor) settings.defaultEditor = 'system'
  autoUpdater.autoDownload = !!settings.autoDownload
  applyNativeTheme()
}
// thèmes clairs : seul 'light' ; les autres sont sombres (dialogues natifs, barres, champs)
const applyNativeTheme = () => { nativeTheme.themeSource = settings.theme === 'system' ? 'system' : settings.theme === 'light' ? 'light' : 'dark' }
const t = (k, v) => i18n.t(settings.lang, k, v)
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:set', (_, patch) => {
  const previousRoot = currentConfigRoot()
  const previousPath = settings.configPath
  if (patch.lang in i18n.LANGS) settings.lang = patch.lang
  if (typeof patch.theme === 'string') settings.theme = patch.theme
  if (typeof patch.defaultEditor === 'string') settings.defaultEditor = patch.defaultEditor.trim() || 'system'
  if (typeof patch.restoreConnections === 'boolean') {
    settings.restoreConnections = patch.restoreConnections
    if (!settings.restoreConnections) { try { fs.unlinkSync(sessionFile()) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  }
  if (typeof patch.autoDownload === 'boolean') settings.autoDownload = patch.autoDownload
  if ('configPath' in patch) {
    const nextPath = typeof patch.configPath === 'string' ? patch.configPath.trim() : ''
    if (nextPath !== previousPath) {
      if (nextPath) {
        const target = path.resolve(nextPath)
        fs.mkdirSync(target, { recursive: true })
        if (!hasCyberdogConfig(target) && patch.copyConfigOnChange) copyCyberdogConfig(previousRoot, target)
        settings.configPath = target
      } else settings.configPath = ''
      load()
      loadGroups()
      loadPaths()
      loadFavs()
    }
  }
  autoUpdater.autoDownload = !!settings.autoDownload
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  applyNativeTheme()
  return settings
})
const sessionFile = () => path.join(app.getPath('userData'), 'session.json')
const { normalizeSession } = require('./session-state')
ipcMain.handle('session:get', () => {
  if (!settings.restoreConnections) return []
  try { const saved = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); return saved.configRoot === currentConfigRoot() ? normalizeSession(saved.tabs, servers) : [] } catch { return [] }
})
ipcMain.on('session:update', (_, items) => {
  if (!settings.restoreConnections) return
  try { fs.writeFileSync(sessionFile(), JSON.stringify({ configRoot: currentConfigRoot(), tabs: normalizeSession(items, servers) }), { mode: 0o600 }) }
  catch (e) { console.warn('Cannot save session:', e.message) }
})
ipcMain.handle('settings:config-status', (_, dir) => {
  const target = path.resolve(String(dir || '').trim())
  return { path: target, hasConfig: hasCyberdogConfig(target) }
})
ipcMain.handle('settings:pick-config', async () => {
  const result = await dialog.showOpenDialog(win, {
    defaultPath: settings.configPath || app.getPath('userData'),
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

const pub = s => ({ id: s.id, name: s.name, host: s.host, port: s.port, user: s.user, hasPass: !!s.pass, group: s.group, favorite: !!s.favorite })
const list = () => servers.map(pub)
const secret = s => (s.pass ? safeStorage.decryptString(Buffer.from(s.pass, 'base64')) : undefined)
const find = id => servers.find(s => s.id === id) ?? (() => { throw new Error(t('err.server_not_found')) })()

// ---------- SSH ----------
const P = (o, m, ...a) => new Promise((res, rej) => o[m](...a, (e, r) => (e ? rej(e) : res(r))))
const q = p => `'${p.replace(/'/g, `'\\''`)}'`
const send = (...a) => win && !win.isDestroyed() && win.webContents.send(...a)
let releaseUrl
let updateVersion
let updateMode = 'manual'
let updateReady = false
let updateDownloadStarted = false
let installAfterDownload = false
let updateCheckPromise
let updateNotes = ''
let updateReleaseName = ''
let updateAsset
let updateFile
let updatePercent = 0
let lastUpdateState = 'current'
let updateOpenPromise

function openDownloadedUpdate() {
  installAfterDownload = false
  if (updateOpenPromise) return updateOpenPromise
  updateOpenPromise = openUpdatePackage({ platform: process.platform, file: updateFile, version: updateVersion, dialog, shell, app, window: win, t })
    .finally(() => { updateOpenPromise = null })
  return updateOpenPromise
}

ipcMain.handle('app:version', () => app.getVersion())
const updateStatus = (state, extra = {}) => ({
  state,
  mode: updateMode,
  version: updateVersion,
  name: updateReleaseName,
  notes: updateNotes,
  url: releaseUrl,
  percent: updatePercent,
  ...extra,
})
const sendUpdate = (state, extra) => {
  lastUpdateState = state
  send('app:update', updateStatus(state, extra))
}
ipcMain.handle('app:update:status', () => updateStatus(lastUpdateState))

function useManualUpdate(error) {
  if (error) console.error('Cyberdog update failed; opening the release page instead:', error)
  updateMode = 'manual'
  updateDownloadStarted = false
  installAfterDownload = false
  sendUpdate('available')
}

async function downloadReleaseAsset(openFallback = true) {
  if (!updateAsset) {
    if (openFallback) return shell.openExternal(releaseUrl)
    throw new Error('The release does not contain a compatible update package.')
  }
  updateDownloadStarted = true
  updatePercent = 0
  sendUpdate('downloading')
  const target = path.join(app.getPath('downloads'), updateAsset.name)
  const temporary = target + '.download'
  try {
    // Chromium networking follows the system proxy, including enterprise PAC/WPAD.
    const response = await net.fetch(updateAsset.url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Cyberdog' },
      signal: AbortSignal.timeout(30 * 60 * 1000),
    })
    if (!response.ok || !response.body) throw new Error(`GitHub returned HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    const output = fs.openSync(temporary, 'w', 0o600)
    const hash = crypto.createHash('sha256')
    const reader = response.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.length
        fs.writeSync(output, value)
        updatePercent = total ? Math.floor(received * 100 / total) : 0
        sendUpdate('downloading')
      }
    } finally {
      fs.closeSync(output)
    }
    if (updateAsset.digest && hash.digest('hex') !== updateAsset.digest) throw new Error('The downloaded update checksum is invalid.')
    fs.rmSync(target, { force: true })
    fs.renameSync(temporary, target)
    updateFile = target
    updateReady = true
    updateDownloadStarted = false
    updatePercent = 100
    sendUpdate('ready')
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    updateDownloadStarted = false
    updatePercent = 0
    useManualUpdate(error)
    throw error
  }
  if (installAfterDownload) await openDownloadedUpdate()
}

async function performUpdateAction(install) {
  if (!releaseUrl || !updateVersion) throw new Error('No Cyberdog update is available.')
  installAfterDownload = install
  if (updateMode !== 'install') {
    if (updateReady && updateFile) return install ? openDownloadedUpdate() : undefined
    if (updateDownloadStarted) return
    return downloadReleaseAsset()
  }
  try { await updateCheckPromise } catch (e) { useManualUpdate(e); return shell.openExternal(releaseUrl) }
  if (updateMode !== 'install') return shell.openExternal(releaseUrl)
  if (updateReady) return install ? autoUpdater.quitAndInstall() : undefined
  if (updateDownloadStarted) return
  updateDownloadStarted = true
  sendUpdate('downloading', { percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    useManualUpdate(e)
    return shell.openExternal(releaseUrl)
  }
}
ipcMain.handle('app:update:action', () => performUpdateAction(true))
ipcMain.handle('app:update:download', () => performUpdateAction(false))

async function checkForAppUpdate() {
  if (!app.isPackaged) return
  try {
    const response = await net.fetch('https://api.github.com/repos/pickywawa/cyberdog/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cyberdog' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
    const release = await response.json()
    if (!isNewerVersion(release.tag_name, app.getVersion())) {
      updateVersion = undefined
      updateNotes = ''
      updateReleaseName = ''
      releaseUrl = undefined
      updateAsset = undefined
      updateFile = undefined
      updateReady = false
      updateDownloadStarted = false
      updatePercent = 0
      sendUpdate('current')
      return
    }
    updateVersion = String(release.tag_name).replace(/^v/, '')
    updateReleaseName = String(release.name || release.tag_name)
    updateNotes = String(release.body || '').trim().slice(0, 12000)
    releaseUrl = /^https:\/\/github\.com\/pickywawa\/cyberdog\/releases\//.test(release.html_url)
      ? release.html_url
      : 'https://github.com/pickywawa/cyberdog/releases/latest'
    updateMode = isWin && !process.env.PORTABLE_EXECUTABLE_DIR ? 'install' : 'manual'
    updateAsset = selectUpdateAsset(release, process.platform, process.arch, updateVersion)

    if (updateMode === 'install') {
      let result
      try {
        updateCheckPromise = autoUpdater.checkForUpdates()
        result = await updateCheckPromise
      } catch (e) {
        return useManualUpdate(e)
      }
      if (!result?.isUpdateAvailable) return useManualUpdate(new Error('No compatible Windows installer was found.'))
    }
    if (settings.autoDownload) {
      if (updateMode === 'manual') downloadReleaseAsset(false).catch(error => console.error('Unable to download Cyberdog update:', error))
    } else sendUpdate(updateDownloadStarted ? 'downloading' : 'available')
  } catch (e) {
    console.error('Unable to check for Cyberdog updates:', e)
    sendUpdate('error')
  }
}

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.on('update-available', info => {
  updateVersion = info.version
  if (settings.autoDownload && updateMode === 'install') updateDownloadStarted = true
  sendUpdate(updateDownloadStarted ? 'downloading' : 'available')
})
autoUpdater.on('download-progress', progress => {
  updateDownloadStarted = true
  updatePercent = Math.floor(progress.percent)
  sendUpdate('downloading')
})
autoUpdater.on('update-downloaded', info => {
  updateReady = true
  updateDownloadStarted = false
  updatePercent = 100
  sendUpdate('ready', { version: info.version })
  if (installAfterDownload) autoUpdater.quitAndInstall()
})
autoUpdater.on('update-not-available', () => {
  if (updateMode === 'install' && updateVersion) useManualUpdate(new Error('The release does not contain a compatible update package.'))
})

function connect(s) {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let mismatch = false
    const t0 = Date.now()
    c.on('ready', () => { c.connectMs = Date.now() - t0; resolve(c) })
    c.on('error', e => reject(mismatch ? new Error(t('err.hostkey')) : e))
    c.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => secret(s) ?? '')))
    const privateKey = s.key && fs.existsSync(s.key) ? fs.readFileSync(s.key) : undefined
    if (privateKey) {
      const parsed = sshUtils.parseKey(privateKey, keyPassphrases.get(s.key))
      if (parsed instanceof Error) {
        if (/encrypted|passphrase|decrypt|integrity check/i.test(parsed.message)) { keyPassphrases.delete(s.key); reject(new Error('KEY_PASSPHRASE_REQUIRED')); return }
        reject(parsed); return
      }
    }
    c.connect({
      host: s.host,
      port: s.port,
      username: s.user,
      password: secret(s),
      privateKey,
      passphrase: s.key ? keyPassphrases.get(s.key) : undefined,
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
  transfers.cancelConnection(id)
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
  if ('group' in d) { if (d.group && groups.some(g => g.id === d.group)) s.group = d.group; else delete s.group }
  // duplication : sans nouveau mot de passe, on reprend celui (chiffré) du serveur d'origine
  const src = d.copyFrom && servers.find(x => x.id === d.copyFrom)
  if (src && !d.pass) Object.assign(s, { pass: src.pass, key: src.key })
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

// mise à jour légère d'un serveur (favori, groupe) sans toucher à la connexion
ipcMain.handle('servers:update', (_, id, patch) => {
  const s = find(id)
  if ('favorite' in patch) { if (patch.favorite) s.favorite = true; else delete s.favorite }
  if ('group' in patch) { if (patch.group && groups.some(g => g.id === patch.group)) s.group = patch.group; else delete s.group }
  persist()
  return list()
})

// ---------- groupes de serveurs (userData/groups.json) ----------
const groupsFile = () => path.join(currentConfigRoot(), 'groups.json')
let groups = []
const loadGroups = () => { try { groups = JSON.parse(fs.readFileSync(groupsFile(), 'utf8')) } catch { groups = [] } }
const saveGroups = () => { checkConfigRoot(); fs.writeFileSync(groupsFile(), JSON.stringify(groups, null, 2)) }
const groupByName = name => groups.find(g => g.name.toLowerCase() === name.toLowerCase())
const groupName = id => groups.find(g => g.id === id)?.name

ipcMain.handle('groups:list', () => groups)
ipcMain.handle('groups:save', (_, d) => {
  const name = d.name?.trim()
  if (!name) throw new Error(t('err.group_name_required'))
  const clash = groupByName(name)
  if (clash && clash.id !== d.id) throw new Error(t('err.group_exists'))
  const g = groups.find(x => x.id === d.id) ?? (groups.push({ id: crypto.randomUUID(), name }), groups.at(-1))
  g.name = name
  saveGroups()
  return groups
})
ipcMain.handle('groups:update', (_, id, patch) => {
  const g = groups.find(x => x.id === id)
  if (!g) return groups
  for (const k of ['collapsed', 'favorite']) if (k in patch) { if (patch[k]) g[k] = true; else delete g[k] }
  saveGroups()
  return groups
})
ipcMain.handle('groups:reorder', (_, ids) => { groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); saveGroups(); return groups })
ipcMain.handle('groups:delete', (_, id) => {
  groups = groups.filter(g => g.id !== id)
  servers.forEach(s => { if (s.group === id) delete s.group })
  saveGroups()
  persist()
  return { groups, servers: list() }
})

// ---------- chemins enregistrés (userData/paths.json) ----------
// { id, name, path, serverId } ; serverId absent = valable pour tous les serveurs
const pathsFile = () => path.join(currentConfigRoot(), 'paths.json')
let savedPaths = []
let pathsLoadError
const loadPaths = () => {
  try {
    const stored = readList(pathsFile())
    savedPaths = configTransfer.linkPaths(stored, servers)
    pathsLoadError = null
    if (JSON.stringify(stored) !== JSON.stringify(savedPaths)) {
      try { writePaths() } catch (e) { console.warn('Saved-path metadata could not be persisted:', e.message) }
    }
  }
  catch (e) { savedPaths = []; pathsLoadError = e; console.error('Cannot read saved paths:', e) }
}
const writePaths = () => { checkConfigRoot(); if (pathsLoadError) throw pathsLoadError; writeList(pathsFile(), savedPaths) }
ipcMain.handle('paths:list', () => savedPaths)
ipcMain.handle('paths:save', (_, d) => {
  if (pathsLoadError) throw pathsLoadError
  const p = String(d.path || '').trim()
  if (!p.startsWith('/') && p !== '~' && !p.startsWith('~/')) throw new Error(t('err.path_required'))
  const server = d.serverId ? find(d.serverId) : null
  let e = savedPaths.find(x => x.id === d.id)
  if (!e) savedPaths.push((e = { id: crypto.randomUUID() }))
  Object.assign(e, { name: String(d.name || '').trim(), path: p })
  if (d.serverId) {
    e.serverId = d.serverId
    e.server = { host: server.host, port: server.port, user: server.user }
  } else { delete e.serverId; delete e.server }
  writePaths()
  return savedPaths
})
ipcMain.handle('paths:delete', (_, id) => { if (pathsLoadError) throw pathsLoadError; savedPaths = savedPaths.filter(x => x.id !== id); writePaths(); return savedPaths })

// ajoute un serveur venant d'un import (Cyberduck ou zip) sauf doublon host/port/user
function addImported(b) {
  if (typeof b?.host !== 'string' || !b.host.trim()) return false
  const s = { name: String(b.name || b.host), host: b.host.trim(), port: +b.port || 22, user: String(b.user ?? ''), key: typeof b.key === 'string' ? b.key : undefined }
  if (servers.some(x => x.host === s.host && x.port === s.port && x.user === s.user)) return false
  const gname = typeof b.group === 'string' ? b.group.trim() : ''
  if (gname) {
    const g = groupByName(gname) ?? (groups.push({ id: crypto.randomUUID(), name: gname }), groups.at(-1))
    s.group = g.id
    saveGroups()
  }
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

// ---------- Configuration bundles ----------
const configData = () => ({ groups, servers, actions, paths: savedPaths })
const publicConfig = () => ({ groups, servers: list(), actions, paths: savedPaths })
ipcMain.handle('config:catalog', () => { checkConfigRoot(); if (pathsLoadError) throw pathsLoadError; return publicConfig() })
ipcMain.handle('config:export', async (_, selection) => {
  if (pathsLoadError) throw pathsLoadError
  // Add portable server references before filtering: a path can target an existing server on import.
  const data = configTransfer.select(configTransfer.portable(configData()), selection)
  const count = configTransfer.TYPES.reduce((n, k) => n + data[k].length, 0)
  if (!count) throw new Error(t('config.empty'))
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), 'cyberdog-config.zip'), filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  configTransfer.writeBundle(data, r.filePath)
  return { path: r.filePath, count }
})
function mergeConfiguration(data) {
  checkConfigRoot()
  if (pathsLoadError) throw pathsLoadError
  const result = configTransfer.merge(configData(), data)
  const before = configData()
  try {
    ;({ groups, servers, actions, paths: savedPaths } = result.data)
    persist(); persistActions(); saveGroups(); writePaths()
  } catch (e) {
    ;({ groups, servers, actions, paths: savedPaths } = before)
    try { persist(); persistActions(); saveGroups(); writePaths() } catch (rollback) { console.error('Configuration rollback failed:', rollback) }
    throw e
  }
  return { ...publicConfig(), added: result.added, skipped: result.skipped }
}
ipcMain.handle('config:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Cyberdog configuration ZIP', extensions: ['zip'] }] })
  if (r.canceled) return null
  return mergeConfiguration(configTransfer.readBundle(r.filePaths[0]))
})
ipcMain.handle('config:import-client', async (_, source) => {
  if (!['filezilla', 'winscp'].includes(source)) throw new Error('Unsupported import source')
  const r = await dialog.showOpenDialog(win, { title: source === 'filezilla' ? 'FileZilla — XML' : 'WinSCP — INI', properties: ['openFile'], filters: [{ name: source, extensions: [source === 'filezilla' ? 'xml' : 'ini'] }] })
  if (r.canceled) return null
  const file = r.filePaths[0]
  if (fs.statSync(file).size > 8e6) throw new Error('Import exceeds 8 MB')
  const bytes = fs.readFileSync(file)
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
  return mergeConfiguration({ groups: [], servers: clientImport[source](text), actions: [], paths: [] })
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
  const resolved = await require('./sftp-navigation').resolveDirectory(s, dir)
  dir = resolved.path
  const selected = resolved.selected
  const items = (await P(s, 'readdir', dir)).filter(f => f.filename !== '.' && f.filename !== '..')
  const entries = await Promise.all(items.map(async f => {
    const a = f.attrs
    const type = a.mode & 0o170000
    const isLink = type === 0o120000
    let isDir = type === 0o040000
    if (isLink) isDir = await P(s, 'stat', posix.join(dir, f.filename)).then(x => x.isDirectory(), () => false)
    const l = f.longname.split(/\s+/)
    return { name: f.filename, size: a.size, mtime: a.mtime * 1000, mode: a.mode & 0o7777, uid: a.uid, gid: a.gid, owner: l[2] ?? a.uid, group: l[3] ?? a.gid, isDir, isLink }
  }))
  return { path: dir, entries, selected }
})

ipcMain.handle('sftp:mkdir', (_, id, p) => P(S(id), 'mkdir', p))
// flag wx: ne jamais écraser un fichier existant
ipcMain.handle('sftp:touch', (_, id, p) => P(S(id), 'writeFile', p, '', { flag: 'wx' }))
ipcMain.handle('sftp:rename', (_, id, from, to) => P(S(id), 'rename', from, to))
ipcMain.handle('sftp:ownership', async (_, id, file) => {
  const attrs = await P(S(id), 'stat', file)
  let users = []
  try {
    const result = await exec(getConn(id).client, 'getent passwd 2>/dev/null || cat /etc/passwd', { timeout: 10000 })
    if (result.code === 0) users = permissions.parseUsers(result.out)
  } catch {}
  return { uid: attrs.uid, gid: attrs.gid, mode: attrs.mode & 0o7777, users }
})
ipcMain.handle('sftp:attributes', async (_, id, file, attrs) => {
  try { await permissions.applyAttributes(S(id), file, attrs) }
  catch (error) { if (error.ownerChanged) throw new Error(t('perm.partial', { error: error.message })); throw error }
})
ipcMain.handle('sftp:chmod', (_, id, p, value) => {
  if (typeof value !== 'string' || !/^[0-7]{3,4}$/.test(value) || parseInt(value, 8) > 0o7777) throw new Error(i18n.t(settings.lang, 'err.permissions'))
  return P(S(id), 'chmod', p, parseInt(value, 8))
})

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

const { executeTransfer } = require('./transfer-files')(transfers)
ipcMain.handle('transfers:list', () => transfers.list())
ipcMain.handle('transfers:cancel', (_, id) => transfers.cancel(id))
ipcMain.handle('sftp:download', async (_, id, paths) => {
  const s = S(id), downloads = app.getPath('downloads')
  let target, single = paths.length === 1 && !(await P(s, 'stat', paths[0])).isDirectory()
  if (single) { const r = await dialog.showSaveDialog(win, { defaultPath: path.join(downloads, posix.basename(paths[0])) }); if (r.canceled) return null; target = r.filePath }
  else { const r = await dialog.showOpenDialog(win, { title: t('dlg.download_into'), properties: ['openDirectory', 'createDirectory'] }); if (r.canceled) return null; target = r.filePaths[0] }
  const ok = await transfers.run(id, 'download', posix.basename(paths[0]), job => executeTransfer(s, 'download', paths, p => single ? target : path.join(target, posix.basename(p)), job))
  return ok ? target : null
})
ipcMain.handle('sftp:upload', async (_, id, locals, dir) => {
  const s = S(id), clash = []
  for (const l of locals) if (await P(s, 'stat', posix.join(dir, path.basename(l))).then(() => true, () => false)) clash.push(path.basename(l))
  if (clash.length) {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [t('dlg.replace'), t('btn.cancel')], defaultId: 1, cancelId: 1, message: t('dlg.exists'), detail: clash.join('\n') })
    if (r.response) return false
  }
  return transfers.run(id, 'upload', path.basename(locals[0]), job => executeTransfer(s, 'upload', locals, p => posix.join(dir, path.basename(p)), job))
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

// ---------- Process Explorer (SSH, Linux sans agent) ----------
ipcMain.handle('process:list', async (_, id) => {
  const r = await exec(getConn(id).client, 'sh -s', { input: processModel.SNAPSHOT, max: 8e6 })
  if (r.code !== 0) throw new Error(r.out || 'Process snapshot failed')
  if (r.out.length >= 8e6) throw new Error('Process snapshot exceeds size limit')
  return processModel.parse(r.out)
})
ipcMain.handle('process:details', async (_, id, process) => {
  const r = await exec(getConn(id).client, 'sh -s', { input: processModel.details(process) })
  if (r.code !== 0) throw new Error(r.out || 'Process unavailable')
  return r.out
})
ipcMain.handle('process:signal', async (_, id, process, signal) => {
  const r = await exec(getConn(id).client, 'sh -s', { input: processModel.signal(process, signal) })
  if (r.code !== 0) throw new Error(r.out || 'Signal failed')
})

// ---------- Certificates and local SSH keys ----------
async function certificateCommand(c, script, sudo, timeout = 60000) {
  const privilege = sudo ? sudoOf(c) : null
  return exec(c.client, `${privilege ? privilege.prefix + ' ' : ''}sh -c ${q(script)}`, { input: privilege?.input, timeout, max: 2e6 })
}
ipcMain.handle('cert:scan', async (_, id, options = {}) => {
  const c = getConn(id)
  const result = await certificateCommand(c, certificateTools.scanScript(options.directory || ''), options.sudo === true)
  if (result.code !== 0) throw new Error(result.out || 'Certificate scan failed')
  if (result.out.length >= 2e6) throw new Error('Certificate scan exceeds size limit')
  c.certificates = certificateTools.parseScan(result.out)
  return c.certificates
})
ipcMain.handle('cert:renew', async (_, id, fingerprint, sudo = false) => {
  const c = getConn(id)
  const cert = c.certificates?.certificates.find(x => x.fingerprint === fingerprint)
  if (!c.certificates?.certbot || !cert?.certName) throw new Error(t('cert.unsupported'))
  const result = await certificateCommand(c, certificateTools.renewScript(cert.certName), sudo === true, 180000)
  if (result.code !== 0) throw new Error(result.out || 'Certificate renewal failed')
  return { out: result.out }
})
const localKeyStore = () => sshKeys.createKeyStore(path.join(os.homedir(), '.ssh', 'cyberdog'), path.join(app.getPath('userData'), 'ssh-keys.json'))
ipcMain.handle('keys:remote', async (_, id) => {
  const s = S(id), home = await P(s, 'realpath', '.')
  const file = posix.join(home, '.ssh/authorized_keys')
  let contents
  try { const st = await P(s, 'stat', file); if (st.size > 2 * 1024 * 1024) throw new Error('authorized_keys exceeds 2 MB'); contents = await P(s, 'readFile', file) }
  catch (e) { if (e.code === 2) return { path: file, items: [] }; throw e }
  return { path: file, items: sshKeys.parseAuthorizedKeys(String(contents)) }
})
ipcMain.handle('keys:list', () => localKeyStore().list())
ipcMain.handle('keys:generate', async (_, options) => {
  const key = await localKeyStore().generate(options)
  if (options.passphrase) keyPassphrases.set(key.privatePath, options.passphrase)
  return localKeyStore().list()
})
ipcMain.handle('keys:import', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: path.join(os.homedir(), '.ssh'), filters: [{ name: 'SSH public key', extensions: ['pub'] }] })
  if (result.canceled) return null
  localKeyStore().importPublic(result.filePaths[0])
  return localKeyStore().list()
})
ipcMain.handle('keys:install', async (_, id, keyId) => {
  const key = localKeyStore().get(keyId)
  const result = await exec(getConn(id).client, 'sh -s', { input: sshKeys.installScript(key.publicKey) })
  if (result.code !== 0) throw new Error(result.out || 'Public key installation failed')
  return { exists: result.out.trim() === 'EXISTS' }
})
ipcMain.handle('keys:use', (_, serverId, keyId) => {
  const key = localKeyStore().get(keyId)
  if (!key.hasPrivate) throw new Error(t('keys.no_private'))
  const server = find(serverId)
  server.key = key.privatePath
  persist()
  return list()
})
ipcMain.handle('keys:unlock', (_, serverId, passphrase) => {
  const server = find(serverId)
  if (!server.key || typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error(t('keys.unlock_failed'))
  const parsed = sshUtils.parseKey(fs.readFileSync(server.key), passphrase)
  if (parsed instanceof Error) throw new Error(t('keys.unlock_failed'))
  keyPassphrases.set(server.key, passphrase)
})
ipcMain.handle('keys:reveal', (_, keyId) => { const key = localKeyStore().get(keyId); shell.showItemInFolder(key.publicPath) })

// ---------- Santé du serveur ----------
const healthOf = async (client, connectMs) => {
  const t0 = Date.now()
  await exec(client, 'true', { timeout: 10000 })
  const latencyMs = Date.now() - t0
  const r = await exec(client, 'sh -s', { input: HEALTH_SCRIPT })
  return { ...parseHealth(r.out), latencyMs, connectMs, ts: Date.now() }
}
ipcMain.handle('health:check', (_, id) => { const c = getConn(id); return healthOf(c.client, c.connectMs) })

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

// sudo : mot de passe enregistré sur stdin (jamais en argument), sinon `sudo -n`
const sudoOf = c => {
  const pw = c.server && secret(c.server)
  return { prefix: pw ? "sudo -S -p ''" : 'sudo -n', input: pw ? pw + '\n' : undefined }
}

// ---------- Désarchivage sur le serveur ----------
ipcMain.handle('sftp:extract', async (_, id, file, toFolder) => {
  const c = getConn(id)
  const name = posix.basename(file)
  const k = archive.kind(name)
  if (!k) throw new Error(t('err.archive_unknown'))
  const dir = posix.dirname(file)
  const target = toFolder && !k.single ? posix.join(dir, archive.folderName(name)) : dir
  const r = await exec(c.client, 'sh -s', { input: archive.command(name, file, target, q), timeout: 600000 })
  const missing = r.out.match(/MISSING:(\S+)/)
  if (missing) throw new Error(t('err.tool_missing', { tool: missing[1] }))
  if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`)
})

// ---------- Logs en direct (journalctl, fichiers, docker) ----------
const streams = new Map() // id -> { stream }
const UNIT_NAME = /^[\w@:.\\-]+$/
const DOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/

ipcMain.handle('log:start', async (_, connId, spec) => {
  const c = getConn(connId)
  let cmd
  if (spec.kind === 'journal') {
    if (spec.pid != null && (!Number.isSafeInteger(spec.pid) || spec.pid <= 0)) throw new Error('invalid pid')
    if (spec.unit && !UNIT_NAME.test(spec.unit)) throw new Error('invalid unit')
    cmd = ['journalctl', '-f', '-n', '300', '-o', 'json', '--no-pager', ...(spec.unit ? ['-u', spec.unit] : []), ...(spec.pid ? ['_PID=' + spec.pid] : [])]
  } else if (spec.kind === 'file') {
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) throw new Error('invalid path')
    cmd = ['tail', '-n', '300', '-F', spec.path]
  } else if (spec.kind === 'docker') {
    if (!DOCKER_ID.test(spec.id)) throw new Error('invalid id')
    cmd = ['docker', 'logs', '-f', '--tail', '300', spec.id]
  } else throw new Error('invalid source')

  const s = spec.sudo || (spec.kind === 'docker' && c.dockerSudo) ? sudoOf(c) : null
  const stream = await new Promise((res, rej) => c.client.exec(`exec ${s ? s.prefix + ' ' : ''}${cmd.map(q).join(' ')}`, (e, st) => (e ? rej(e) : res(st))))
  if (s?.input) stream.write(s.input)

  const id = crypto.randomUUID()
  streams.set(id, { stream })
  let pending = []
  let timer
  const flush = () => {
    timer = null
    if (pending.length) send('log:data', id, pending.slice(-2000))
    pending = []
  }
  // découpe en lignes par canal ; envoi groupé toutes les 120 ms
  const splitter = isErr => {
    let buf = ''
    stream.setEncoding?.('utf8')
    return chunk => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const l of parts) if (l.trim()) pending.push(logfmt.normalize(spec.kind, l.replace(/\r$/, ''), isErr))
      timer ??= setTimeout(flush, 120)
    }
  }
  stream.on('data', splitter(false))
  stream.stderr.setEncoding('utf8')
  stream.stderr.on('data', splitter(true))
  stream.on('close', code => { clearTimeout(timer); flush(); streams.delete(id); send('log:end', id, code) })
  return id
})

ipcMain.handle('log:stop', (_, id) => {
  const s = streams.get(id)
  if (!s) return
  streams.delete(id)
  try { s.stream.signal('TERM') } catch {} // le serveur peut ne pas supporter les signaux
  s.stream.close()
})

// recherches favorites (un fichier JSON pour toutes les sources)
const favFile = () => path.join(currentConfigRoot(), 'log-favorites.json')
let favs = []
const loadFavs = () => { try { favs = JSON.parse(fs.readFileSync(favFile(), 'utf8')) } catch { favs = [] } }
const saveFavs = () => fs.writeFileSync(favFile(), JSON.stringify(favs, null, 2))
ipcMain.handle('favs:list', () => favs)
ipcMain.handle('favs:save', (_, f) => {
  favs.push({ id: crypto.randomUUID(), name: String(f.name || f.text || 'Log').slice(0, 60), source: f.source, text: String(f.text || ''), level: f.level || 'all' })
  saveFavs()
  return favs
})
ipcMain.handle('favs:delete', (_, id) => { favs = favs.filter(f => f.id !== id); saveFavs(); return favs })

// ---------- Docker ----------
// docker direct ; si « permission denied » (pas dans le groupe docker) on réessaie avec sudo et on s'en souvient pour la connexion
async function docker(c, args, { timeout = 30000 } = {}) {
  const run = sudo => {
    const s = sudo ? sudoOf(c) : null
    return exec(c.client, `${s ? s.prefix + ' ' : ''}docker ${args.map(q).join(' ')}`, { timeout, input: s?.input })
  }
  let r = await run(!!c.dockerSudo)
  if (!c.dockerSudo && r.code !== 0 && /permission denied/i.test(r.out)) { c.dockerSudo = true; r = await run(true) }
  if (r.code === 127 || /docker: (command )?not found/i.test(r.out)) throw new Error(t('docker.unavailable'))
  return r
}
const jsonLines = out => out.split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const lastLines = out => out.trim().split('\n').slice(-2).join(' ')

ipcMain.handle('docker:list', async (_, id) => {
  const c = getConn(id)
  const [ps, st] = await Promise.all([docker(c, ['ps', '-a', '--format', '{{json .}}']), docker(c, ['stats', '--no-stream', '--format', '{{json .}}'])])
  if (ps.code !== 0) throw new Error(lastLines(ps.out))
  const stats = new Map(jsonLines(st.out).map(s => [s.ID ?? s.Container, s]))
  return jsonLines(ps.out).map(p => {
    const s = stats.get(p.ID)
    return { id: p.ID, name: p.Names, image: p.Image, state: p.State, status: p.Status, ports: p.Ports, cpu: s ? parseFloat(s.CPUPerc) : null, mem: s ? parseFloat(s.MemPerc) : null, memUsage: s?.MemUsage }
  })
})

ipcMain.handle('docker:images', async (_, id) => {
  const r = await docker(getConn(id), ['images', '--format', '{{json .}}'])
  if (r.code !== 0) throw new Error(lastLines(r.out))
  return jsonLines(r.out).map(i => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince }))
})

ipcMain.handle('docker:inspect', async (_, id, kind, target) => {
  if (!DOCKER_ID.test(target) || !['image', 'container'].includes(kind)) throw new Error('invalid')
  const r = await docker(getConn(id), kind === 'image' ? ['image', 'inspect', target] : ['inspect', target])
  if (r.code !== 0) throw new Error(lastLines(r.out))
  const json = JSON.parse(r.out)
  return { rows: dockerfmt.summarize(kind, json), raw: JSON.stringify(json, null, 2).slice(0, 200000) }
})

ipcMain.handle('docker:action', async (_, id, target, action) => {
  if (!DOCKER_ID.test(target) || !['start', 'stop', 'restart'].includes(action)) throw new Error('invalid')
  const r = await docker(getConn(id), [action, target], { timeout: 90000 })
  if (r.code !== 0) throw new Error(lastLines(r.out))
})

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
app.whenReady().then(() => {
  loadSettings()
  load()
  loadGroups()
  loadPaths()
  loadFavs()
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../build/icon.png'))
  if (isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Cyberdog',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: t('settings.title') + '…', accelerator: 'Cmd+,', click: () => win && win.webContents.send('app:open-settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]))
  } else Menu.setApplicationMenu(null)
  const windowStateFile = path.join(app.getPath('userData'), 'window-state.json')
  let windowState
  try { windowState = JSON.parse(fs.readFileSync(windowStateFile, 'utf8')) } catch {}
  const primary = screen.getPrimaryDisplay()
  const displays = [primary, ...screen.getAllDisplays().filter(d => d.id !== primary.id)]
  const windowBounds = restoreWindow(windowState, displays)
  win = new BrowserWindow({
    ...windowBounds,
    minWidth: Math.min(1040, windowBounds.width),
    minHeight: Math.min(560, windowBounds.height),
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : app.isPackaged ? {} : { icon: path.join(__dirname, '../build/icon.png') }),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171d' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.once('ready-to-show', () => {
    if (windowState?.maximized) win.maximize()
    win.show()
  })
  let windowSaveTimer
  const saveWindow = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    try { fs.writeFileSync(windowStateFile, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })) } catch (e) { console.warn('Cannot save window state:', e.message) }
  }
  const scheduleWindowSave = () => { clearTimeout(windowSaveTimer); windowSaveTimer = setTimeout(saveWindow, 250) }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, scheduleWindowSave)
  win.on('close', () => { clearTimeout(windowSaveTimer); saveWindow() })
  win.webContents.once('did-finish-load', () => {
    if (settings.configPath && !fs.existsSync(settings.configPath)) send('toast', t('config.unavailable'), true, 10000)
    if (pathsLoadError) send('toast', t('config.paths_error'), true, 10000)
    checkForAppUpdate()
    setInterval(checkForAppUpdate, 6 * 60 * 60 * 1000).unref()
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
