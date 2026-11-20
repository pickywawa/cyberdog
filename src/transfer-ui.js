// Transfer queue in the status bar of each explorer: what is running, waiting, failed and done for this server.
// Queue: pause / resume, priority, move up / down; Failed: retry; Done: clear. Rows are updated in place so that a
// focused control (priority list, button) survives the progress updates.
const transferItems = new Map()
const transferWidgets = new Set()
const QUEUE_STATES = ['running', 'queued', 'paused'], FAILED_STATES = ['error', 'cancelled', 'interrupted']
const tabOf = x => QUEUE_STATES.includes(x.state) ? 'queue' : FAILED_STATES.includes(x.state) ? 'failed' : 'done'
const isUp = x => x.direction === 'upload' || x.direction === 'copy'
function transferText(x) {
  if (x.asking) return t('transfer.asking')
  if (x.state !== 'running') return t('transfer.' + x.state) + (x.skipped ? ' · ' + t('transfer.skipped', { n: x.skipped }) : '')
  if (!x.scanned) return t('transfer.preparing')
  const left = x.remaining == null ? '…' : x.remaining < 60 ? Math.ceil(x.remaining) + ' s' : Math.ceil(x.remaining / 60) + ' min'
  return `${sizeOf(x.done)} / ${sizeOf(x.total)} · ${sizeOf(x.speed)}/s · ${t('transfer.remaining', { time: left })}`
}
const percentOf = x => x.total > 0 ? Math.min(100, x.done / x.total * 100) : x.state === 'done' ? 100 : 0
const transferCall = (channel, ...args) => api.invoke(channel, ...args).catch(e => toast(errText(e), true))
const PRIORITIES = [['high', 1], ['normal', 0], ['low', -1]]

function transferRow(x) {
  const button = (name, title, onclick) => h('button', { type: 'button', className: 'ib', innerHTML: icon(name), title: t(title), ariaLabel: t(title), onclick })
  const tools = h('span', { className: 'transfer-tools' })
  if (x.asking) tools.append(h('button', { type: 'button', className: 'chip on', textContent: t('transfer.answer'), onclick: () => showConflict(x.id) }))
  if (QUEUE_STATES.includes(x.state)) {
    if (x.state !== 'running') {
      const priority = h('select', { className: 'transfer-priority', title: t('transfer.priority'), ariaLabel: t('transfer.priority'), onchange: () => transferCall('transfers:priority', x.id, priority.value) },
        ...PRIORITIES.map(([key]) => h('option', { value: key, textContent: t('transfer.priority_' + key) })))
      priority.value = PRIORITIES.find(([, n]) => n === (x.priority || 0))[0]
      tools.append(priority, button('chevron-up', 'transfer.up', () => transferCall('transfers:move', x.id, -1)), button('chevron-down', 'transfer.down', () => transferCall('transfers:move', x.id, 1)))
    }
    tools.append(x.state === 'paused' ? button('play', 'transfer.start', () => transferCall('transfers:resume', x.id)) : button('pause', 'transfer.pause', () => transferCall('transfers:pause', x.id)))
    tools.append(button('x', 'btn.cancel', () => transferCall('transfers:cancel', x.id)))
  } else {
    if (x.resumable) tools.append(button('refresh', x.state === 'error' ? 'transfer.retry' : 'transfer.resume', () => transferCall('transfers:resume', x.id)))
    tools.append(button('trash', 'transfer.remove', () => { transferItems.delete(x.id); transferCall('transfers:clear', x.id); paintTransfers() }))
  }
  const progress = h('progress', { max: 100 })
  const status = h('small')
  const el = h('div', { className: 'transfer-row' },
    h('div', { className: 'transfer-heading' }, h('span', { innerHTML: icon(isUp(x) ? 'upload' : 'download') }), h('b', { className: 'transfer-name', textContent: x.name, title: x.name }), tools),
    progress, status)
  el.dataset.transferId = x.id
  const update = v => {
    progress.value = percentOf(v)
    progress.ariaLabel = v.name + ' ' + Math.round(percentOf(v)) + '%'
    status.className = v.state === 'error' ? 'err' : 'dim'
    status.textContent = v.state === 'error' ? v.error : transferText(v)
    el.querySelector('.transfer-name').textContent = v.name
  }
  update(x)
  // a row is rebuilt when its controls change, otherwise only its numbers are
  return { el, update, key: [x.state, x.asking, x.resumable, x.priority].join() }
}

