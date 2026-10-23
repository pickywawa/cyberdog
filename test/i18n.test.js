const assert = require('assert')
const { D, t } = require('../src/i18n')

const ref = Object.keys(D.en).sort()
for (const lang of ['fr', 'de', 'it']) assert.deepStrictEqual(Object.keys(D[lang]).sort(), ref, `${lang}: clés différentes de en`)

// chaque variable {x} d'une clé en doit exister dans les autres langues
const vars = s => (s.match(/\{\w+\}/g) || []).sort().join()
for (const k of ref) for (const lang of ['fr', 'de', 'it']) assert.strictEqual(vars(D[lang][k]), vars(D.en[k]), `${lang}:${k}`)

assert.strictEqual(t('fr', 'ex.items', { n: 1 }), '1 élément')
assert.strictEqual(t('fr', 'ex.items', { n: 3 }), '3 éléments')
assert.strictEqual(t('xx', 'btn.cancel'), 'Cancel') // langue inconnue → en
console.log('ok')
