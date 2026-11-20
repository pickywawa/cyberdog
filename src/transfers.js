const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Transfer queue. A job keeps its plan (what to copy, what is done) so that an interrupted or paused transfer can be
// resumed: finished files are skipped and the partial one continues where it stopped when both ends allow it.
// Jobs wait in the queue ('queued') until one of the `limit` slots is free; the highest priority goes first, then the
// order of the queue. A paused job keeps its place but is not started until it is resumed.
// With a `file`, unfinished jobs are remembered across restarts and come back as "interrupted".
// runner(job, resuming) does the copying (see transfer-files.js); a job is plain data: endpoints (refs), top-level
// source/target pairs (top) and the plan, so it can be saved and run again.
const PRIORITY = { high: 1, normal: 0, low: -1 }
const PENDING = ['queued', 'paused']
const RESUMABLE = ['paused', 'error', 'cancelled', 'interrupted']
const clampLimit = n => Math.max(1, Math.min(10, Math.round(+n) || 1))

class Transfers {
  constructor(send, file, runner, { limit = 2 } = {}) {
    this.items = new Map(); this.send = send; this.file = file; this.runner = runner
    this.limit = clampLimit(limit); this.seq = 0
    // ask(job, conflict) -> Promise<{ action, all }>: the app asks the user what to do with a file that already exists
    this.ask = null
    for (const x of this.restore()) { x.order = ++this.seq; this.items.set(x.id, x) }
  }
  setLimit(n) { this.limit = clampLimit(n); this.pump() }
  list() { return [...this.items.values()].sort((a, b) => a.order - b.order).map(x => this.view(x)) }
  view(x) {
    const { stream, plan, top, refs, waiters, stop, policy, abortAsk, ...v } = x
    const seconds = (Date.now() - x.started) / 1000, sent = x.done - (x.base || 0)
    v.speed = x.state === 'running' && seconds > 0 ? sent / seconds : 0
    v.remaining = v.speed > 0 ? Math.max(0, (x.total - x.done) / v.speed) : null
    v.resumable = RESUMABLE.includes(x.state) && (x.plan ? x.plan.some(i => !i.done) : x.state === 'paused' || !!x.top)
    v.skipped = plan ? plan.filter(i => i.skipped).length : 0
    return v
  }
  emit(x, force = false) { if (force || Date.now() - (x.sent || 0) > 150) { x.sent = Date.now(); this.send('transfer:update', this.view(x)) } this.save() }

  // meta: { refs: { src, dst } (each { serverId } or { disk: true }), top: [{ source, target }], serverIds, priority, hold, policy }
  // Resolves when the job ends: true when completed, false when cancelled; rejects when it fails.
  run(connId, direction, name, meta = {}) {
    const x = {
      id: crypto.randomUUID(), connId, direction, name, state: meta.hold ? 'paused' : 'queued', done: 0, total: 0, started: Date.now(), scanned: false, base: 0,
      refs: meta.refs, top: meta.top, serverIds: meta.serverIds || [], priority: PRIORITY[meta.priority] ?? 0, order: ++this.seq, policy: meta.policy,
    }
    this.items.set(x.id, x)
    const finished = this.wait(x)
    this.emit(x, true)
    this.pump()
    return finished
  }
  wait(x) { return new Promise((resolve, reject) => (x.waiters ||= []).push({ resolve, reject })) }
  settle(x, error) {
    const waiting = x.waiters || []
    x.waiters = []
    for (const w of waiting) error ? w.reject(error) : w.resolve(x.state === 'done')
  }
  // next job to start: highest priority, then queue order
  next() { return [...this.items.values()].filter(x => x.state === 'queued').sort((a, b) => b.priority - a.priority || a.order - b.order)[0] }
  pump() {
    let running = [...this.items.values()].filter(x => x.state === 'running').length
    for (let x; running < this.limit && (x = this.next()); running++) this.execute(x)
  }
  async execute(x) {
    const resuming = !!x.plan
    Object.assign(x, { state: 'running', stop: null, error: undefined, started: Date.now(), base: x.done })
    this.emit(x, true)
    let failure
    try { await this.runner(x, resuming); this.check(x); x.state = 'done' }
    catch (e) {
      if (x.stop === 'pause') x.state = 'paused'
      else if (x.stop === 'cancel') x.state = 'cancelled'
      else { x.state = 'error'; x.error = e.message; failure = e }
    } finally { x.stream = null; x.stop = null; x.asking = false; x.abortAsk = null }
    this.emit(x, true)
    this.save(true)
    if (x.state !== 'paused') this.settle(x, failure)
    this.trim()
    this.pump()
  }
  trim() { const finished = [...this.items.values()].filter(v => ['done', 'cancelled', 'error'].includes(v.state) && !v.waiters?.length); for (const old of finished.slice(0, -50)) this.items.delete(old.id) }
  check(x) { if (x.stop) throw new Error(x.stop === 'pause' ? 'Transfer paused' : 'Transfer cancelled') }
  interrupt(x, why) {
    x.stop = why
    x.stream?.destroy(new Error(why === 'pause' ? 'Transfer paused' : 'Transfer cancelled'))
    x.abortAsk?.()
    this.emit(x, true)
  }

