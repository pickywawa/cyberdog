const assert = require('node:assert/strict')
const { isNewerVersion, selectUpdateAsset, openUpdatePackage } = require('../src/update-version')

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
// Installation handoff: cancellation never opens/quits; failed DMG opening never quits.
;(async () => {
  const calls = []
  let response = 0, openError = '', finishOpen
  const options = {
    platform: 'darwin', file: '/Downloads/Cyberdog.dmg', version: '1.4.1', window: {},
    t: (key, vars) => key + (vars?.version || ''),
    dialog: { showMessageBox: async (_, spec) => { calls.push('confirm'); assert.equal(spec.cancelId, 1); assert(spec.message.includes('1.4.1')); return { response } } },
    shell: { openPath: async file => { assert.equal(file, options.file); calls.push('open'); return openError } },
    app: { quit: () => calls.push('quit') },
  }
  response = 1
  await openUpdatePackage(options)
  assert.deepEqual(calls.splice(0), ['confirm'])
  response = 0
  await openUpdatePackage(options)
  assert.deepEqual(calls.splice(0), ['confirm', 'open', 'quit'])
  openError = 'Unable to mount disk image'
  await assert.rejects(openUpdatePackage(options), /Unable to mount/)
  assert.deepEqual(calls.splice(0), ['confirm', 'open'])
  openError = ''
  options.shell.openPath = () => new Promise(resolve => { calls.push('open'); finishOpen = resolve })
  const pending = openUpdatePackage(options)
  await Promise.resolve()
  assert.deepEqual(calls.splice(0), ['confirm', 'open'])
  finishOpen('')
  await pending
  assert.deepEqual(calls.splice(0), ['quit'], 'quits only after the OS accepts the DMG')
  options.shell.openPath = async () => { throw new Error('OS error') }
  await assert.rejects(openUpdatePackage(options), /OS error/)
  assert.deepEqual(calls.splice(0), ['confirm'])
  options.platform = 'win32'
  options.file = '/Downloads/Cyberdog-portable.exe'
  options.shell.openPath = async () => { calls.push('open'); return '' }
  await openUpdatePackage(options)
  assert.deepEqual(calls, ['open'], 'portable Windows behavior is unchanged')
  console.log('ok')
})().catch(error => { console.error(error); process.exitCode = 1 })
