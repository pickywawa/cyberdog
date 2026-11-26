const localSshKeys=require('./local-ssh-keys')
const {serverOptions}=require('./server-options')
const serverType=require('./server-type')
const objectStorage=require('./object-storage')
const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, nativeTheme, nativeImage, shell, screen, net, clipboard, powerMonitor } = require('electron')
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
const { exportZip, readZip } = require('./share')
const configTransfer = require('./config-transfer')
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
const scheduleModel = require('./schedules')
const kubeModel = require('./kube')
const dbModel = require('./databases')
const { HEALTH_SCRIPT, parseHealth, SERVICES_CMD, parseServices, UNIT_RE, SVC_ACTIONS } = require('./health')
const { restoreWindow } = require('./window-state')

const { Transfers } = require('./transfers')
let transferEngine
const transfers = new Transfers((...args) => send(...args), path.join(app.getPath('userData'), 'transfers.json'), (job, resuming) => transferEngine.runJob(job, resuming))
const posix = path.posix
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
// Mac App Store build: sandboxed, updated by the App Store, no access outside the container except user-picked files.
const isMas = !!process.mas
let win
let servers = []
let actions = []
const pendingVaultClients = new Set()
const conns = new Map() // id -> { client, sftp?, stream?, server?, connectMs?, tmp: [dirs] }

const DEFAULT_SETTINGS = { lang: 'en', theme: 'dracula', configPath: '', defaultEditor: 'internal', editorWrap: false, editorMinimap: true, editorFontSize: 13, autoDownload: false, restoreConnections: false, showLocalPane: false, maxTransfers: 2 }
const checkConfigRoot = () => {
  if (settings.configPath && !fs.existsSync(settings.configPath)) throw new Error(t('config.unavailable'))
}
const currentConfigRoot = () => {
  const custom = settings?.configPath?.trim()
  return custom || app.getPath('userData')
}

