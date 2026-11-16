const assert = require('assert')
const { match, label } = require('../src/shortcuts')

const k = (key, mods = {}, code) => ({ key, code: code || '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
const act = (e, ctx) => match(e, ctx)?.action ?? null

// issue #1 : ⌘R / Ctrl+R / F5 rafraîchissent la liste
assert.strictEqual(act(k('r', { metaKey: true }), { mac: true }), 'refresh')
assert.strictEqual(act(k('r', { ctrlKey: true }), { mac: false }), 'refresh')
assert.strictEqual(act(k('F5'), { mac: false }), 'refresh')
assert.strictEqual(act(k('r', { ctrlKey: true }), { mac: true }), null) // ⌃R sur Mac n'est pas ⌘R
assert.strictEqual(act(k('R', { metaKey: true, shiftKey: true }), { mac: true }), null)

// pas d'action fichier pendant la saisie ni dans le terminal
assert.strictEqual(act(k('r', { metaKey: true }), { mac: true, editing: true }), null)
assert.strictEqual(act(k('a', { ctrlKey: true }), { mac: false, terminal: true }), null)
assert.strictEqual(act(k('w', { ctrlKey: true }), { mac: false, terminal: true }), null) // Ctrl+W reste au shell
assert.strictEqual(act(k('Tab', { ctrlKey: true }), { mac: false, terminal: true }), 'nextTab')
assert.strictEqual(act(k('w', { metaKey: true }), { mac: true, terminal: true }), 'closeTab')
// focus hors de la liste : navigation désactivée, raccourcis à modificateur conservés
assert.strictEqual(act(k('ArrowDown'), { elsewhere: true }), null)
assert.strictEqual(act(k('r', { ctrlKey: true }), { elsewhere: true }), 'refresh')

// onglets, y compris claviers AZERTY (e.key « & » pour la touche 1)
assert.deepStrictEqual(match(k('3', { metaKey: true }, 'Digit3'), { mac: true }), { action: 'tab', n: 3 })
assert.deepStrictEqual(match(k('&', { metaKey: true }, 'Digit1'), { mac: true }), { action: 'tab', n: 1 })
assert.strictEqual(act(k('Tab', { ctrlKey: true, shiftKey: true })), 'prevTab')
assert.strictEqual(act(k('`', { ctrlKey: true }, 'Backquote'), { mac: true }), 'terminal')

// navigation et sélection
assert.deepStrictEqual(match(k('ArrowDown', { shiftKey: true })), { action: 'down', extend: true })
assert.strictEqual(act(k('ArrowUp', { metaKey: true }), { mac: true }), 'parent')
assert.strictEqual(act(k('[', { metaKey: true }, 'BracketLeft'), { mac: true }), 'back')
assert.strictEqual(act(k('Backspace', { metaKey: true }), { mac: true }), 'delete')
assert.strictEqual(act(k('Backspace')), null) // jamais de suppression sans modificateur
assert.strictEqual(act(k('N', { ctrlKey: true, shiftKey: true }, 'KeyN')), 'newFolder')
assert.strictEqual(act(k('/', { metaKey: true }, 'Slash'), { mac: true }), 'help')

// libellés
assert.strictEqual(label('Mod+Shift+N', true), '⇧⌘N')
assert.strictEqual(label('Mod+Shift+N', false), 'Ctrl+Shift+N')
assert.strictEqual(label('Mod+R', false), 'Ctrl+R')
console.log('ok')
