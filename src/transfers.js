const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Transfer jobs. A job keeps its plan (what to copy, what is done) so that an interrupted transfer can be resumed:
// finished files are skipped and the partial one continues where it stopped when both ends allow it.
// With a `file`, unfinished jobs are remembered across restarts and come back as "interrupted".
// runner(job, resuming) does the copying (see transfer-files.js); a job is plain data: endpoints (refs), top-level
// source/target pairs (top) and the plan, so it can be saved and run again.
class Transfers {
  constructor(send, file, runner) {
    this.items = new Map(); this.send = send; this.file = file; this.runner = runner
    for (const x of this.restore()) this.items.set(x.id, x)
  }
  list() { return [...this.items.values()].map(x => this.view(x)) }
  view(x) {
    const { stream, plan, top, refs, ...v } = x
    const seconds = (Date.now() - x.started) / 1000, sent = x.done - (x.base || 0)
    v.speed = x.state === 'running' && seconds > 0 ? sent / seconds : 0
    v.remaining = v.speed > 0 ? Math.max(0, (x.total - x.done) / v.speed) : null
    v.resumable = ['error', 'cancelled', 'interrupted'].includes(x.state) && !!plan?.some(i => !i.done)
    return v
  }
  emit(x, force = false) { if (force || Date.now() - (x.sent || 0) > 150) { x.sent = Date.now(); this.send('transfer:update', this.view(x)) } this.save() }

  // meta: { refs: { src, dst } (each { serverId } or { disk: true }), top: [{ source, target }], serverIds }
  async run(connId, direction, name, meta = {}) {
    const x = { id: crypto.randomUUID(), connId, direction, name, state: 'running', done: 0, total: 0, started: Date.now(), scanned: false, base: 0, refs: meta.refs, top: meta.top, serverIds: meta.serverIds || [] }
    this.items.set(x.id, x)
    return this.execute(x, false)
  }
  async execute(x, resuming) {
    this.emit(x, true)
    try { await this.runner(x, resuming); this.check(x); x.state = 'done' }
    catch (e) { x.state = x.cancelled ? 'cancelled' : 'error'; x.error = e.message; if (!x.cancelled) throw e }
    finally { x.stream = null; this.emit(x, true); this.save(true); this.trim() }
    return x.state !== 'cancelled'
  }
  trim() { const finished = [...this.items.values()].filter(v => v.state !== 'running'); for (const old of finished.slice(0, -30)) this.items.delete(old.id) }
  // Continue an interrupted job
  async resume(id) {
    const x = this.items.get(id)
    if (!x || x.state === 'running' || !this.view(x).resumable) throw new Error('Nothing to resume')
    Object.assign(x, { state: 'running', cancelled: false, error: undefined, started: Date.now(), base: x.done })
    return this.execute(x, true)
  }
  check(x) { if (x.cancelled) throw new Error('Transfer cancelled') }
  cancel(id) { const x = this.items.get(id); if (x?.state === 'running') { x.cancelled = true; x.stream?.destroy(new Error('Transfer cancelled')); this.emit(x, true) } }
  cancelConnection(id) { for (const x of this.items.values()) if (x.connId === id) this.cancel(x.id) }

  // ---- memory across restarts ----
  restore() {
    if (!this.file) return []
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return saved.filter(x => x && x.plan && x.refs && x.state !== 'done').map(x => ({ ...x, connId: null, state: 'interrupted', base: x.done, started: Date.now(), scanned: true }))
    } catch { return [] }
  }
  save(now = false) {
    if (!this.file) return
    if (!now) { if (this.saving) return; this.saving = setTimeout(() => { this.saving = null; this.save(true) }, 2000); this.saving.unref?.(); return }
    clearTimeout(this.saving); this.saving = null
    // plans of very large trees are not remembered (they would make every save slow)
    const keep = [...this.items.values()].filter(x => x.refs && x.plan && x.state !== 'done' && x.plan.length <= 5000)
      .map(({ stream, sent, ...x }) => x)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (keep.length) fs.writeFileSync(this.file + '.tmp', JSON.stringify(keep)), fs.renameSync(this.file + '.tmp', this.file)
      else fs.rmSync(this.file, { force: true })
    } catch {}
  }
}
module.exports = { Transfers }
