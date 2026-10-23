const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { HEALTH_SCRIPT, parseHealth, parseServices, UNIT_RE } = require('../src/health')

// faux /proc : le CPU passe de (busy=100, idle=900) à (busy=150, idle=950) pendant le sleep => 50 %
const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'))
const w = (f, s) => fs.writeFileSync(path.join(proc, f), s)
w('stat', 'cpu  50 0 50 900 0 0 0 0 0 0\n')
w('uptime', '93784.55 1234.00\n')
w('loadavg', '0.52 0.40 0.30 1/200 999\n')
w('cpuinfo', 'processor : 0\nprocessor : 1\n')
w('meminfo', 'MemTotal: 2000000 kB\nMemFree: 100 kB\nMemAvailable: 500000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n')
setTimeout(() => w('stat', 'cpu  75 0 75 950 0 0 0 0 0 0\n'), 200)

const run = () => new Promise(res => {
  const p = spawn('sh', ['-s'], { env: { ...process.env, PROC: proc } })
  let o = ''
  p.stdout.on('data', d => (o += d))
  p.on('close', () => res(o))
  p.stdin.end(HEALTH_SCRIPT)
})

;(async () => {
const out = await run()
const h = parseHealth(out)
assert.strictEqual(h.cpu, 50)
assert.strictEqual(h.uptime, 93784)
assert.deepStrictEqual(h.load, [0.52, 0.4, 0.3])
assert.strictEqual(h.cores, 2)
assert.deepStrictEqual(h.mem, { total: 2000000 * 1024, used: 1500000 * 1024, swapTotal: 1000 * 1024, swapUsed: 600 * 1024 })
assert(h.disks.length > 0 && h.disks.every(d => d.size > 0 && d.pct >= 0 && d.mount.startsWith('/')), 'df')

// df : tmpfs ignoré, volume disque gardé, point de montage avec espace
const d = parseHealth('DISK=tmpfs|100|1|99|1%|/run\nDISK=/dev/sda1|1000|900|100|90%|/mnt/my data\n')
assert.deepStrictEqual(d.disks, [{ fs: '/dev/sda1', size: 1024000, used: 921600, avail: 102400, pct: 90, mount: '/mnt/my data' }])

const s = parseServices('ssh.service loaded active running OpenBSD Secure Shell server\nfoo.service not-found inactive dead foo.service\nnginx.service loaded failed failed A high performance web server\n')
assert.deepStrictEqual(s.map(x => [x.unit, x.active, x.sub, x.desc]), [['ssh.service', 'active', 'running', 'OpenBSD Secure Shell server'], ['nginx.service', 'failed', 'failed', 'A high performance web server']])

assert(UNIT_RE.test('systemd-resolved.service') && UNIT_RE.test('getty@tty1.service'))
assert(!UNIT_RE.test('x.service; rm -rf /') && !UNIT_RE.test("a'b.service") && !UNIT_RE.test('$(id).service'))

fs.rmSync(proc, { recursive: true, force: true })
console.log('ok')
})()
