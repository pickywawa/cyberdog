// Export / import (serveurs, actions rapides) : un .json par élément dans un zip. Pur JS (adm-zip), identique sur macOS et Windows.
const AdmZip = require('adm-zip')
const fs = require('fs')
const path = require('path')

// Seuls les champs listés sortent (par défaut : jamais le mot de passe ni l'empreinte d'hôte).
async function exportZip(items, file, fields = ['name', 'host', 'port', 'user', 'key']) {
  if(items.some(s=>s.networkAccess?.mode==='bastion'))throw Error('Routed servers require a configuration ZIP with dependencies')
  const zip = new AdmZip()
  items.forEach((s, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${s.name.replace(/[^\w.-]+/g, '_')}.json`
    zip.addFile(name, Buffer.from(JSON.stringify(Object.fromEntries(fields.map(k => [k, s[k]])), null, 2)))
  })
  fs.writeFileSync(file, zip.toBuffer())
}

// Retourne les objets JSON, dans l'ordre des noms (compatible zip fait au Finder/Explorateur : dossier, __MACOSX, ._*).
// Lecture en mémoire uniquement : rien n'est extrait sur le disque (pas de zip-slip).
async function readZip(file) {
  const out = []
  const entries = new AdmZip(file).getEntries().filter(e => !e.isDirectory).sort((a, b) => a.entryName.localeCompare(b.entryName))
  for (const e of entries) {
    const name = e.entryName
    if (!name.endsWith('.json') || name.includes('__MACOSX') || path.basename(name).startsWith('._') || e.header.size > 1e5) continue
    try { out.push(JSON.parse(e.getData().toString('utf8'))) } catch {}
  }
  return out
}

module.exports = { exportZip, readZip }
