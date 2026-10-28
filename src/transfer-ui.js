const transferItems = new Map()
const transferWidgets = new Set()
function transferText(x) {
  if (x.state !== 'running') return t('transfer.' + x.state)
  if (!x.scanned) return t('transfer.preparing')
  const left = x.remaining == null ? '…' : x.remaining < 60 ? Math.ceil(x.remaining) + ' s' : Math.ceil(x.remaining / 60) + ' min'
  return `${sizeOf(x.done)} / ${sizeOf(x.total)} · ${sizeOf(x.speed)}/s · ${t('transfer.remaining', { time: left })}`
}
function buildTransfers(ex) {
  const summary = h('button', { className: 'transfer-summary', ariaExpanded: 'false' })
  const popover = h('div', { className: 'transfer-popover', role: 'region', ariaLabel: t('transfer.title') })
  const widget = h('div', { className: 'transfer-widget', hidden: true }, summary, popover)
  const toggle = value => { widget.classList.toggle('expanded', value); summary.ariaExpanded = String(value) }
  summary.onclick = () => toggle(!widget.classList.contains('expanded'))
  widget.onmouseenter = () => toggle(true)
  widget.onmouseleave = () => { if (!widget.contains(document.activeElement)) toggle(false) }
  widget.onfocusin = () => toggle(true)
  widget.onfocusout = e => { if (!widget.contains(e.relatedTarget)) toggle(false) }
  widget.onkeydown = e => { if (e.key === 'Escape') { summary.focus(); toggle(false) } }
  const paint = () => {
    if (!ex.explorer?.isConnected) return
    const items = [...transferItems.values()].filter(x => x.connId === ex.connId || (!x.connId && x.serverIds?.includes(ex.server?.id)))
    widget.hidden = !items.length
    if (!items.length) return
    const running = items.filter(x => x.state === 'running')
    const latest = running.at(-1) || items.at(-1)
    const percent = x => x.total > 0 ? Math.min(100, x.done / x.total * 100) : x.state === 'done' ? 100 : 0
    const progress = x => h('progress', { max: 100, value: percent(x), ariaLabel: x.name + ' ' + Math.round(percent(x)) + '%' })
    summary.replaceChildren(h('span', { innerHTML: icon(latest.direction === 'upload' || latest.direction === 'copy' ? 'upload' : 'download') }), h('span', { className: 'transfer-name', textContent: latest.name }), h('span', { textContent: latest.state === 'running' ? `${Math.round(percent(latest))}%${running.length > 1 ? ' · ' + running.length : ''}` : t('transfer.' + latest.state) }), progress(latest))
    summary.title = transferText(latest)
    const focused = popover.contains(document.activeElement) ? document.activeElement.dataset.transferId || 'clear' : null
    const clear = h('button', { className: 'chip', textContent: t('transfer.clear'), onclick: () => { for (const x of items) if (x.state !== 'running') transferItems.delete(x.id); paintTransfers() } })
    popover.replaceChildren(h('div', { className: 'transfer-heading' }, h('b', { textContent: t('transfer.title') }), clear), h('small', { className: 'dim', textContent: t('transfer.partial') }))
    for (const x of items.slice().reverse()) {
      const row = h('div', { className: 'transfer-row' }, h('div', { className: 'transfer-heading' }, h('span', { innerHTML: icon(x.direction === 'upload' || x.direction === 'copy' ? 'upload' : 'download') }), h('b', { className: 'transfer-name', textContent: x.name, title: x.name }), h('span', { textContent: t('transfer.' + x.direction) })))
      if (x.resumable) row.firstChild.append(h('button', { className: 'chip', textContent: t('transfer.resume'), onclick: () => api.invoke('transfers:resume', x.id).catch(e => toast(errText(e), true)) }))
      if (x.state === 'running') row.firstChild.append(h('button', { className: 'ib', innerHTML: icon('x'), title: t('btn.cancel'), ariaLabel: t('btn.cancel'), onclick: () => api.invoke('transfers:cancel', x.id).catch(e => toast(errText(e), true)) }))
      if (x.state === 'running') row.querySelector('button').dataset.transferId = x.id
      row.append(progress(x), h('small', { className: x.state === 'error' ? 'err' : 'dim', textContent: x.state === 'error' ? x.error : transferText(x) }))
      popover.append(row)
    }
    if (focused) { const target = [...popover.querySelectorAll('button')].find(b => b.dataset.transferId === focused) || clear; target.focus({ preventScroll: true }) }
  }
  transferWidgets.add({ widget, paint })
  return widget
}
function paintTransfers() { for (const item of transferWidgets) { if (item.widget.isConnected) item.paint(); else transferWidgets.delete(item) } }
api.on('transfer:update', x => { transferItems.set(x.id, x); const finished = [...transferItems.values()].filter(v => v.state !== 'running'); for (const old of finished.slice(0, -30)) transferItems.delete(old.id); paintTransfers() })
api.invoke('transfers:list').then(items => { for (const x of items) if (!transferItems.has(x.id)) transferItems.set(x.id, x); paintTransfers() }).catch(() => {})
