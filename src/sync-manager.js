// Synchronized folder pairs (a local folder kept in sync with a folder on a server): saved pairs, comparisons,
// runs through the transfer queue, and watching ("keep the server up to date").
// No Electron here: main.js gives the dependencies, the tests give their own.
//
// deps: {
//   file      saved pairs (JSON), dir: snapshots, one file per pair
//   transfers the queue (transfers.js), whose jobs copy (transfer-files.js)
//   side(ref) -> the side for an endpoint ({ disk: true } or { serverId })
//   send(views) the pairs changed; notify(text, error) a message for the user; t(key, vars) translations
//   access(pair) -> release()  lets the app read the folder (Mac App Store: security-scoped bookmark)
//   watch(dir, onChange) -> { close }  defaults to fs.watch, recursive
// }
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const sync = require('./sync')

const DEBOUNCE = 400, MAX_WAIT = 3000, RETRY = 30000
const clean = p => ({
  id: p.id, serverId: String(p.serverId), local: String(p.local), remote: String(p.remote || '/'),
  deleteRemote: !!p.deleteRemote, excludes: p.excludes == null ? sync.DEFAULT_EXCLUDES : String(p.excludes), watch: !!p.watch,
  ...(p.bookmark ? { bookmark: p.bookmark } : {}), ...(p.lastSync ? { lastSync: p.lastSync } : {}), created: p.created || Date.now(),
})

class SyncManager {
  constructor(deps) {
    this.d = { watch: defaultWatch, access: () => () => {}, notify: () => {}, send: () => {}, t: k => k, ...deps }
    this.pairs = this.load()
    this.live = new Map() // pair id -> { state, error, pendingDeletes, conflicts, watcher, dirty, ... }
    this.compares = new Map() // token -> a comparison waiting for the user's choice
  }

  // ---- saved pairs ----
  load() { try { return JSON.parse(fs.readFileSync(this.d.file, 'utf8')).filter(p => p?.id && p.local && p.serverId).map(clean) } catch { return [] } }
  persist() {
    try { fs.mkdirSync(path.dirname(this.d.file), { recursive: true }); fs.writeFileSync(this.d.file + '.tmp', JSON.stringify(this.pairs, null, 1)); fs.renameSync(this.d.file + '.tmp', this.d.file) } catch {}
  }
  snapFile(id) { return path.join(this.d.dir, id.replace(/[^\w-]/g, '') + '.json') }
  snapshot(id) { try { return JSON.parse(fs.readFileSync(this.snapFile(id), 'utf8')) } catch { return {} } }
  saveSnapshot(id, snap) { try { fs.mkdirSync(this.d.dir, { recursive: true }); fs.writeFileSync(this.snapFile(id), JSON.stringify(snap)) } catch {} }
  get(id) { return this.pairs.find(p => p.id === id) }

  view(p) {
    const w = this.live.get(p.id) || {}
    const { bookmark, ...v } = p
    return { ...v, state: w.state || (p.watch ? 'stopped' : 'idle'), error: w.error, pendingDeletes: w.pendingDeletes || 0, conflicts: w.conflicts || 0, lastCount: w.lastCount }
  }
  list(serverId) { return this.pairs.filter(p => !serverId || p.serverId === serverId).map(p => this.view(p)) }
  changed() { this.d.send(this.list()) }

  // Adds or updates a pair. A pair that changes folders forgets its last synchronization.
  save(input) {
    if (!input?.local || !path.isAbsolute(String(input.local))) throw new Error(this.d.t('sync.err_local'))
    if (!input.serverId) throw new Error('serverId')
    const old = input.id && this.get(input.id)
    const pair = clean({ ...old, ...input, id: old?.id || crypto.randomUUID(), remote: '/' + String(input.remote || '/').replace(/^\/+/, '').replace(/\/+$/, '') })
    if (old && (old.local !== pair.local || old.remote !== pair.remote || old.serverId !== pair.serverId)) { this.stop(old.id); fs.rmSync(this.snapFile(old.id), { force: true }); delete pair.lastSync }
    if (old) this.pairs[this.pairs.indexOf(old)] = pair
    else this.pairs.push(pair)
    this.persist()
    if (!pair.watch) this.stop(pair.id)
    this.changed()
    return this.view(pair)
  }
  remove(id) {
    this.stop(id)
    this.pairs = this.pairs.filter(p => p.id !== id)
    fs.rmSync(this.snapFile(id), { force: true })
    this.persist()
    this.changed()
  }

