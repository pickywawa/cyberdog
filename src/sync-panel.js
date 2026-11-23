// Synchronized folders, in the window: the "Synchronize with a local folder…" dialog, the comparison preview
// (added / modified / deleted / conflicts, each one can be unticked), the "Sync" panel of a server tab, the badge on
// the path bar of a synchronized folder, and comparing the two panes of a tab (local pane next to the server).
// The work is done by main (sync-manager.js); this file only asks and shows.
let syncPairs = []
const SYNC_KINDS = ['add', 'modify', 'delete', 'conflict']
const SYNC_ROWS = 800 // rows drawn per group; the others follow the group's checkbox
// long paths keep their start and, above all, their end (the folder's name): /Users/me/…/projects/site
const shortPath = (p, max = 52) => p.length <= max ? p : p.slice(0, Math.floor(max * 0.3)) + '…' + p.slice(-Math.ceil(max * 0.7))
const syncBase = p => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const pairsOf = server => syncPairs.filter(p => p.serverId === server?.id)
// the pair a remote folder belongs to (the innermost one)
const syncPairAt = (server, dir) => pairsOf(server).filter(p => dir && (dir === p.remote || dir.startsWith(p.remote === '/' ? '/' : p.remote + '/'))).sort((a, b) => b.remote.length - a.remote.length)[0]

api.invoke('sync:list').then(v => { syncPairs = v; paintSyncAll() }).catch(() => {})
api.on('sync:update', v => { syncPairs = v; paintSyncAll() })
function paintSyncAll() {
  for (const tb of tabs) {
    if (tb.panel === 'sync') paintSync(tb)
    tb.panes?.forEach(paintSyncBadge)
  }
}

// ---- context menu entries (renderer.js ctxMenu) ----
// dir: the folder the entry is about; the local pane offers only the comparison with the other pane
function syncMenuItems(ex, dir, { panes: withPanes = true } = {}) {
  const other = ex.root?.panes?.find(p => p !== ex)
  const panes = withPanes && other && (ex.localPane || other.localPane) && !(ex.localPane && other.localPane) ? [{ label: t('sync.compare_panes'), icon: 'sync', fn: () => comparePanes(ex) }] : []
  if (ex.localPane || !dir) return panes
  return [{ label: t('sync.menu'), icon: 'sync', fn: () => syncForm(ex, dir) }, ...panes]
}

// ---- the pair's form ----
async function syncForm(ex, remoteDir, pair = null) {
  const server = pair ? servers.find(s => s.id === pair.serverId) || ex.server : ex.server
  const form = await modal(t(pair ? 'sync.form_edit' : 'sync.form_title'), [
    { name: 'local', label: t('sync.local'), type: 'folder', value: pair?.local || '', placeholder: t('sync.pick'), pick: current => api.invoke('sync:pick-local', current || undefined) },
    { name: 'remote', label: t('sync.remote', { server: server.name }), value: pair?.remote || remoteDir || '/' },
    { name: 'mode', label: t('sync.mode'), type: 'select', value: pair?.watch ? 'watch' : pair ? 'once' : 'watch', options: [['watch', t('sync.mode_watch')], ['once', t('sync.mode_once')]] },
    { name: 'deleteRemote', label: t('sync.delete_remote'), type: 'checkbox', value: !!pair?.deleteRemote },
    { name: 'excludes', label: t('sync.excludes'), value: pair ? pair.excludes : '.git, node_modules, .DS_Store, Thumbs.db, desktop.ini, *.swp, *~, *.tmp', placeholder: '.git, node_modules, *.log' },
  ], t('sync.compare'), { wide: true })
  if (!form) return
  if (!form.local) { toast(t('sync.err_local'), true); return syncForm(ex, form.remote, { ...pair, ...form, serverId: server.id, watch: form.mode === 'watch' }) }
  try {
    // watching starts once the first comparison has been reviewed (or stays on when it was)
    const saved = await api.invoke('sync:save', { id: pair?.id, serverId: server.id, local: form.local, remote: form.remote.trim() || '/', deleteRemote: form.deleteRemote, excludes: form.excludes, watch: form.mode === 'watch' && !!pair?.watch })
    if (form.mode === 'once' && pair?.watch) await api.invoke('sync:watch', saved.id, false)
    compareSync(saved.id, { watch: form.mode === 'watch', title: syncBase(saved.local) })
  } catch (e) { toast(errText(e), true) }
}

