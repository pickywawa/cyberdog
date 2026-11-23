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

// presse-papiers de fichiers, propriétés, volets
assert.strictEqual(act(k('c', { metaKey: true }), { mac: true }), 'copy')
assert.strictEqual(act(k('C', { metaKey: true, shiftKey: true }), { mac: true }), 'copyPath')
assert.strictEqual(act(k('x', { ctrlKey: true }), { mac: false }), 'cut')
assert.strictEqual(act(k('v', { ctrlKey: true }, 'KeyV'), { mac: false }), 'paste')
assert.strictEqual(act(k('d', { metaKey: true }), { mac: true }), 'duplicate')
assert.strictEqual(act(k('i', { metaKey: true }), { mac: true }), 'info')
assert.strictEqual(act(k('c', { metaKey: true }), { mac: true, editing: true }), null) // copier du texte dans un champ
assert.strictEqual(act(k('c', { ctrlKey: true }), { mac: false, terminal: true }), null) // Ctrl+C reste au shell
assert.strictEqual(act(k('v', { metaKey: true }), { mac: true, elsewhere: true }), null) // collage ailleurs que dans la liste
assert.strictEqual(act(k('Tab')), 'switchPane')
assert.strictEqual(act(k('Tab'), { elsewhere: true }), null) // Tab garde son rôle hors de la liste
assert.strictEqual(act(k('Tab', { ctrlKey: true })), 'nextTab')

// libellés
assert.strictEqual(label('Mod+Shift+N', true), '⇧⌘N')
assert.strictEqual(label('Mod+Shift+N', false), 'Ctrl+Shift+N')
assert.strictEqual(label('Mod+R', false), 'Ctrl+R')

// AZERTY : ⌘Z (touche Z à la place du W QWERTY, code KeyW) reste un « annuler », pas une fermeture d'onglet
assert.strictEqual(act(k('z', { metaKey: true }, 'KeyW'), { mac: true, editing: true }), null)
assert.strictEqual(act(k('z', { metaKey: true }, 'KeyW'), { mac: true }), null)
assert.strictEqual(act(k('Z', { metaKey: true, shiftKey: true }, 'KeyW'), { mac: true, editing: true }), null)
assert.strictEqual(act(k('w', { metaKey: true }, 'KeyZ'), { mac: true }), 'closeTab')
assert.strictEqual(act(k('q', { metaKey: true }, 'KeyA'), { mac: true }), null) // ⌘Q AZERTY n'est pas « tout sélectionner »
// Disposition non latine : la position physique sert toujours
assert.strictEqual(act(k('ц', { metaKey: true }, 'KeyW'), { mac: true }), 'closeTab')
console.log('ok')