  // ---- compare, then run what the user picked ----
  // pair: a saved pair's id, or { serverId, local, remote, excludes, deleteRemote } for a one-off comparison
  async compare(target) {
    const pair = typeof target === 'string' ? this.get(target) : clean({ ...target, id: null })
    if (!pair) throw new Error('Unknown pair')
    const release = this.d.access(pair)
    try {
      const exclude = sync.excluder(pair.excludes)
      const localSide = await this.d.side({ disk: true }), remoteSide = await this.d.side({ serverId: pair.serverId })
      const root = await localSide.info(pair.local)
      if (!root?.isDirectory) throw new Error(this.d.t('sync.err_missing', { path: pair.local }))
      const [local, remote] = await Promise.all([sync.scan(localSide, pair.local, exclude), sync.scan(remoteSide, pair.remote, exclude)])
      const snapshot = pair.id ? this.snapshot(pair.id) : {}
      const { items, same } = sync.diff(local, remote, snapshot, pair)
      const token = crypto.randomUUID()
      this.compares.set(token, { pair, local, remote, items, same, at: Date.now() })
      for (const [k, c] of this.compares) if (Date.now() - c.at > 30 * 60000) this.compares.delete(k)
      return { token, id: pair.id, local: pair.local, remote: pair.remote, items, same: same.length, remoteMissing: !remote.size && !(await remoteSide.info(pair.remote)) }
    } finally { release() }
  }

  // Runs the chosen differences (relative paths) of a comparison. watch: start watching once done (saved pairs).
  // Resolves when the transfer ends: { ok, sent, deleted }.
  async apply(token, rels, { watch = false } = {}) {
    const c = this.compares.get(token)
    if (!c) throw new Error('Comparison expired')
    this.compares.delete(token)
    const chosen = new Set(rels)
    const items = c.items.filter(i => chosen.has(i.rel))
    const pair = c.pair.id ? this.get(c.pair.id) || c.pair : c.pair
    // folders that must exist on the server for the chosen files
    const extra = sync.parents(items.filter(i => i.kind !== 'delete').map(i => i.rel), {}, c.local).filter(r => c.remote.get(r)?.dir !== true && !chosen.has(r))
    // and the pair's own folder, the first time
    if (!c.remote.size && items.some(i => i.kind !== 'delete')) extra.unshift('')
    const all = [...extra.map(rel => ({ rel, kind: 'add', dir: true, local: { dir: true } })), ...items]
    const result = await this.run(pair, all, c)
    if (pair.id && result.ok) {
      const w = this.live.get(pair.id)
      if (w) { w.pendingDeletes = 0; w.conflicts = 0 }
      if (watch && !pair.watch) { pair.watch = true; this.persist() }
      if (pair.watch) this.start(pair.id, { initial: false })
    }
    return result
  }