function buildTransfers(ex) {
  const summary = h('button', { className: 'transfer-summary', ariaExpanded: 'false' })
  const tabsBar = h('div', { className: 'transfer-tabs', role: 'tablist' })
  const actions = h('span', { className: 'transfer-actions' })
  const list = h('div', { className: 'transfer-list' })
  const popover = h('div', { className: 'transfer-popover', role: 'region', ariaLabel: t('transfer.title') },
    h('div', { className: 'transfer-heading' }, h('b', { textContent: t('transfer.title') }), actions), tabsBar, list)
  const widget = h('div', { className: 'transfer-widget', hidden: true }, summary, popover)
  const toggle = value => { widget.classList.toggle('expanded', value); summary.ariaExpanded = String(value) }
  summary.onclick = () => toggle(!widget.classList.contains('expanded'))
  widget.onmouseenter = () => toggle(true)
  widget.onmouseleave = () => { if (!widget.contains(document.activeElement)) toggle(false) }
  widget.onfocusin = () => toggle(true)
  widget.onfocusout = e => { if (!widget.contains(e.relatedTarget)) toggle(false) }
  widget.onkeydown = e => { if (e.key === 'Escape') { summary.focus(); toggle(false) } }
  const rows = new Map() // id -> transferRow
  let current = 'queue', chosen = false // the tab the user picked stays; otherwise the first one with something in it
  const paint = () => {
    if (!ex.explorer?.isConnected) return
    const items = [...transferItems.values()].filter(x => x.connId === ex.connId || x.serverIds?.includes(ex.server?.id)).sort((a, b) => (a.order || 0) - (b.order || 0))
    widget.hidden = !items.length
    if (!items.length) return
    const running = items.filter(x => x.state === 'running')
    const asking = items.find(x => x.asking)
    const latest = asking || running.at(-1) || items.filter(x => x.state === 'queued')[0] || items.at(-1)
    const waiting = items.filter(x => x.state === 'queued').length
    summary.replaceChildren(h('span', { innerHTML: icon(isUp(latest) ? 'upload' : 'download') }), h('span', { className: 'transfer-name', textContent: latest.name }),
      h('span', { textContent: asking ? '?' : latest.state === 'running' ? `${Math.round(percentOf(latest))}%${running.length + waiting > 1 ? ` · ${running.length + waiting}` : ''}` : t('transfer.' + latest.state) }),
      h('progress', { max: 100, value: percentOf(latest), ariaLabel: latest.name + ' ' + Math.round(percentOf(latest)) + '%' }))
    summary.classList.toggle('asking', !!asking)
    summary.title = transferText(latest)

    const groups = { queue: [], failed: [], done: [] }
    for (const x of items) groups[tabOf(x)].push(x)
    if (!chosen && !groups[current].length) current = ['queue', 'failed', 'done'].find(k => groups[k].length)
    const tabButton = key => {
      const b = h('button', { type: 'button', role: 'tab', className: 'chip' + (key === current ? ' on' : ''), ariaSelected: String(key === current), textContent: `${t('transfer.tab_' + key)} ${groups[key].length}`, onclick: () => { current = key; chosen = true; paint() } })
      b.dataset.tab = key
      return b
    }
    const tabsKey = ['queue', 'failed', 'done'].map(k => k + groups[k].length).join() + current
    if (tabsBar.dataset.key !== tabsKey) { tabsBar.dataset.key = tabsKey; tabsBar.replaceChildren(...['queue', 'failed', 'done'].map(tabButton)) }
    const actionsKey = current + (groups.queue.some(x => x.state === 'paused') ? 'p' : '') + (groups.queue.some(x => x.state !== 'paused') ? 'r' : '') + groups[current].length
    if (actions.dataset.key !== actionsKey) {
      actions.dataset.key = actionsKey
      const chip = (key, fn) => h('button', { type: 'button', className: 'chip', textContent: t(key), onclick: fn })
      actions.replaceChildren(...(current === 'queue'
        ? [...(groups.queue.some(x => x.state === 'paused') ? [chip('transfer.start_all', () => transferCall('transfers:start-all'))] : []),
           ...(groups.queue.some(x => x.state !== 'paused') ? [chip('transfer.pause_all', () => { for (const x of groups.queue) if (x.state !== 'paused') transferCall('transfers:pause', x.id) })] : [])]
        : current === 'failed'
          ? [...(groups.failed.some(x => x.resumable) ? [chip('transfer.retry_all', () => transferCall('transfers:retry-failed'))] : []), chip('transfer.clear', () => clear(groups.failed))]
          : [chip('transfer.clear', () => clear(groups.done))]))
    }

    const shown = groups[current]
    for (const [id, row] of rows) if (!shown.some(x => x.id === id)) { row.el.remove(); rows.delete(id) }
    shown.forEach((x, i) => {
      let row = rows.get(x.id)
      const key = [x.state, x.asking, x.resumable, x.priority].join()
      if (row && row.key !== key) {
        const focused = row.el.contains(document.activeElement)
        const next = transferRow(x)
        row.el.replaceWith(next.el)
        rows.set(x.id, (row = next))
        if (focused) next.el.querySelector('button, select')?.focus({ preventScroll: true })
      } else if (!row) rows.set(x.id, (row = transferRow(x)))
      else row.update(x)
      if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] || null)
    })
    if (!shown.length) list.replaceChildren(h('small', { className: 'dim transfer-empty', textContent: t('transfer.none') }))
    else list.querySelector('.transfer-empty')?.remove()
  }
  const clear = items => {
    for (const x of items) { transferItems.delete(x.id); transferCall('transfers:clear', x.id) }
    paintTransfers()
  }
  transferWidgets.add({ widget, paint })
  return widget
}
function paintTransfers() { for (const item of transferWidgets) { if (item.widget.isConnected) item.paint(); else transferWidgets.delete(item) } }
api.on('transfer:update', x => {
  transferItems.set(x.id, x)
  if (!x.asking) dropConflict(x.id)
  const finished = [...transferItems.values()].filter(v => !QUEUE_STATES.includes(v.state))
  for (const old of finished.slice(0, -50)) transferItems.delete(old.id)
  paintTransfers()
})
api.invoke('transfers:list').then(items => { for (const x of items) if (!transferItems.has(x.id)) transferItems.set(x.id, x); paintTransfers() }).catch(() => {})

