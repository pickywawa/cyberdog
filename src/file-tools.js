// Small pure helpers of the file explorer (tested in test/file-tools.test.js): name filters, file URLs, type-to-select.
;(function () {
  // ---- Filters ----
  // A filter hides names matching its patterns ("*.log, node_modules .DS_Store": commas or spaces, * and ? wildcards,
  // case-insensitive) and, optionally, hidden files (names starting with a dot). Folders and files alike.
  // filter: { enabled, patterns, dotfiles }
  function rules(patterns) {
    return String(patterns || '').split(/[,\s]+/).filter(Boolean)
      .map(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'))
  }
  const active = f => !!f?.enabled && (!!f.dotfiles || rules(f.patterns).length > 0)
  function apply(entries, f) {
    if (!active(f)) return entries
    const list = rules(f.patterns)
    return entries.filter(e => !((f.dotfiles && e.name.startsWith('.')) || list.some(r => r.test(e.name))))
  }

  // ---- URL of a file (Copy URL) ----
  // server: a saved server as the renderer sees it; p: the explorer path ("/var/www/index.html"). null when the
  // protocol has no meaningful address (cloud drives).
  const encode = p => p.split('/').map(s => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/')
  const withSlash = p => (p.startsWith('/') ? p : '/' + p)
  function fileUrl(server, p) {
    const path = encode(withSlash(p || '/'))
    const login = u => (u ? encodeURIComponent(u) + '@' : '')
    const port = (value, def) => (value && +value !== def ? ':' + value : '')
    const trim = u => String(u || '').replace(/\/+$/, '')
    const bucket = server.bucket ? '/' + encodeURIComponent(server.bucket) : ''
    switch (server.type || 'ssh') {
      case 'ssh': return `sftp://${login(server.user)}${server.host}${port(server.port, 22)}${path}`
      case 'ftp': {
        const scheme = server.security === 'none' ? 'ftp' : server.security === 'implicit' ? 'ftps' : 'ftpes'
        return `${scheme}://${login(server.user)}${server.host}${port(server.port, scheme === 'ftps' ? 990 : 21)}${path}`
      }
      case 'webdav': return trim(server.url) + path
      case 's3': return `s3:/${bucket}${path}`
      case 'smb': return `smb://${server.host}${bucket}${path}`
      case 'azure': return (trim(server.url) || `https://${server.user}.blob.core.windows.net`) + bucket + path
      case 'azurefiles': return (trim(server.url) || `https://${server.user}.file.core.windows.net`) + bucket + path
      case 'local': return 'file://' + path
      default: return null
    }
  }

  // ---- Type to select ----
  // names: the rows in display order; query: what was typed; current: index of the selected row (or null).
  // One letter cycles through the names starting with it; more letters select the first name starting with them.
  // -> index of the row to select, or -1.
  function typeAhead(names, query, current) {
    const q = String(query || '').toLocaleLowerCase(), n = names.length
    if (!q || !n) return -1
    const starts = i => names[i].toLocaleLowerCase().startsWith(q)
    const from = q.length === 1 && current != null && current >= 0 && current < n && starts(current) ? current + 1 : 0
    for (let k = 0; k < n; k++) { const i = (from + k) % n; if (starts(i)) return i }
    return -1
  }

  const api = { rules, active, apply, fileUrl, typeAhead }
  if (typeof module !== 'undefined') module.exports = api
  else window.fileTools = api
})()
