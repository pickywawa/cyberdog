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
    if (val('Protocol') !== '1' || !val('Host')) continue
    const folders = []
    for (let p = s.parentNode; p; p = p.parentNode) if (p.nodeName === 'Folder') folders.unshift(Array.from(p.childNodes).filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim())
    out.push({ name: val('Name') || val('Host'), host: val('Host'), port: Number(val('Port')) || 22, user: val('User'), key: val('Keyfile') || undefined, group: folders.filter(Boolean).join(' / ') || undefined })
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
    if (!v.hostname || !['1', '2'].includes(v.fsprotocol || '1')) return []
    const parts = s.name.split('/')
    return [{ name: parts.pop(), group: parts.join(' / ') || undefined, host: v.hostname, port: Number(v.portnumber) || 22, user: v.username || '', key: v.publickeyfile || undefined }]
  })
}
module.exports = { filezilla, winscp }
