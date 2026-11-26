// Bookmark readers for other clients. Every reader is pure: text in, entries out (the disk is read by client-sources.js).
// Entry: { name, group?, type ('ssh' | 'ftp' | 's3' | 'webdav' | 'azure' | 'azurefiles' | 'dropbox' | 'onedrive' | 'gdrive'),
//          host, port, user, key?, security?, url?, region?, bucket?, pass?, pw }
// pw says what happened to the password: 'ok' (read), 'none' (nothing saved), 'master' (a master password would unlock it),
// 'wrong' (the master password given did not), 'locked' (encrypted in a way Cyberdog cannot read),
// 'external' (kept in the system keychain or the client's own vault), 'legacy' (old format not supported).
const { DOMParser } = require('@xmldom/xmldom')
const secrets = require('./client-secrets')

const MAX = 8e6
const big = text => { if (String(text).length > MAX) throw new Error('Import exceeds 8 MB') }
const join = parts => parts.map(p => String(p || '').trim()).filter(Boolean).join(' / ') || undefined
const httpsUrl = (host, port, secure = true, path = '') => {
  const scheme = secure ? 'https' : 'http', def = secure ? 443 : 80
  return `${scheme}://${host}${port && +port !== def ? ':' + port : ''}${path && path !== '/' ? '/' + String(path).replace(/^\/+/, '') : ''}`
}
const pwOf = pass => pass ? 'ok' : 'none'

// ---------- FileZilla: sitemanager.xml ----------
// Protocol ids (FileZilla ServerProtocol): 0 FTP (TLS when available), 1 SFTP, 3 FTPS implicit, 4 FTPES, 6 plain FTP;
// FileZilla Pro: 7 S3, 9 WebDAV, 10 Azure Files, 11 Azure Blob, 14 Google Drive, 15 Dropbox, 16 OneDrive, 19 WebDAV over http.
function filezilla(xml) {
  big(xml)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid FileZilla XML')
  const errors = []
  const doc = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(xml, 'text/xml')
  if (errors.length || doc.documentElement?.tagName !== 'FileZilla3') throw new Error('Invalid FileZilla export')
  const out = []
  for (const s of Array.from(doc.getElementsByTagName('Server'))) {
    const node = key => Array.from(s.childNodes).find(n => n.nodeType === 1 && n.nodeName === key)
    const val = key => node(key)?.textContent.trim() || ''
    const folders = []
    for (let p = s.parentNode; p; p = p.parentNode) if (p.nodeName === 'Folder') folders.unshift(Array.from(p.childNodes).filter(n => n.nodeType === 3).map(n => n.nodeValue).join(''))
    const host = val('Host'), protocol = +val('Protocol'), port = +val('Port') || undefined
    if (!host) continue
    const base = { name: val('Name') || host, group: join(folders), host, port, user: val('User') }
    const ftp = { 0: 'explicit', 4: 'explicit', 3: 'implicit', 6: 'none' }[protocol]
    let e
    if (protocol === 1) e = { ...base, type: 'ssh', port: port || 22, key: val('Keyfile') || undefined }
    else if (ftp) e = { ...base, type: 'ftp', security: ftp, port: port || (ftp === 'implicit' ? 990 : 21) }
    else if (protocol === 7) e = { ...base, type: 's3', url: httpsUrl(host, port) }
    else if (protocol === 9 || protocol === 19) e = { ...base, type: 'webdav', url: httpsUrl(host, port, protocol === 9) }
    else if (protocol === 10 || protocol === 11) e = { ...base, type: protocol === 10 ? 'azurefiles' : 'azure', user: base.user || host.split('.')[0] }
    else if ({ 14: 1, 15: 1, 16: 1 }[protocol]) e = { ...base, type: { 14: 'gdrive', 15: 'dropbox', 16: 'onedrive' }[protocol], user: '' }
    else continue
    const p = node('Pass')
    if (p) {
      const pass = secrets.filezillaPassword(p.textContent, p.getAttribute('encoding'))
      if (pass === null) e.pw = 'locked'
      else { e.pass = pass; e.pw = pwOf(pass) }
    } else e.pw = 'none'
    out.push(e)
  }
  return out
}

