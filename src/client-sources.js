// Where other clients keep their bookmarks, per OS, and how to read them (parsers: client-import.js).
// A source: { id, label, installed(env), auto(env) -> loader | null, pick?: { files | folder, extensions }, unsupported? }
// loader: { file, read(opts) -> entries }. env: { home, appData, platform, exec(cmd, args) -> stdout, localUser }
const fs = require('fs')
const path = require('path')
const parsers = require('./client-import')
const { parseDuck } = require('./duck')

const exists = p => { try { return !!p && fs.existsSync(p) } catch { return false } }
const isFile = p => { try { return fs.statSync(p).isFile() } catch { return false } }
const MAX = 8e6
// UTF-16 (regedit, some WinSCP.ini) or UTF-8
function readText(file) {
  const st = fs.statSync(file)
  if (!st.isFile() || st.size > MAX) throw new Error('Import exceeds 8 MB')
  const b = fs.readFileSync(file)
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  return b.toString('utf8').replace(/^﻿/, '')
}
const listDir = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)).filter(isFile) } catch { return [] } }
function walk(dir, re, rel = '', out = [], depth = 0) {
  if (depth > 8) return out
  let items = []
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of items) {
    const r = rel ? rel + '/' + d.name : d.name
    if (d.isDirectory()) walk(path.join(dir, d.name), re, r, out, depth + 1)
    else if (re.test(d.name)) out.push({ file: path.join(dir, d.name), rel: r })
  }
  return out
}
const app = (env, mac, win = []) => env.platform === 'darwin'
  ? mac.some(n => exists(path.join('/Applications', n)) || exists(path.join(env.home, 'Applications', n)))
  : env.platform === 'win32' ? win.some(exists) : false
const reg = async (env, key) => { try { return await env.exec('reg', ['query', key, '/s']) } catch { return '' } }

// .reg export (regedit) -> the INI form `reg query` gives: [Sessions\name] + key=value
function regFileToIni(text, root) {
  const out = [], low = root.toLowerCase()
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^\[(.+)\]\s*$/)
    if (h) { const k = h[1]; out.push(k.toLowerCase().startsWith(low + '\\') ? `[Sessions\\${k.slice(root.length + 1)}]` : '[-]'); continue }
    const m = line.match(/^"(.+?)"=(.*)$/)
    if (!m) continue
    let v = m[2]
    if (/^dword:/i.test(v)) v = String(parseInt(v.slice(6), 16))
    else v = v.replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\').replace(/\\"/g, '"')
    out.push(`${m[1]}=${v}`)
  }
  return out.join('\n')
}

// Cyberduck: XML as is, binary plist (macOS) through plutil
async function readPlist(env, f, format = 'xml1') {
  const raw = fs.readFileSync(f)
  if (format === 'xml1' && raw.includes('<plist')) return raw.toString('utf8')
  if (env.platform !== 'darwin') return ''
  try { return await env.exec('plutil', ['-convert', format, '-o', '-', f]) } catch { return '' }
}
const duckDirs = env => env.platform === 'win32'
  ? [path.join(env.appData, 'Cyberduck', 'Bookmarks')]
  : [path.join(env.home, 'Library/Application Support/duck/Bookmarks'), path.join(env.home, 'Library/Group Containers/G69SCX94XU.duck/Library/Application Support/duck/Bookmarks')]
const readDucks = async (env, files) => { const out = []; for (const f of files) { const e = parseDuck(await readPlist(env, f)); if (e) out.push(e) } return out }

const filezillaFile = env => env.platform === 'win32' ? path.join(env.appData, 'FileZilla', 'sitemanager.xml') : path.join(env.home, '.config/filezilla/sitemanager.xml')
const WINSCP_KEY = 'HKEY_CURRENT_USER\\Software\\Martin Prikryl\\WinSCP 2'
const PUTTY_KEY = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions'
const MOBA_KEY = 'HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm'
const mobaFiles = env => [path.join(env.appData, 'MobaXterm', 'MobaXterm.ini'), path.join(env.home, 'Documents', 'MobaXterm', 'MobaXterm.ini')]
const rcloneFile = env => process.env.RCLONE_CONFIG || (env.platform === 'win32' ? path.join(env.appData, 'rclone', 'rclone.conf') : path.join(env.home, '.config/rclone/rclone.conf'))
const crtDir = env => env.platform === 'win32' ? path.join(env.appData, 'VanDyke', 'Config', 'Sessions')
  : env.platform === 'darwin' ? path.join(env.home, 'Library/Application Support/VanDyke/SecureCRT/Config/Sessions') : path.join(env.home, '.vandyke/SecureCRT/Config/Sessions')
const tabbyFile = env => env.platform === 'win32' ? path.join(env.appData, 'tabby', 'config.yaml')
  : env.platform === 'darwin' ? path.join(env.home, 'Library/Application Support/tabby/config.yaml') : path.join(env.home, '.config/tabby/config.yaml')
