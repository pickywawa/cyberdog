// Import from other clients: home cards, entries of the Import menu, and the summary shown before importing.
let importSources = []

async function scanImportSources() {
  try { importSources = await api.invoke('import:sources') } catch { importSources = [] }
  paintImportCards()
}

function importCardText(s) {
  if (s.error) return s.error
  if (s.locked) return t('imp.card_locked')
  if (!s.total) return t('imp.card_empty')
  return s.fresh ? t('imp.card_fresh', { n: s.fresh }) : t('imp.card_done')
}

// Home: one card per client found on this computer, between "Add" and "Import configuration".
// "Export configuration" only shows while there are fewer than 4 other cards.
function paintImportCards() {
  const cards = $('#empty .cards')
  if (!cards) return
  cards.querySelectorAll('.card-import').forEach(c => c.remove())
  const anchor = $('#card-zip')
  importSources.filter(s => s.auto).forEach((s, i) => {
    const card = h('button', { className: `card-btn card-import c${2 + (i % 3)}`, type: 'button', onclick: () => importPreview(s.id) },
      h('span', { className: 'ct', innerHTML: icon('download') }), h('b', { textContent: t('imp.card_t', { app: s.label }) }), h('small', { textContent: importCardText(s) }))
    if (s.auto && s.total && !s.fresh && !s.locked) card.classList.add('done')
    if (s.fresh || s.locked) card.classList.add('has-new') // servers waiting: highlighted until imported
    cards.insertBefore(card, anchor)
  })
  const others = [...cards.children].filter(c => c.id !== 'card-export' && !c.hidden).length
  $('#card-export').hidden = others >= 4
}

function importMenuItems() {
  const auto = importSources.filter(s => s.auto)
  const files = importSources.filter(s => s.pick)
  const unsupported = importSources.filter(s => s.unsupported && s.installed)
  return [
    ...auto.map(s => ({ label: t('imp.card_t', { app: s.label }), icon: 'download', hint: s.locked ? '🔒' : s.total ? String(s.fresh) : '', fn: () => importPreview(s.id) })),
    '-',
    { label: t('imp.menu_file'), icon: 'file', children: async () => files.map(s => ({ label: s.label + '…', icon: 'file', fn: () => importPreview(s.id, { pick: true }) })) },
    ...unsupported.map(s => ({ label: `${s.label} — ${t('imp.unsupported')}`, icon: 'info', fn: () => toast(t('imp.unsupported_' + s.unsupported), true, 8000) })),
  ]
}

// Why passwords were not recovered, in the words of the source
function importPasswordNotes(r) {
  const count = st => r.items.filter(x => x.pw === st).length
  const notes = []
  const ok = count('ok'), none = count('none'), external = count('external'), locked = count('locked'), legacy = count('legacy')
  if (ok) notes.push(['ok', t('imp.pw_ok', { n: ok })])
  if (external) notes.push(['warn', t(`imp.pw_external_${r.id}`, { n: external })])
  if (locked) notes.push(['warn', ['filezilla', 'winscp'].includes(r.id) ? t(`imp.pw_locked_${r.id}`, { n: locked }) : t('imp.pw_locked', { n: locked })])
  if (legacy) notes.push(['warn', t('imp.pw_legacy', { n: legacy })])
  if (none) notes.push(['dim', t('imp.pw_none', { n: none })])
  return notes
}