// ---------- INI helpers (WinSCP, PuTTY, MobaXterm, rclone) ----------
function ini(text) {
  const sections = []
  let cur = null
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const h = line.match(/^\s*\[(.+)\]\s*$/)
    if (h) { cur = { name: h[1], values: Object.create(null), order: [] }; sections.push(cur); continue }
    const m = cur && line.match(/^\s*([^;#=\s][^=]*?)\s*=(.*)$/)
    if (m) { cur.values[m[1].toLowerCase()] = m[2].trim(); cur.order.push([m[1], m[2].trim()]) }
  }
  return sections
}
// `reg query <root> /s` output -> INI text with one [prefix\subkey] section per key (REG_DWORD written in decimal).
function regToIni(output, root, prefix) {
  const lines = [], rootLow = root.toLowerCase()
  for (const line of String(output).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      const rel = line.trim().slice(root.length).replace(/^\\/, '')
      lines.push(!line.trim().toLowerCase().startsWith(rootLow) ? '[-]' : rel ? `[${prefix ? prefix + '\\' : ''}${rel}]` : prefix ? `[${prefix}]` : '[-]')
      continue
    }
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/) || line.match(/^\s{2,}(.+?)\s{2,}(REG_\w+)\s*$/)
    if (!m) continue
    const v = m[3] ?? ''
    lines.push(`${m[1]}=${m[2] === 'REG_DWORD' ? parseInt(v, 16) : v}`)
  }
  return lines.join('\n')
}

// ---------- WinSCP: WinSCP.ini or the registry (same keys) ----------
// FSProtocol: 0 SCP, 1 SFTP (SCP fallback), 2 SFTP, 5 FTP, 6 WebDAV, 7 S3. Ftps: 0 none, 1 implicit, 2/3 explicit.
function winscp(text) {
  big(text)
  const decode = s => { try { return decodeURIComponent(s) } catch { return s } }
  const all = ini(text)
  const security = all.find(s => /^Configuration\\Security$/i.test(s.name))?.values || {}
  const sessions = all.filter(s => /^Sessions\\/i.test(s.name)).map(s => ({ name: decode(s.name.replace(/^Sessions\\/i, '')), values: s.values }))
  const defaults = sessions.find(s => s.name === 'Default Settings')?.values || {}
  return sessions.filter(s => s.name !== 'Default Settings').flatMap(s => {
    const v = { ...defaults, ...s.values }
    const parts = s.name.split('/'), name = parts.pop(), group = join(parts)
    const host = decode(v.hostname || ''), user = decode(v.username || ''), port = +v.portnumber || undefined
    if (!host) return []
    const fs = v.fsprotocol || '2', ftps = v.ftps || '0'
    let e
    if (['0', '1', '2'].includes(fs)) e = { type: 'ssh', port: port || 22, key: decode(v.publickeyfile || '') || undefined }
    else if (fs === '5') { const sec = { 1: 'implicit', 2: 'explicit', 3: 'explicit' }[ftps] || 'none'; e = { type: 'ftp', security: sec, port: port || (sec === 'implicit' ? 990 : 21) } }
    else if (fs === '6') e = { type: 'webdav', url: httpsUrl(host, port, ftps !== '0' || port === 443) }
    else if (fs === '7') e = { type: 's3', url: httpsUrl(host, port), region: decode(v.s3defaultregion || '') || undefined }
    else return []
    Object.assign(e, { name, group, host, user })
    if (v.passwordplain) { e.pass = decode(v.passwordplain); e.pw = 'ok' }
    else if (v.password) {
      if (secrets.winscpIsMaster(v.password) || security.usemasterpassword === '1') e.pw = 'locked'
      else { const p = secrets.winscpPassword(v.password, user, host); e.pw = p ? 'ok' : 'locked'; if (p) e.pass = p }
    } else e.pw = 'none'
    return [e]
  })
}