const transmitDir = env => path.join(env.home, 'Library/Application Support/Transmit/Metadata')
const transmitStores = env => [path.join(env.home, 'Library/Containers/com.panic.transmit.mas/Data/Library/Application Support/Transmit/Connections.transmitstore'), path.join(env.home, 'Library/Application Support/Transmit/Connections.transmitstore')]
const websshDb = env => path.join(env.home, 'Library/Containers/com.itimeteo.webssh/Data/Library/Application Support/webssh.db')
const vscodeSettings = env => env.platform === 'win32' ? path.join(env.appData, 'Code', 'User', 'settings.json')
  : env.platform === 'darwin' ? path.join(env.home, 'Library/Application Support/Code/User/settings.json') : path.join(env.home, '.config/Code/User/settings.json')
// remote.SSH.configFile when VS Code points at another file, ~/.ssh/config otherwise
function sshConfigFile(env) {
  try {
    const m = readText(vscodeSettings(env)).match(/"remote\.SSH\.configFile"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) { const p = JSON.parse(`"${m[1]}"`).replace(/^~(?=$|[\\/])/, env.home); if (path.isAbsolute(p)) return p }
  } catch {}
  return path.join(env.home, '.ssh', 'config')
}
const fileLoader = (file, parse) => isFile(file) ? { file, read: opts => parse(readText(file), opts) } : null

