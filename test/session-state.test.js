const assert = require('assert')
const { normalizeSession } = require('../src/session-state')
const servers = [{ id:'a' }, { id:'b' }]
assert.deepEqual(normalizeSession(null, servers), [])
assert.deepEqual(normalizeSession([{serverId:'a',terminal:true,password:'secret',command:'rm anything',paths:['/var/www','/etc','/tmp']}, {serverId:'deleted'}, null, {serverId:'b',terminal:'yes',paths:['relative', 42, '/ok\0bad', '/srv']}], servers),
  [{serverId:'a',terminal:true,paths:['/var/www','/etc']}, {serverId:'b',terminal:false,paths:['/srv']}])
assert.deepEqual(normalizeSession([{serverId:'a'}], servers), [{serverId:'a',terminal:false,paths:[]}]) // sessions saved before the folders were kept
assert.equal(normalizeSession(Array.from({length:100}, () => ({serverId:'a'})), servers).length, 50)
console.log('session references and credential exclusion ok')