// ---------- PuTTY: registry (Windows) or ~/.putty/sessions (Linux/macOS), same keys ----------
function putty(text) {
  big(text)
  const decode = s => { try { return decodeURIComponent(s) } catch { return s } }
  return ini(text).filter(s => /^Sessions\\/i.test(s.name)).flatMap(s => {
    const name = decode(s.name.replace(/^Sessions\\/i, '')), v = s.values
    if (name === 'Default Settings' || (v.protocol && v.protocol !== 'ssh')) return []
    let host = v.hostname || '', user = v.username || ''
    if (host.includes('@')) { user ||= host.slice(0, host.lastIndexOf('@')); host = host.slice(host.lastIndexOf('@') + 1) }
    if (!host) return []
    return [{ name, type: 'ssh', host, port: +v.portnumber || 22, user, key: v.publickeyfile || undefined, pw: 'none' }]
  })
}
// One file per session in ~/.putty/sessions -> the same INI text as the registry
const puttyFiles = files => files.map(f => `[Sessions\\${f.name}]\n${f.text}`).join('\n')

// ---------- OpenSSH config (VS Code Remote-SSH reads it) ----------
function sshConfig(text, { localUser = '' } = {}) {
  big(text)
  const blocks = []
  let cur = { patterns: ['*'], values: [] }
  blocks.push(cur)
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase(), value = m[2].replace(/^"(.*)"$/, '$1')
    if (key === 'host') { cur = { patterns: value.split(/\s+/), values: [] }; blocks.push(cur) }
    else if (key === 'match') { cur = { patterns: [], values: [] }; blocks.push(cur) }
    else cur.values.push([key, value])
  }
  const glob = p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  const matches = (b, alias) => { let ok = false; for (const p of b.patterns) { if (p.startsWith('!')) { if (glob(p.slice(1)).test(alias)) return false } else if (glob(p).test(alias)) ok = true } return ok }
  const aliases = [...new Set(blocks.flatMap(b => b.patterns).filter(p => p && !/[*?!]/.test(p)))]
  return aliases.map(alias => {
    const v = {}
    for (const b of blocks) if (matches(b, alias)) for (const [k, x] of b.values) v[k] ??= x // first value wins, as in ssh
    const host = (v.hostname || alias).replace(/%h/g, alias)
    return { name: alias, type: 'ssh', host, port: +v.port || 22, user: v.user || localUser, key: v.identityfile || undefined, pw: 'none' }
  })
}

