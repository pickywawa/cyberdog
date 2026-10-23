// Vérifie ci/publish-release.mjs contre un faux GitLab local : fichiers trouvés -> liens, 409 -> ajout des liens manquants.
const assert = require('assert')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { version } = require('../package.json')

const exe = `Cyberdog-Setup-${version}-x64.exe`
const dmg = `Cyberdog-${version}-mac-arm64.dmg`

function startServer({ present, releaseExists, existingLinks = [] }) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, token: req.headers['job-token'], body: body && JSON.parse(body) })
      const file = req.url.split('/').pop()
      if (req.url.includes('/packages/generic/')) return res.writeHead(present.includes(file) ? 200 : 404).end('x')
      if (req.method === 'POST' && req.url.endsWith('/releases')) return releaseExists ? res.writeHead(409).end('{}') : res.writeHead(201).end('{}')
      if (req.url.endsWith('/assets/links')) return req.method === 'GET' ? res.writeHead(200).end(JSON.stringify(existingLinks)) : res.writeHead(201).end('{}')
      res.writeHead(500).end()
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, calls, port: server.address().port })))
}

const run = port => new Promise(resolve => {
  const p = spawn('node', [path.join(__dirname, '../ci/publish-release.mjs')], {
    env: { PATH: process.env.PATH, CI_API_V4_URL: `http://127.0.0.1:${port}/api/v4`, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok', CI_COMMIT_TAG: `v${version}` },
  })
  let out = ''
  p.stdout.on('data', d => (out += d))
  p.stderr.on('data', d => (out += d))
  p.on('close', code => resolve({ code, out }))
})

;(async () => {
  // 1) release neuve : seuls les fichiers présents deviennent des liens
  let s = await startServer({ present: [exe, 'SHA256SUMS-windows.txt'] })
  let r = await run(s.port)
  assert.strictEqual(r.code, 0, r.out)
  const create = s.calls.find(c => c.method === 'POST' && c.url.endsWith('/releases'))
  assert.strictEqual(create.token, 'tok')
  assert.strictEqual(create.body.tag_name, `v${version}`)
  assert.deepStrictEqual(create.body.assets.links.map(l => l.name), [exe, 'SHA256SUMS-windows.txt'])
  s.server.close()

  // 2) release déjà là (ex. 2e passage après ajout du .dmg) : on n'ajoute que le lien manquant
  s = await startServer({ present: [exe, dmg], releaseExists: true, existingLinks: [{ name: exe }] })
  r = await run(s.port)
  assert.strictEqual(r.code, 0, r.out)
  const added = s.calls.filter(c => c.method === 'POST' && c.url.endsWith('/assets/links'))
  assert.deepStrictEqual(added.map(c => c.body.name), [dmg])
  s.server.close()

  // 3) tag différent de package.json : refus
  s = await startServer({ present: [] })
  r = await new Promise(resolve => {
    const p = spawn('node', [path.join(__dirname, '../ci/publish-release.mjs')], { env: { PATH: process.env.PATH, CI_API_V4_URL: 'http://x', CI_PROJECT_ID: '1', CI_JOB_TOKEN: 't', CI_COMMIT_TAG: 'v0.0.0' } })
    p.on('close', code => resolve({ code }))
  })
  assert.notStrictEqual(r.code, 0)
  s.server.close()
  console.log('ok')
})()
