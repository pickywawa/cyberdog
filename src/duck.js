// Parse un bookmark Cyberduck (.duck = plist XML) en serveur. Retourne null si ni SFTP ni FTP/FTPS.
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function parseDuck(xml) {
  const b = {}
  // ponytail: regex clé/chaîne à plat (ignore les dicts imbriqués), un vrai parseur plist si un champ imbriqué devient utile
  for (const [, k, v] of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) b[k] ??= unxml(v)
  if (!b.Hostname) return null
  if (b.Protocol === 'ftp' || b.Protocol === 'ftp-tls') {
    // Cyberduck: ftp = plain, ftp-tls = FTPS (implicit on port 990, explicit otherwise)
    const tls = b.Protocol === 'ftp-tls', port = +b.Port || 21
    return { name: b.Nickname || b.Hostname, host: b.Hostname, port, user: b.Username || '', type: 'ftp', security: !tls ? 'none' : port === 990 ? 'implicit' : 'explicit' }
  }
  if (b.Protocol !== 'sftp') return null
  return {
    name: b.Nickname || b.Hostname,
    host: b.Hostname,
    port: +b.Port || 22,
    user: b.Username || '',
    key: b['Private Key File'] || undefined,
  }
}

module.exports = { parseDuck }
