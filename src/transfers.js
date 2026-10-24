const crypto = require('crypto')
class Transfers {
  constructor(send) { this.items = new Map(); this.send = send }
  list() { return [...this.items.values()].map(x => this.view(x)) }
  view(x) { const { stream, ...v } = x; const seconds = (Date.now() - x.started) / 1000; v.speed = seconds > 0 ? x.done / seconds : 0; v.remaining = v.speed > 0 ? Math.max(0, (x.total - x.done) / v.speed) : null; return v }
  emit(x, force = false) { if (force || Date.now() - (x.sent || 0) > 150) { x.sent = Date.now(); this.send('transfer:update', this.view(x)) } }
  async run(connId, direction, name, work) {
    const x = { id: crypto.randomUUID(), connId, direction, name, state: 'running', done: 0, total: 0, started: Date.now(), scanned: false }
    this.items.set(x.id, x); this.emit(x, true)
    try { await work(x); this.check(x); x.state = 'done' }
    catch (e) { x.state = x.cancelled ? 'cancelled' : 'error'; x.error = e.message; if (!x.cancelled) throw e }
    finally { x.stream = null; this.emit(x, true); const finished = [...this.items.values()].filter(v => v.state !== 'running'); for (const old of finished.slice(0, -30)) this.items.delete(old.id) }
    return x.state !== 'cancelled'
  }
  check(x) { if (x.cancelled) throw new Error('Transfer cancelled') }
  cancel(id) { const x = this.items.get(id); if (x?.state === 'running') { x.cancelled = true; x.stream?.destroy(new Error('Transfer cancelled')); this.emit(x, true) } }
  cancelConnection(id) { for (const x of this.items.values()) if (x.connId === id) this.cancel(x.id) }
}
module.exports = { Transfers }
