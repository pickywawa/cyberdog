const assert = require('assert')
const { spawnSync } = require('child_process')
const model = require('../src/processes')
const { SNAPSHOT, parse, observe, identity, group, signal, details } = model
const cid = 'a'.repeat(64)
const raw = `@@META
100
1000.00 0
cpu 100 0 100 800 0 0 0 0 0 0
MemTotal: 2000000 kB
MemAvailable: 500000 kB
@@PS
 10 1 alice S 2048 100 node node /srv/app.js --flag hello world
 11 10 alice Z 0 90 node [node] <defunct>
 12 10 bob S 1024 80 worker worker --test
 99 1 bob S 0 0 exited gone
@@TICKS
10 1000 42
11 100 43
12 200 44
@@GROUPS
/proc/10/cgroup 0::/system.slice/api.service
/proc/11/cgroup 0::/system.slice/api.service
/proc/12/cgroup 0::/system.slice/docker-${cid}.scope
`
const first = parse(raw)
assert.equal(first.list.length, 3, 'exited PIDs are discarded')
assert.equal(first.list[0].command, 'node /srv/app.js --flag hello world')
assert.equal(first.list[0].service, 'api.service')
assert.equal(first.list[2].container, cid)
assert.equal(first.memUsed, 1500000 * 1024)
assert.throws(() => parse('permission denied'))
assert.throws(() => parse(raw.replace('100\n1000', '0\n1000')))
const histories = new Map()
observe(first, null, histories)
assert.equal(first.list[0].cpu, null, 'no fabricated first CPU sample')
assert.equal(first.list[1].alerts[0].key, 'zombie')
let prev = first
for (let i = 1; i <= 7; i++) {
  const s = parse(raw)
  s.uptime += i * 5; s.total += i * 500; s.idle += i * 400
  s.list[0].ticks += i * 50
  observe(s, prev, histories)
  assert.equal(s.list[0].cpu, 10, 'CPU uses tick deltas and clock frequency')
  assert(Math.abs(s.cpu - 20) < 1e-8)
  prev = s
}
const spike = parse(raw)
spike.uptime += 40; spike.total += 4000; spike.idle += 3000
spike.list[0].ticks = prev.list[0].ticks + 200
spike.list[0].rss += 40 * 1024 * 1024
observe(spike, prev, histories)
assert(spike.list[0].alerts.some(a => a.key === 'spike' && a.ratio === '4.0'))
assert(spike.list[0].alerts.some(a => a.key === 'growth'))
const recycled = parse(raw)
recycled.uptime += 45; recycled.list[0].start = '999'
observe(recycled, spike, histories)
assert.equal(recycled.list[0].cpu, null, 'PID reuse has no inherited CPU history')
assert.equal(histories.has(identity(spike.list[0])), false)
assert.equal(histories.get(identity(recycled.list[0])).length, 1)
assert.equal(group(first.list, 'tree').length, 1)
assert.equal(group(first.list, 'user').length, 2)
assert.equal(group(first.list, 'service').find(g => g.name === 'api.service').list.length, 2)
assert.equal(group(first.list, 'container').length, 2)
assert.equal(group(first.list, 'name').find(g => g.name === 'node').list.length, 2)
const cycle = first.list.map(p => ({ ...p, ppid: p.pid === 10 ? 11 : 10 }))
assert(group(cycle, 'tree').length, 'cyclic ancestry must terminate')
for (const pid of [-1, 0, '10', 2.5, 1e30]) assert.throws(() => signal({ pid, start: '42' }, 'TERM'))
assert.throws(() => signal({ pid: 1, start: '42' }, 'KILL'))
assert.throws(() => signal({ pid: 10, start: '42; touch /tmp/no' }, 'TERM'))
assert.throws(() => signal({ pid: 10, start: '42' }, 'TERM; reboot'))
assert(signal(first.list[0], 'TERM').includes('kill -TERM 10'))
assert(details({ pid: 1, start: '1' }).includes('/proc/1/stat'), 'PID 1 details remain available')
for (const script of [SNAPSHOT, details(first.list[0]), signal(first.list[0], 'KILL')]) {
  const r = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
// Verify Linux stat fields, including names containing spaces and closing parentheses.
const stat = '10 (node (worker)) S 1 2 3 4 5 6 7 8 9 10 100 200 13 14 15 16 17 18 999 20'
const awk = "{p=$1; sub(/^.*\\) /, \"\"); split($0,a,\" \"); print p,a[12]+a[13],a[20]}"
const r = spawnSync('awk', [awk], { input: stat, encoding: 'utf8' })
assert.equal(r.stdout.trim(), '10 300 999')
console.log('processes ok')
