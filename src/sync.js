// Folder synchronization, local -> server: scan both sides, compare them, build the transfer plan.
// Pure (no Electron): sync-manager.js runs it, the transfer queue (transfers.js + transfer-files.js) copies.
//
// Paths inside a pair are relative ("a/b.txt", always with "/"); the local root is an OS path, the remote one POSIX.
// A side is diskSide / sftpSide from transfer-files.js (entries, info, ...).
//
// The snapshot is the state of the last synchronization, per relative path:
//   { d: 1 } a folder present on both sides, { l: [size, mtime], r: [size, mtime] } a file as it was on each side.
// It tells a file deleted here from a file added on the server, and a file changed here from one changed there:
// a file only on the server is deleted only when it was synchronized before.
const path = require('path')
const posix = path.posix

const DEFAULT_EXCLUDES = '.git, node_modules, .DS_Store, Thumbs.db, desktop.ini, *.swp, *~, *.tmp'
const SLACK = 2000 // ms: SFTP dates have one-second precision, FAT two

// "*.swp, node_modules, build/*.map" -> rel => excluded?
// A pattern without "/" applies to every name in the path (so a folder excludes what it holds),
// one with "/" to the path from the root of the pair. * and ? stop at "/", ** does not.
function excluder(text) {
  const toRe = p => new RegExp('^' + p.split(/(\*\*|\*|\?)/).map(s => s === '**' ? '.*' : s === '*' ? '[^/]*' : s === '?' ? '[^/]' : s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$', process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '')
  const patterns = String(text || '').split(/[,\n]/).map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean)
  const names = patterns.filter(p => !p.includes('/')).map(toRe), paths = patterns.filter(p => p.includes('/')).map(toRe)
  return rel => {
    const parts = rel.split('/')
    if (parts.some(n => names.some(re => re.test(n)))) return true
    return parts.some((_, i) => paths.some(re => re.test(parts.slice(0, i + 1).join('/'))))
  }
}

const relJoin = (a, b) => a ? a + '/' + b : b
const localPath = (root, rel) => rel ? path.join(root, ...rel.split('/')) : root
const remotePath = (root, rel) => rel ? posix.join(root, rel) : root

// Everything under root (or under root/rel): Map rel -> { dir, size, mtime }. Links to folders are not followed
// (nothing outside the pair is touched), links on the server are left alone. A missing root gives an empty map.
async function scan(side, root, exclude = () => false, { rel = '', check = () => {} } = {}) {
  const out = new Map()
  const start = await side.info(join(side, root, rel))
  if (!start) return out
  if (!start.isDirectory) { if (rel) out.set(rel, { dir: false, size: start.size, mtime: start.mtime }); return out }
  if (rel) out.set(rel, { dir: true, size: 0, mtime: 0 })
  const walk = async r => {
    check()
    for (const e of await side.entries(join(side, root, r))) {
      const child = relJoin(r, e.name)
      if (exclude(child) || e.isLink) continue
      out.set(child, e.isDirectory ? { dir: true, size: 0, mtime: 0 } : { dir: false, size: e.size, mtime: e.mtime })
      if (e.isDirectory) await walk(child)
    }
  }
  await walk(rel)
  return out
}
// a side joins its own way (OS paths on the disk, POSIX on a server)
const join = (side, root, rel) => rel ? side.join(root, ...rel.split('/')) : root

const sameAs = (x, pair, slack) => !!x && !!pair && x.size === pair[0] && Math.abs((x.mtime || 0) - (pair[1] || 0)) <= slack
const fileState = x => [x.size, x.mtime]

// local, remote: maps from scan(); snapshot: from the last sync ({} the first time).
// -> { items, same } where items are the differences (sorted by path), each
//    { rel, kind: add | modify | delete | conflict, dir, local?, remote?, checked, reason? }
// and same the paths already in sync (files and folders), for the next snapshot.
// checked: what the preview selects by default (and what watching applies on its own).
function diff(local, remote, snapshot = {}, { deleteRemote = false } = {}) {
  const items = [], same = []
  const rels = [...new Set([...local.keys(), ...remote.keys()])].sort()
  let gone = null // a folder deleted as a whole: what it holds is not listed
  for (const rel of rels) {
    if (gone && rel.startsWith(gone + '/')) continue
    const L = local.get(rel), R = remote.get(rel), S = snapshot[rel]
    const info = x => x && (x.dir ? { dir: true } : { size: x.size, mtime: x.mtime })
    if (L && !R) { items.push({ rel, kind: 'add', dir: L.dir, local: info(L), checked: true }); continue }
    if (!L && R) {
      if (R.dir) gone = rel
      items.push({ rel, kind: 'delete', dir: R.dir, remote: info(R), checked: deleteRemote && !!S, reason: S ? undefined : 'only_remote' })
      continue
    }
    if (L.dir !== R.dir) { if (R.dir) gone = rel; items.push({ rel, kind: 'conflict', dir: L.dir, local: info(L), remote: info(R), checked: false, reason: 'type_differs' }); continue }
    if (L.dir) { same.push(rel); continue }
    if ((S?.l && sameAs(L, S.l, 1) && sameAs(R, S.r, SLACK)) || (L.size === R.size && Math.abs(L.mtime - R.mtime) <= SLACK)) { same.push(rel); continue }
    const localChanged = !S?.l || !sameAs(L, S.l, 1)
    const remoteChanged = S?.r ? !sameAs(R, S.r, SLACK) : R.mtime > L.mtime + SLACK
    if (remoteChanged) items.push({ rel, kind: 'conflict', dir: false, local: info(L), remote: info(R), checked: false, reason: S?.r ? 'remote_changed' : 'remote_newer', localChanged })
    else items.push({ rel, kind: 'modify', dir: false, local: info(L), remote: info(R), checked: true })
  }
  return { items, same }
}

// Selected differences -> plan for the transfer queue (transfer-files.js): deletions first (deepest first),
// then folders (outermost first), then files. A conflict between a file and a folder replaces what is on the server.
function plan(items, localRoot, remoteRoot) {
  const deletes = [], dirs = [], files = []
  const del = (it, dir) => deletes.push({ op: 'delete', rel: it.rel, target: remotePath(remoteRoot, it.rel), directory: dir, size: 0 })
  for (const it of items) {
    if (it.kind === 'delete') { del(it, it.dir); continue }
    if (it.kind === 'conflict' && it.remote && it.local && !!it.remote.dir !== !!it.local.dir) del(it, !!it.remote.dir)
    const source = localPath(localRoot, it.rel), target = remotePath(remoteRoot, it.rel)
    if (it.dir) dirs.push({ rel: it.rel, source, target, directory: true })
    else files.push({ rel: it.rel, source, target, size: it.local.size, mtime: it.local.mtime, sync: true })
  }
  const depth = x => x.rel ? x.rel.split('/').length : 0 // '' is the pair's own folder
  deletes.sort((a, b) => depth(b) - depth(a))
  dirs.sort((a, b) => depth(a) - depth(b))
  return [...deletes, ...dirs, ...files]
}

// Folders the plan needs on the server for these relative paths (a file changed in a new folder)
function parents(rels, snapshot, local) {
  const need = new Set()
  for (const rel of rels) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      if (!snapshot[p]?.d && local.get(p)?.dir) need.add(p)
    }
  }
  return [...need]
}

