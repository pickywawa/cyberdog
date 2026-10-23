const assert = require('assert')
const { levelOf, normalize } = require('../src/logs')
const { summarize } = require('../src/docker')

// journalctl -o json
const j = normalize('journal', JSON.stringify({ __REALTIME_TIMESTAMP: '1700000000123456', SYSLOG_IDENTIFIER: 'sshd', PRIORITY: '3', MESSAGE: 'Failed password for root' }))
assert.deepStrictEqual(j, { ts: 1700000000123, src: 'sshd', lv: 'error', m: 'Failed password for root' })
assert.strictEqual(normalize('journal', JSON.stringify({ PRIORITY: '4', MESSAGE: 'x' })).lv, 'warn')
assert.strictEqual(normalize('journal', JSON.stringify({ PRIORITY: '6', MESSAGE: [104, 105] })).m, 'hi') // MESSAGE binaire
assert.deepStrictEqual(normalize('journal', '-- No entries --'), { m: '-- No entries --' })
assert.deepStrictEqual(normalize('file', 'tail: cannot open', true), { m: 'tail: cannot open', err: true })

// niveaux déduits du texte (nginx, applis)
assert.strictEqual(levelOf('2025/10/23 [error] 12#12: *1 connect() failed'), 'error')
assert.strictEqual(levelOf('1.2.3.4 - - [23/Oct] "GET /x HTTP/1.1" 502 150'), 'error')
assert.strictEqual(levelOf('1.2.3.4 - - [23/Oct] "GET /x HTTP/1.1" 404 150'), 'warn')
assert.strictEqual(levelOf('1.2.3.4 - - [23/Oct] "GET / HTTP/1.1" 200 150'), 'info')
assert.strictEqual(levelOf('WARNING: deprecated option'), 'warn')

// docker inspect
const img = summarize('image', [{ Id: 'sha256:abcdef0123456789', RepoTags: ['nginx:1.25'], Created: '2025-01-01', Size: 187000000, Os: 'linux', Architecture: 'amd64', RootFS: { Layers: ['a', 'b'] }, Config: { Cmd: ['nginx'], ExposedPorts: { '80/tcp': {} }, Env: ['A=1'] } }])
assert.deepStrictEqual(img.find(r => r[0] === 'Id'), ['Id', 'abcdef012345'])
assert.deepStrictEqual(img.find(r => r[0] === 'Platform'), ['Platform', 'linux/amd64'])
assert.deepStrictEqual(img.find(r => r[0] === 'Exposed ports'), ['Exposed ports', ['80/tcp']])
assert(!img.some(r => r[0] === 'User')) // champs vides omis
const ctr = summarize('container', [{ Name: '/web', Config: { Image: 'nginx' }, State: { Status: 'running', StartedAt: '2025-01-02' }, HostConfig: { RestartPolicy: { Name: 'always' } }, NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { bridge: { IPAddress: '172.17.0.2' } } }, Mounts: [{ Source: '/data', Destination: '/usr/share/nginx/html', RW: false }] }])
assert.deepStrictEqual(ctr.find(r => r[0] === 'Name'), ['Name', 'web'])
assert.deepStrictEqual(ctr.find(r => r[0] === 'Ports'), ['Ports', ['80/tcp → 0.0.0.0:8080']])
assert.deepStrictEqual(ctr.find(r => r[0] === 'Mounts'), ['Mounts', ['/data → /usr/share/nginx/html (ro)']])
console.log('ok')
