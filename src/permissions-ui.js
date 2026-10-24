async function permissionDialog(tab, entry, remote) {
  const m = $('#modal')
  let closed = false, busy = false, ready = false
  const close = () => { if (busy) return; closed = true; m.hidden = true; m.replaceChildren() }
  const ownerLabel = h('b', { textContent: `${t('perm.current_owner')} : ${entry.owner}` })
  const owner = h('select', { className: 'lsel full', disabled: true, ariaLabel: t('perm.owner') }, h('option', { textContent: t('dash.checking') }))
  const status = h('small', { className: 'dim', role: 'status' })
  const submit = h('button', { type: 'submit', className: 'primary', disabled: true, textContent: t('btn.save') })
  const mode = h('input', { value: entry.mode.toString(8).padStart(4, '0'), maxLength: 4, inputMode: 'numeric', pattern: '[0-7]{3,4}', required: true, disabled: true, ariaLabel: t('perm.octal') })
  const checks = []
  const special = []
  const valid = () => /^[0-7]{3,4}$/.test(mode.value)
  const syncFromNumber = () => {
    const ok = valid()
    mode.setCustomValidity(ok ? '' : t('err.permissions'))
    submit.disabled = !ready || busy || !ok
    if (!ok) return
    const bits = parseInt(mode.value, 8)
    for (const [check, bit] of [...checks, ...special]) check.checked = !!(bits & bit)
  }
  const syncFromChecks = () => { mode.value = [...checks, ...special].reduce((bits, [check, bit]) => bits | (check.checked ? bit : 0), 0).toString(8).padStart(4, '0'); syncFromNumber() }
  const box = (bit, label, list) => { const check = h('input', { type: 'checkbox', disabled: true, ariaLabel: label, onchange: syncFromChecks }); list.push([check, bit]); return check }
  const table = h('table', { className: 'permission-grid' },
    h('thead', {}, h('tr', {}, h('th'), ...['read', 'write', 'execute'].map(k => h('th', { scope: 'col', textContent: t('perm.' + k) })))),
    h('tbody', {}, ...[['owner', 6], ['group', 3], ['others', 0]].map(([key, shift]) => h('tr', {}, h('th', { scope: 'row', textContent: t('perm.' + key) }), ...[['read', 4], ['write', 2], ['execute', 1]].map(([k, bit]) => h('td', {}, box(bit << shift, `${t('perm.' + key)} — ${t('perm.' + k)}`, checks)))))))
  const specialRow = h('div', { className: 'permission-special' }, ...[['setuid', 0o4000], ['setgid', 0o2000], ['sticky', 0o1000]].map(([key, bit]) => h('label', { className: 'check' }, box(bit, key, special), key)))
  mode.oninput = syncFromNumber
  const form = h('form', {
    className: 'card permission-card', role: 'dialog', ariaModal: 'true', ariaLabel: t('ctx.permissions'),
    onkeydown: e => { if (e.key === 'Escape') close() },
    onsubmit: async e => {
      e.preventDefault()
      if (!ready || !valid() || busy) return
      busy = true; submit.disabled = true; status.textContent = t('perm.saving')
      try {
        await api.invoke('sftp:attributes', tab.connId, remote, { uid: Number(owner.value), mode: mode.value })
        busy = false; close()
      } catch (e) { status.textContent = errText(e); status.classList.add('err') }
      finally { busy = false; syncFromNumber(); await load(tab, tab.path, false) }
    },
  }, h('h3', { textContent: t('ctx.permissions') }), h('small', { className: 'dim permission-file', textContent: remote }), ownerLabel,
    h('label', {}, t('perm.owner'), owner), h('small', { className: 'dim', textContent: `${t('perm.group')} : ${entry.group}` }),
    table, h('label', {}, t('perm.octal'), mode), specialRow, status,
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: close }), submit))
  m.onmousedown = e => { if (e.target === m) close() }
  m.replaceChildren(form); m.hidden = false
  syncFromNumber()
  try {
    await ensure(tab)
    const meta = await api.invoke('sftp:ownership', tab.connId, remote)
    if (closed) return
    const accounts = [...meta.users]
    if (!accounts.some(u => u.uid === meta.uid)) accounts.push({ uid: meta.uid, name: String(entry.owner || meta.uid) })
    owner.replaceChildren(...accounts.map(u => h('option', { value: String(u.uid), textContent: `${u.name} (UID ${u.uid})` })))
    owner.value = String(meta.uid)
    ownerLabel.textContent = `${t('perm.current_owner')} : ${accounts.find(u => u.uid === meta.uid).name} (UID ${meta.uid})`
    mode.value = (meta.mode & 0o7777).toString(8).padStart(4, '0')
    ready = true
    owner.disabled = !meta.users.length
    mode.disabled = false
    for (const [check] of [...checks, ...special]) check.disabled = false
    status.textContent = t(meta.users.length ? 'perm.note' : 'perm.users_unavailable')
    syncFromNumber(); mode.focus()
  } catch (e) { if (!closed) { status.textContent = errText(e); status.classList.add('err') } }
}
