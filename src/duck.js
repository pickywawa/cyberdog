// Parse un bookmark Cyberduck (.duck = plist XML) en serveur. Retourne null pour un protocole non géré.
// Les mots de passe restent dans le trousseau du système (pw: 'external').
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function parseDuck(xml) {
  const b = {}
  // ponytail: regex clé/chaîne à plat (ignore les dicts imbriqués), un vrai parseur plist si un champ imbriqué devient utile
  for (const [, k, v] of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) b[k] ??= unxml(v)
  if (!b.Hostname) return null
  const base = { name: b.Nickname || b.Hostname, host: b.Hostname, user: b.Username || '', pw: 'external' }
  const port = +b.Port || undefined
  switch (b.Protocol) {
    case 'ftp': case 'ftp-tls': {
      // Cyberduck: ftp = plain, ftp-tls = FTPS (implicit on port 990, explicit otherwise)
      const tls = b.Protocol === 'ftp-tls', p = port || 21
      return { ...base, port: p, type: 'ftp', security: !tls ? 'none' : p === 990 ? 'implicit' : 'explicit' }
    }
    case 'sftp': return { ...base, port: port || 22, key: b['Private Key File'] || undefined }
    case 's3': return { ...base, type: 's3', url: `https://${b.Hostname}${port && port !== 443 ? ':' + port : ''}` }
    case 'dav': case 'davs': {
      const secure = b.Protocol === 'davs', def = secure ? 443 : 80, path = (b.Path || '').replace(/^\/+/, '')
      return { ...base, type: 'webdav', url: `${secure ? 'https' : 'http'}://${b.Hostname}${port && port !== def ? ':' + port : ''}${path ? '/' + path : ''}` }
    }
    case 'azure': return { ...base, type: 'azure', user: b.Username || b.Hostname.split('.')[0] }
    case 'dropbox': case 'onedrive': case 'googledrive': return { ...base, type: b.Protocol === 'googledrive' ? 'gdrive' : b.Protocol, user: '' }
    default: return null
  }
}

module.exports = { parseDuck }