// ---------- A file already exists at the target ----------
// Questions come from the transfer queue, one at a time (several transfers can run at once).
const conflicts = []
let conflictShown = null
const CONFLICT_CHOICES = ['overwrite', 'newer', 'size', 'resume', 'rename', 'skip']
api.on('transfer:conflict', q => { conflicts.push(q); nextConflict() })
function dropConflict(jobId) {
  for (let i = conflicts.length - 1; i >= 0; i--) if (conflicts[i].job === jobId) conflicts.splice(i, 1)
  if (conflictShown?.job === jobId) { conflictShown.close(); conflictShown = null; nextConflict() }
}
function showConflict(jobId) { const q = conflicts.find(x => x.job === jobId); if (q && conflictShown?.job !== jobId) { conflictShown?.close(); conflictShown = null; conflicts.splice(conflicts.indexOf(q), 1); conflicts.unshift(q); nextConflict() } }
function nextConflict() {
  if (conflictShown || !conflicts.length) return
  const q = conflicts.shift()
  let last = 'overwrite'
  try { last = localStorage.getItem('cyberdog.conflict') || last } catch {}
  const usable = c => c !== 'resume' || (q.canResume && q.target.size < q.source.size)
  if (!usable(last) || !CONFLICT_CHOICES.includes(last)) last = 'overwrite'
  const when = ms => ms ? new Date(ms).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'medium' }) : '—'
  const side = (key, info, newer) => h('div', { className: 'conflict-side' }, h('b', { textContent: t(key) }),
    h('span', { textContent: `${sizeOf(info.size || 0)}${info.size >= 1024 ? ` (${(info.size || 0).toLocaleString(lang)} ${t('info.bytes')})` : ''}` }),
    h('span', { className: newer ? 'conflict-newer' : 'dim', textContent: when(info.mtime) }))
  const radios = CONFLICT_CHOICES.map(choice => {
    const input = h('input', { type: 'radio', name: 'conflict-choice', value: choice, checked: choice === last, disabled: !usable(choice) })
    return h('label', { className: 'check' + (usable(choice) ? '' : ' disabled') }, input, h('span', { textContent: t('conflict.' + choice) }))
  })
  const all = h('input', { type: 'checkbox' })
  const overlay = h('div', { className: 'conflict-overlay' })
  const answer = action => {
    if (action !== 'cancel') try { localStorage.setItem('cyberdog.conflict', action) } catch {}
    api.invoke('transfer:conflict-answer', q.id, { action, all: all.checked }).catch(() => {})
    close()
    conflictShown = null
    nextConflict()
  }
  const chosen = () => card.querySelector('input[name=conflict-choice]:checked')?.value || 'skip'
  const card = h('form', { className: 'card conflict-card', role: 'alertdialog', ariaModal: 'true', ariaLabel: t('conflict.title'),
    onsubmit: e => { e.preventDefault(); answer(chosen()) },
    onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); answer('cancel') } } },
    h('h3', { textContent: t(q.directory ? 'conflict.title_dir' : 'conflict.title') }),
    h('div', { className: 'conflict-file' }, h('b', { textContent: q.name }), h('small', { className: 'dim mono', textContent: q.path })),
    h('div', { className: 'conflict-sides' }, side('conflict.source', q.source, q.source.mtime > q.target.mtime), side('conflict.target', q.target, q.target.mtime > q.source.mtime)),
    h('div', { className: 'conflict-choices' }, ...radios),
    h('label', { className: 'check' }, all, h('span', { textContent: t('conflict.all') })),
    h('div', { className: 'btns' },
      h('button', { type: 'button', className: 'danger-btn', textContent: t('conflict.cancel'), onclick: () => answer('cancel') }),
      h('button', { type: 'submit', className: 'primary', textContent: 'OK' })))
  overlay.append(card)
  document.body.append(overlay)
  const close = () => overlay.remove()
  conflictShown = { job: q.job, close }
  card.querySelector('button.primary').focus()
}
