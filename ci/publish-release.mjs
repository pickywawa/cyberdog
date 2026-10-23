// Crée (ou complète) la Release GitLab du tag courant avec les fichiers déjà publiés dans le Package Registry
// (voir ci/upload.sh). N'utilise que CI_JOB_TOKEN : aucun jeton personnel nécessaire.
// Idempotent : peut être relancé (ex. après l'ajout du .dmg par un runner macOS).
import { readFileSync } from 'node:fs'

const { CI_API_V4_URL: api, CI_PROJECT_ID: pid, CI_JOB_TOKEN: token, CI_COMMIT_TAG: tag } = process.env
if (!api || !pid || !token || !tag) {
  console.error('CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN et CI_COMMIT_TAG sont requis (pipeline de tag uniquement).')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.version !== version) {
  console.error(`Le tag ${tag} ne correspond pas à package.json (${pkg.version}).`)
  process.exit(1)
}

const PACKAGE = 'cyberdog'
const base = `${api}/projects/${pid}/packages/generic/${PACKAGE}/${version}`
const headers = { 'JOB-TOKEN': token }
const CANDIDATES = [
  `Cyberdog-Setup-${version}-x64.exe`,
  `Cyberdog-${version}-portable-x64.exe`,
  `Cyberdog-${version}-mac-arm64.dmg`,
  `Cyberdog-${version}-mac-x64.dmg`,
  'SHA256SUMS-windows.txt',
  'SHA256SUMS-macos.txt',
]

const exists = async file => {
  const r = await fetch(`${base}/${file}`, { headers })
  await r.body?.cancel() // seul le statut nous intéresse
  return r.ok
}

const found = []
for (const f of CANDIDATES) if (await exists(f)) found.push(f)
console.log('Fichiers trouvés dans le Package Registry :', found.join(', ') || '(aucun)')

const link = f => ({ name: f, url: `${base}/${f}`, link_type: 'package' })
const description = `## Cyberdog ${version}

Gestionnaire SSH/SFTP moderne : explorateur de fichiers, terminal intégré, tableau de bord de santé des serveurs et actions rapides.

### Téléchargements

| Plateforme | Fichier |
|---|---|
| Windows (installeur) | \`Cyberdog-Setup-${version}-x64.exe\` |
| Windows (portable) | \`Cyberdog-${version}-portable-x64.exe\` |
| macOS Apple Silicon | \`Cyberdog-${version}-mac-arm64.dmg\` |
| macOS Intel | \`Cyberdog-${version}-mac-x64.dmg\` |

Les fichiers disponibles sont listés dans *Assets*. Vérifiez-les avec les fichiers \`SHA256SUMS-*.txt\`.

### Premier lancement (app non signée)
- **macOS** : clic droit → *Ouvrir*, ou \`xattr -dr com.apple.quarantine /Applications/Cyberdog.app\`
- **Windows** : SmartScreen → *Informations complémentaires* → *Exécuter quand même*
`

const json = { 'Content-Type': 'application/json', ...headers }
const res = await fetch(`${api}/projects/${pid}/releases`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ tag_name: tag, name: `Cyberdog ${version}`, description, assets: { links: found.map(link) } }),
})

if (res.ok) {
  console.log(`Release ${tag} créée avec ${found.length} fichier(s).`)
} else if (res.status === 409) {
  // la release existe déjà : on ajoute seulement les liens manquants
  const linksUrl = `${api}/projects/${pid}/releases/${encodeURIComponent(tag)}/assets/links`
  const have = new Set((await (await fetch(linksUrl, { headers })).json()).map(l => l.name))
  for (const f of found.filter(f => !have.has(f))) {
    const r = await fetch(linksUrl, { method: 'POST', headers: json, body: JSON.stringify(link(f)) })
    console.log(r.ok ? `Lien ajouté : ${f}` : `Ajout du lien ${f} impossible (HTTP ${r.status})`)
  }
} else {
  console.error(`Création de la release impossible : HTTP ${res.status} ${await res.text()}`)
  process.exit(1)
}
