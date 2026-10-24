const assert = require('assert')
const { restoreWindow } = require('../src/window-state')
const displays = [{ workArea: { x: 0, y: 25, width: 1920, height: 1055 } }, { workArea: { x: -1440, y: 0, width: 1440, height: 900 } }]
assert.deepStrictEqual(restoreWindow(null, displays), { width: 1280, height: 800 })
const bounds = { x: 100, y: 100, width: 1300, height: 850 }
assert.deepStrictEqual(restoreWindow({ bounds }, displays), bounds)
assert.deepStrictEqual(restoreWindow({ bounds: { x: -1300, y: 40, width: 1200, height: 800 } }, displays), { x: -1300, y: 40, width: 1200, height: 800 })
assert.deepStrictEqual(restoreWindow({ bounds: { x: 9000, y: 9000, width: 1600, height: 1000 } }, displays), { x: 320, y: 80, width: 1600, height: 1000 }, 'unplugged monitor returns to a visible work area')
assert.deepStrictEqual(restoreWindow({ bounds: { x: 1800, y: 900, width: 2500, height: 1400 } }, displays), { x: 0, y: 25, width: 1920, height: 1055 })
assert.equal(restoreWindow({ bounds: { x: 0, y: 0, width: 50, height: 50 } }, displays).width, 1040)
for (const b of [{ ...bounds, x: NaN }, { ...bounds, width: -1 }, { ...bounds, height: Infinity }, {}]) assert.deepStrictEqual(restoreWindow({ bounds: b }, displays), { width: 1280, height: 800 })
assert.deepStrictEqual(restoreWindow({ bounds }, [{ workArea: { x: 0, y: 0, width: 800, height: 500 } }]), { x: 0, y: 0, width: 800, height: 500 })
console.log('window state ok')
