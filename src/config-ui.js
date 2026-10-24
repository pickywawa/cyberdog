// Configuration export selection and unified import. Native file dialogs remain in main.
async function exportConfiguration() {
  try {
    const data = await api.invoke('config:catalog')
    const kinds = ['groups', 'servers', 'actions', 'paths']
    const selected = Object.fromEntries(kinds.map(k => [k, new Set(data[k].map(x => x.id))]))
    const m = $('#modal')
    const close = () => { m.hidden = true; m.replaceChildren() }
    const total = h('small', { className: 'dim', role: 'status' })
    const submit = h('button', { type: 'submit', className: 'primary', textContent: t('config.export') })
    const syncTotal = () => { const n = kinds.reduce((n, k) => n + selected[k].size, 0); total.textContent = t('config.selected', { n }); submit.disabled = n === 0 }
    const sections = kinds.filter(k => k !== 'groups' || data.groups.length).map(k => {
      const items = data[k], children = []
      const all = h('input', { type: 'checkbox', checked: !!items.length, disabled: !items.length, ariaLabel: t('config.all') + ' — ' + t('config.' + k) })
      const count = h('small', { className: 'dim' })
      const sync = () => { all.checked = !!items.length && selected[k].size === items.length; all.indeterminate = selected[k].size > 0 && selected[k].size < items.length; count.textContent = `${selected[k].size} / ${items.length}`; syncTotal() }
      const groupCheck = h('label', { className: 'check', onclick: e => e.stopPropagation() }, all, h('b', { textContent: t('config.' + k) }))
      const section = h('details', { className: 'config-section' }, h('summary', {}, groupCheck, count))
      section.dataset.kind = k
      for (const item of items) {
        const box = h('input', { type: 'checkbox', checked: true, onchange: () => { if (box.checked) selected[k].add(item.id); else selected[k].delete(item.id); sync() } })
        const sub = k === 'servers' ? `${item.user}@${item.host}:${item.port}` : k === 'paths' ? `${item.path} · ${item.serverId ? data.servers.find(s => s.id === item.serverId)?.name || t('config.missing_server') : t('config.global')}` : k === 'actions' ? item.script.split('\n')[0].slice(0, 100) : ''
        children.push(box)
        section.append(h('label', { className: 'check config-item' }, box, h('span', {}, h('span', { textContent: item.name || item.path }), sub ? h('small', { className: 'dim', textContent: sub }) : '')))
      }
      if (!items.length) section.append(h('p', { className: 'dim', textContent: t('config.none') }))
      all.onchange = () => { for (const [i, item] of items.entries()) { children[i].checked = all.checked; if (all.checked) selected[k].add(item.id); else selected[k].delete(item.id) } sync() }
      sync()
      return section
    })
    const form = h('form', {
      className: 'card config-card', role: 'dialog', ariaModal: 'true', ariaLabel: t('config.title'),
      onkeydown: e => { if (e.key === 'Escape') close() },
      onsubmit: async e => {
        e.preventDefault()
        submit.disabled = true
        try {
          const r = await api.invoke('config:export', Object.fromEntries(kinds.map(k => [k, [...selected[k]]])))
          if (r) { close(); toast(t('config.exported', { n: r.count, path: r.path }), false, 6000) }
        } catch (e) { toast(errText(e), true) }
        finally { syncTotal() }
      },
    }, h('h3', { textContent: t('config.title') }), h('p', { className: 'note', textContent: t('config.note') }), h('div', { className: 'config-sections' }, ...sections), total,
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: close }), submit))
    m.onmousedown = e => { if (e.target === m) close() }
    m.replaceChildren(form); m.hidden = false
    syncTotal(); form.querySelector('input,button')?.focus()
  } catch (e) { toast(errText(e), true) }
}
async function importConfiguration(source) {
  try {
    const r = source ? await api.invoke('config:import-client', source) : await api.invoke('config:import')
    if (!r) return
    servers = r.servers; groups = r.groups; quickActions = r.actions; savedPaths = r.paths
    renderServers(); repaintPaths(); repaintActions()
    toast(t('config.imported', { ...r.added, skipped: r.skipped }), false, 8000)
  } catch (e) { toast(errText(e), true) }
}
