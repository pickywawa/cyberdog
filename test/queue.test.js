// Transfer queue: simultaneous transfers limit, priorities, order, pause / resume, retry; files that already exist
// at the target (overwrite, newer, size, resume, rename, skip, apply to all, cancel).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Transfers } = require('../src/transfers')
const { decide, numbered } = require('../src/transfer-files')
const { local } = require('../src/local-storage')
const { sftpOver } = require('../src/object-storage')
const tick = () => new Promise(r => setTimeout(r, 5))
const until = async (test, label) => { for (let i = 0; i < 400; i++) { if (test()) return; await tick() } throw new Error('timeout: ' + label) }

;(async () => {
  // ---- scheduling ----
  const gates = new Map(), started = []
  const runner = job => new Promise((resolve, reject) => {
    started.push(job.name)
    const gate = { resolve, reject }
    gates.set(job.name, gate)
    job.stream = { destroy: e => reject(e) }
  })
  const q = new Transfers(() => {}, null, runner, { limit: 2 })
  const state = name => q.list().find(x => x.name === name)?.state
  const id = name => q.list().find(x => x.name === name).id
  const done = {}
  for (const name of ['a', 'b', 'c', 'd']) done[name] = q.run('c', 'upload', name, { top: [] })
  await tick()
  assert.deepStrictEqual(started, ['a', 'b'], 'two at a time')
  assert.strictEqual(state('c'), 'queued')
  q.setPriority(id('d'), 'high')
  gates.get('a').resolve()
  assert.strictEqual(await done.a, true)
  await until(() => started.length === 3, 'third start')
  assert.deepStrictEqual(started, ['a', 'b', 'd'], 'high priority goes first')
  // pause a waiting job: it keeps its place but does not start
  q.pause(id('c'))
  assert.strictEqual(state('c'), 'paused')
  gates.get('b').resolve(); gates.get('d').resolve()
  await Promise.all([done.b, done.d])
  await tick()
  assert.deepStrictEqual(started, ['a', 'b', 'd'], 'a paused job is not started')
  const resumed = q.resume(id('c'))
  await until(() => started.includes('c'), 'resume c')
  // pause a running job, then resume it
  q.pause(id('c'))
  await until(() => state('c') === 'paused', 'paused while running')
  q.resume(id('c'))
  await until(() => started.filter(n => n === 'c').length === 2, 'c runs again')
  gates.get('c').resolve()
  assert.strictEqual(await resumed, true)
  assert.strictEqual(await done.c, true, 'the first caller learns about the completion too')

  // limit 1, order in the queue and moving up
  q.setLimit(1)
  started.length = 0
  for (const name of ['e', 'f', 'g']) done[name] = q.run('c', 'upload', name, { top: [] })
  await tick()
  q.move(id('g'), -1)
  gates.get('e').resolve(); await done.e
  await until(() => started.length === 2, 'next after e')
  assert.deepStrictEqual(started, ['e', 'g'], 'g was moved before f')
  // cancel a waiting job
  q.cancel(id('f'))
  assert.strictEqual(await done.f, false)
  // a failure, then retry
  gates.get('g').reject(new Error('network down'))
  await assert.rejects(done.g, /network down/)
  assert.strictEqual(state('g'), 'error')
  q.retryFailed()
  await until(() => state('g') === 'running', 'retry')
  gates.get('g').resolve()
  await until(() => state('g') === 'done', 'retried job done')
  q.clear()
  assert.strictEqual(q.list().length, 0, 'finished jobs cleared')

  // ---- decisions on an existing file ----
  const older = { size: 10, mtime: 1000000 }, newer = { size: 10, mtime: 5000000 }
  assert.deepStrictEqual(decide('overwrite', older, newer, true), { write: 0 })
  assert.deepStrictEqual(decide('newer', newer, older, true), { write: 0 })
  assert.deepStrictEqual(decide('newer', older, newer, true), { skip: true })
  assert.deepStrictEqual(decide('newer', { size: 1, mtime: 2000400 }, { size: 1, mtime: 2000000 }, true), { skip: true }, 'one-second precision')
  assert.deepStrictEqual(decide('size', older, newer, true), { skip: true })
  assert.deepStrictEqual(decide('size', { size: 11 }, newer, true), { write: 0 })
  assert.deepStrictEqual(decide('resume', { size: 100 }, { size: 40 }, true), { write: 40 })
  assert.deepStrictEqual(decide('resume', { size: 100 }, { size: 40 }, false), { write: 0 })
  assert.deepStrictEqual(decide('resume', { size: 100 }, { size: 100 }, true), { skip: true })
  assert.deepStrictEqual(decide('resume', { size: 10 }, { size: 40 }, true), { write: 0 })
  assert.deepStrictEqual(decide('rename', older, newer, true), { rename: true })
  assert.deepStrictEqual(decide('skip', older, newer, true), { skip: true })
  assert.strictEqual(numbered('report.pdf', 2), 'report (2).pdf')
  assert.strictEqual(numbered('.env', 1), '.env (1)')
  assert.strictEqual(numbered('site.d', 1, true), 'site.d (1)')

  // ---- the engine asks, and does what was answered ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-queue-'))
  try {
    const disk = path.join(root, 'disk'), remote = path.join(root, 'remote')
    fs.mkdirSync(path.join(disk, 'tree'), { recursive: true }); fs.mkdirSync(path.join(remote, 'tree'), { recursive: true })
    const write = (dir, name, data, age = 0) => { const f = path.join(dir, 'tree', name); fs.writeFileSync(f, data); if (age) fs.utimesSync(f, new Date(Date.now() - age), new Date(Date.now() - age)) }
    const reset = () => {
      for (const [name, a, b] of [['same.txt', 'hello', 'hello'], ['bigger.txt', 'new content!', 'old'], ['partial.bin', 'abcdefghij', 'abcd'], ['fresh.txt', 'fresh', null], ['keep.txt', 'mine', 'theirs']]) {
        write(disk, name, a); if (b === null) fs.rmSync(path.join(remote, 'tree', name), { force: true }); else write(remote, name, b, 3600000) // remote copies are an hour older
      }
      for (const f of fs.readdirSync(path.join(remote, 'tree'))) if (/\(\d\)/.test(f)) fs.rmSync(path.join(remote, 'tree', f))
    }
    const session = sftpOver(local({ root: remote }))
    let answers, asked
    const m = new Transfers(() => {}, null, (job, resuming) => engine.runJob(job, resuming))
    const engine = require('../src/transfer-files')(m, ref => (ref.disk ? null : session))
    m.ask = async (job, info) => { asked.push(info.name); const a = answers[info.name] || answers['*']; return typeof a === 'string' ? { action: a } : a }
    const upload = () => m.run('c', 'upload', 'tree', { refs: { src: { disk: true }, dst: { serverId: 'r' } }, top: [{ source: path.join(disk, 'tree'), target: '/tree' }] })
    const read = name => fs.readFileSync(path.join(remote, 'tree', name), 'utf8')

    reset(); asked = []
    answers = { 'same.txt': 'size', 'bigger.txt': 'newer', 'partial.bin': 'resume', 'keep.txt': 'rename' }
    assert.strictEqual(await upload(), true)
    assert.deepStrictEqual(asked.sort(), ['bigger.txt', 'keep.txt', 'partial.bin', 'same.txt'], 'asked once per existing file, never for a new one')
    assert.strictEqual(read('same.txt'), 'hello')
    assert.strictEqual(read('bigger.txt'), 'new content!', 'the local file is newer')
    assert.strictEqual(read('partial.bin'), 'abcdefghij', 'completed from where it was')
    assert.strictEqual(read('keep.txt'), 'theirs'); assert.strictEqual(read('keep (1).txt'), 'mine')
    assert.strictEqual(read('fresh.txt'), 'fresh')
    const last = m.list().at(-1)
    assert.strictEqual(last.skipped, 1, 'same.txt was skipped'); assert.strictEqual(last.done, last.total, 'skipped files count as done')

    // "apply to all": one question for the whole job
    reset(); asked = []
    answers = { '*': { action: 'skip', all: true } }
    assert.strictEqual(await upload(), true)
    assert.strictEqual(asked.length, 1)
    assert.strictEqual(read('bigger.txt'), 'old'); assert.strictEqual(read('keep.txt'), 'theirs'); assert.strictEqual(read('fresh.txt'), 'fresh')

    // overwrite everything, and cancel
    reset(); asked = []
    answers = { '*': { action: 'overwrite', all: true } }
    await upload()
    assert.strictEqual(read('keep.txt'), 'mine'); assert.strictEqual(read('partial.bin'), 'abcdefghij')
    reset(); asked = []
    answers = { '*': 'cancel' }
    assert.strictEqual(await upload(), false)
    assert.strictEqual(m.list().at(-1).state, 'cancelled')

    // a job paused while the question is open stops waiting for the answer
    reset(); asked = []
    m.ask = () => new Promise(() => {})
    const waiting = upload()
    await until(() => m.list().at(-1).asking, 'question open')
    m.pause(m.list().at(-1).id)
    await until(() => m.list().at(-1).state === 'paused', 'paused while asking')
    assert.strictEqual(m.list().at(-1).asking, false)
    m.cancel(m.list().at(-1).id)
    assert.strictEqual(await waiting, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
  console.log('queue and conflicts ok')
})().catch(e => { console.error(e); process.exitCode = 1 })