  // One job in the queue for these differences; the snapshot follows what completed.
  // quiet: no message when it fails (watching retries on its own and already shows the error)
  async run(pair, items, scanned = {}, { quiet = false } = {}) {
    const live = pair.id ? this.state(pair.id) : null
    const plan = sync.plan(items, pair.local, pair.remote)
    const sent = plan.filter(i => i.sync).length, deleted = plan.filter(i => i.op === 'delete').length
    const save = () => {
      if (!pair.id) return
      this.saveSnapshot(pair.id, sync.nextSnapshot(this.snapshot(pair.id), { ...scanned }, plan.filter(i => i.done)))
      pair.lastSync = Date.now(); this.persist()
    }
    if (!plan.length) { save(); this.changed(); return { ok: true, sent: 0, deleted: 0 } }
    if (live) { live.state = 'syncing'; live.error = undefined; this.changed() }
    const release = this.d.access(pair)
    try {
      const done = await this.d.transfers.run(null, 'sync', path.basename(pair.local), {
        refs: { src: { disk: true }, dst: { serverId: pair.serverId } }, serverIds: [pair.serverId], policy: 'overwrite', plan,
      })
      save()
      if (live) { live.state = live.watcher ? 'watching' : undefined; live.lastCount = sent + deleted }
      if (done) this.d.notify(this.d.t('sync.done', { name: path.basename(pair.local), sent, deleted }))
      return { ok: done, sent, deleted }
    } catch (e) {
      save() // what did complete is remembered
      if (live) { live.state = live.watcher ? 'error' : undefined; live.error = e.message }
      if (!quiet) this.d.notify(this.d.t('sync.failed', { name: path.basename(pair.local), error: e.message }), true)
      throw e
    } finally { release(); this.changed() }
  }

  // ---- watching ----
  state(id) { if (!this.live.has(id)) this.live.set(id, {}); return this.live.get(id) }
  watching(id) { return !!this.live.get(id)?.watcher }

  // Starts watching a pair (saved as watched). initial: compare with the server first (when it was not running:
  // changes made while the app was closed are sent; deletions wait for the user's review).
  start(id, { initial = true } = {}) {
    const pair = this.get(id)
    if (!pair) return
    if (!pair.watch) { pair.watch = true; this.persist() }
    const w = this.state(id)
    if (w.watcher) return this.changed()
    Object.assign(w, { dirty: new Set(), full: initial, review: initial, state: 'watching', error: undefined, pendingDeletes: 0 })
    w.release = this.d.access(pair)
    const exclude = sync.excluder(pair.excludes)
    try {
      w.watcher = this.d.watch(pair.local, (name, error) => {
        if (error) return this.fail(id, error)
        if (!name) w.full = true
        else { const rel = name.split(path.sep).join('/'); if (!exclude(rel)) w.dirty.add(rel); else return }
        this.schedule(id)
      })
    } catch (e) { this.fail(id, e); return }
    if (initial) this.schedule(id, 0)
    this.changed()
  }
  // Stops watching. keep: the pair stays marked as watched (it starts again when its server is opened)
  stop(id, { keep = true } = {}) {
    const w = this.live.get(id)
    if (w) { w.watcher?.close(); w.release?.(); clearTimeout(w.timer); clearTimeout(w.retry); this.live.delete(id) }
    const pair = this.get(id)
    if (pair && !keep && pair.watch) { pair.watch = false; this.persist() }
    this.changed()
  }
  fail(id, error) {
    const w = this.live.get(id)
    w?.watcher?.close(); if (w) w.watcher = null
    if (w) { w.release?.(); w.release = null; w.state = 'error'; w.error = error.message || String(error) }
    this.changed()
  }
  // a server was opened: its watched pairs start; the computer woke up: everything is compared again
  serverOpened(serverId) { for (const p of this.pairs) if (p.watch && p.serverId === serverId && !this.watching(p.id)) this.start(p.id) }
  rescanAll() { for (const [id, w] of this.live) if (w.watcher) { w.full = true; this.schedule(id, 0) } }

  schedule(id, delay = DEBOUNCE) {
    const w = this.live.get(id)
    if (!w) return
    w.since ||= Date.now()
    w.pending = true
    clearTimeout(w.timer)
    w.timer = setTimeout(() => this.flush(id), Date.now() - w.since > MAX_WAIT ? 0 : delay)
    w.timer.unref?.()
  }