// ---- compare, preview, run ----
// target: a pair's id or { serverId, remote, localConn, localPath }; opts.watch: watching starts after the run
async function compareSync(target, opts = {}) {
  const m = $('#modal')
  const busy = h('div', { className: 'card sync-busy', role: 'status' }, h('span', { className: 'server-spinner' }), h('span', { textContent: t('sync.comparing') }),
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: () => { cancelled = true; m.hidden = true; m.replaceChildren() } })))
  let cancelled = false
  m.onmousedown = null
  m.replaceChildren(busy); m.hidden = false
  let result
  try { result = await api.invoke('sync:compare', target) } catch (e) { if (!cancelled) { m.hidden = true; m.replaceChildren(); toast(errText(e), true) } return }
  if (cancelled) return
  syncPreview(result, opts)
}

function syncPreview(c, { watch = false, title = '' } = {}) {
  const m = $('#modal')
  const server = servers.find(s => s.id === syncPairs.find(p => p.id === c.id)?.serverId)
  const chosen = new Set(c.items.filter(i => i.checked).map(i => i.rel))
  const close = () => { m.hidden = true; m.replaceChildren() }
  const run = h('button', { className: 'primary' })
  const paintRun = () => {
    const n = chosen.size
    run.textContent = n ? t(watch ? 'sync.run_watch' : 'sync.run', { n }) : watch ? t('sync.start_watch') : t('sync.run', { n })
    run.disabled = !n && !watch
    groups.forEach(g => g.paint())
  }
  const detail = i => {
    const parts = []
    if (i.reason) parts.push(t('sync.r.' + i.reason))
    const side = i.kind === 'delete' ? i.remote : i.local
    if (side && !side.dir) parts.push(sizeOf(side.size) + (side.mtime ? ' · ' + dateOf(side.mtime) : ''))
    if (i.kind === 'conflict' && i.remote && !i.remote.dir && i.remote.mtime) parts.push(t('sync.server_date', { date: dateOf(i.remote.mtime) }))
    return parts.join(' · ')
  }
  const groups = SYNC_KINDS.map(kind => {
    const list = c.items.filter(i => i.kind === kind)
    if (!list.length) return null
    const all = h('input', { type: 'checkbox', onchange: () => { list.forEach(i => all.checked ? chosen.add(i.rel) : chosen.delete(i.rel)); rows.forEach(r => (r.box.checked = all.checked)); paintRun() } })
    const count = h('span', { className: 'dim' })
    const rows = list.slice(0, SYNC_ROWS).map(i => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(i.rel), onchange: () => { box.checked ? chosen.add(i.rel) : chosen.delete(i.rel); paintRun() } })
      const el = h('label', { className: 'sync-row', title: i.rel }, box, h('span', { className: 'sync-ic', innerHTML: icon(i.dir ? 'folder' : 'file') }), h('span', { className: 'sync-rel', textContent: i.rel + (i.dir ? '/' : '') }), h('small', { className: 'dim', textContent: detail(i) }))
      return Object.assign(el, { box })
    })
    const more = list.length > SYNC_ROWS ? [h('div', { className: 'dim small sync-more', textContent: t('sync.more', { n: list.length - SYNC_ROWS }) })] : []
    const el = h('div', { className: 'sync-group k-' + kind },
      h('label', { className: 'check sync-ghead' }, all, h('span', { className: 'sync-dot' }), h('b', { textContent: t('sync.k.' + kind) }), count),
      h('div', { className: 'sync-rows' }, ...rows, ...more))
    return Object.assign(el, { paint: () => { const n = list.filter(i => chosen.has(i.rel)).length; all.checked = n === list.length; all.indeterminate = n > 0 && n < list.length; count.textContent = `${n} / ${list.length}` } })
  }).filter(Boolean)
  const where = (server ? server.name + ':' : '') + c.remote
  const card = h('form', { className: 'card wide sync-preview', onsubmit: e => {
    e.preventDefault()
    close()
    const sid = server?.id || syncPairs.find(p => p.id === c.id)?.serverId
    api.invoke('sync:apply', c.token, [...chosen], { watch }).then(() => {
      for (const tb of tabs) for (const p of tb.panes || []) if (p.path && (p.server?.id === sid || p.localPane) && !p.loading) load(p, p.path, false, true)
    }, e => toast(errText(e), true))
    if (chosen.size) toast(t('sync.started', { name: title || syncBase(c.local) }))
  }, onkeydown: e => { if (e.key === 'Escape') close() } },
    h('h3', { textContent: t('sync.preview_title') }),
    h('div', { className: 'sync-route' }, h('span', { className: 'mono', textContent: shortPath(c.local, 44), title: c.local }), h('span', { innerHTML: icon('chevron-right') }), h('span', { className: 'mono', textContent: shortPath(where, 44), title: where })),
    ...(c.items.length ? [h('div', { className: 'dim small', textContent: t('sync.summary', { n: c.items.length }) + (c.same ? ' · ' + t('sync.same', { n: c.same }) : '') }), h('div', { className: 'sync-groups' }, ...groups)]
      : [h('div', { className: 'msg small sync-same', textContent: t('sync.identical') })]),
    ...(c.remoteMissing ? [h('div', { className: 'dim small', textContent: t('sync.remote_missing') })] : []),
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: close }), run))
  paintRun()
  if (!c.items.length && !watch) { run.disabled = false; run.textContent = 'OK'; card.onsubmit = e => { e.preventDefault(); close() } }
  m.onmousedown = e => { if (e.target === m) close() }
  m.replaceChildren(card)
  m.hidden = false
  run.focus()
}

