const assert = require('assert')
const archive = require('../src/archive')

const q = s => `'${s.replace(/'/g, `'\\''`)}'`

assert.strictEqual(archive.kind('site.tar.gz').id, 'tar')
assert.strictEqual(archive.kind('SITE.TGZ').id, 'tar')
assert.strictEqual(archive.kind('a.zip').id, 'zip')
assert.strictEqual(archive.kind('dump.sql.gz').id, 'gz')
assert.strictEqual(archive.kind('notes.txt'), null)
assert.strictEqual(archive.kind('.gz'), null) // pas de nom : ce n'est pas une archive
assert.strictEqual(archive.folderName('site.tar.gz'), 'site')
assert.strictEqual(archive.folderName('my.app.v2.zip'), 'my.app.v2')

const cmd = archive.command('site.tar.gz', "/srv/it's here/site.tar.gz", "/srv/it's here/site", q)
assert(cmd.includes(`tar -xf '/srv/it'\\''s here/site.tar.gz' -C '/srv/it'\\''s here/site'`), cmd)
assert(cmd.includes('MISSING:tar'))
assert(archive.command('x.gz', '/d/x.gz', '/d', q).includes(`gzip -dc '/d/x.gz' > '/d/x'`))

// exécution réelle (tar + zip locaux) : le dossier cible est créé et rempli
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'))
fs.mkdirSync(path.join(tmp, 'src'))
fs.writeFileSync(path.join(tmp, 'src', 'a.txt'), 'hello')
execSync(`tar -czf ${q(tmp + '/src.tar.gz')} -C ${q(tmp + '/src')} .`)
execSync(archive.command('src.tar.gz', `${tmp}/src.tar.gz`, `${tmp}/out`, q), { shell: '/bin/sh' })
assert.strictEqual(fs.readFileSync(path.join(tmp, 'out', 'a.txt'), 'utf8'), 'hello')

// création : tar.gz et zip d'une sélection (noms avec espace, apostrophe et tiret initial), puis aller-retour
assert.deepStrictEqual(archive.formats, ['tar.gz', 'zip'])
assert.strictEqual(archive.archiveName(['site'], 'zip'), 'site.zip')
assert.strictEqual(archive.archiveName(['a', 'b'], 'tar.gz'), 'archive.tar.gz')
assert.strictEqual(archive.createCommand('rar', '/d', ['a'], 'a.rar', q), null)
fs.mkdirSync(path.join(tmp, "my dir"))
fs.writeFileSync(path.join(tmp, "my dir", "it's.txt"), 'x')
fs.writeFileSync(path.join(tmp, '-n.txt'), 'dash')
for (const format of archive.formats) {
  const out = `pack.${format}`
  execSync(archive.createCommand(format, tmp, ['my dir', '-n.txt'], out, q), { shell: '/bin/sh' })
  assert(fs.existsSync(path.join(tmp, out)), out)
  // ne jamais écraser une archive existante
  let code = 0
  try { execSync(archive.createCommand(format, tmp, ['my dir'], out, q), { shell: '/bin/sh', stdio: 'pipe' }) } catch (e) { code = e.status; assert(String(e.stdout).includes('EXISTS')) }
  assert.strictEqual(code, 17)
  const dest = path.join(tmp, 'x-' + format)
  execSync(archive.command(out, `${tmp}/${out}`, dest, q), { shell: '/bin/sh' })
  assert.strictEqual(fs.readFileSync(path.join(dest, 'my dir', "it's.txt"), 'utf8'), 'x')
  assert.strictEqual(fs.readFileSync(path.join(dest, '-n.txt'), 'utf8'), 'dash')
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log('ok')