async function importPreview(id, opts = {}) {
  let r
  try { r = await api.invoke('import:preview', id, opts) } catch (e) { return toast(errText(e), true) }
  if (!r) return
  const m = $('#modal')
  const close = () => { m.hidden = true; m.replaceChildren() }
  const selected = new Set(r.items.filter(x => x.status === 'new').map(x => x.i))
  const submit = h('button', { type: 'submit', className: 'primary' })
  const sync = () => { submit.textContent = t('imp.import', { n: selected.size }); submit.disabled = !selected.size; secs.forEach(f => f()) }
  const secs = []

  // master password: whole file encrypted (r.locked) or some passwords waiting for it
  const needMaster = r.locked || (r.master && r.items.some(x => x.pw === 'master' || x.pw === 'wrong'))
  const wrong = r.locked === 'master_wrong' || r.items.some(x => x.pw === 'wrong')
  let masterBox = null
  if (needMaster) {
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: t('imp.master_label'), ariaLabel: t('imp.master_label') })
    const unlock = async () => { if (!input.value) return input.focus(); close(); importPreview(id, { token: r.token, master: input.value }) }
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); unlock() } }
    masterBox = h('div', { className: 'imp-master' },
      h('p', { className: 'note', textContent: t(r.locked ? 'imp.locked_config' : 'imp.master_hint', { app: r.label }) }),
      wrong ? h('p', { className: 'imp-err', textContent: t('imp.master_wrong') }) : '',
      h('div', { className: 'imp-master-row' }, input, h('button', { type: 'button', textContent: t('imp.unlock'), onclick: unlock })))
  }

  const row = x => {
    const box = h('input', { type: 'checkbox', checked: selected.has(x.i), onchange: () => { box.checked ? selected.add(x.i) : selected.delete(x.i); sync() } })
    const sub = [`${x.user ? x.user + '@' : ''}${x.host}${x.port && x.type !== 'ssh' && !String(x.host).includes('://') ? ':' + x.port : x.type === 'ssh' && x.port !== 22 ? ':' + x.port : ''}`, t('type.' + x.type), x.group, x.status === 'existing' && x.existingName !== x.name ? '↺ ' + x.existingName : '', x.keyDropped ? t('imp.key_dropped') : ''].filter(Boolean).join(' · ')
    const badge = x.pw === 'ok' ? h('span', { className: 'imp-pw', title: t('imp.pw_badge'), innerHTML: icon('key') }) : ''
    return { box, el: h('label', { className: 'check config-item' }, box, h('span', { className: 'imp-item' }, h('span', { textContent: x.name }), h('small', { className: 'dim', textContent: sub })), badge) }
  }
  const section = (kind, items, open) => {
    if (!items.length) return ''
    const rows = items.map(row)
    const all = h('input', { type: 'checkbox', ariaLabel: t('config.all') })
    const count = h('small', { className: 'dim' })
    all.onchange = () => { rows.forEach(({ box }, j) => { box.checked = all.checked; all.checked ? selected.add(items[j].i) : selected.delete(items[j].i) }); sync() }
    secs.push(() => { const n = items.filter(x => selected.has(x.i)).length; all.checked = n === items.length; all.indeterminate = n > 0 && n < items.length; count.textContent = `${n} / ${items.length}` })
    const det = h('details', { className: 'config-section', open }, h('summary', {}, h('label', { className: 'check', onclick: e => e.stopPropagation() }, all, h('b', { textContent: t(kind === 'new' ? 'imp.new' : 'imp.existing') })), count), ...rows.map(x => x.el))
    return det
  }
  const fresh = r.items.filter(x => x.status === 'new'), old = r.items.filter(x => x.status === 'existing')
  const notes = importPasswordNotes(r)

  const form = h('form', {
    className: 'card config-card imp-card', role: 'dialog', ariaModal: 'true', ariaLabel: t('imp.title', { app: r.label }),
    onkeydown: e => { if (e.key === 'Escape') close() },
    onsubmit: async e => {
      e.preventDefault()
      submit.disabled = true
      try {
        const res = await api.invoke('import:apply', r.token, [...selected])
        servers = res.servers; groups = res.groups
        renderServers(); close()
        const msg = t('imp.done', { added: res.added, updated: res.updated, passwords: res.passwords })
        if (res.failed.length) toast(`${msg} ${t('imp.failed', { n: res.failed.length, names: res.failed.map(f => `${f.name} (${errText(new Error(f.error))})`).join(', ') })}`, true, 10000)
        else toast(msg, false, 6000)
        scanImportSources()
      } catch (err) { toast(errText(err), true); sync() }
    },
  },
    h('h3', { textContent: t('imp.title', { app: r.label }) }),
    h('p', { className: 'note imp-file', textContent: t('imp.source', { file: r.file }) }),
    masterBox || '',
    ...notes.map(([kind, text]) => h('p', { className: `imp-note ${kind}`, textContent: text })),
    h('div', { className: 'config-sections' }, section('new', fresh, true), section('existing', old, !fresh.length), !r.items.length && !r.locked ? h('p', { className: 'dim', textContent: t('imp.none_found') }) : ''),
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: close }), submit))
  m.onmousedown = e => { if (e.target === m) close() }
  m.replaceChildren(form); m.hidden = false
  sync()
  ;(form.querySelector('.imp-master input') || submit).focus()
}

scanImportSources()
