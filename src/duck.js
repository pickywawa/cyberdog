// Parse un bookmark Cyberduck (.duck = plist XML) en serveur. Retourne null si non-SFTP.
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function parseDuck(xml) {
  const b = {}
  // ponytail: regex clé/chaîne à plat (ignore les dicts imbriqués), un vrai parseur plist si un champ imbriqué devient utile
  for (const [, k, v] of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) b[k] ??= unxml(v)
  if (b.Protocol !== 'sftp' || !b.Hostname) return null
  return {
    name: b.Nickname || b.Hostname,
    host: b.Hostname,
    port: +b.Port || 22,
    user: b.Username || '',
    key: b['Private Key File'] || undefined,
  }
}

module.exports = { parseDuck }
