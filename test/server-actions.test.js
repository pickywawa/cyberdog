// Actions made for one server: exported with that server, linked back to it on import (or left out without it).
const assert = require('assert')
const { withServerItems, portable, select, merge } = require('../src/config-transfer')

const data = {
  groups: [], paths: [],
  servers: [{ id: 's1', name: 'Web', host: 'web.example.test', port: 22, user: 'deploy' }, { id: 's2', name: 'DB', host: 'db.example.test', port: 22, user: 'root' }],
  actions: [{ id: 'g', name: 'Uptime', script: 'uptime' }, { id: 'w', name: 'Backup web', script: 'tar czf /tmp/site.tgz /var/www', serverId: 's1' }, { id: 'd', name: 'Dump', script: 'pg_dumpall', serverId: 's2' }],
}
// checking a server adds its actions, nothing else
const picked = withServerItems(data, { groups: [], servers: ['s1'], actions: ['g'], paths: [] })
assert.deepStrictEqual(picked.actions.sort(), ['g', 'w'])
const out = select(portable(data), picked)
assert.deepStrictEqual(out.actions.map(a => a.id).sort(), ['g', 'w'])
assert.deepStrictEqual(out.actions.find(a => a.id === 'w').server, { host: 'web.example.test', port: 22, user: 'deploy' })

// import elsewhere: the action follows the imported server; an action whose server is not there is skipped
const empty = { groups: [], servers: [], actions: [], paths: [] }
let r = merge(empty, out)
const web = r.data.servers.find(s => s.host === 'web.example.test')
assert.strictEqual(r.data.actions.find(a => a.name === 'Backup web').serverId, web.id)
assert.strictEqual(r.data.actions.find(a => a.name === 'Uptime').serverId, undefined)
r = merge({ ...empty, servers: [{ id: 'mine', host: 'web.example.test', port: 22, user: 'deploy', name: 'Already here' }] }, { ...empty, actions: [out.actions.find(a => a.id === 'w')] })
assert.strictEqual(r.data.actions[0].serverId, 'mine', 'linked to the same server already configured')
r = merge(empty, { ...empty, actions: [{ name: 'Orphan', script: 'x', serverId: 'zz', server: { host: 'nowhere.test', port: 22, user: 'a' } }] })
assert.strictEqual(r.data.actions.length, 0); assert.strictEqual(r.skipped, 1)
console.log('server actions ok')
