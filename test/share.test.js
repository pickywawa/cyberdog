const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const { exportZip, readZip } = require('../src/share')

;(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'))
  const zip = path.join(tmp, 'out.zip')
  const servers = [
    { id: 'a', name: 'Zeta é', host: '1.1.1.1', port: 22, user: 'root', pass: 'SECRET', fp: 'abc', order: 0 },
    { id: 'b', name: 'Alpha', host: '2.2.2.2', port: 2222, user: 'me', key: '/k' },
  ]
  await exportZip(servers, zip)
  await exportZip(servers, zip) // ré-export sur le même fichier ne doit pas dupliquer
  const back = await readZip(zip)
  assert.deepStrictEqual(back, [
    { name: 'Zeta é', host: '1.1.1.1', port: 22, user: 'root' },
    { name: 'Alpha', host: '2.2.2.2', port: 2222, user: 'me', key: '/k' },
  ])
  assert(!new AdmZip(zip).getEntries().some(e => e.getData().toString().includes('SECRET')))
  assert.strictEqual(new AdmZip(zip).getEntries().length, 2) // ré-export : pas de doublon

  // actions rapides : seuls name + script sortent
  await exportZip([{ id: 'x', name: 'Clean logs', script: 'rm -f /tmp/*.log\necho ok', order: 3 }], zip, ['name', 'script'])
  assert.deepStrictEqual(await readZip(zip), [{ name: 'Clean logs', script: 'rm -f /tmp/*.log\necho ok' }])

  // zip fait au Finder : dossier + __MACOSX + fichiers ._
  const f = new AdmZip()
  f.addFile('folder/x.json', Buffer.from('{"host":"h","user":"u"}'))
  f.addFile('folder/._x.json', Buffer.from('garbage'))
  f.addFile('__MACOSX/folder/._y.json', Buffer.from('{"host":"no"}'))
  f.writeZip(path.join(tmp, 'f.zip'))
  assert.deepStrictEqual(await readZip(path.join(tmp, 'f.zip')), [{ host: 'h', user: 'u' }])

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('ok')
})()
