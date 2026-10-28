// Interrupted transfers: resuming skips finished files, continues the partial one where both ends can seek, restarts it
// where they cannot, survives a restart, and copies straight between two servers.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Transfers } = require('../src/transfers')
const { local } = require('../src/local-storage')
const { sftpOver } = require('../src/object-storage')

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-resume-'))
  const mk = name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir }
  try {
    const disk = mk('disk'), serverA = mk('a'), serverB = mk('b'), store = path.join(root, 'transfers.json')
    const big = Buffer.alloc(3 * 1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = i % 251
    fs.mkdirSync(path.join(disk, 'tree')); fs.writeFileSync(path.join(disk, 'tree', 'first.bin'), big.subarray(0, 100000)); fs.writeFileSync(path.join(disk, 'tree', 'second.bin'), big); fs.writeFileSync(path.join(disk, 'tree', 'third.bin'), 'last')

    // sessions, with spies on what is written and from where
    const writes = [], reads = []
    const session = (dir, write = true) => {
      const s = sftpOver(local({ root: dir }))
      const w = s.createWriteStream.bind(s), r = s.createReadStream.bind(s)
      s.createWriteStream = (p, o = {}) => { writes.push([p, o.start || 0]); return w(p, o) }
      s.createReadStream = (p, o = {}) => { reads.push([p, o.start || 0]); return r(p, o) }
      if (!write) s.canResume = { read: true, write: false }
      return s
    }
    const sessions = { a: session(serverA), b: session(serverB), slow: session(serverA, false) }
    let engine
    const make = file => { const m = new Transfers(() => {}, file, (job, resuming) => engine.runJob(job, resuming)); engine = require('../src/transfer-files')(m, ref => ref.disk ? null : sessions[ref.serverId]); return m }
    let m = make(store)
    const job = (src, dst, target = '/tree') => m.run('c', 'upload', 'tree', { refs: { src, dst }, serverIds: ['a'], top: [{ source: path.join(disk, 'tree'), target }] })

    // interrupt in the middle of second.bin (cancel once ~1 MB of it has gone through)
    const timer = setInterval(() => { const x = m.list()[0]; if (x && x.done > 100000 + 1024 * 1024) m.cancel(x.id) }, 1)
    assert.strictEqual(await job({ disk: true }, { serverId: 'a' }), false, 'cancelled')
    clearInterval(timer)
    const x = m.list()[0]
    assert.strictEqual(x.state, 'cancelled'); assert.strictEqual(x.resumable, true)
    const partial = fs.statSync(path.join(serverA, 'tree', 'second.bin')).size
    assert(partial > 0 && partial < big.length, 'second.bin is partial: ' + partial)
    assert(!fs.existsSync(path.join(serverA, 'tree', 'third.bin')), 'third.bin not started')

    // resume: first.bin is not touched again, second.bin continues at its partial size, third.bin is copied
    writes.length = 0
    assert.strictEqual(await m.resume(x.id), true)
    assert(!writes.some(([p]) => p.endsWith('first.bin')), 'finished files are skipped')
    assert.deepStrictEqual(writes.find(([p]) => p.endsWith('second.bin')), ['/tree/second.bin', partial], 'continues where it stopped')
    assert.deepStrictEqual(fs.readFileSync(path.join(serverA, 'tree', 'second.bin')), big)
    assert.strictEqual(fs.readFileSync(path.join(serverA, 'tree', 'third.bin'), 'utf8'), 'last')
    const done = m.list()[0]
    assert.strictEqual(done.state, 'done'); assert.strictEqual(done.done, done.total)
    await assert.rejects(m.resume(x.id), /Nothing to resume/)

    // an end that cannot append restarts the partial file from the beginning
    fs.rmSync(path.join(serverA, 'tree'), { recursive: true })
    const timer2 = setInterval(() => { const y = m.list().at(-1); if (y && y.state === 'running' && y.done > 100000 + 512 * 1024) m.cancel(y.id) }, 1)
    await job({ disk: true }, { serverId: 'slow' })
    clearInterval(timer2)
    const y = m.list().at(-1); assert.strictEqual(y.state, 'cancelled')
    writes.length = 0
    await m.resume(y.id)
    assert.deepStrictEqual(writes.find(([p]) => p.endsWith('second.bin')), ['/tree/second.bin', 0], 'no append: starts over')
    assert.deepStrictEqual(fs.readFileSync(path.join(serverA, 'tree', 'second.bin')), big)

    // a changed source is not stitched onto an old partial copy
    fs.rmSync(path.join(serverA, 'tree'), { recursive: true })
    const timer3 = setInterval(() => { const z = m.list().at(-1); if (z && z.state === 'running' && z.done > 100000 + 512 * 1024) m.cancel(z.id) }, 1)
    await job({ disk: true }, { serverId: 'a' })
    clearInterval(timer3)
    const z = m.list().at(-1); assert.strictEqual(z.state, 'cancelled')
    fs.appendFileSync(path.join(disk, 'tree', 'second.bin'), 'changed')
    writes.length = 0
    await m.resume(z.id)
    assert.deepStrictEqual(writes.find(([p]) => p.endsWith('second.bin')), ['/tree/second.bin', 0])
    assert.strictEqual(fs.statSync(path.join(serverA, 'tree', 'second.bin')).size, big.length + 7)
    fs.writeFileSync(path.join(disk, 'tree', 'second.bin'), big)

    // the unfinished job survives a restart ("interrupted") and resumes against fresh connections
    fs.rmSync(path.join(serverA, 'tree'), { recursive: true })
    const timer4 = setInterval(() => { const w = m.list().at(-1); if (w && w.state === 'running' && w.done > 100000 + 512 * 1024) m.cancel(w.id) }, 1)
    await job({ disk: true }, { serverId: 'a' })
    clearInterval(timer4)
    const w = m.list().at(-1); assert.strictEqual(w.state, 'cancelled'); m.save(true)
    m = make(store)
    const back = m.list().find(i => i.id === w.id)
    assert(back, 'remembered after a restart'); assert.strictEqual(back.state, 'interrupted'); assert.strictEqual(back.resumable, true)
    assert.strictEqual(await m.resume(w.id), true)
    assert.deepStrictEqual(fs.readFileSync(path.join(serverA, 'tree', 'second.bin')), big)
    assert(!fs.existsSync(store), 'nothing left to remember once done')

    // server to server: one connection to the other, nothing staged on disk
    fs.rmSync(path.join(serverA, 'tree'), { recursive: true }); fs.cpSync(path.join(disk, 'tree'), path.join(serverA, 'tree'), { recursive: true })
    reads.length = 0; writes.length = 0
    assert.strictEqual(await m.run('c', 'copy', 'tree', { refs: { src: { serverId: 'a' }, dst: { serverId: 'b' } }, serverIds: ['a', 'b'], top: [{ source: '/tree', target: '/copy' }] }), true)
    assert.deepStrictEqual(fs.readFileSync(path.join(serverB, 'copy', 'second.bin')), big)
    assert.strictEqual(fs.readFileSync(path.join(serverB, 'copy', 'third.bin'), 'utf8'), 'last')
    assert(reads.length === 3 && writes.length === 3)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
  console.log('resume ok')
})().catch(e => { console.error(e); process.exit(1) })