// ---------- rclone.conf ----------
const truthy = v => /^(true|1|yes)$/i.test(v || '')
function rclone(text, { master } = {}) {
  big(text)
  if (secrets.rcloneIsEncrypted(text)) {
    const clear = secrets.rcloneDecryptConfig(text, master)
    if (!clear) { const e = new Error(master ? 'master_wrong' : 'master_required'); e.code = master ? 'master_wrong' : 'master_required'; throw e }
    text = clear
  }
  return ini(text).flatMap(({ name, values: v }) => {
    const pass = v.pass ? secrets.rcloneReveal(v.pass) : null
    const pw = v.pass ? (pass === null ? 'locked' : 'ok') : 'none'
    const withPass = e => ({ ...e, name, ...(pass ? { pass } : {}), pw })
    switch (v.type) {
      case 'sftp': if (!v.host) return []; return [withPass({ type: 'ssh', host: v.host, port: +v.port || 22, user: v.user || '', key: v.key_file || undefined })]
      case 'ftp': {
        if (!v.host) return []
        const security = truthy(v.tls) ? 'implicit' : truthy(v.explicit_tls) ? 'explicit' : 'none'
        return [withPass({ type: 'ftp', host: v.host, port: +v.port || (security === 'implicit' ? 990 : 21), user: v.user || '', security })]
      }
      case 'webdav': {
        let u; try { u = new URL(v.url) } catch { return [] }
        return [withPass({ type: 'webdav', host: u.host, url: v.url, user: v.user || '' })]
      }
      case 's3': {
        const endpoint = v.endpoint ? (/^https?:\/\//.test(v.endpoint) ? v.endpoint : 'https://' + v.endpoint) : ''
        let host = 's3.amazonaws.com'; try { if (endpoint) host = new URL(endpoint).host } catch { return [] }
        const secret = v.secret_access_key || ''
        return [{ name, type: 's3', host, url: endpoint || undefined, region: v.region || undefined, user: v.access_key_id || '', ...(secret ? { pass: secret } : {}), pw: pwOf(secret) }]
      }
      case 'azureblob': case 'azurefiles': {
        if (!v.account) return []
        const type = v.type === 'azureblob' ? 'azure' : 'azurefiles'
        return [{ name, type, host: `${v.account}.${type === 'azure' ? 'blob' : 'file'}.core.windows.net`, user: v.account, bucket: v.share_name || undefined, ...(v.key ? { pass: v.key } : {}), pw: v.key ? 'ok' : 'none' }]
      }
      case 'dropbox': case 'onedrive': case 'drive': {
        const type = { dropbox: 'dropbox', onedrive: 'onedrive', drive: 'gdrive' }[v.type]
        return [{ name, type, host: type, user: '', pw: 'external' }]
      }
      default: return []
    }
  })
}

// ---------- SecureCRT: one .ini per session under Config/Sessions (sub-folders are groups) ----------
// files: [{ rel: 'Prod/web.example.com.ini', text }]
function securecrt(files, { master = '' } = {}) {
  const out = []
  for (const f of files) {
    big(f.text)
    const base = f.rel.split(/[\\/]/).pop()
    if (!/\.ini$/i.test(base) || /^(__FolderData__|Default)\.ini$/i.test(base)) continue
    const v = Object.create(null)
    for (const line of String(f.text).replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^([SDBZ]):"([^"]+)"=(.*)$/)
      if (m) v[m[2].toLowerCase()] = m[1] === 'D' ? parseInt(m[3], 16) : m[3].trim()
    }
    const proto = String(v['protocol name'] || 'SSH2').toUpperCase(), host = v.hostname
    if (!host) continue
    let e
    if (/^SSH[12]$|^SFTP$/.test(proto)) e = { type: 'ssh', port: v['[ssh2] port'] || v.port || 22 }
    else if (/^FTP/.test(proto)) { const security = /SSL|TLS/.test(proto) ? 'explicit' : 'none'; e = { type: 'ftp', security, port: v.port || v['[ftp] port'] || 21 } }
    else continue
    Object.assign(e, { name: base.replace(/\.ini$/i, ''), group: join(f.rel.split(/[\\/]/).slice(0, -1)), host, user: v.username || '' })
    const v2 = v['password v2']
    if (v2) {
      const p = secrets.securecrtPassword(v2, master)
      if (p !== null) { e.pass = p; e.pw = 'ok' }
      else e.pw = master ? 'wrong' : 'master'
    } else e.pw = v.password ? 'legacy' : 'none'
    out.push(e)
  }
  return out
}

// ---------- Tabby: config.yaml profiles ----------
function tabby(text) {
  big(text)
  const yaml = require('js-yaml')
  const doc = yaml.load(text, { schema: yaml.JSON_SCHEMA }) || {}
  const groups = new Map((Array.isArray(doc.groups) ? doc.groups : []).map(g => [g?.id, g?.name]))
  return (Array.isArray(doc.profiles) ? doc.profiles : []).flatMap(p => {
    const o = p?.options || {}
    if (p?.type !== 'ssh' || !o.host) return []
    let key = Array.isArray(o.privateKeys) ? o.privateKeys[0] : undefined
    if (typeof key === 'string' && key.startsWith('file://')) { try { key = require('url').fileURLToPath(key) } catch { key = undefined } }
    return [{ name: String(p.name || o.host), group: join([groups.get(p.group) ?? p.group]), type: 'ssh', host: String(o.host), port: +o.port || 22, user: String(o.user || ''), key: typeof key === 'string' ? key : undefined, pw: o.auth === 'publicKey' ? 'none' : 'external' }]
  })
}

