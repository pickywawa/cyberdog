const assert = require('assert')
const { normalizeSession } = require('../src/session-state')
const servers = [{ id:'a' }, { id:'b' }]
assert.deepEqual(normalizeSession(null, servers), [])
assert.deepEqual(normalizeSession([{serverId:'a',terminal:true,password:'secret',command:'rm anything'}, {serverId:'deleted'}, null, {serverId:'b',terminal:'yes'}], servers), [{serverId:'a',terminal:true}, {serverId:'b',terminal:false}])
assert.equal(normalizeSession(Array.from({length:100}, () => ({serverId:'a'})), servers).length, 50)
console.log('session references and credential exclusion ok')
