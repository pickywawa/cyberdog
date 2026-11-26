// Import from other clients: detection (home page), preview (summary before import) and import.
// Passwords never reach the renderer: the preview only says whether each one was read.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const serverType = require('./server-type')
const localSshKeys = require('./local-ssh-keys')
const { SOURCES } = require('./client-sources')

const env = () => ({
  home: os.homedir(), appData: process.env.APPDATA || '', localAppData: process.env.LOCALAPPDATA || '',
  programFiles: process.env.ProgramFiles || 'C:\\Program Files', programFilesX86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  platform: process.platform, localUser: (() => { try { return os.userInfo().username } catch { return '' } })(),
  exec: (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64e6, windowsHide: true, timeout: 20000 }, (e, out) => e ? rej(e) : res(out))),
})
const sources = e => SOURCES.filter(s => s.os.includes(e.platform))
const serverKey = s => [s.type || 'ssh', String(s.host || '').toLowerCase(), +s.port || 22, String(s.user || '').toLowerCase()].join('|')

// An entry from a reader -> the data servers:save takes, or null when it cannot become a server
function normalize(e, ev) {
  const type = e.type || 'ssh'
  const d = { name: String(e.name || e.host || '').trim().slice(0, 200), host: String(e.host || '').trim(), user: String(e.user || '').trim() }
  if (type !== 'ssh') d.type = type
  if (e.port) d.port = +e.port
  for (const k of ['security', 'url', 'region', 'bucket']) if (e[k]) d[k] = e[k]
  if (type === 'ssh') { d.user ||= ev.localUser; d.port ||= 22 }
  if (type === 'ftp') d.user ||= 'anonymous'
  if (e.key && type === 'ssh') {
    const key = String(e.key).replace(/^~(?=$|[\\/])/, ev.home)
    try { if (path.isAbsolute(key)) { localSshKeys.readPrivateKey(key); d.key = key } } catch {}
  }
  let storage
  try { storage = serverType.storageFields(d) } catch { return null }
  const host = storage ? storage.host : d.host, port = storage ? storage.port : d.port
  if (!host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!d.name) d.name = host
  return { data: d, group: e.group ? String(e.group).trim().slice(0, 100) : '', pass: typeof e.pass === 'string' && e.pass ? e.pass : '', pw: e.pw || 'none', match: serverKey({ type, host, port, user: d.user }), keyDropped: !!e.key && !d.key && type === 'ssh' }
}

function register({ ipcMain, dialog, getWin, servers, groups, groupByName, addGroup, saveServer, list }) {
  const sessions = new Map() // token -> { source, read, file }
  const existingOf = n => servers().find(s => !s.teamId && serverKey(s) === n.match)

  async function load(source, read, opts = {}) {
    const ev = env()
    try {
      const entries = (await read(opts)).map(e => normalize(e, ev)).filter(Boolean)
      // the same server listed twice in the source: keep the first
      const seen = new Set()
      return { entries: entries.filter(n => !seen.has(n.match) && seen.add(n.match)) }
    } catch (e) {
      if (e.code === 'master_required' || e.code === 'master_wrong') return { entries: [], locked: e.code }
      throw e
    }
  }

  ipcMain.handle('import:sources', async () => {
    const ev = env(), out = []
    for (const s of sources(ev)) {
      let loader = null, installed = false
      try { installed = !!s.installed?.(ev) } catch {}
      try { loader = s.auto ? await s.auto(ev) : null } catch {}
      if (!installed && !loader) { if (s.pick || s.unsupported) out.push({ id: s.id, label: s.label, installed: false, pick: !!s.pick, unsupported: s.unsupported }); continue }
      const item = { id: s.id, label: s.label, installed: true, auto: !!loader, pick: !!s.pick, unsupported: s.unsupported, master: !!s.master }
      if (loader) {
        try {
          const r = await load(s, loader.read)
          item.total = r.entries.length
          item.fresh = r.entries.filter(n => !existingOf(n)).length
          item.locked = r.locked
        } catch (e) { item.error = e.message }
      }
      out.push(item)
    }
    return out
  })

  // opts: { pick (choose a file even if the client was found), master, token (unlock the same selection again) }
  ipcMain.handle('import:preview', async (_, id, opts = {}) => {
    const ev = env(), s = sources(ev).find(x => x.id === id)
    if (!s || s.unsupported) throw new Error('Unsupported import source')
    let sess = opts.token && sessions.get(opts.token)
    if (!sess || sess.source !== id) {
      const loader = !opts.pick && s.auto ? await s.auto(ev) : null
      if (loader) sess = { source: id, file: loader.file, read: loader.read }
      else {
        if (!s.pick) return null
        const props = s.pick.folder ? ['openDirectory'] : ['openFile', ...(s.pick.multi ? ['multiSelections'] : [])]
        const filters = s.pick.extensions ? [{ name: s.label, extensions: s.pick.extensions }, { name: '*', extensions: ['*'] }] : undefined
        const r = await dialog.showOpenDialog(getWin(), { title: s.label, defaultPath: ev.home, properties: props, filters })
        if (r.canceled || !r.filePaths.length) return null
        for (const f of r.filePaths) if (!s.pick.folder && fs.statSync(f).size > 64e6) throw new Error('Import exceeds 64 MB')
        sess = { source: id, file: r.filePaths.join(', '), read: o => s.pick.read(ev, r.filePaths, o) }
      }
      sess.token = crypto.randomUUID()
      sessions.clear() // one summary open at a time
      sessions.set(sess.token, sess)
    }
    const r = await load(s, sess.read, { master: typeof opts.master === 'string' ? opts.master : undefined })
    sess.entries = r.entries
    const items = r.entries.map((n, i) => {
      const ex = existingOf(n)
      return { i, name: n.data.name, group: n.group, type: n.data.type || 'ssh', host: n.data.url || n.data.host, port: n.data.port, user: n.data.user, pw: n.pw, keyDropped: n.keyDropped, status: ex ? 'existing' : 'new', existingName: ex?.name }
    })
    return { token: sess.token, id, label: s.label, file: sess.file, items, locked: r.locked, master: !!s.master }
  })

  ipcMain.handle('import:apply', async (_, token, indices) => {
    const sess = sessions.get(token)
    if (!sess?.entries) throw new Error('Import expired')
    let added = 0, updated = 0, passwords = 0
    const failed = []
    for (const i of new Set(indices)) {
      const n = sess.entries[i]
      if (!n) continue
      const ex = existingOf(n)
      const d = { ...n.data }
      if (ex) d.id = ex.id
      if (n.group) d.group = (groupByName(n.group) ?? addGroup(n.group)).id
      if (n.pass) { d.pass = n.pass; if (!d.key) d.authMode = 'password' }
      else if (d.key) d.authMode = 'key'
      try {
        await saveServer(d)
        ex ? updated++ : added++
        if (n.pass) passwords++
      } catch (e) { failed.push({ name: d.name, error: e.message }) }
    }
    sessions.delete(token)
    return { servers: list(), groups: groups(), added, updated, passwords, failed }
  })
}

module.exports = { register, normalize, serverKey }