// ---------- MobaXterm: MobaXterm.ini, [Bookmarks] / [Bookmarks_N] ----------
// Session line: "#<type>#<icon>%host%port%user%..." with type 109 SSH, 140 SFTP, 130 FTP.
// Passwords: [Passwords] "ssh22:user@host=<base64>", readable only with the master password.
function mobaxterm(text, { master } = {}) {
  big(text)
  const all = ini(text)
  const stored = new Map()
  for (const s of all.filter(s => /^Passwords$/i.test(s.name))) for (const [k, v] of s.order) stored.set(k.toLowerCase(), v)
  const out = []
  for (const s of all.filter(s => /^Bookmarks(_\d+)?$/i.test(s.name))) {
    const group = join(String(s.values.subrep || '').split('\\'))
    for (const [name, value] of s.order) {
      const m = /^#(\d+)#\d*%(.*)$/.exec(value)
      if (!m || /^(SubRep|ImgNum)$/i.test(name)) continue
      const [host, port, user = ''] = m[2].split('%'), type = { 109: 'ssh', 140: 'ssh', 130: 'ftp' }[m[1]]
      if (!type || !host) continue
      const e = type === 'ftp' ? { name, group, type, host, port: +port || 21, user, security: 'none' } : { name, group, type, host, port: +port || 22, user }
      const raw = stored.get(`${type === 'ftp' ? 'ftp' : 'ssh'}${e.port}:${user}@${host}`.toLowerCase()) ?? stored.get(`${user}@${host}`.toLowerCase())
      if (!raw) e.pw = 'none'
      else if (!master) e.pw = 'master'
      else { const p = secrets.mobaxtermPassword(raw, master); if (p) { e.pass = p; e.pw = 'ok' } else e.pw = 'wrong' }
      out.push(e)
    }
  }
  return out
}

// ---------- Transmit 5: one metadata plist per favorite (com_panic_transmit_* keys) ----------
function transmit(dicts) {
  const out = []
  for (const d of dicts) {
    const get = re => { const k = Object.keys(d || {}).find(k => re.test(k)); return k ? d[k] : undefined }
    const host = get(/server$|hostname$|address$/i), proto = String(get(/protocol$/i) || 'sftp').toLowerCase()
    if (typeof host !== 'string' || !host) continue
    const port = +get(/port$/i) || undefined, user = String(get(/username$|user$/i) || ''), name = String(get(/nickname$/i) || get(/^(name|title)$/i) || host)
    let e
    if (/sftp|ssh/.test(proto)) e = { type: 'ssh', port: port || 22 }
    else if (/ftp/.test(proto)) { const security = /implicit/.test(proto) ? 'implicit' : /ftps|ssl|tls/.test(proto) ? 'explicit' : 'none'; e = { type: 'ftp', security, port: port || (security === 'implicit' ? 990 : 21) } }
    else if (/s3/.test(proto)) e = { type: 's3', url: httpsUrl(host, port) }
    else if (/dav/.test(proto)) e = { type: 'webdav', url: httpsUrl(host, port, /https|ssl|tls/.test(proto) || port === 443) }
    else continue
    out.push({ ...e, name, group: typeof d.group === 'string' ? d.group : undefined, host, user, pw: 'external' })
  }
  return out
}