// The snapshot after a run. done: plan items that completed; same: from diff (in sync without copying anything).
function nextSnapshot(previous, { local, remote, same = [] }, done) {
  const next = { ...previous }
  for (const rel of same) {
    const L = local?.get(rel), R = remote?.get(rel)
    if (!L || !R) continue
    next[rel] = L.dir ? { d: 1 } : { l: fileState(L), r: fileState(R) }
  }
  for (const item of done) {
    if (item.op === 'delete') { for (const k of Object.keys(next)) if (k === item.rel || k.startsWith(item.rel + '/')) delete next[k]; continue }
    if (item.directory) { if (item.rel) next[item.rel] = { d: 1 }; continue }
    if (item.after) next[item.rel] = { l: [item.size, item.mtime], r: [item.after.size, item.after.mtime] }
  }
  return next
}

// Watching: what changed under the local paths that moved (fs.watch), against the snapshot alone (the server is not
// listed again). local: a scan of those paths. -> items as diff() gives them.
function changes(dirty, local, snapshot, { deleteRemote = false } = {}) {
  const items = [], seen = new Set()
  const under = rel => Object.keys(snapshot).filter(k => k === rel || k.startsWith(rel + '/'))
  for (const rel of dirty) {
    if (!local.has(rel)) { // gone here
      if (snapshot[rel] && !seen.has(rel)) { seen.add(rel); items.push({ rel, kind: 'delete', dir: !!snapshot[rel].d || under(rel).length > 1, checked: deleteRemote }) }
      continue
    }
    for (const [r, L] of local) {
      if (!(r === rel || r.startsWith(rel + '/')) || seen.has(r)) continue
      seen.add(r)
      const S = snapshot[r]
      if (L.dir) { if (!S?.d) items.push({ rel: r, kind: 'add', dir: true, local: { dir: true }, checked: true }); continue }
      if (!S?.l || !sameAs(L, S.l, 1)) items.push({ rel: r, kind: S ? 'modify' : 'add', dir: false, local: { size: L.size, mtime: L.mtime }, checked: true })
    }
    // what the folder held and no longer does
    if (local.get(rel)?.dir) for (const k of under(rel)) if (!local.has(k) && !seen.has(k) && !items.some(i => i.kind === 'delete' && k.startsWith(i.rel + '/'))) {
      seen.add(k); items.push({ rel: k, kind: 'delete', dir: !!snapshot[k].d, checked: deleteRemote })
    }
  }
  // a folder's deletion covers what it holds
  const dirs = items.filter(i => i.kind === 'delete' && i.dir).map(i => i.rel)
  return items.filter(i => !(i.kind === 'delete' && dirs.some(d => i.rel.startsWith(d + '/')))).sort((a, b) => a.rel < b.rel ? -1 : 1)
}

// Watching applies deletions on its own only when they are few: an emptied or unmounted folder must not empty the server.
function tooManyDeletes(count, snapshot) {
  const files = Object.values(snapshot).filter(x => x.l).length
  return count > 50 || (files >= 20 && count > files / 2)
}

module.exports = { DEFAULT_EXCLUDES, excluder, scan, diff, plan, parents, nextSnapshot, changes, tooManyDeletes, localPath, remotePath }
