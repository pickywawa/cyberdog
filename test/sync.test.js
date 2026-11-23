// Folder synchronization: exclusions, comparison with and without a snapshot, the plan, and a whole run
// (compare -> apply -> watch) between a local folder and a "server" (a local folder behind the SFTP-like adapter).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sync = require('../src/sync')
const { Transfers } = require('../src/transfers')
const { SyncManager } = require('../src/sync-manager')
const { local } = require('../src/local-storage')
const { sftpOver } = require('../src/object-storage')

// ---- exclusions ----
const ex = sync.excluder('.git, node_modules, *.swp, build/*.map, docs/**/draft*')
assert(ex('.git')); assert(ex('.git/HEAD')); assert(ex('a/node_modules/x/y.js')); assert(ex('src/.main.js.swp'))
assert(ex('build/app.js.map')); assert(!ex('src/build/app.js.map')); assert(ex('docs/a/b/draft-1.md'))
assert(!ex('src/main.js')); assert(!ex('gitignore')); assert(!sync.excluder('')('anything'))

// ---- comparison ----
const M = obj => new Map(Object.entries(obj))
const f = (size, mtime) => ({ dir: false, size, mtime }), D = { dir: true, size: 0, mtime: 0 }
{
  // no snapshot: new, changed, same (date within 2 s), newer on the server, only on the server
  const { items, same } = sync.diff(
    M({ a: f(1, 10000), b: f(2, 20000), c: f(3, 30000), d: f(4, 10000), dir: D, 'dir/x': f(1, 1) }),
    M({ b: f(9, 10000), c: f(3, 31500), d: f(5, 90000), old: f(1, 1), gone: D, 'gone/y': f(1, 1) }),
    {}, { deleteRemote: true })
  const by = Object.fromEntries(items.map(i => [i.rel, i]))
  assert.deepStrictEqual(Object.keys(by).sort(), ['a', 'b', 'd', 'dir', 'dir/x', 'gone', 'old'])
  assert.strictEqual(by.a.kind, 'add'); assert.strictEqual(by.b.kind, 'modify'); assert(by.b.checked)
  assert.strictEqual(by.d.kind, 'conflict'); assert.strictEqual(by.d.reason, 'remote_newer'); assert(!by.d.checked)
  assert.strictEqual(by.gone.kind, 'delete'); assert(by.gone.dir); assert(!by['gone/y'], 'a deleted folder covers its content')
  assert.strictEqual(by.old.reason, 'only_remote'); assert(!by.old.checked, 'never synced: not deleted by default')
  assert.deepStrictEqual(same, ['c'])
}
{
  // with a snapshot: unchanged on both sides even though dates differ (no utimes on the server),
  // changed on the server only = conflict, deleted locally after a sync = checked deletion
  const snap = { a: { l: [1, 1000], r: [1, 555000] }, b: { l: [2, 2000], r: [2, 600000] }, c: { l: [3, 3000], r: [3, 3000] } }
  const { items, same } = sync.diff(M({ a: f(1, 1000), b: f(2, 2000) }), M({ a: f(1, 555000), b: f(7, 700000), c: f(3, 3000) }), snap, { deleteRemote: true })
  assert.deepStrictEqual(same, ['a'])
  assert.deepStrictEqual(items.map(i => [i.rel, i.kind, i.checked, i.reason]), [['b', 'conflict', false, 'remote_changed'], ['c', 'delete', true, undefined]])
  // without deleteRemote, the deletion is listed but not selected
  assert.strictEqual(sync.diff(M({}), M({ c: f(3, 3000) }), snap).items[0].checked, false)
}
{
  // plan order: deletions deepest first, folders outermost first, then files; a file replacing a folder deletes it
  const plan = sync.plan([
    { rel: 'a/b/c.txt', kind: 'add', dir: false, local: { size: 3, mtime: 1 } },
    { rel: 'a', kind: 'add', dir: true }, { rel: 'a/b', kind: 'add', dir: true },
    { rel: 'x', kind: 'delete', dir: true }, { rel: 'x2/y/z', kind: 'delete', dir: false },
    { rel: 'k', kind: 'conflict', dir: false, local: { size: 1, mtime: 1 }, remote: { dir: true } },
  ], '/home/me/site', '/var/www')
  assert.deepStrictEqual(plan.map(i => [i.op || (i.directory ? 'dir' : 'file'), i.target]), [
    ['delete', '/var/www/x2/y/z'], ['delete', '/var/www/x'], ['delete', '/var/www/k'],
    ['dir', '/var/www/a'], ['dir', '/var/www/a/b'], ['file', '/var/www/a/b/c.txt'], ['file', '/var/www/k']])
  assert.strictEqual(plan.find(i => i.rel === 'a/b/c.txt').source, path.join('/home/me/site', 'a', 'b', 'c.txt'))
}
{
  // watching: what moved, against the snapshot
  const snap = { a: { l: [1, 1] , r: [1, 1] }, d: { d: 1 }, 'd/x': { l: [1, 1], r: [1, 1] }, 'd/y': { l: [1, 1], r: [1, 1] }, e: { d: 1 }, 'e/z': { l: [1, 1], r: [1, 1] } }
  const items = sync.changes(['a', 'd', 'e', 'n.txt'], M({ a: f(2, 5), d: D, 'd/x': f(1, 1), 'n.txt': f(1, 9) }), snap, { deleteRemote: true })
  assert.deepStrictEqual(items.map(i => [i.rel, i.kind, i.dir]), [['a', 'modify', false], ['d/y', 'delete', false], ['e', 'delete', true], ['n.txt', 'add', false]])
  assert(sync.tooManyDeletes(51, {})); assert(sync.tooManyDeletes(11, Object.fromEntries([...Array(20)].map((_, i) => [i, { l: [1, 1] }])))); assert(!sync.tooManyDeletes(3, snap))
}