  // Sends what changed since the last run. One run at a time per pair; changes during a run wait for the next one.
  async flush(id) {
    const w = this.live.get(id), pair = this.get(id)
    if (w) w.pending = false
    if (!w || !pair || !w.watcher) return
    if (w.busy) { w.again = true; return }
    w.busy = true; w.since = 0
    const dirty = w.dirty; w.dirty = new Set()
    const full = w.full; w.full = false
    const review = w.review; w.review = false
    try {
      const localSide = await this.d.side({ disk: true })
      if (!(await localSide.info(pair.local))?.isDirectory) throw new Error(this.d.t('sync.err_missing', { path: pair.local }))
      const snapshot = this.snapshot(id), exclude = sync.excluder(pair.excludes)
      let items, scanned = {}
      if (full) {
        const remoteSide = await this.d.side({ serverId: pair.serverId })
        const [local, remote] = await Promise.all([sync.scan(localSide, pair.local, exclude), sync.scan(remoteSide, pair.remote, exclude)])
        const d = sync.diff(local, remote, snapshot, pair)
        items = d.items; scanned = { local, remote, same: d.same }
        w.conflicts = items.filter(i => i.kind === 'conflict').length
      } else {
        // only the paths that moved; a path inside another one that moved is covered by it
        const rels = [...dirty].sort().filter((r, i, all) => !all.slice(0, i).some(a => r.startsWith(a + '/')))
        const local = new Map()
        for (const rel of rels) for (const [k, v] of await sync.scan(localSide, pair.local, exclude, { rel })) local.set(k, v)
        items = sync.changes(rels, local, snapshot, pair)
        const need = sync.parents(items.filter(i => i.kind !== 'delete').map(i => i.rel), snapshot, local)
        for (const rel of need) {
          if (!items.some(i => i.rel === rel)) {
            const st = await localSide.info(sync.localPath(pair.local, rel))
            if (st?.isDirectory) items.push({ rel, kind: 'add', dir: true, local: { dir: true }, checked: true })
          }
        }
      }
      // deletions: applied on their own only when asked for, few, and not on the first pass after a (re)start
      const deletes = items.filter(i => i.kind === 'delete' && i.checked)
      const holdDeletes = review || sync.tooManyDeletes(deletes.length, snapshot)
      w.pendingDeletes = holdDeletes ? deletes.length : 0
      if (holdDeletes && deletes.length) this.d.notify(this.d.t('sync.pending_deletes', { n: deletes.length }), true)
      const todo = items.filter(i => i.checked && (i.kind !== 'delete' || !holdDeletes))
      if (todo.length || full) await this.run(pair, todo, scanned, { quiet: w.state === 'error' })
      if (w.state === 'error') { w.state = 'watching'; w.error = undefined }
    } catch (e) {
      // the server is unreachable or the job failed: what moved is tried again later
      for (const r of dirty) w.dirty.add(r)
      if (full) w.full = true
      w.state = 'error'; w.error = e.message
      clearTimeout(w.retry); w.retry = setTimeout(() => this.schedule(id, 0), RETRY); w.retry.unref?.()
    } finally {
      w.busy = false
      this.changed()
      if (this.live.get(id) === w && (w.again || w.dirty.size || w.full) && w.state !== 'error') { w.again = false; this.schedule(id) }
    }
  }

  // resolves once a pair has nothing waiting nor running (tests)
  async settled(id) { for (let w; (w = this.live.get(id)) && (w.pending || w.busy);) await new Promise(r => setTimeout(r, 20)) }

  close() { for (const id of [...this.live.keys()]) { const w = this.live.get(id); w.watcher?.close(); w.release?.(); clearTimeout(w.timer); clearTimeout(w.retry) } this.live.clear() }
}

// fs.watch on the whole tree (macOS, Windows; Linux since Node 20): onChange(relative name | null, error?)
function defaultWatch(dir, onChange) {
  const watcher = fs.watch(dir, { recursive: true }, (_, name) => onChange(name ? String(name) : null))
  watcher.on('error', e => onChange(null, e))
  return watcher
}

module.exports = { SyncManager }
