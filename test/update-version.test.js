const assert = require('node:assert/strict')
const { isNewerVersion, selectUpdateAsset } = require('../src/update-version')

assert.equal(isNewerVersion('v1.3.0', '1.2.9'), true)
assert.equal(isNewerVersion('1.2.1', '1.2.0'), true)
assert.equal(isNewerVersion('1.2.0', '1.2.0'), false)
assert.equal(isNewerVersion('1.1.9', '1.2.0'), false)
assert.equal(isNewerVersion('latest', '1.2.0'), false)
assert.deepEqual(selectUpdateAsset({
  assets: [{
    name: 'Cyberdog-1.3.0-mac-arm64.dmg',
    browser_download_url: 'https://github.com/pickywawa/cyberdog/releases/download/v1.3.0/Cyberdog-1.3.0-mac-arm64.dmg',
    digest: 'sha256:abc123',
  }],
}, 'darwin', 'arm64', '1.3.0'), {
  name: 'Cyberdog-1.3.0-mac-arm64.dmg',
  url: 'https://github.com/pickywawa/cyberdog/releases/download/v1.3.0/Cyberdog-1.3.0-mac-arm64.dmg',
  digest: 'abc123',
})
assert.equal(selectUpdateAsset({ assets: [] }, 'darwin', 'arm64', '1.3.0'), undefined)
console.log('ok')