// ---- a whole run ----
;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sync-'))
  try {
    const here = path.join(root, 'here'), server = path.join(root, 'server')
    fs.mkdirSync(path.join(here, 'src', 'deep'), { recursive: true }); fs.mkdirSync(path.join(here, '.git')); fs.mkdirSync(server)
    fs.writeFileSync(path.join(here, 'index.html'), '<h1>hi</h1>'); fs.writeFileSync(path.join(here, 'src', 'deep', 'app.js'), 'go()'); fs.writeFileSync(path.join(here, '.git', 'HEAD'), 'ref')
    fs.writeFileSync(path.join(server, 'stray.txt'), 'was there')

    const session = sftpOver(local({ root: server }))
    const transfers = new Transfers(() => {}, null, (job, resuming) => engine.runJob(job, resuming))
    const engine = require('../src/transfer-files')(transfers, ref => ref.disk ? null : session)
    const { diskSide, sftpSide } = require('../src/transfer-files')
    const notes = [], watchers = []
    const manager = new SyncManager({
      file: path.join(root, 'pairs.json'), dir: path.join(root, 'snaps'), transfers,
      side: ref => ref.disk ? diskSide : sftpSide(session), notify: (text, err) => notes.push([text, !!err]), t: (k, v) => k + (v ? JSON.stringify(v) : ''),
      watch: (dir, onChange) => { const w = { dir, onChange, closed: false, close() { this.closed = true } }; watchers.push(w); return w },
    })
    assert.throws(() => manager.save({ serverId: 's', local: 'relative/path', remote: '/' }), /sync.err_local/)
    const pair = manager.save({ serverId: 's', local: here, remote: '/site/', deleteRemote: true })
    assert.strictEqual(pair.remote, '/site'); assert.strictEqual(pair.state, 'idle')

    // first comparison: the server folder does not exist yet
    let c = await manager.compare(pair.id)
    assert.strictEqual(c.remoteMissing, true)
    assert.deepStrictEqual(c.items.map(i => i.rel), ['index.html', 'src', 'src/deep', 'src/deep/app.js'], '.git is excluded')
    // the user picks only the deep file: its folders (and the pair's root) come with it
    let r = await manager.apply(c.token, ['src/deep/app.js'])
    assert.deepStrictEqual(r, { ok: true, sent: 1, deleted: 0 })
    assert.strictEqual(fs.readFileSync(path.join(server, 'site', 'src', 'deep', 'app.js'), 'utf8'), 'go()')
    assert(!fs.existsSync(path.join(server, 'site', 'index.html')))

    c = await manager.compare(pair.id)
    assert.deepStrictEqual(c.items.map(i => [i.rel, i.kind]), [['index.html', 'add']], 'synced files are now the same')
    r = await manager.apply(c.token, c.items.map(i => i.rel), { watch: true })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(manager.list()[0].watch, true); assert.strictEqual(manager.list()[0].state, 'watching')
    assert.strictEqual(watchers.length, 1)
    assert.deepStrictEqual((await manager.compare(pair.id)).items, [])

    // watching: a change, a new file in a new folder, an excluded file, a deletion
    const w = watchers[0]
    const flushed = () => manager.settled(pair.id)
    fs.writeFileSync(path.join(here, 'index.html'), '<h1>hello</h1>')
    fs.mkdirSync(path.join(here, 'img')); fs.writeFileSync(path.join(here, 'img', 'logo.svg'), '<svg/>')
    fs.writeFileSync(path.join(here, '.git', 'index'), 'x')
    for (const name of ['index.html', 'img', path.join('img', 'logo.svg'), path.join('.git', 'index')]) w.onChange(name)
    await flushed()
    assert.strictEqual(fs.readFileSync(path.join(server, 'site', 'index.html'), 'utf8'), '<h1>hello</h1>')
    assert.strictEqual(fs.readFileSync(path.join(server, 'site', 'img', 'logo.svg'), 'utf8'), '<svg/>')
    assert(!fs.existsSync(path.join(server, 'site', '.git')))
    fs.rmSync(path.join(here, 'src'), { recursive: true }); w.onChange('src')
    await flushed()
    assert(!fs.existsSync(path.join(server, 'site', 'src')), 'a folder deleted here is deleted on the server')
    assert.deepStrictEqual((await manager.compare(pair.id)).items, [])

    // restart: changes made while the app was closed are sent, deletions wait for the user
    manager.stop(pair.id)
    assert(w.closed); assert.strictEqual(manager.list()[0].watch, true)
    fs.writeFileSync(path.join(here, 'new.txt'), 'n'); fs.rmSync(path.join(here, 'img'), { recursive: true })
    manager.serverOpened('s')
    await flushed()
    assert(fs.existsSync(path.join(server, 'site', 'new.txt')))
    assert(fs.existsSync(path.join(server, 'site', 'img', 'logo.svg')), 'deletion held for review')
    assert.strictEqual(manager.list()[0].pendingDeletes, 1)
    c = await manager.compare(pair.id)
    assert.deepStrictEqual(c.items.map(i => [i.rel, i.kind, i.checked]), [['img', 'delete', true]])
    await manager.apply(c.token, ['img'])
    assert(!fs.existsSync(path.join(server, 'site', 'img'))); assert.strictEqual(manager.list()[0].pendingDeletes, 0)

    // a file only on the server that was never synced is not deleted unless picked
    c = await manager.compare(pair.id)
    assert.deepStrictEqual(c.items, [])
    fs.writeFileSync(path.join(server, 'site', 'theirs.txt'), 't')
    c = await manager.compare(pair.id)
    assert.deepStrictEqual(c.items.map(i => [i.rel, i.checked, i.reason]), [['theirs.txt', false, 'only_remote']])

    // pairs survive a restart; removing one forgets its snapshot
    const again = new SyncManager({ file: path.join(root, 'pairs.json'), dir: path.join(root, 'snaps'), transfers, side: () => diskSide })
    assert.strictEqual(again.list().length, 1); assert.strictEqual(again.list()[0].state, 'stopped')
    manager.close()
    again.remove(pair.id)
    assert.strictEqual(again.list().length, 0); assert(!fs.existsSync(again.snapFile(pair.id)))
    assert(notes.filter(([, err]) => err).every(([text]) => /pending_deletes/.test(text)), JSON.stringify(notes))
    console.log('ok')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})().catch(e => { console.error(e); process.exit(1) })
