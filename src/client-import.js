// Supported portable exports: FileZilla XML and WinSCP INI. Credentials are never imported.
const { DOMParser } = require('@xmldom/xmldom')
function filezilla(xml) {
  if (xml.length > 8e6 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or oversized FileZilla XML')
  const errors = []
  const doc = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(xml, 'text/xml')
  if (errors.length || doc.documentElement?.tagName !== 'FileZilla3') throw new Error('Invalid FileZilla export')
  const out = []
  for (const s of Array.from(doc.getElementsByTagName('Server'))) {
    const val = key => Array.from(s.childNodes).find(n => n.nodeType === 1 && n.nodeName === key)?.textContent.trim() || ''
    // FileZilla protocol ids: 1 SFTP, 0 FTP (explicit TLS when available), 4 FTPES, 3 FTPS (implicit), 6 plain FTP
    const protocol = val('Protocol'), ftp = { 0: 'explicit', 4: 'explicit', 3: 'implicit', 6: 'none' }[protocol]
    if ((protocol !== '1' && !ftp) || !val('Host')) continue
    const folders = []
    for (let p = s.parentNode; p; p = p.parentNode) if (p.nodeName === 'Folder') folders.unshift(Array.from(p.childNodes).filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim())
    const group = folders.filter(Boolean).join(' / ') || undefined
    if (ftp) out.push({ name: val('Name') || val('Host'), host: val('Host'), port: Number(val('Port')) || (ftp === 'implicit' ? 990 : 21), user: val('User'), type: 'ftp', security: ftp, group })
    else out.push({ name: val('Name') || val('Host'), host: val('Host'), port: Number(val('Port')) || 22, user: val('User'), key: val('Keyfile') || undefined, group })
  }
  return out
}
function winscp(ini) {
  if (ini.length > 8e6) throw new Error('WinSCP export exceeds 8 MB')
  const decode = s => { try { return decodeURIComponent(s) } catch { return s } }
  const sections = []
  let current
  for (const line of ini.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const section = line.match(/^\s*\[Sessions\\(.+)\]\s*$/)
    if (section) { current = { name: decode(section[1]), values: Object.create(null) }; sections.push(current) }
    else if (/^\s*\[/.test(line)) current = null
    else if (current) { const m = line.match(/^\s*([^;#=][^=]*?)=(.*)$/); if (m) current.values[m[1].toLowerCase()] = decode(m[2].trim()) }
  }
  const defaults = sections.find(s => s.name === 'Default Settings')?.values || {}
  return sections.filter(s => s.name !== 'Default Settings').flatMap(s => {
    const v = { ...defaults, ...s.values }
    const parts = s.name.split('/')
    // WinSCP fsprotocol 5 = FTP; ftps: 0 none, 1 implicit, 2/3 explicit
    if (v.hostname && v.fsprotocol === '5') {
      const security = { 1: 'implicit', 2: 'explicit', 3: 'explicit' }[v.ftps] || 'none'
      return [{ name: parts.pop(), group: parts.join(' / ') || undefined, host: v.hostname, port: Number(v.portnumber) || (security === 'implicit' ? 990 : 21), user: v.username || '', type: 'ftp', security }]
    }
    if (!v.hostname || !['1', '2'].includes(v.fsprotocol || '1')) return []
    return [{ name: parts.pop(), group: parts.join(' / ') || undefined, host: v.hostname, port: Number(v.portnumber) || 22, user: v.username || '', key: v.publickeyfile || undefined }]
  })
}
module.exports = { filezilla, winscp }
