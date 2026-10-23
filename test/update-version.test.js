const assert = require('node:assert/strict')
const { isNewerVersion } = require('../src/update-version')

assert.equal(isNewerVersion('v1.3.0', '1.2.9'), true)
assert.equal(isNewerVersion('1.2.1', '1.2.0'), true)
assert.equal(isNewerVersion('1.2.0', '1.2.0'), false)
assert.equal(isNewerVersion('1.1.9', '1.2.0'), false)
assert.equal(isNewerVersion('latest', '1.2.0'), false)
console.log('ok')