const SOURCES = [
  {
    id: 'cyberduck', label: 'Cyberduck', os: ['darwin', 'win32'],
    installed: env => app(env, ['Cyberduck.app'], [path.join(env.programFiles, 'Cyberduck')]),
    auto: env => { const dir = duckDirs(env).find(d => listDir(d, /\.duck$/i).length); return dir ? { file: dir, read: () => readDucks(env, listDir(dir, /\.duck$/i)) } : null },
    pick: { multi: true, extensions: ['duck'], read: (env, files) => readDucks(env, files) },
  },
  {
    id: 'filezilla', label: 'FileZilla', os: ['darwin', 'win32', 'linux'],
    installed: env => app(env, ['FileZilla.app'], [path.join(env.programFiles, 'FileZilla FTP Client')]) || exists(path.dirname(filezillaFile(env))),
    auto: env => fileLoader(filezillaFile(env), parsers.filezilla),
    pick: { extensions: ['xml'], read: (env, [f]) => parsers.filezilla(readText(f)) },
  },
  {
    id: 'winscp', label: 'WinSCP', os: ['win32'],
    installed: env => app(env, [], [path.join(env.programFiles, 'WinSCP'), path.join(env.programFilesX86, 'WinSCP'), path.join(env.localAppData, 'Programs', 'WinSCP')]),
    auto: async env => {
      const file = [path.join(env.appData, 'WinSCP.ini')].find(isFile)
      if (file) return { file, read: () => parsers.winscp(readText(file)) }
      const out = await reg(env, WINSCP_KEY + '\\Sessions')
      if (!out.trim()) return null
      return { file: WINSCP_KEY, read: async () => parsers.winscp(parsers.regToIni(out, WINSCP_KEY, '') + '\n' + parsers.regToIni(await reg(env, WINSCP_KEY + '\\Configuration\\Security'), WINSCP_KEY, '')) }
    },
    pick: { extensions: ['ini'], read: (env, [f]) => parsers.winscp(readText(f)) },
  },
  {
    id: 'mobaxterm', label: 'MobaXterm', os: ['win32'], master: true,
    installed: env => app(env, [], [path.join(env.programFilesX86, 'Mobatek', 'MobaXterm'), path.join(env.programFiles, 'Mobatek', 'MobaXterm')]) || mobaFiles(env).some(isFile),
    auto: env => {
      const file = mobaFiles(env).find(isFile)
      if (!file) return null
      // passwords of the installed edition live in the registry (key P)
      return { file, read: async opts => parsers.mobaxterm(readText(file) + '\n' + parsers.regToIni(await reg(env, MOBA_KEY + '\\P'), MOBA_KEY + '\\P', 'Passwords'), opts) }
    },
    pick: { extensions: ['ini'], read: (env, [f], opts) => parsers.mobaxterm(readText(f), opts) },
  },
  {
    id: 'transmit', label: 'Transmit', os: ['darwin'],
    installed: env => app(env, ['Transmit.app']),
    auto: env => {
      const store = transmitStores(env).find(isFile)
      if (store) return { file: store, read: () => readTransmitStore(env, store) }
      const meta = listDir(transmitDir(env), /\.favoriteMetadata$/i)
      return meta.length ? { file: transmitDir(env), read: () => readTransmit(env, meta) } : null
    },
    pick: { multi: true, extensions: ['transmitstore', 'favoriteMetadata'], read: async (env, files) => (await Promise.all(files.map(f => /\.transmitstore$/i.test(f) ? readTransmitStore(env, f) : readTransmit(env, [f])))).flat() },
  },
  {
    id: 'webssh', label: 'WebSSH', os: ['darwin'],
    installed: env => app(env, ['WebSSH.app']) || isFile(websshDb(env)),
    auto: env => isFile(websshDb(env)) ? { file: websshDb(env), read: () => readWebssh(env, websshDb(env)) } : null,
    pick: { extensions: ['db'], read: (env, [f]) => readWebssh(env, f) },
  },
  { id: 'termius', label: 'Termius', os: ['darwin', 'win32', 'linux'], unsupported: 'termius', installed: env => app(env, ['Termius.app'], [path.join(env.localAppData, 'Programs', 'Termius')]) },
  {
    id: 'rclone', label: 'rclone', os: ['darwin', 'win32', 'linux'], master: true,
    installed: env => isFile(rcloneFile(env)),
    auto: env => fileLoader(rcloneFile(env), parsers.rclone),
    pick: { extensions: ['conf'], read: (env, [f], opts) => parsers.rclone(readText(f), opts) },
  },
  {
    id: 'putty', label: 'PuTTY', os: ['darwin', 'win32', 'linux'],
    installed: env => app(env, [], [path.join(env.programFiles, 'PuTTY'), path.join(env.programFilesX86, 'PuTTY')]) || listDir(path.join(env.home, '.putty', 'sessions'), /./).length > 0,
    auto: async env => {
      if (env.platform === 'win32') {
        const out = await reg(env, PUTTY_KEY)
        return out.trim() ? { file: PUTTY_KEY, read: () => parsers.putty(parsers.regToIni(out, PUTTY_KEY, 'Sessions')) } : null
      }
      const dir = path.join(env.home, '.putty', 'sessions'), files = listDir(dir, /./)
      return files.length ? { file: dir, read: () => parsers.putty(parsers.puttyFiles(files.map(f => ({ name: path.basename(f), text: readText(f) })))) } : null
    },
    pick: { extensions: ['reg'], read: (env, [f]) => parsers.putty(regFileToIni(readText(f), PUTTY_KEY)) },
  },
  {
    id: 'securecrt', label: 'SecureCRT', os: ['darwin', 'win32', 'linux'], master: true,
    installed: env => app(env, ['SecureCRT.app'], [path.join(env.programFiles, 'VanDyke Software', 'SecureCRT')]) || exists(crtDir(env)),
    auto: env => { const dir = crtDir(env); return walk(dir, /\.ini$/i).length ? { file: dir, read: opts => readCrt(dir, opts) } : null },
    pick: { folder: true, read: (env, [dir], opts) => readCrt(dir, opts) },
  },
  {
    id: 'tabby', label: 'Tabby', os: ['darwin', 'win32', 'linux'],
    installed: env => app(env, ['Tabby.app'], [path.join(env.localAppData, 'Programs', 'Tabby')]) || isFile(tabbyFile(env)),
    auto: env => fileLoader(tabbyFile(env), parsers.tabby),
    pick: { extensions: ['yaml', 'yml'], read: (env, [f]) => parsers.tabby(readText(f)) },
  },
  { id: 'commanderone', label: 'Commander One', os: ['darwin'], unsupported: 'commanderone', installed: env => app(env, ['Commander One.app', 'Commander One PRO.app']) },
  {
    id: 'sshconfig', label: 'VS Code · SSH config', os: ['darwin', 'win32', 'linux'],
    installed: env => isFile(sshConfigFile(env)),
    auto: env => fileLoader(sshConfigFile(env), (text, opts) => parsers.sshConfig(text, { ...opts, localUser: env.localUser })),
    pick: { read: (env, [f]) => parsers.sshConfig(readText(f), { localUser: env.localUser }) },
  },
]

async function readTransmit(env, files) {
  const dicts = []
  for (const f of files) { try { dicts.push(JSON.parse(await readPlist(env, f, 'json'))) } catch {} }
  return parsers.transmit(dicts)
}
async function readTransmitStore(env, file) {
  const xml = await readPlist(env, file)
  return xml ? parsers.transmitStore(parsers.unarchive(parsers.plistXml(xml))) : []
}
// WebSSH keeps its objects in SQLite: read it with the system sqlite3, read-only
async function readWebssh(env, file) {
  if (fs.statSync(file).size > 64e6) throw new Error('Import exceeds 64 MB')
  const out = await env.exec('sqlite3', ['-readonly', '-json', file, 'SELECT NSFKey AS key, NSFAttribute AS attribute, NSFValue AS value FROM NSFValues'])
  return parsers.webssh(out.trim() ? JSON.parse(out) : [])
}
function readCrt(dir, opts) {
  const files = walk(dir, /\.ini$/i).slice(0, 5000).map(({ file, rel }) => ({ rel, text: readText(file) }))
  return parsers.securecrt(files, opts)
}

module.exports = { SOURCES, regFileToIni, readText }