// ---------- WebSSH (macOS / iOS): webssh.db rows { key, attribute, value } of NSFValues ----------
// Connection objects carry objectType "connection"; roles say SSH and/or SFTP. The password is stored as is.
function webssh(rows) {
  const objects = new Map()
  for (const r of rows) { if (!objects.has(r.key)) objects.set(r.key, {}); objects.get(r.key)[r.attribute] = r.value }
  const out = []
  for (const o of objects.values()) {
    if (o.objectType !== 'connection' || o.type && o.type !== 'SERVER' || +o.objectIsDeleted || !o.host) continue
    if (o.roles && !/SSH|SFTP/i.test(o.roles)) continue
    const pass = typeof o['authentication.password'] === 'string' ? o['authentication.password'] : ''
    out.push({ name: String(o.name || o.host), group: join([o.groupName]), type: 'ssh', host: String(o.host), port: +o.port || 22, user: String(o['authentication.user'] || ''), ...(pass ? { pass } : {}), pw: pwOf(pass) })
  }
  return out
}

// ---------- Apple plist XML and NSKeyedArchiver (Transmit's Connections.transmitstore) ----------
function plistXml(xml) {
  big(xml)
  if (/<!ENTITY/i.test(xml)) throw new Error('Invalid plist')
  const doc = new DOMParser({ errorHandler: {} }).parseFromString(xml, 'text/xml')
  const kids = n => Array.from(n.childNodes).filter(c => c.nodeType === 1)
  const val = n => {
    switch (n.nodeName) {
      case 'dict': { const o = {}, c = kids(n); for (let i = 0; i + 1 < c.length; i += 2) o[c[i].textContent] = val(c[i + 1]); return o }
      case 'array': return kids(n).map(val)
      case 'string': case 'date': return n.textContent
      case 'integer': case 'real': return Number(n.textContent)
      case 'true': return true
      case 'false': return false
      case 'data': return Buffer.from(n.textContent.replace(/\s+/g, ''), 'base64')
      default: return null
    }
  }
  const root = doc.documentElement && kids(doc.documentElement)[0]
  return root ? val(root) : null
}
function unarchive(archive) {
  const objs = archive?.$objects
  if (!Array.isArray(objs)) return archive
  const seen = new Map()
  const uid = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'CF$UID' in v
  const res = v => {
    if (uid(v)) v = objs[v['CF$UID']]
    if (v === '$null') return null
    if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) return v
    if (seen.has(v)) return seen.get(v)
    if (Array.isArray(v)) { const a = []; seen.set(v, a); v.forEach(x => a.push(res(x))); return a }
    if (Array.isArray(v['NS.objects']) && !v['NS.keys']) { const a = []; seen.set(v, a); v['NS.objects'].forEach(x => a.push(res(x))); return a }
    const o = {}; seen.set(v, o)
    if (Array.isArray(v['NS.keys'])) v['NS.keys'].forEach((k, i) => { o[res(k)] = res(v['NS.objects'][i]) })
    else for (const [k, x] of Object.entries(v)) if (k !== '$class') o[k] = res(x)
    return o
  }
  return res(archive.$top?.root ?? Object.values(archive.$top || {})[0])
}
// Transmit groups: { name, connections: [...], groups?/children? } -> flat dicts tagged with their group path
function transmitStore(root) {
  const out = [], seen = new Set()
  const visit = (node, trail) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) return node.forEach(n => visit(n, trail))
    const hostKey = Object.keys(node).find(k => /^(server|address|host|hostname)$/i.test(k))
    if (hostKey && typeof node[hostKey] === 'string') { out.push({ ...node, group: join(trail) }); return }
    const isGroup = Array.isArray(node.connections) || Array.isArray(node.children) || Array.isArray(node.groups)
    const name = isGroup && typeof node.name === 'string' && !/^(GlobalSiteGroup|History)/i.test(node.name) ? [node.name] : []
    for (const [k, v] of Object.entries(node)) if (!/^history/i.test(k) && k !== 'parent') visit(v, [...trail, ...name])
  }
  visit(root, [])
  return transmit(out)
}

module.exports = { webssh, plistXml, unarchive, transmitStore, filezilla, winscp, putty, puttyFiles, sshConfig, rclone, securecrt, tabby, mobaxterm, transmit, regToIni, ini }