const accountIPC = (channel, handler) => ipcMain.handle(channel, (event,...args) => {
  const expected = require('node:url').pathToFileURL(path.join(__dirname,'index.html')).href
  if(!win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || event.senderFrame.url.split(/[?#]/)[0]!==expected) throw new Error('access_denied')
  return handler(...args)
})
const extension=require('./workspace/main').createExtension({
 accountIPC,send:(...args)=>send(...args),conns,pendingVaultClients,list:()=>list(),t:(...a)=>t(...a),
 get servers(){return servers},set servers(value){servers=value},persist:()=>persist(),
 get groups(){return groups},set groups(value){groups=value},saveGroups:()=>saveGroups(),
 get actions(){return actions},set actions(value){actions=value},persistActions:()=>persistActions(),
 get savedPaths(){return savedPaths},set savedPaths(value){savedPaths=value},writePaths:()=>writePaths(),
 serverOptions,readPrivateKey:localSshKeys.readPrivateKey,keyPassphrase:id=>keyPassphrases.get(id),
 ssh:{Client,utils:sshUtils},
 credentials:async s=>{const a=await extension.connectionAuth(s);return{password:s.authMode==='key'?undefined:a?.password??secret(s),privateKey:s.authMode==='password'?undefined:a?.privateKey||(s.key?fs.readFileSync(s.key):undefined),passphrase:a?.passphrase||(s.key?keyPassphrases.get(s.key):undefined),agent:a||isMas?undefined:process.env.SSH_AUTH_SOCK||(isWin?'\\\\.\\pipe\\openssh-ssh-agent':undefined)}},
 allGroups:()=>allGroups(),allActions:()=>allActions(),allPaths:()=>allPaths(),
})

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
  if (isMas) { settings.configPath = ''; settings.autoDownload = false }
  // Retain custom paths even when an external volume is temporarily unavailable.
  if (!settings.defaultEditor) settings.defaultEditor = 'internal'
  // 1.13: files open in the built-in editor, except for people who had picked an application of their own
  if (!settings.editorMigrated) {
    if (settings.defaultEditor === 'system') settings.defaultEditor = 'internal'
    settings.editorMigrated = true
    try { if (fs.existsSync(settingsFile())) fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)) } catch {}
  }
  updater.setAutoDownload(settings.autoDownload)
  transfers.setLimit(settings.maxTransfers)
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
  if (typeof patch.defaultEditor === 'string') settings.defaultEditor = patch.defaultEditor.trim() || 'internal'
  if (typeof patch.editorWrap === 'boolean') settings.editorWrap = patch.editorWrap
  if (typeof patch.editorMinimap === 'boolean') settings.editorMinimap = patch.editorMinimap
  if (Number.isInteger(patch.editorFontSize) && patch.editorFontSize >= 9 && patch.editorFontSize <= 32) settings.editorFontSize = patch.editorFontSize
  if (typeof patch.restoreConnections === 'boolean') {
    settings.restoreConnections = patch.restoreConnections
    if (!settings.restoreConnections) { try { fs.unlinkSync(sessionFile()) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  }
  if (typeof patch.autoDownload === 'boolean') settings.autoDownload = patch.autoDownload
  if (typeof patch.showLocalPane === 'boolean') settings.showLocalPane = patch.showLocalPane
  if (Number.isInteger(patch.maxTransfers) && patch.maxTransfers >= 1 && patch.maxTransfers <= 10) { settings.maxTransfers = patch.maxTransfers; transfers.setLimit(patch.maxTransfers) }
  if (isMas) { delete patch.configPath; delete patch.autoDownload }
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
  updater.setAutoDownload(settings.autoDownload)
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

const pub = s => ({ id: s.id, type: s.type, url: s.url, region: s.region, bucket: s.bucket, preset: s.preset, virtualHost: s.virtualHost, security: s.security, insecureTls: s.insecureTls, hasToken: !!s.token, hasProxyPass: !!s.proxyPass, proxyType: s.proxyType, proxyHost: s.proxyHost, proxyPort: s.proxyPort, proxyUser: s.proxyUser, authMethod: s.authMethod, domain: s.domain, profile: s.profile, azureAuth: s.azureAuth, tenant: s.tenant, clientId: s.clientId, name: s.name, host: s.host, port: s.port, user: s.user, hasPass: !!s.pass||!!s.hasPass,authMode:s.authMode||(s.key?'key':'password'),hasSyncedCredential:!!s.hasSyncedCredential,hasStoredKey:!!s.keyData||!!s.hasStoredKey,key:s.key, website:s.website,tags:s.tags,downloadDir:s.downloadDir,loading:!!s.loading, group: s.group, favorite: !!s.favorite, teamId:s.teamId, teamRole:s.teamRole,canEditServers:s.canEditServers,personal:s.personal,networkAccess:s.networkAccess,vaultId:s.vaultId,vaultName:s.vaultName,vaultProvider:s.vaultProvider,itemId:s.vaultId?s.itemId:undefined })
const list = () => [...servers,...extension.servers()].map(pub)
const secret = s => (s.pass ? safeStorage.decryptString(Buffer.from(s.pass, 'base64')) : undefined)
const find = id => [...servers,...extension.servers()].find(s => s.id === id) ?? (() => { throw new Error(t('err.server_not_found')) })()

// ---------- SSH ----------
const P = (o, m, ...a) => new Promise((res, rej) => o[m](...a, (e, r) => (e ? rej(e) : res(r))))
const q = p => `'${p.replace(/'/g, `'\\''`)}'`
const send = (...a) => win && !win.isDestroyed() && win.webContents.send(...a)
ipcMain.handle('app:version', () => app.getVersion())
const updater = require('./updater')({ app, ipcMain, net, shell, dialog, send, t: (...a) => t(...a), getWindow: () => win, getSettings: () => settings, isWin })

async function connect(s, options = {}) {
  if(s.networkAccess&&s.networkAccess.mode!=='direct'){
    return extension.openConnection(s, options)
  }
  const auth=await extension.connectionAuth(s)
  let pending
  return new Promise((resolve, reject) => {
    const c = new Client()
    if(auth){pending={client:c,server:s};pendingVaultClients.add(pending);c.once('close',()=>reject(new Error(auth.error||'connection_closed')))}
    let mismatch = false
    const t0 = Date.now()
    c.on('ready', () => { c.connectMs = Date.now() - t0; resolve(c) })
    c.on('error', e => reject(mismatch ? new Error(t('err.hostkey')) : auth?new Error(auth.error||'connection_failed'):e))
    c.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => s.authMode==='key'?'':auth?.password ?? secret(s) ?? '')))
    const privateKey = s.authMode==='password'?undefined:auth?.privateKey || (s.key && fs.existsSync(s.key) ? fs.readFileSync(s.key) : undefined)
    if (privateKey) {
      const parsed = sshUtils.parseKey(privateKey, auth?.passphrase || keyPassphrases.get(s.key))
      if (parsed instanceof Error) {
        if(auth){reject(new Error(auth.keyError||'invalid_key'));return}
        if (/encrypted|passphrase|decrypt|integrity check/i.test(parsed.message)) { keyPassphrases.delete(s.key||'cloud:'+s.id); reject(new Error('KEY_PASSPHRASE_REQUIRED')); return }
        reject(parsed); return
      }
    }
    c.connect({
      host: s.host,
      port: s.port,
      username: s.user,
      password: s.authMode==='key'?undefined:auth?.password || secret(s),
      privateKey,
      passphrase: auth?.passphrase || (s.key ? keyPassphrases.get(s.key) : undefined),
      agent: auth || isMas ? undefined : process.env.SSH_AUTH_SOCK || (isWin ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined),
      tryKeyboard: true,
      keepaliveInterval: 15000,
      readyTimeout: 15000,
      hostHash: 'sha256',
      // trust on first use
      hostVerifier: fp => {
        if (!s.fp) { s.fp = fp; try{if(extension.owns(s.id))extension.saveCredentials(s,{fp});else persist()}catch{mismatch=true;return false} }
        mismatch = s.fp !== fp
        return !mismatch
      },
    })
  }).finally(()=>{if(pending)pendingVaultClients.delete(pending);if(auth){auth.password='';auth.privateKey='';auth.passphrase=''}})
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

ipcMain.handle('servers:list', () => { Promise.resolve(extension.init()).catch(()=>{}); return list() })
ipcMain.handle('app:downloads',()=>app.getPath('downloads'))

async function saveServer(d) {
  if(extension.handlesServerData(d))return extension.saveServer(d)

  if(d.authMode!==undefined&&!['password','key'].includes(d.authMode))throw Error('invalid_auth_mode')
  if(d.key)localSshKeys.readPrivateKey(d.key)
  const options=serverOptions(d,servers.find(s=>s.id===(d.id||d.copyFrom)))
  const networkAccess=await extension.validateServer?.(d)
  const prev = servers.find(x => x.id === (d.id || d.copyFrom))
  const form = { ...d, type: d.type || prev?.type }
  // an endpoint that was only derived from the previous preset/region must follow the new ones
  if (form.type === 's3' && prev?.type === 's3' && form.url === prev.url && form.url === serverType.storageFields({ type: 's3', preset: prev.preset, region: prev.region }).url) form.url = ''
  if (form.type === 's3' && prev?.type === 's3' && (form.preset || '') !== (prev.preset || '') && form.region === prev.region && form.region === (serverType.S3_PRESETS[prev.preset || '']?.region || 'us-east-1')) form.region = ''
  const storage = serverType.storageFields(form)
  const name = d.name?.trim(), host = storage ? storage.host : d.host?.trim(), user = d.user?.trim()
  const noLogin = (storage?.type === 's3' && storage.profile) || (['azure', 'azurefiles'].includes(storage?.type) && storage.azureAuth === 'entra' && !user) || ['dropbox', 'onedrive', 'gdrive', 'smb'].includes(storage?.type)
  if (!host || (!user && !noLogin)) throw new Error(t(storage ? 'err.url_user_required' : 'err.host_user_required'))
  if(!storage&&(!Number.isInteger(Number(d.port??22))||Number(d.port??22)<1||Number(d.port??22)>65535))throw Error('invalid_server')
  let s = servers.find(x => x.id === d.id)
  if (!s) servers.push((s = { id: crypto.randomUUID() }))
  Object.assign(s, options, { name: name || host, host, port: +d.port || 22, user, fp: undefined }, storage)
  if(networkAccess!==undefined)s.networkAccess=networkAccess
  if (['azure', 'azurefiles'].includes(storage?.type) && prev && (prev.azureAuth || 'key') !== storage.azureAuth && !d.pass) delete s.pass // an account key must not become a client secret
  // cloud drives keep a refresh token in `pass`: another application, or an explicit reset, means signing in again
  if (['dropbox', 'onedrive', 'gdrive'].includes(storage?.type) && ((prev && (prev.clientId || '') !== storage.clientId) || d.resetAuth)) delete s.pass
  if(d.authMode!==undefined){s.authMode=d.authMode;if(s.authMode==='password'){delete s.key;delete s.keyData}else delete s.pass}
  if(d.key&&d.authMode!=='password'){s.key=d.key;delete s.keyData}
  if ('group' in d) { if (d.group && groups.some(g => g.id === d.group)) s.group = d.group; else delete s.group }
  // duplication : sans nouveau mot de passe, on reprend celui (chiffré) du serveur d'origine
  const src = d.copyFrom && servers.find(x => x.id === d.copyFrom)
  if (src && !d.pass) {if(d.authMode!=='key')s.pass=src.pass;if(d.authMode!=='password'&&!d.key)s.key=src.key}
  // secondary secrets: S3 session token / Google client secret (token), proxy password
  const secretOf = v => { if (!safeStorage.isEncryptionAvailable()) throw new Error(t('err.keychain')); return safeStorage.encryptString(v.trim()).toString('base64') }
  const hasToken = ['s3', 'gdrive'].includes(storage?.type)
  if (hasToken && d.token) s.token = secretOf(d.token)
  if (hasToken && d.clearToken) delete s.token
  if (src && hasToken && !d.token && !d.clearToken) s.token = src.token
  if (!hasToken) delete s.token
  if (storage && storage.proxyType && storage.proxyType !== 'none') {
    if (d.proxyPass) s.proxyPass = secretOf(d.proxyPass)
    else if (src && !prev?.proxyPass && src.proxyPass) s.proxyPass = src.proxyPass
    if (!storage.proxyUser) delete s.proxyPass
  } else delete s.proxyPass
  if (d.pass&&d.authMode!=='key') {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('err.keychain'))
    s.pass = safeStorage.encryptString(d.pass).toString('base64')
  }
  persist()
  return list()
}
ipcMain.handle('servers:save', (_, d) => saveServer(d))

ipcMain.handle('servers:delete', async (_,id)=>{await extension.beforeDeleteServer?.(id);if(extension.owns(id))return extension.removeServer(id);servers=servers.filter(s=>s.id!==id);persist();return list()})

ipcMain.handle('servers:reorder', (_, ids) => {
  servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  persist()
  return list()
})

// mise à jour légère d'un serveur (favori, groupe) sans toucher à la connexion
ipcMain.handle('servers:update', async (_, id, patch) => {
  const s = find(id)
  if(extension.owns(id))return extension.updateServer(s,patch)
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

const allGroups=()=>[...groups,...extension.groups()]
const allActions=()=>[...actions,...extension.actions()]
const allPaths=()=>[...savedPaths,...extension.paths()]

ipcMain.handle('groups:list', () => allGroups())
ipcMain.handle('groups:save', async (_, d) => {
  if(await extension.routeAsset('groups',d))return allGroups()
  const name = d.name?.trim()
  if (!name) throw new Error(t('err.group_name_required'))
  const clash = groupByName(name)
  if (clash && clash.id !== d.id) throw new Error(t('err.group_exists'))
  const g = groups.find(x => x.id === d.id) ?? (groups.push({ id: crypto.randomUUID(), name }), groups.at(-1))
  g.name = name
  saveGroups()
  await extension.finishAssetMove(d)
  return allGroups()
})
ipcMain.handle('groups:update', (_, id, patch) => {
  if(extension.updateGroup(id,patch))return allGroups()
  const g = groups.find(x => x.id === id)
  if (!g) return allGroups()
  for (const k of ['collapsed', 'favorite']) if (k in patch) { if (patch[k]) g[k] = true; else delete g[k] }
  saveGroups()
  return allGroups()
})
ipcMain.handle('groups:reorder', (_, ids) => { groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); saveGroups(); return allGroups() })
ipcMain.handle('groups:delete', async (_, id) => {
  if(await extension.deleteAsset('groups',id))return{groups:allGroups(),servers:list()}
  groups = groups.filter(g => g.id !== id)
  servers.forEach(s => { if (s.group === id) delete s.group })
  saveGroups()
  persist()
  return { groups:allGroups(), servers: list() }
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
ipcMain.handle('paths:list', () => allPaths())
ipcMain.handle('paths:save', async (_, d) => {
  if(await extension.routeAsset('paths',d))return allPaths()
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
  await extension.finishAssetMove(d)
  return allPaths()
})
ipcMain.handle('paths:delete', async (_, id) => { if(await extension.deleteAsset('paths',id))return allPaths();if (pathsLoadError) throw pathsLoadError; savedPaths = savedPaths.filter(x => x.id !== id); writePaths(); return allPaths() })

// ajoute un serveur venant d'un import (Cyberduck ou zip) sauf doublon host/port/user
// ---------- Import from other clients (FileZilla, WinSCP, Cyberduck...) : see import-main.js ----------
require('./import-main').register({ ipcMain, dialog, safeStorage, getWin: () => win, t, servers: () => servers, groups: () => groups, groupByName, addGroup: name => { const g = { id: crypto.randomUUID(), name }; groups.push(g); saveGroups(); return g }, saveServer, list, isMas })

// ---------- Configuration bundles ----------
const configData = () => ({ groups, servers, actions, paths: savedPaths })
const publicConfig = () => ({ groups, servers: list().filter(s=>!s.vaultId), actions, paths: savedPaths })
ipcMain.handle('config:catalog', () => { checkConfigRoot(); if (pathsLoadError) throw pathsLoadError; return publicConfig() })
ipcMain.handle('config:export', async (_, selection) => {
  if (pathsLoadError) throw pathsLoadError
  // Add portable server references before filtering: a path can target an existing server on import.
  let data = configTransfer.select(configTransfer.portable(configData()), configTransfer.withServerItems(configData(), selection))
  if(extension.prepareExport)data=extension.prepareExport(data)
  const count = configTransfer.TYPES.reduce((n, k) => n + data[k].length, 0)
  if (!count) throw new Error(t('config.empty'))
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), 'cyberdog-config.zip'), filters: [{ name: 'Zip', extensions: ['zip'] }] })
  if (r.canceled) return null
  configTransfer.writeBundle(data, r.filePath, extension.bundleOptions?.(data))
  return { path: r.filePath, count }
})
function mergeConfiguration(data) {
  checkConfigRoot()
  if (pathsLoadError) throw pathsLoadError
  const result = configTransfer.merge(configData(), data, extension.finalizeImport)
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
  return mergeConfiguration(configTransfer.readBundle(r.filePaths[0],extension.readBundleOptions?.()))
})

// ---------- SFTP ----------
// Entra ID device sign-in: show the code, open the Microsoft page; the connection resumes once signed in
function showDeviceCode({ userCode, url }) {
  clipboard.writeText(userCode)
  shell.openExternal(url).catch(() => {})
  dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], message: t('azure.device_title'), detail: t('azure.device_msg', { code: userCode, url }) }).catch(() => {})
}
// Opens (or fails to open) a connection to a saved server and registers it; returns { id, home }
async function openConn(sid) {
  const ticket=extension.beginConnection?.(sid)
  let client
  try{
    const server=extension.owns(sid)?await extension.resolveServer(sid):find(sid)
    if(!serverType.isShell(server)){
      const plain=v=>v?safeStorage.decryptString(Buffer.from(v,'base64')):undefined
      const saveRefreshToken=token=>{const s=servers.find(x=>x.id===sid);if(s&&safeStorage.isEncryptionAvailable()){s.pass=safeStorage.encryptString(token).toString('base64');persist()}}
      const t0=Date.now(),sftp=await objectStorage.open(server,secret(server),{token:plain(server.token),proxyPass:plain(server.proxyPass),onDeviceCode:showDeviceCode,openUrl:url=>shell.openExternal(url),onRefreshToken:saveRefreshToken}),id=crypto.randomUUID()
      conns.set(id,{sftp,tmp:[],server,connectMs:Date.now()-t0})
      return{id,home:'/'}
    }
    client=await connect(server,{ticket})
    const sftp=await P(client,'sftp'),home=await P(sftp,'realpath','.'),id=crypto.randomUUID()
    conns.set(id,{client,sftp,tmp:[],server,connectMs:client.connectMs})
    client.on('close',()=>drop(id))
    return{id,home}
  }catch(e){client?.end();throw e}finally{extension.endConnection?.(ticket)}
}
// opening a server starts watching its synchronized folders
ipcMain.handle('files:open', async (_, sid) => { const r = await openConn(sid); syncManager.serverOpened(sid); return r })

// The local file system as a connection (local pane): '/' is the root, or the list of drives on Windows
const LOCAL_SERVER = { id: 'local', type: 'local', name: 'Local' }
async function openLocal() {
  const id = crypto.randomUUID(), be = require('./local-storage').local()
  conns.set(id, { sftp: require('./object-storage').sftpOver(be), tmp: [], server: LOCAL_SERVER, local: be })
  const home = os.homedir().replace(/\\/g, '/')
  return { id, home: /^[A-Za-z]:/.test(home) ? '/' + home : home }
}
ipcMain.handle('files:openLocal', () => openLocal())

ipcMain.handle('conn:close', (_, id) => { const c = conns.get(id); if (c?.client) c.client.end(); else if (c) { c.sftp?.end?.(); drop(id) } })

ipcMain.handle('sftp:list', async (_, id, dir, known) => {
  const s = S(id)
  const resolved = await require('./sftp-navigation').resolveDirectory(s, dir, !!known)
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
ipcMain.handle('storage:link', (_, id, p, seconds) => { const s = S(id); if (!s.link) throw new Error('unsupported'); return s.link(p, Number(seconds)) })
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
// The local pane sends files to the Trash / Recycle Bin instead of deleting them for good
ipcMain.handle('sftp:rm', (_, id, paths) => removePaths(id, paths))

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

// Where a transfer endpoint lives now: its connection if still open, another open one to the same server, or a new one
async function resolveRef(ref) {
  if (ref.disk) return null
  let id = ref.connId && conns.get(ref.connId)?.sftp ? ref.connId : [...conns].find(([, c]) => c.server?.id === ref.serverId && c.sftp)?.[0]
  if (!id) id = ref.serverId === 'local' ? (await openLocal()).id : (await openConn(ref.serverId)).id
  ref.connId = id
  return conns.get(id).sftp
}
transferEngine = require('./transfer-files')(transfers, resolveRef)
const { sftpSide, uniqueTarget } = require('./transfer-files')

// ---------- Synchronized folders (sync-manager.js) ----------
// A local folder kept in sync with a folder on a server: compare + preview, or watch and send every change.
const { SyncManager } = require('./sync-manager')
const pickedBookmarks = new Map() // folder -> security-scoped bookmark (Mac App Store: access after a restart)
const syncManager = new SyncManager({
  file: path.join(app.getPath('userData'), 'sync-pairs.json'),
  dir: path.join(app.getPath('userData'), 'sync'),
  transfers,
  side: async ref => { const s = await resolveRef(ref); return s ? sftpSide(s) : require('./transfer-files').diskSide },
  send: views => send('sync:update', views),
  notify: (text, error) => send('toast', text, !!error),
  t: (k, v) => t(k, v),
  access: pair => {
    if (!isMas || !pair.bookmark) return () => {}
    try { return app.startAccessingSecurityScopedResource(pair.bookmark) || (() => {}) } catch { return () => {} }
  },
})
ipcMain.handle('sync:list', (_, serverId) => syncManager.list(serverId || undefined))
ipcMain.handle('sync:pick-local', async (_, current) => {
  const r = await dialog.showOpenDialog(win, { title: t('sync.local'), defaultPath: current || os.homedir(), properties: ['openDirectory', 'createDirectory'], securityScopedBookmarks: isMas })
  if (r.canceled || !r.filePaths[0]) return null
  if (r.bookmarks?.[0]) pickedBookmarks.set(r.filePaths[0], r.bookmarks[0])
  return r.filePaths[0]
})
ipcMain.handle('sync:save', (_, pair) => {
  if (!pair || typeof pair !== 'object') throw new Error('Invalid pair')
  const bookmark = pickedBookmarks.get(pair.local) || (syncManager.get(pair.id)?.local === pair.local ? syncManager.get(pair.id).bookmark : undefined)
  return syncManager.save({ id: pair.id, serverId: pair.serverId, local: pair.local, remote: pair.remote, deleteRemote: pair.deleteRemote, excludes: pair.excludes, watch: pair.watch, bookmark })
})
ipcMain.handle('sync:remove', (_, id) => syncManager.remove(String(id)))
// target: a pair's id, or { serverId, remote, localConn, localPath } to compare the two panes of a tab
ipcMain.handle('sync:compare', (_, target) => {
  if (typeof target === 'string') return syncManager.compare(target)
  const c = conns.get(target?.localConn)
  if (!c?.local) throw new Error(t('sync.err_local'))
  return syncManager.compare({ serverId: target.serverId, remote: target.remote, local: c.local.nativePath(target.localPath), deleteRemote: false })
})
ipcMain.handle('sync:apply', (_, token, rels, opts) => syncManager.apply(String(token), Array.isArray(rels) ? rels.map(String) : [], { watch: !!opts?.watch }))
ipcMain.handle('sync:watch', (_, id, on) => on ? syncManager.start(String(id)) : syncManager.stop(String(id), { keep: false }))
// A file already exists at the target: the window asks what to do (the answer can apply to the rest of the job)
const CONFLICT_ACTIONS = ['overwrite', 'newer', 'size', 'resume', 'rename', 'skip', 'cancel']
const conflictAsks = new Map() // question id -> resolve
transfers.ask = (job, info) => new Promise(resolve => {
  if (!win || win.isDestroyed()) return resolve({ action: 'skip' })
  const id = crypto.randomUUID()
  conflictAsks.set(id, resolve)
  send('transfer:conflict', { id, job: job.id, direction: job.direction, ...info })
})
ipcMain.handle('transfer:conflict-answer', (_, id, answer) => {
  const resolve = conflictAsks.get(id)
  conflictAsks.delete(id)
  resolve?.({ action: CONFLICT_ACTIONS.includes(answer?.action) ? answer.action : 'skip', all: !!answer?.all })
})
ipcMain.handle('transfers:list', () => transfers.list())
ipcMain.handle('transfers:cancel', (_, id) => transfers.cancel(id))
ipcMain.handle('transfers:pause', (_, id) => transfers.pause(id))
ipcMain.handle('transfers:resume', (_, id) => transfers.resume(id).then(ok => ok, e => { throw e }))
ipcMain.handle('transfers:retry-failed', () => transfers.retryFailed())
ipcMain.handle('transfers:start-all', () => { for (const x of transfers.list()) if (x.state === 'paused') transfers.resume(x.id).catch(() => {}) })
ipcMain.handle('transfers:priority', (_, id, priority) => transfers.setPriority(id, priority))
ipcMain.handle('transfers:move', (_, id, delta) => transfers.move(id, Number(delta)))
ipcMain.handle('transfers:clear', (_, id) => { transfers.clear(id || undefined); return transfers.list() })
const downloadsDir = id => { const preferred = conns.get(id)?.server?.downloadDir; return preferred && path.isAbsolute(preferred) && fs.existsSync(preferred) && fs.statSync(preferred).isDirectory() ? preferred : app.getPath('downloads') }
// opts.hold: add to the queue without starting (the queue's Start button starts it)
ipcMain.handle('sftp:download', async (_, id, paths, opts = {}) => {
  const s = S(id), downloads = downloadsDir(id)
  let target, single = paths.length === 1 && !(await P(s, 'stat', paths[0])).isDirectory()
  if (single) { const r = await dialog.showSaveDialog(win, { defaultPath: path.join(downloads, posix.basename(paths[0])) }); if (r.canceled) return null; target = r.filePath }
  else { const r = await dialog.showOpenDialog(win, { title: t('dlg.download_into'), defaultPath:downloads, properties: ['openDirectory', 'createDirectory'] }); if (r.canceled) return null; target = r.filePaths[0] }
  const sid = conns.get(id).server.id
  // the save dialog already asked about replacing the file
  const ok = await transfers.run(id, 'download', posix.basename(paths[0]), { hold: !!opts.hold, policy: single ? 'overwrite' : undefined, refs: { src: { connId: id, serverId: sid }, dst: { disk: true } }, serverIds: [sid], top: paths.map(p => ({ source: p, target: single ? target : path.join(target, posix.basename(p)) })) })
  return ok ? target : null
})
// Files already at the target are handled one by one through the conflict question
ipcMain.handle('sftp:upload', async (_, id, locals, dir, opts = {}) => {
  S(id)
  const sid = conns.get(id).server.id
  return transfers.run(id, 'upload', path.basename(locals[0]), { hold: !!opts.hold, refs: { src: { disk: true }, dst: { connId: id, serverId: sid } }, serverIds: [sid], top: locals.map(p => ({ source: p, target: posix.join(dir, path.basename(p)) })) })
})
// 'dir', 'file' or null (nothing there): cyberdog:open in an action's output
ipcMain.handle('files:kind', (_, id, p) => P(S(id), 'stat', p).then(st => st.isDirectory() ? 'dir' : 'file', () => null))
// cyberdog:url in an action's output: web links only
ipcMain.handle('link:open', (_, url) => {
  let u
  try { u = new URL(String(url)) } catch { throw new Error(t('qa.bad_url')) }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(t('qa.bad_url'))
  return shell.openExternal(u.href)
})
// "Show in Finder / Explorer" for a downloaded file
ipcMain.handle('files:reveal', (_, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) throw new Error(t('dl.missing'))
  shell.showItemInFolder(p)
})
// Files a quick action asks for ("cyberdog:download /path" in its output): straight to the server's download folder
ipcMain.handle('files:fetch', async (_, id, paths) => {
  S(id)
  const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')).slice(0, 20)
  if (!list.length) return []
  const dir = downloadsDir(id), sid = conns.get(id).server.id
  const top = list.map(p => ({ source: p, target: path.join(dir, posix.basename(p)) }))
  const running = transfers.run(id, 'download', posix.basename(list[0]), { refs: { src: { connId: id, serverId: sid }, dst: { disk: true } }, serverIds: [sid], top })
  const job = transfers.list().at(-1)
  await running
  // where the files really are ("Keep both" renames them); folders are given as such
  const plan = transfers.items.get(job.id)?.plan || []
  return top.map(x => plan.find(i => i.source === x.source && !i.skipped)?.target).filter(f => f && fs.existsSync(f))
})
// Upload button: pick files (or folders) on this computer
ipcMain.handle('files:pick', async (_, kind) => {
  const properties = [...(kind === 'dir' ? ['openDirectory'] : isMac && kind !== 'file' ? ['openFile', 'openDirectory'] : ['openFile']), 'multiSelections']
  const r = await dialog.showOpenDialog(win, { title: t('up.pick_title'), properties })
  return r.canceled ? [] : r.filePaths
})
// Copy between two servers, straight from one connection to the other
ipcMain.handle('transfer:copyToServer', async (_, id, paths, serverId, dir) => {
  const from = conns.get(id)?.server, to = (await resolveRef({ serverId })) && [...conns.values()].find(c => c.server?.id === serverId)?.server
  if (!from || !to) throw new Error(t('err.lost'))
  return transfers.run(id, 'copy', posix.basename(paths[0]), { refs: { src: { connId: id, serverId: from.id }, dst: { serverId } }, serverIds: [from.id, to.id], top: paths.map(p => ({ source: p, target: posix.join(dir, posix.basename(p)) })) })
})

// Paste, drag and drop, "Move to…" and "Duplicate": copy or move files from one connection (a server, the local pane)
// to a folder of another one, or of the same one. On the same server a move is a rename; everything else goes
// through the transfer queue. A copy into the folder the files come from makes numbered copies ("name (1).ext").
// A move between two servers deletes the sources once copied, except those the user chose to skip.
const sameServer = (a, b) => a === b || (!!a?.server?.id && a.server.id === b?.server?.id)
const insideOf = (dir, p) => dir === p || dir.startsWith(p.replace(/\/+$/, '') + '/')
ipcMain.handle('files:paste', async (_, from, paths, to, dir, mode) => {
  const a = conns.get(from), b = conns.get(to)
  if (!a?.sftp || !b?.sftp) throw new Error(t('err.lost'))
  if (!Array.isArray(paths) || !paths.length || typeof dir !== 'string') return { ok: false }
  const same = sameServer(a, b)
  if (same && paths.some(p => insideOf(dir, p))) throw new Error(t('err.into_itself'))
  if (same && mode === 'move') {
    if (!(await P(b.sftp, 'stat', dir).then(st => st.isDirectory(), () => false))) throw new Error(t('err.no_folder', { path: dir }))
    const taken = []
    for (const p of paths) {
      const target = posix.join(dir, posix.basename(p))
      if (target === p) continue
      if (await P(b.sftp, 'stat', target).then(() => true, () => false)) { taken.push(posix.basename(p)); continue }
      await P(b.sftp, 'rename', p, target)
    }
    if (taken.length) throw new Error(t('err.exists', { names: taken.join(', ') }))
    return { ok: true, renamed: true }
  }
  const side = sftpSide(b.sftp), top = []
  for (const p of paths) {
    let target = posix.join(dir, posix.basename(p))
    if (same && target === p) target = await uniqueTarget(side, target, (await P(a.sftp, 'stat', p)).isDirectory())
    top.push({ source: p, target })
  }
  const sid = a.server.id, did = b.server.id, meta = { refs: { src: { connId: from, serverId: sid }, dst: { connId: to, serverId: did } }, serverIds: [...new Set([sid, did])], top }
  const running = transfers.run(from, 'copy', posix.basename(paths[0]), meta)
  const job = transfers.list().at(-1)
  const ok = await running
  if (ok && mode === 'move') {
    const plan = transfers.items.get(job.id)?.plan || []
    const kept = top.filter(x => plan.some(i => i.skipped && insideOf(i.source, x.source)))
    await removePaths(from, top.filter(x => !kept.includes(x)).map(x => x.source))
  }
  return { ok }
})
async function removePaths(id, paths) {
  const local = conns.get(id)?.local
  for (const p of paths) local ? await shell.trashItem(local.nativePath(p)) : await rmr(S(id), p)
}

// Properties: link targets, and the total size of the selection (folders are walked, a level at a time)
ipcMain.handle('files:info', async (_, id, paths) => {
  const s = S(id), started = Date.now()
  let size = 0, files = 0, dirs = 0, partial = false, level = []
  const links = {}
  for (const p of paths) {
    const st = await P(s, 'lstat', p)
    const type = st.mode & 0o170000
    if (type === 0o120000 || st.isSymbolicLink?.()) { links[p] = s.readlink ? await P(s, 'readlink', p).catch(() => '') : ''; files++; continue }
    if (st.isDirectory()) level.push(p)
    else { files++; size += st.size || 0 }
  }
  while (level.length) {
    const next = []
    for (let i = 0; i < level.length; i += 8) {
      if (files + dirs > 200000 || Date.now() - started > 30000) { partial = true; break }
      await Promise.all(level.slice(i, i + 8).map(async d => {
        let list
        try { list = await P(s, 'readdir', d) } catch { partial = true; return }
        for (const e of list) {
          if (e.filename === '.' || e.filename === '..') continue
          if ((e.attrs.mode & 0o170000) === 0o040000) { dirs++; next.push(posix.join(d, e.filename)) } else { files++; size += e.attrs.size || 0 }
        }
      }))
    }
    if (partial) break
    level = next
  }
  return { size, files, dirs, partial, links }
})
ipcMain.handle('files:symlink', (_, id, target, link) => {
  const s = S(id)
  if (!s.symlink) throw new Error('unsupported')
  if (typeof target !== 'string' || !target || typeof link !== 'string' || !link) throw new Error('invalid')
  return P(s, 'symlink', target, link)
})
// Permissions on a whole folder: everything below it, only the files or only the folders (symbolic links are left alone).
// owner: a uid to apply too, or null. Over SSH it is one `find`; elsewhere the tree is walked.
ipcMain.handle('files:chmod-recursive', async (_, id, root, mode, scope, owner) => {
  if (!permissions.validMode(mode) || !['all', 'files', 'dirs'].includes(scope)) throw new Error(t('err.permissions'))
  if (owner != null && !permissions.validUid(owner)) throw new Error('invalid')
  const c = conns.get(id), s = S(id)
  if (c?.client) {
    const type = scope === 'files' ? '-type f' : scope === 'dirs' ? '-type d' : '! -type l'
    const steps = [...(owner != null ? [`find ${q(root)} ${type} -exec chown ${owner} {} +`] : []), `find ${q(root)} ${type} -exec chmod ${mode} {} +`]
    const r = await exec(c.client, steps.join(' && '), { timeout: 300000 })
    if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-2).join(' ') || `exit ${r.code}`)
    return
  }
  const apply = async (p, isDir) => {
    if (scope === 'files' ? isDir : scope === 'dirs' ? !isDir : false) return
    if (owner != null) { const st = await P(s, 'stat', p); await P(s, 'chown', p, owner, st.gid) }
    await P(s, 'chmod', p, parseInt(mode, 8))
  }
  const walk = async dir => {
    await apply(dir, true)
    for (const e of await P(s, 'readdir', dir)) {
      if (e.filename === '.' || e.filename === '..') continue
      const type = e.attrs.mode & 0o170000, p = posix.join(dir, e.filename)
      if (type === 0o040000) await walk(p)
      else if (type !== 0o120000) await apply(p, false)
    }
  }
  await walk(root)
})

// ---------- Éditeur interne ----------
// Text is decoded and encoded again in the file's own encoding (see editor-files.js): saving never changes the bytes
// of what was not edited. The date seen when opening protects against overwriting a file changed meanwhile.
const editorFiles = require('./editor-files')
const secondsOf = t => Math.floor((typeof t === 'number' ? t : +t / 1000) || 0)
ipcMain.handle('editor:read', async (_, id, p) => {
  const s = S(id), st = await P(s, 'stat', p)
  if (st.isDirectory()) return { error: 'directory' }
  if (st.size > editorFiles.MAX_SIZE) return { error: 'too_big', size: st.size }
  const chunks = []
  let size = 0
  await new Promise((resolve, reject) => {
    const r = s.createReadStream(p)
    r.on('data', c => { size += c.length; if (size > editorFiles.MAX_SIZE) r.destroy(new Error('too_big')); else chunks.push(c) })
    r.on('end', resolve); r.on('close', resolve); r.on('error', reject)
  })
  const file = editorFiles.decode(Buffer.concat(chunks))
  if (file.binary) return { error: 'binary' }
  return { ...file, mtime: secondsOf(st.mtime), size: st.size }
})
// -> { mtime } once written, or { conflict: true } when the file changed since `seen` (seconds) and `force` is not set
ipcMain.handle('editor:write', async (_, id, p, text, encoding, seen, force) => {
  const s = S(id)
  let bytes
  try { bytes = editorFiles.encode(String(text), encoding) }
  catch (e) { if (e.code === 'unencodable') throw new Error(t('editor.unencodable', { char: e.char, encoding: editorFiles.ENCODINGS.includes(encoding) ? encoding : '?' })); throw e }
  if (!force) {
    const now = await P(s, 'stat', p).catch(() => null)
    if (now && seen && secondsOf(now.mtime) !== seen) return { conflict: true }
  }
  await P(s, 'writeFile', p, bytes)
  const after = await P(s, 'stat', p)
  send('sftp:changed', id, posix.dirname(p), posix.basename(p))
  return { mtime: secondsOf(after.mtime), size: after.size }
})
// Check / apply a known configuration file on its SSH server (config-profiles.js builds the command from the path)
const configProfiles = require('./config-profiles')
ipcMain.handle('editor:config', async (_, id, p, profileId, action) => {
  const spec = configProfiles.command(p, profileId, action)
  if (!spec) throw new Error('invalid')
  const c = getConn(id), s = spec.sudo ? sudoOf(c) : null, run = `sh -c ${q(spec.cmd)}`
  const cmd = s ? `if [ "$(id -u)" = 0 ]; then ${run}; else ${s.prefix} ${run}; fi` : run
  const r = await exec(c.client, cmd, { input: s?.input, timeout: action === 'up' ? 600000 : 120000 })
  return { code: r.code, out: r.out }
})
// Monaco's web workers: their file names carry a hash that changes with each version
ipcMain.handle('editor:workers', () => {
  const dir = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs', 'assets')
  const files = fs.readdirSync(dir)
  const pick = prefix => files.find(f => f.startsWith(prefix + '-') && f.endsWith('.js'))
  return { editor: pick('editor.worker'), json: pick('json.worker'), css: pick('css.worker'), html: pick('html.worker'), ts: pick('ts.worker') }
})

// Édition : téléchargement en tmp, ouverture dans l'appli, renvoi à chaque sauvegarde
ipcMain.handle('sftp:edit', async (_, id, remote, appPath) => {
  const c = conns.get(id)
  if (c.local) { // edit in place
    const file = c.local.nativePath(remote)
    if (!appPath) shell.openPath(file)
    else execFile(isMac ? 'open' : appPath, isMac ? ['-a', appPath, file] : [file], () => {})
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-'))
  const name = posix.basename(remote)
  const local = path.join(dir, name)
  c.tmp.push(dir)
  await P(c.sftp, 'fastGet', remote, local)
  fs.watchFile(local, { interval: 700 }, async (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return
    try { await P(c.sftp, 'fastPut', local, remote); send('toast', t('t.file_sent', { name })); send('sftp:changed', id, posix.dirname(remote), name) } catch (e) { send('toast', t('t.send_failed', { name, error: e.message }), true) }
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

// ---------- Scheduled tasks (crontab + systemd timers) ----------
const scheduleSnapshot = async c => {
  const r = await exec(c.client, 'sh -s', { input: scheduleModel.SNAPSHOT, timeout: 30000, max: 4e6 })
  if (r.code !== 0) throw new Error(r.out.trim() || 'Schedule snapshot failed')
  return scheduleModel.parse(r.out)
}
ipcMain.handle('sched:list', (_, id) => scheduleSnapshot(getConn(id)))
// Edits only the connected user's crontab; the line must still be what the renderer saw.
ipcMain.handle('sched:edit', async (_, id, op) => {
  const c = getConn(id)
  const cur = await exec(c.client, 'crontab -l 2>/dev/null')
  const next = scheduleModel.applyEdit(cur.code === 0 ? cur.out : '', op || {})
  const r = await exec(c.client, 'crontab -', { input: next, timeout: 30000 })
  if (r.code !== 0) throw new Error(r.out.trim() || `exit ${r.code}`)
})
// Runs a task now. The command comes from a fresh snapshot, never from the renderer.
ipcMain.handle('sched:run', async (_, id, ref) => {
  const c = getConn(id), snap = await scheduleSnapshot(c), q = scheduleModel.q
  let cmd, stdin
  if (ref?.source === 'periodic') {
    const p = snap.periodic.find(p => p.id === ref.id)
    if (!p) throw new Error(t('cron.changed'))
    const s = sudoOf(c)
    cmd = `if [ "$(id -u)" = 0 ]; then exec ${q(p.file)}; else exec ${s.prefix} ${q(p.file)}; fi`
    stdin = s.input
  } else {
    const e = snap.entries.find(e => e.id === ref?.id && e.raw === ref.raw)
    if (!e) throw new Error(t('cron.changed'))
    const script = scheduleModel.runScript(e), input = scheduleModel.cronCommand(e.command).stdin
    if (!e.user || e.user === snap.me) { cmd = `sh -c ${q(script)}`; stdin = input }
    else {
      const s = sudoOf(c)
      cmd = `if [ "$(id -u)" = 0 ]; then exec su -s /bin/sh ${q(e.user)} -c ${q(script)}; else exec ${s.prefix} -u ${q(e.user)} sh -c ${q(script)}; fi`
      stdin = (s.input || '') + (input || '') || undefined
    }
  }
  const r = await exec(c.client, cmd, { input: stdin, timeout: 600000 })
  return { code: r.code, out: r.out }
})
ipcMain.handle('sched:timer', async (_, id, unit, action) => {
  const kind = action === 'start' ? '.service' : '.timer'
  if (!['start', 'enable', 'disable'].includes(action) || typeof unit !== 'string' || !UNIT_NAME.test(unit) || !unit.endsWith(kind)) throw new Error('invalid')
  const c = getConn(id), s = sudoOf(c)
  const sub = action === 'start' ? `start --no-block ${q(unit)}` : `${action} --now ${q(unit)}`
  const r = await exec(c.client, `if [ "$(id -u)" = 0 ]; then systemctl ${sub}; else ${s.prefix} systemctl ${sub}; fi`, { input: s.input, timeout: 60000 })
  if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`)
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
ipcMain.handle('keys:available',()=>localSshKeys.listPrivateKeys(os.homedir(),[path.join(app.getPath('userData'),'keys')]))
ipcMain.handle('keys:choose',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile','showHiddenFiles'],defaultPath:path.join(app.getPath('home'),'.ssh')});if(r.canceled)return null
  const info=localSshKeys.readPrivateKey(r.filePaths[0]).info
  return isMas?localSshKeys.copyIntoContainer(info.path,path.join(app.getPath('userData'),'keys')).info:info})
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
ipcMain.handle('keys:use', async (_, serverId, keyId) => {
  const key = localKeyStore().get(keyId)
  if (!key.hasPrivate) throw new Error(t('keys.no_private'))
  const server = extension.owns(serverId) ? await extension.resolveServer(serverId) : find(serverId)
  if(server.vaultId)throw new Error('extension_managed')
  if(extension.owns(server.id))return extension.saveServer({...server,authMode:'key',key:key.privatePath,syncCredentials:false})
  server.key=key.privatePath;server.authMode='key';delete server.pass;delete server.keyData;persist()
  return list()
})
ipcMain.handle('keys:unlock', async (_, serverId, passphrase) => {
  const server = extension.owns(serverId) ? await extension.resolveServer(serverId) : find(serverId)
  if(typeof passphrase!=='string'||passphrase.length>1024)throw new Error(t('keys.unlock_failed'))
  const auth=await extension.connectionAuth(server)
  const privateKey=auth?.privateKey||(server.key&&fs.readFileSync(server.key))
  if(!privateKey)throw new Error(t('keys.unlock_failed'))
  const parsed=sshUtils.parseKey(privateKey,passphrase)
  if (parsed instanceof Error) throw new Error(t('keys.unlock_failed'))
  keyPassphrases.set(server.key||'cloud:'+server.id,passphrase)
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

ipcMain.handle('actions:list', () => allActions())
ipcMain.handle('actions:save', async (_, d) => {
  if (d?.teamId && d.serverId) throw new Error(t('qa.server_local_only'))
  if(await extension.routeAsset('actions',d))return allActions()
  const name = d.name?.trim()
  if (!name || !d.script?.trim()) throw new Error(t('err.name_script_required'))
  if (d.script.length > MAX_SCRIPT) throw new Error(t('err.script_too_big'))
  // an action can be made for one server only (local actions: the shared spaces do not carry it)
  const serverId = typeof d.serverId === 'string' && d.serverId ? d.serverId : null
  if (serverId && !servers.some(s => s.id === serverId)) throw new Error(t('err.server_not_found'))
  let a = actions.find(x => x.id === d.id)
  if (!a) actions.push((a = { id: crypto.randomUUID() }))
  Object.assign(a, { name, script: d.script })
  if (serverId) a.serverId = serverId
  else delete a.serverId
  persistActions()
  await extension.finishAssetMove(d)
  return allActions()
})
ipcMain.handle('actions:delete', async (_, id) => {if(await extension.deleteAsset('actions',id))return allActions();actions = actions.filter(a => a.id !== id); persistActions(); return allActions() })

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
  return { actions:allActions(), added }
})

// le script voyage en base64 dans la commande : stdin reste libre pour les scripts interactifs
// vars: the answers to a form the action asked for (cyberdog:select / input / buttons), set before the script runs
ipcMain.handle('action:run', async (_, id, script, vars) => {
  const c = getConn(id)
  if(script&&typeof script==='object')script=await extension.resolveAction(script,c.server)
  if(typeof script!=='string'||script.length>MAX_SCRIPT)throw new Error('invalid_script')
  script = require('./action-commands').exports(vars) + script
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
  if (conns.get(id)?.local) return paths.map(p => conns.get(id).local.nativePath(p)) // already on this computer
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
app.on('will-quit', () => { syncManager.close(); for (const c of conns.values()) try { c.sftp?.end?.() } catch {} // unmounts SMB shares
  if (dragRoot) fs.rmSync(dragRoot, { recursive: true, force: true }) })

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

// ---------- Création d'archive sur le serveur ----------
const plainName = n => typeof n === 'string' && n && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\0')
ipcMain.handle('sftp:compress', async (_, id, dir, names, format, out) => {
  const c = getConn(id)
  if (typeof dir !== 'string' || !Array.isArray(names) || !names.length || !names.every(plainName) || !plainName(out) || !archive.formats.includes(format)) throw new Error(t('err.archive_unknown'))
  const r = await exec(c.client, 'sh -s', { input: archive.createCommand(format, dir, names, out, q), timeout: 600000 })
  const missing = r.out.match(/MISSING:(\S+)/)
  if (missing) throw new Error(t('err.tool_missing', { tool: missing[1] }))
  if (r.code === 17 && /EXISTS/.test(r.out)) throw new Error(t('err.archive_exists', { name: out }))
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
  } else if (spec.kind === 'kube') {
    cmd = kubeModel.logArgs(spec)
  } else throw new Error('invalid source')

  const s = spec.sudo || (spec.kind === 'docker' && c.dockerSudo) || (spec.kind === 'kube' && c.kubeSudo) ? sudoOf(c) : null
  const bin = spec.kind === 'kube' ? (await kubeBin(c)) + ' ' : ''
  const stream = await new Promise((res, rej) => c.client.exec(`exec ${s ? s.prefix + ' ' : ''}${bin}${cmd.map(q).join(' ')}`, (e, st) => (e ? rej(e) : res(st))))
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
async function docker(c, args, { timeout = 30000, bin = 'docker' } = {}) {
  const run = sudo => {
    const s = sudo ? sudoOf(c) : null
    return exec(c.client, `${s ? s.prefix + ' ' : ''}${bin} ${args.map(q).join(' ')}`, { timeout, input: s?.input })
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
    return { id: p.ID, name: p.Names, image: p.Image, state: p.State, status: p.Status, ports: p.Ports, compose: /(^|,)com\.docker\.compose\.service=/.test(p.Labels || ''), sudo: !!c.dockerSudo, cpu: s ? parseFloat(s.CPUPerc) : null, mem: s ? parseFloat(s.MemPerc) : null, memUsage: s?.MemUsage }
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
  if (!DOCKER_ID.test(target) || !['start', 'stop', 'restart', 'pause', 'unpause'].includes(action)) throw new Error('invalid')
  const r = await docker(getConn(id), [action, target], { timeout: 90000 })
  if (r.code !== 0) throw new Error(lastLines(r.out))
})

// docker compose up -d --force-recreate --no-deps <service>, à partir des labels posés par Compose sur le conteneur
ipcMain.handle('docker:recreate', async (_, id, target) => {
  if (!DOCKER_ID.test(target)) throw new Error('invalid')
  const c = getConn(id)
  const ins = await docker(c, ['inspect', '--format', '{{json .Config.Labels}}', target])
  if (ins.code !== 0) throw new Error(lastLines(ins.out))
  const L = JSON.parse(ins.out.trim() || '{}') || {}
  const svc = L['com.docker.compose.service']
  if (!svc) throw new Error(t('docker.not_compose'))
  const files = (L['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean)
  const dir = L['com.docker.compose.project.working_dir']
  const args = [...(L['com.docker.compose.project'] ? ['-p', L['com.docker.compose.project']] : []), ...(dir ? ['--project-directory', dir] : []), ...files.flatMap(f => ['-f', f]), 'up', '-d', '--force-recreate', '--no-deps', svc]
  let r = await docker(c, ['compose', ...args], { timeout: 300000 })
  // Compose v1 (binaire docker-compose) si le plugin « docker compose » est absent
  if (r.code !== 0 && /is not a docker command|unknown command|unknown shorthand flag/i.test(r.out)) r = await docker(c, args, { timeout: 300000, bin: 'docker-compose' })
  if (r.code !== 0) throw new Error(lastLines(r.out))
})

// ---------- Kubernetes (kubectl du serveur : kubectl, k3s ou microk8s) ----------
// The first kubectl found is kept for the connection; an unreadable kubeconfig (k3s, microk8s) switches to sudo, as Docker does.
async function kubeBin(c) {
  if (c.kubeBin) return c.kubeBin
  const r = await exec(c.client, `for b in kubectl k3s microk8s; do command -v "$b" >/dev/null 2>&1 && { echo "$b"; exit 0; }; done; for b in /snap/bin/microk8s /usr/local/bin/k3s; do [ -x "$b" ] && { echo "$b"; exit 0; }; done; exit 1`)
  const found = r.code === 0 ? r.out.trim().split('\n').pop() : ''
  if (!found) throw new Error(t('kube.err.missing'))
  c.kubeBin = found.endsWith('kubectl') ? found : found + ' kubectl'
  return c.kubeBin
}
async function kubectl(c, args, { timeout = 30000, max = 2e6 } = {}) {
  const bin = await kubeBin(c)
  const run = sudo => { const s = sudo ? sudoOf(c) : null; return exec(c.client, `${s ? s.prefix + ' ' : ''}${bin} ${args.map(q).join(' ')}`, { timeout, max, input: s?.input }) }
  let r = await run(!!c.kubeSudo)
  if (!c.kubeSudo && r.code !== 0 && kubeModel.errorKind(r.out) === 'permission') {
    const again = await run(true)
    if (again.code === 0 || kubeModel.errorKind(again.out) !== 'permission') { c.kubeSudo = true; r = again }
  }
  return r
}
const kubeError = r => { const k = kubeModel.errorKind(r.out); return new Error(k ? t('kube.err.' + k) : r.out.trim().split('\n').filter(l => !/^W\d{4} /.test(l)).slice(-3).join(' ') || `exit ${r.code}`) }
// stdout and stderr are mixed: the JSON document is what starts with { at the start of a line
const kubeJson = out => { const i = out.search(/^\{/m), j = out.lastIndexOf('}'); if (i < 0 || j < i) throw new Error('kubectl: no JSON'); return JSON.parse(out.slice(i, j + 1)) }
ipcMain.handle('kube:info', async (_, id) => {
  const c = getConn(id)
  const [list, cur] = [await kubectl(c, kubeModel.contextsArgs()), await kubectl(c, kubeModel.currentArgs())]
  if (list.code !== 0 && kubeModel.errorKind(list.out)) throw kubeError(list)
  const contexts = list.code === 0 ? list.out.split('\n').map(s => s.trim()).filter(s => kubeModel.CONTEXT.test(s) && !/^W\d{4} /.test(s)) : []
  return { bin: c.kubeBin, sudo: !!c.kubeSudo, contexts, current: cur.code === 0 ? cur.out.trim().split('\n').pop() : '' }
})
ipcMain.handle('kube:namespaces', async (_, id, query) => {
  const r = await kubectl(getConn(id), kubeModel.namespacesArgs(query || {}))
  if (r.code !== 0) throw kubeError(r)
  return r.out.trim().split('\n').pop().split(/\s+/).filter(n => kubeModel.NAME.test(n)).sort()
})
ipcMain.handle('kube:list', async (_, id, query) => {
  const c = getConn(id)
  const [r, top] = await Promise.all([kubectl(c, kubeModel.listArgs(query), { max: 40e6, timeout: 45000 }), query.kind === 'pods' ? kubectl(c, kubeModel.topArgs(query)).catch(() => null) : null])
  if (r.code !== 0) throw kubeError(r)
  if (r.out.length >= 40e6) throw new Error(t('kube.err.too_big'))
  const items = kubeModel.summarize(kubeJson(r.out))
  const metrics = top?.code === 0 ? kubeModel.parseTop(top.out, query.namespace) : null
  if (metrics) for (const p of items) Object.assign(p, metrics.get(`${p.namespace}/${p.name}`) || {})
  return { items, metrics: !!metrics, sudo: !!c.kubeSudo, bin: c.kubeBin }
})
ipcMain.handle('kube:text', async (_, id, query) => {
  const r = await kubectl(getConn(id), kubeModel.textArgs(query))
  if (r.code !== 0) throw kubeError(r)
  return r.out
})
ipcMain.handle('kube:action', async (_, id, query) => {
  const r = await kubectl(getConn(id), kubeModel.actionArgs(query), { timeout: 60000 })
  if (r.code !== 0) throw kubeError(r)
  return r.out.trim()
})

// ---------- Databases (psql, mysql / mariadb, redis-cli of the server or of a Docker container) ----------
// Logins typed in the panel are kept per server and instance, encrypted like the server passwords.
const dbLoginsFile = () => path.join(currentConfigRoot(), 'db-logins.json')
const readDbLogins = () => { try { return JSON.parse(fs.readFileSync(dbLoginsFile(), 'utf8')) } catch { return {} } }
function dbLogin(server, instId) {
  const x = readDbLogins()[server.id]?.[instId]
  if (!x) return null
  let pass = ''
  try { pass = x.pass ? safeStorage.decryptString(Buffer.from(x.pass, 'base64')) : '' } catch {}
  return { user: x.user, database: x.database || '', pass }
}
ipcMain.handle('db:login', (_, id, instId, login) => {
  const c = getConn(id), all = readDbLogins()
  if (typeof instId !== 'string' || instId.length > 200) throw new Error('invalid instance')
  const mine = (all[c.server.id] ||= {})
  if (!login) delete mine[instId]
  else {
    const user = String(login.user || '').trim(), database = String(login.database || '').trim()
    if (!user || user.length > 128 || database.length > 128 || /[\0\r\n]/.test(user + database)) throw new Error('invalid login')
    if (login.pass && !safeStorage.isEncryptionAvailable()) throw new Error(t('err.keychain'))
    const prev = mine[instId]
    mine[instId] = { user, database, pass: login.pass ? safeStorage.encryptString(String(login.pass)).toString('base64') : login.keepPass && prev?.user === user ? prev.pass : '' }
  }
  if (!Object.keys(mine).length) delete all[c.server.id]
  fs.writeFileSync(dbLoginsFile(), JSON.stringify(all, null, 2), { mode: 0o600 })
})

// stdout and stderr apart: results on one side, errors on the other
function execSplit(client, cmd, { input, timeout = 120000, max = 20e6 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = '', errOut = '', cut = false
      const timer = setTimeout(() => { stream.close(); resolve({ code: 124, out, err: errOut, cut, timeout: true }) }, timeout)
      stream.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.on('data', d => { if (out.length < max) out += d; else cut = true })
      stream.stderr.on('data', d => { if (errOut.length < 1e6) errOut += d })
      stream.on('close', code => { clearTimeout(timer); resolve({ code, out, err: errOut, cut }) })
      stream.end(input)
    })
  })
}

async function dbDiscover(c) {
  const r = await exec(c.client, 'sh -s', { input: dbModel.SNAPSHOT, timeout: 20000 })
  const snap = dbModel.parseSnapshot(r.out)
  let containers = []
  if (snap.bins.includes('docker')) {
    try {
      const ps = await docker(c, ['ps', '-a', '--format', '{{json .}}'])
      const lines = ps.code === 0 ? ps.out.split('\n').filter(l => l.startsWith('{')) : []
      const names = lines.map(l => { try { return JSON.parse(l) } catch { return {} } }).filter(x => dbModel.imageEngine(x.Image)).map(x => x.Names).filter(n => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n || ''))
      const ins = names.length ? await docker(c, ['inspect', ...names]) : null
      let inspected = []
      try { inspected = ins?.code === 0 ? JSON.parse(ins.out.slice(ins.out.indexOf('['))) : [] } catch {}
      containers = dbModel.parseContainers(lines, inspected)
    } catch {}
  }
  // sudo: without password (NOPASSWD), with the saved password of the server, or not at all
  c.dbSudo = snap.sudo === 'nopass' ? 'nopass' : secret(c.server) ? 'pass' : 'no'
  c.dbInstances = new Map([...snap.instances, ...containers].map(x => [x.id, x]))
  return { sudo: c.dbSudo, bins: snap.bins, instances: [...c.dbInstances.values()].map(x => { const l = dbLogin(c.server, x.id); return { ...dbModel.publicInstance(x), login: l ? { user: l.user, database: l.database, hasPass: !!l.pass } : null } }) }
}
ipcMain.handle('db:discover', (_, id) => dbDiscover(getConn(id)))

const dbInst = (c, instId) => c.dbInstances?.get(instId) || (() => { throw new Error(t('db.err.gone')) })()
async function dbRun(c, inst, { tool = 'client', db, data = '', timeout, max, wrapCmd } = {}) {
  const login = dbLogin(c.server, inst.id)
  const { cmd, needsSudoPassword } = dbModel.command({ inst, creds: login, sudo: c.dbSudo, dockerSudo: !!c.dockerSudo }, { tool, db })
  const pass = login ? login.pass : inst.secret || ''
  const input = (needsSudoPassword ? (secret(c.server) || '') + '\n' : '') + pass + '\n' + data
  const r = await execSplit(c.client, wrapCmd ? wrapCmd(cmd) : cmd, { input, timeout, max })
  if (r.timeout) throw new Error(t('db.err.timeout'))
  return r
}
const dbFail = (inst, r) => {
  const msg = dbModel.cleanError(inst.engine, r.err) || r.out.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`
  if (/sudo: a (terminal|password) is required|sudo: no tty|is not in the sudoers/i.test(msg)) return new Error(t('db.err.sudo'))
  if (r.code === 127 && /not found/.test(msg)) return new Error(t('db.err.client', { error: msg }))
  return new Error(msg)
}
async function dbSql(c, inst, statements, { db, readOnly = true, maxRows } = {}) {
  const r = await dbRun(c, inst, { db, data: dbModel.sqlScript(inst.engine, statements, { readOnly }) })
  const p = dbModel.parseSql(inst.engine, r.out, r.err, statements, { maxRows })
  // an error in a statement (psql exits with 3, mysql names the line) is a result; anything else is a connection failure
  const inScript = inst.engine === 'postgres' ? r.code === 3 : /^ERROR \d+ \(\w+\) at line \d+/m.test(r.err)
  if (!p.results.length && !(inScript && p.error)) throw dbFail(inst, r)
  p.cut = r.cut
  return p
}
async function dbRedis(c, inst, commands, { db } = {}) {
  const r = await dbRun(c, inst, { db, data: dbModel.redisScript(commands) })
  const parts = dbModel.splitRedis(r.out)
  if (!parts.length && (r.code !== 0 || r.err.trim())) throw dbFail(inst, r)
  if (parts.length === 1 && /^\(error\) (NOAUTH|WRONGPASS)/.test(parts[0].trim())) throw new Error(parts[0].trim().replace(/^\(error\) /, ''))
  return parts
}

// the panel's views: a fixed set of queries, built in databases.js
ipcMain.handle('db:op', async (_, id, instId, op, a = {}) => {
  const c = getConn(id), inst = dbInst(c, instId)
  if (inst.engine === 'redis') {
    const R = dbModel.REDIS
    if (op === 'overview') { const [info] = await dbRedis(c, inst, R.overview()); return { info: dbModel.parseInfo(dbModel.parseRedis(info)) } }
    if (op === 'keys') {
      const [scan] = await dbRedis(c, inst, R.keys(a.pattern, a.cursor, a.count), { db: a.db })
      const v = dbModel.parseRedis(scan)
      if (!Array.isArray(v)) throw new Error(v?.error || String(v))
      const keys = (v[1] || []).slice(0, 1000), meta = keys.length ? await dbRedis(c, inst, R.meta(keys), { db: a.db }) : []
      return { cursor: v[0], keys: keys.map((k, i) => ({ key: k, type: dbModel.parseRedis(meta[i * 2] || ''), ttl: dbModel.parseRedis(meta[i * 2 + 1] || '') })) }
    }
    if (op === 'key') {
      if (typeof a.key !== 'string' || a.key.length > 4096) throw new Error('invalid key')
      const parts = (await dbRedis(c, inst, R.key(a.key), { db: a.db })).map(dbModel.parseRedis)
      const [type, ttl, memory, get, hash, list, set, zset, stream, ...lens] = parts
      const value = { string: get, hash, list, set: Array.isArray(set) ? set[1] : set, zset, stream }[type] ?? null
      const length = { string: lens[0], hash: lens[1], list: lens[2], set: lens[3], zset: lens[4], stream: lens[5] }[type] ?? null
      return { type, ttl, memory, value, length }
    }
    if (op === 'activity') { const [list] = await dbRedis(c, inst, R.activity()); return { clients: dbModel.parseClients(dbModel.parseRedis(list)) } }
    if (op === 'kill') { const [r] = await dbRedis(c, inst, R.kill(a.pid)); const v = dbModel.parseRedis(r); if (v?.error) throw new Error(v.error); return { ok: true } }
    if (op === 'users') { const [r] = await dbRedis(c, inst, R.users()); const v = dbModel.parseRedis(r); if (v?.error) throw new Error(v.error); return { users: (Array.isArray(v) ? v : [v]).filter(Boolean) } }
    throw new Error('invalid operation')
  }
  const Q = dbModel.queries(inst.engine)
  const build = { overview: () => Q.overview(), databases: () => Q.databases(), tables: () => Q.tables(a.db), columns: () => Q.columns(a.db, a.schema, a.table), preview: () => Q.preview(a.db, a.schema, a.table, a),
    activity: () => Q.activity(), kill: () => Q.kill(a.pid, !!a.hard), users: () => Q.users(), grants: () => Q.grants(a.db, a.user, a.host) }[op]
  if (!build) throw new Error('invalid operation')
  // the views read only; stopping a session is the one change, asked for in the panel
  const p = await dbSql(c, inst, build(), { db: inst.engine === 'postgres' ? a.db : op === 'preview' || op === 'columns' || op === 'tables' ? a.db : undefined, readOnly: op !== 'kill' })
  if (p.error && op !== 'overview') throw new Error(p.error.message)
  return p
})

// the SQL / command editor
ipcMain.handle('db:run', async (_, id, instId, text, o = {}) => {
  const c = getConn(id), inst = dbInst(c, instId)
  if (typeof text !== 'string' || text.length > 1e6) throw new Error('invalid script')
  if (inst.engine === 'redis') {
    const lines = dbModel.redisLines(text)
    if (!lines.length) return { results: [] }
    if (o.readOnly !== false) { const bad = lines.find(l => !dbModel.isReadRedis(l)); if (bad) throw new Error(t('db.err.readonly_redis', { cmd: bad.split(/\s+/)[0] })) }
    const t0 = Date.now(), parts = await dbRedis(c, inst, lines, { db: o.db })
    return { ms: Date.now() - t0, results: lines.map((l, i) => ({ statement: l, text: parts[i] ?? '' })) }
  }
  let statements
  try { statements = dbModel.splitSql(text, inst.engine) } catch (e) { throw new Error(t(e.message === 'psql-meta' ? 'db.err.psql_meta' : e.message === 'mysql-meta' ? 'db.err.mysql_meta' : 'db.err.parse')) }
  if (!statements.length) return { results: [] }
  if (o.readOnly !== false) { const bad = statements.find(s => !dbModel.isReadSql(s, inst.engine)); if (bad) throw new Error(t('db.err.readonly', { word: dbModel.firstWord(bad, inst.engine).toUpperCase() })) }
  const t0 = Date.now(), p = await dbSql(c, inst, statements, { db: o.db || undefined, readOnly: o.readOnly !== false, maxRows: 1000 })
  return { ...p, ms: Date.now() - t0 }
})

// backup: dump compressed into ~/cyberdog-backups on the server, then downloaded from the panel if wanted
ipcMain.handle('db:backup', async (_, id, instId, db) => {
  const c = getConn(id), inst = dbInst(c, instId)
  if (inst.engine !== 'redis' && (typeof db !== 'string' || !db)) throw new Error('invalid database')
  const name = dbModel.backupName(inst, db)
  const file = `"$HOME/cyberdog-backups/"${q(name)}`
  const r = await dbRun(c, inst, { tool: 'dump', db, timeout: 3600e3, max: 1e5,
    wrapCmd: cmd => `mkdir -p "$HOME/cyberdog-backups" && chmod 700 "$HOME/cyberdog-backups" && { ${cmd}; echo "@@RC $?" >&2; } | gzip -c > ${file}; s=$(wc -c < ${file}); echo "$HOME/cyberdog-backups/${name} $s"` })
  const rc = /@@RC (\d+)/.exec(r.err)?.[1]
  if (rc !== '0') { await exec(c.client, `rm -f ${file}`).catch(() => {}); throw dbFail(inst, r) }
  const [, file2, size] = /^(\/.*) (\d+)\s*$/m.exec(r.out.trim()) || []
  if (!file2) throw new Error(r.out.trim() || 'backup failed')
  return { path: file2, size: +size }
})

// where the server writes its log: a file (read with sudo), the systemd journal, or docker logs
ipcMain.handle('db:log', async (_, id, instId) => {
  const c = getConn(id), inst = dbInst(c, instId)
  if (inst.source === 'docker') return { kind: 'docker', id: inst.container }
  const sudo = c.dbSudo !== 'no'
  let file = inst.logFile
  try {
    if (!file && inst.engine === 'redis') {
      const [logfile, dir] = (await dbRedis(c, inst, dbModel.REDIS.logInfo())).map(dbModel.parseRedis)
      const f = Array.isArray(logfile) ? logfile[1] : '', d = Array.isArray(dir) ? dir[1] : ''
      if (f) file = f.startsWith('/') ? f : posix.join(d || '/', f)
    } else if (!file && inst.engine === 'mysql') {
      const p = await dbSql(c, inst, dbModel.queries('mysql').logInfo())
      const [logError, datadir] = p.results[0]?.rows[0] || []
      if (logError && logError !== 'stderr') file = logError.startsWith('/') ? logError : posix.join(datadir || '/', logError.replace(/^\.\//, ''))
    } else if (!file && inst.engine === 'postgres') {
      const p = await dbSql(c, inst, dbModel.queries('postgres').logInfo())
      const [collector, dir, data] = p.results[0]?.rows[0] || []
      if (collector === 'on' && dir) {
        const base = dir.startsWith('/') ? dir : posix.join(data || '/', dir)
        const r = await exec(c.client, `${sudo ? sudoOf(c).prefix + ' ' : ''}sh -c ${q(`ls -1t ${q(base)}/*.log 2>/dev/null | head -1`)}`, { input: sudo ? sudoOf(c).input : undefined })
        const f = r.out.trim().split('\n').pop()
        if (f?.startsWith('/')) file = f
      }
    }
  } catch {}
  if (file) return { kind: 'file', path: file, sudo }
  if (inst.unit) return { kind: 'journal', unit: inst.unit, sudo }
  throw new Error(t('db.err.nolog'))
})

// ---------- Terminal ----------
ipcMain.handle('term:open', async (_, id, sid, cols, rows, cwd) => {
  const ticket=extension.beginConnection?.(sid)
  let client
  try{
    const server=extension.owns(sid)?await extension.resolveServer(sid):find(sid)
    client=await connect(server,{ticket})
    const stream=await P(client,'shell',{term:'xterm-256color',cols,rows})
    conns.set(id,{client,stream,server,tmp:[]})
    stream.on('data',d=>send('term:data',id,d));stream.on('close',()=>client.end());client.on('close',()=>drop(id))
    if(cwd)stream.write(`cd ${q(cwd)}\n`)
  }catch(e){client?.end();throw e}finally{extension.endConnection?.(ticket)}
})
ipcMain.on('term:write', (_, id, d) => conns.get(id)?.stream?.write(d))
ipcMain.on('term:resize', (_, id, cols, rows) => conns.get(id)?.stream?.setWindow(rows, cols, 0, 0))

// ---------- Liens d'invitation (cyberdog://invite/<jeton>) ----------
const INVITE_PREFIX = 'cyberdog://invite/'
const inviteFrom = args => args.find(a => typeof a === 'string' && a.startsWith(INVITE_PREFIX) && a.length < 200)
let pendingInvite = inviteFrom(process.argv) || null
function receiveInvite(link) {
  if (!link) return
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    send('invite:received', link)
    if (win.isMinimized()) win.restore()
    win.focus()
  } else pendingInvite = link
}
accountIPC('invite:take', () => { const link = pendingInvite; pendingInvite = null; return link })
if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', (_, argv) => receiveInvite(inviteFrom(argv)))
app.on('open-url', (event, url) => { event.preventDefault(); if (url.startsWith(INVITE_PREFIX) && url.length < 200) receiveInvite(url) })
if (app.isPackaged && !isMas) app.setAsDefaultProtocolClient('cyberdog') // team invitations: no account in the Mac App Store edition

// ---------- Fenêtre ----------
app.whenReady().then(() => {
  if (!isMas) require('./smb-storage').cleanupStaleMounts().catch(() => {}) // shares left mounted by a crash (no SMB in the Mac App Store edition)
  powerMonitor.on('resume', () => syncManager.rescanAll()) // events may have been missed while asleep
  loadSettings()
  setInterval(() => { extension.refresh().catch(() => {}) }, 6 * 60 * 60 * 1000).unref()
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
      { role: 'help', submenu: [{ label: t('kb.title'), accelerator: 'Cmd+/', click: () => win && win.webContents.send('app:shortcuts') }] },
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:true, additionalArguments: isMas ? ['--cyberdog-mas'] : [] },
  })
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  win.webContents.on('will-navigate',event=>event.preventDefault())
  // files with unsaved changes in the editor: the window asks (beforeunload), here the user decides
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win, { type: 'warning', buttons: [t('editor.quit_anyway'), t('btn.cancel')], defaultId: 1, cancelId: 1, message: t('editor.unsaved_quit') })
    if (choice === 0) event.preventDefault()
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
    updater.check()
    setInterval(updater.check, 6 * 60 * 60 * 1000).unref()
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