// the two panes of a tab: this computer's folder and the server's
function comparePanes(ex) {
  const panes = ex.root.panes, localPane = panes.find(p => p.localPane), remotePane = panes.find(p => !p.localPane)
  if (!localPane?.connId || !remotePane?.path || !localPane.path) return
  compareSync({ serverId: remotePane.server.id, remote: remotePane.path, localConn: localPane.connId, localPath: localPane.path }, { title: syncBase(localPane.path) })
}

// ---- the Sync panel of a server tab ----
function renderSync(tab) {
  tab.rpanelActions.append(hib('plus', 'sync.add', () => syncForm(tab.active || tab, tab.active?.path || '/')))
  paintSync(tab)
}
function syncStateText(p) {
  const parts = [t('sync.state.' + p.state) + (p.state === 'error' && p.error ? ' : ' + p.error : '')]
  if (p.pendingDeletes) parts.push(t('sync.pending_deletes', { n: p.pendingDeletes }))
  if (p.conflicts) parts.push(t('sync.conflicts', { n: p.conflicts }))
  if (p.lastSync) parts.push(t('sync.last', { time: dateOf(p.lastSync) }))
  return parts.join(' · ')
}
function paintSync(tab) {
  if (tab.panel !== 'sync') return
  const body = tab.rpanelBody
  const list = pairsOf(tab.server)
  body.replaceChildren(h('div', { className: 'dim small sync-intro', textContent: t('sync.intro') }))
  if (!list.length) body.append(h('div', { className: 'msg small', textContent: t('sync.none') }))
  for (const p of list) {
    const on = ['watching', 'syncing'].includes(p.state)
    const stop = e => e.stopPropagation()
    body.append(h('div', { className: 'ps-row sync-pair' + (on ? ' on' : '') + (p.state === 'error' ? ' err' : ''), title: p.remote, onclick: () => tab.active && load(tab.active, p.remote, true) },
      h('span', { className: 'ps-ic sync-pic', innerHTML: icon('sync') }),
      h('div', { className: 'svc-main' },
        h('b', { textContent: syncBase(p.local) }),
        h('small', { className: 'dim mono', textContent: shortPath(p.local, 40), title: p.local }),
        h('small', { className: 'dim mono', textContent: '→ ' + shortPath(p.remote, 38), title: p.remote }),
        h('small', { className: 'sync-state', textContent: syncStateText(p) })),
      h('span', { className: 'svc-btns' },
        hib('search', 'sync.compare', e => { stop(e); compareSync(p.id, { title: syncBase(p.local) }) }),
        p.watch && !['idle', 'stopped'].includes(p.state)
          ? hib('pause', 'sync.watch_off', e => { stop(e); api.invoke('sync:watch', p.id, false).catch(err => toast(errText(err), true)) })
          : hib('play', 'sync.watch_on', e => { stop(e); p.lastSync ? api.invoke('sync:watch', p.id, true).catch(err => toast(errText(err), true)) : compareSync(p.id, { watch: true, title: syncBase(p.local) }) }),
        hib('pencil', 'qa.edit', e => { stop(e); syncForm(tab.active || tab, p.remote, p) }),
        hib('trash', 'qa.delete', e => { stop(e); if (confirm(t('sync.confirm_delete', { local: p.local, remote: p.remote }))) api.invoke('sync:remove', p.id).catch(err => toast(errText(err), true)) }))))
  }
}

// ---- badge on the path bar of a synchronized folder ----
function paintSyncBadge(ex) {
  if (!ex?.pathBox) return
  const pair = !ex.localPane && syncPairAt(ex.server, ex.path)
  ex.syncBadge ||= h('button', { type: 'button', className: 'ib sync-badge', innerHTML: icon('sync'), onclick: e => { e.stopPropagation(); if (ex.root.panel !== 'sync') setPanel(ex.root, 'sync') } })
  ex.syncBadge.hidden = !pair
  if (!pair) return
  ex.syncBadge.classList.toggle('on', ['watching', 'syncing'].includes(pair.state))
  ex.syncBadge.classList.toggle('err', pair.state === 'error')
  ex.syncBadge.title = t('sync.badge', { local: pair.local }) + ' — ' + syncStateText(pair)
  if (ex.syncBadge.parentNode !== ex.pathBox) ex.pathBox.insertBefore(ex.syncBadge, ex.pathsBtn || null)
}
