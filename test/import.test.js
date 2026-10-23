const assert = require('assert')
const { parseDuck } = require('../src/duck')

const duck = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Protocol</key><string>sftp</string><key>Nickname</key><string>Prod &amp; Co</string>
<key>Hostname</key><string>10.0.0.5</string><key>Port</key><string>2222</string>
<key>Username</key><string>root</string></dict></plist>`

assert.deepStrictEqual(parseDuck(duck), { name: 'Prod & Co', host: '10.0.0.5', port: 2222, user: 'root', key: undefined })
assert.strictEqual(parseDuck(duck.replace('sftp', 'ftp')), null)
console.log('ok')
