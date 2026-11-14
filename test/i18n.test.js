const assert = require('assert')
const { D, PACKS, PACK_CODES, LANGS, t } = require('../src/i18n')

const ref = Object.keys(D.en).sort()
for (const lang of ['fr', 'de', 'it']) assert.deepStrictEqual(Object.keys(D[lang]).sort(), ref, `${lang}: clés différentes de en`)

// chaque variable {x} d'une clé en doit exister dans les autres langues
const vars = s => (s.match(/\{\w+\}/g) || []).sort().join()
for (const k of ref) for (const lang of ['fr', 'de', 'it']) assert.strictEqual(vars(D[lang][k]), vars(D.en[k]), `${lang}:${k}`)

// Packs de langue : toutes les clés en (cœur + workspace), variables identiques, variantes de pluriel autorisées.
require('../src/workspace/i18n').apply(D)
const all = Object.keys(D.en)
const PLURAL = /_(zero|two|few|many)$/
// Les formes _one / _two / _zero peuvent écrire le nombre en toutes lettres (ex. arabe « عنصر واحد »).
const sameVars = (k, s, ref) => vars(s) === vars(ref) || (/_(one|two|zero)$/.test(k) && vars(s.replace(/\{n\}/g, '')) === vars(ref.replace(/\{n\}/g, '')))
for (const code of PACK_CODES) {
  assert.ok(LANGS[code], `${code}: absent de LANGS`)
  const pack = PACKS[code]
  for (const k of all) {
    assert.ok(typeof pack[k] === 'string' && pack[k].trim(), `${code}: clé manquante ${k}`)
    assert.ok(sameVars(k, pack[k], D.en[k]), `${code}:${k}`)
  }
  for (const k of Object.keys(pack)) {
    if (k in D.en) continue
    const base = k.replace(PLURAL, '')
    assert.ok(base !== k && base in D.en, `${code}: clé inconnue ${k}`)
    assert.ok(sameVars(k, pack[k], D.en[base]), `${code}:${k}`)
  }
}

assert.strictEqual(t('fr', 'ex.items', { n: 1 }), '1 élément')
assert.strictEqual(t('fr', 'ex.items', { n: 3 }), '3 éléments')
assert.strictEqual(t('xx', 'btn.cancel'), 'Cancel') // langue inconnue → en
assert.strictEqual(t('es', 'ex.items', { n: 1 }), '1 elemento')
assert.strictEqual(t('es', 'ex.items', { n: 4 }), '4 elementos')
assert.strictEqual(t('es', 'account.sign_out'), 'Cerrar sesión') // le pack l'emporte sur le repli workspace
console.log('ok')