  // ---- queue controls ----
  cancel(id) {
    const x = this.items.get(id)
    if (x?.state === 'running') this.interrupt(x, 'cancel')
    else if (x && PENDING.includes(x.state)) { x.state = 'cancelled'; this.emit(x, true); this.save(true); this.settle(x); this.pump() }
  }
  cancelConnection(id) { for (const x of this.items.values()) if (x.connId === id) this.cancel(x.id) }
  pause(id) {
    const x = this.items.get(id)
    if (x?.state === 'running') this.interrupt(x, 'pause')
    else if (x?.state === 'queued') { x.state = 'paused'; this.emit(x, true); this.save(true) }
  }
  // Continue a paused, interrupted, cancelled or failed job (it goes back to the queue). Resolves like run().
  resume(id) {
    const x = this.items.get(id)
    if (!x || !this.view(x).resumable) return Promise.reject(new Error('Nothing to resume'))
    Object.assign(x, { state: 'queued', error: undefined })
    const finished = this.wait(x)
    this.emit(x, true)
    this.pump()
    return finished
  }
  retryFailed() {
    for (const x of [...this.items.values()]) if (['error', 'interrupted'].includes(x.state) && this.view(x).resumable) this.resume(x.id).catch(() => {})
  }
  setPriority(id, priority) {
    const x = this.items.get(id)
    if (!x || !(priority in PRIORITY)) return
    x.priority = PRIORITY[priority]
    this.emit(x, true)
    this.pump()
  }
  // Moves a waiting job up (-1) or down (+1) among the waiting jobs
  move(id, delta) {
    const waiting = [...this.items.values()].filter(x => PENDING.includes(x.state)).sort((a, b) => a.order - b.order)
    const i = waiting.findIndex(x => x.id === id), j = i + Math.sign(delta)
    if (i < 0 || j < 0 || j >= waiting.length) return
    const a = waiting[i], b = waiting[j]
    ;[a.order, b.order] = [b.order, a.order]
    this.emit(a, true); this.emit(b, true)
  }
  // Removes finished jobs from the list (all of them, or one)
  clear(id) {
    for (const x of [...this.items.values()]) if ((!id || x.id === id) && !['running', ...PENDING].includes(x.state) && !x.waiters?.length) this.items.delete(x.id)
    this.save(true)
  }

  // Asks what to do with a file that already exists (once per job when the answer applies to all)
  async conflict(x, info) {
    if (x.policy) return x.policy
    if (!this.ask) return 'overwrite'
    x.asking = true
    this.emit(x, true)
    try {
      const answer = await new Promise((resolve, reject) => { x.abortAsk = () => resolve({ action: 'stop' }); this.ask(x, info).then(resolve, reject) })
      if (answer.all && !['cancel', 'stop'].includes(answer.action)) x.policy = answer.action
      return answer.action
    } finally { x.asking = false; x.abortAsk = null; this.emit(x, true) }
  }

  // ---- memory across restarts ----
  restore() {
    if (!this.file) return []
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return saved.filter(x => x && x.refs && (x.plan || x.top) && x.state !== 'done')
        .map(x => ({ ...x, connId: null, state: 'interrupted', base: x.done, started: Date.now(), scanned: !!x.plan, priority: x.priority || 0 }))
    } catch { return [] }
  }
  save(now = false) {
    if (!this.file) return
    if (!now) { if (this.saving) return; this.saving = setTimeout(() => { this.saving = null; this.save(true) }, 2000); this.saving.unref?.(); return }
    clearTimeout(this.saving); this.saving = null
    // plans of very large trees are not remembered (they would make every save slow)
    const keep = [...this.items.values()].filter(x => x.refs && (x.plan || x.top) && x.state !== 'done' && (!x.plan || x.plan.length <= 5000))
      .map(({ stream, sent, waiters, stop, asking, abortAsk, ...x }) => x)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (keep.length) fs.writeFileSync(this.file + '.tmp', JSON.stringify(keep)), fs.renameSync(this.file + '.tmp', this.file)
      else fs.rmSync(this.file, { force: true })
    } catch {}
  }
}
module.exports = { Transfers, PRIORITY }
