// TLS certificates on the active SSH server, and local SSH key management.
const newCertificates = () => ({ data: null, directory: '', days: [7, 14, 30, 60, 90].includes(Number(localStorage.getItem('cyberdog.cert.days'))) ? Number(localStorage.getItem('cyberdog.cert.days')) : 30, sudo: false, busy: false, renewing: false, error: null, output: '', ui: null, notified: new Set() })
const newKeys = () => ({ items: [], remote: null, remoteError: null, loaded: false, busy: false, error: null, ui: null })
function certificateState(c, days, now = Date.now()) {
  const remaining = Math.ceil((c.validTo - now) / 86400000)
  return { days: remaining, level: c.validTo <= now ? 'crit' : c.validFrom > now || remaining <= days ? 'warn' : 'ok', expired: c.validTo <= now, notYetValid: c.validFrom > now }
}
const certificateName = c => c.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1] || c.domains || c.subject
const certificateAlert = (c, s) => t(s.expired ? 'cert.expired' : s.notYetValid ? 'cert.not_valid' : 'cert.expires', { name: certificateName(c), days: s.days })
async function certificatePoll(tab) {
  const C = tab.certificates
  if (C.busy || C.renewing) return
  C.busy = true
  paintCertificates(tab)
  try {
    await ensure(tab)
    C.data = await api.invoke('cert:scan', tab.connId, { directory: C.directory, sudo: C.sudo })
    C.error = null
    const alerts = C.data.certificates.filter(c => certificateState(c, C.days).level !== 'ok')
    const fresh = alerts.filter(c => !C.notified.has(c.fingerprint + ':' + C.days + ':' + certificateState(c, C.days).level))
    if (fresh.length) toast(t('cert.alert_count', { n: alerts.length, server: tab.server.name }), true, 7000)
    alerts.forEach(c => C.notified.add(c.fingerprint + ':' + C.days + ':' + certificateState(c, C.days).level))
  } catch (e) { C.error = errText(e) }
  finally { C.busy = false }
  paintCertificates(tab)
}
function renderCertificates(tab) {
  const C = tab.certificates
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => certificatePoll(tab)))
  const input = h('input', { className: 's-filter', placeholder: t('cert.directory_ph'), value: C.directory, ariaLabel: t('cert.directory') })
  const scan = h('button', { className: 'chip', textContent: t('cert.scan'), onclick: () => { C.directory = input.value.trim(); certificatePoll(tab) } })
  input.onkeydown = e => { if (e.key === 'Enter') scan.click() }
  const threshold = h('select', { className: 'lsel', ariaLabel: t('cert.threshold'), onchange: () => { C.days = Number(threshold.value); localStorage.setItem('cyberdog.cert.days', String(C.days)); paintCertificates(tab) } }, ...[7, 14, 30, 60, 90].map(n => h('option', { value: n, textContent: t('cert.days_before', { n }) })))
  threshold.value = String(C.days)
  const sudo = h('input', { type: 'checkbox', checked: C.sudo, onchange: () => { C.sudo = sudo.checked; certificatePoll(tab) } })
  C.ui = h('div', { className: 'security-list' })
  tab.rpanelBody.append(h('p', { className: 'security-note dim', textContent: t('cert.note') }), h('div', { className: 'security-tools' }, input, scan), h('div', { className: 'security-tools' }, h('label', {}, t('cert.threshold'), threshold), h('label', { className: 'check' }, sudo, t('cert.sudo'))), C.ui)
  paintCertificates(tab)
}
function paintCertificates(tab) {
  const C = tab.certificates, body = C.ui
  if (tab.panel !== 'certificates' || !body) return
  body.replaceChildren()
  if (C.error) body.append(h('p', { className: 'err', role: 'alert', textContent: C.error }))
  if (C.busy) body.append(h('p', { className: 'dim', textContent: t('cert.scanning') }))
  const data = C.data
  if (!data) return
  if (data.truncated) body.append(h('p', { className: 'lv-warn', textContent: t('cert.limit') }))
  const certs = [...data.certificates].sort((a, b) => a.validTo - b.validTo)
  const count = certs.filter(c => certificateState(c, C.days).level !== 'ok').length
  body.append(h('div', { className: 'tiles' }, h('div', { className: 'tile-s' }, h('small', { textContent: t('cert.count') }), h('b', { textContent: String(certs.length) })), h('div', { className: 'tile-s' }, h('small', { textContent: t('cert.alerts') }), h('b', { className: count ? 'lv-warn' : 'lv-ok', textContent: String(count) }))), h('small', { className: 'dim', textContent: t('cert.last_scan', { time: new Date(data.scannedAt).toLocaleString(lang) }) }))
  if (!certs.length) body.append(h('p', { className: 'dim', textContent: t('cert.empty') }))
  for (const c of certs) {
    const state = certificateState(c, C.days)
    const canRenew = data.certbot && c.certName
    body.append(h('article', { className: 'd-card certificate-card' }, h('b', { textContent: certificateName(c) }),
      h('span', { className: 'mchip lv-' + state.level, textContent: state.level === 'ok' ? t('cert.valid_days', { days: state.days }) : certificateAlert(c, state) }),
      h('div', { className: 'kvtable' }, ...[[t('cert.valid_from'), dateOf(c.validFrom)], [t('cert.valid_to'), dateOf(c.validTo)], [t('cert.issuer'), c.issuer], [t('cert.domains'), c.domains || '—'], [t('cert.files'), c.paths.join('\n')], ['SHA-256', c.fingerprint]].map(([k, v]) => h('div', { className: 'kvrow' }, h('span', { className: 'k', textContent: k }), h('span', { className: 'v', textContent: v })))),
      h('button', { className: 'chip', textContent: t('cert.renew'), disabled: !canRenew || C.renewing, title: t(canRenew ? 'cert.renew_note' : 'cert.unsupported'), onclick: () => renewCertificate(tab, c) })))
  }
  if (C.renewing) body.append(h('p', { className: 'dim', textContent: t('cert.renewing') }))
  if (C.output) body.append(h('details', { className: 'res', open: true }, h('summary', { textContent: t('cert.result') }), h('pre', { textContent: C.output })))
}
async function renewCertificate(tab, c) {
  const C = tab.certificates
  if (C.renewing || !confirm(t('cert.confirm', { name: c.certName, server: tab.server.name }))) return
  C.renewing = true; C.output = ''; paintCertificates(tab)
  try { C.output = (await api.invoke('cert:renew', tab.connId, c.fingerprint, C.sudo)).out || t('cert.command_done') }
  catch (e) { C.output = errText(e); toast(C.output, true) }
  finally { C.renewing = false }
  await certificatePoll(tab)
}
async function loadKeys(tab) {
  const K = tab.keys
  if (K.busy) return
  K.busy = true
  paintKeys(tab)
  try { K.items = await api.invoke('keys:list'); K.loaded = true; K.error = null; try { await ensure(tab); K.remote = await api.invoke('keys:remote', tab.connId); K.remoteError = null } catch (e) { K.remoteError = errText(e) } } catch (e) { K.error = errText(e) }
  finally { K.busy = false }
  paintKeys(tab)
}
function renderKeys(tab) {
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => loadKeys(tab)))
  tab.keys.ui = h('div', { className: 'security-list' })
  tab.rpanelBody.append(h('p', { className: 'security-note dim', textContent: t('keys.note') }), h('div', { className: 'chips' }, h('button', { className: 'primary', textContent: t('keys.generate'), onclick: () => generateKey(tab) }), h('button', { className: 'chip', textContent: t('keys.import'), onclick: () => importKey(tab) })), tab.keys.ui)
  paintKeys(tab)
  loadKeys(tab)
}
function paintKeys(tab) {
  const K = tab.keys, body = K.ui
  if (tab.panel !== 'keys' || !body) return
  body.replaceChildren()
  if (K.error) body.append(h('p', { className: 'err', role: 'alert', textContent: K.error }))
  if (K.busy) body.append(h('p', { className: 'dim', textContent: t('keys.working') }))
  body.append(h('h4', { textContent: t('keys.remote_title') }))
  if (K.remoteError) body.append(h('p', { className: 'err', textContent: K.remoteError }))
  if (K.remote) {
    body.append(h('small', { className: 'dim key-location', textContent: K.remote.path }))
    if (!K.remote.items.length) body.append(h('p', { className: 'dim', textContent: t('keys.remote_empty') }))
    for (const key of K.remote.items) body.append(h('article', { className: 'd-card key-card' }, h('b', { textContent: key.name }), h('pre', { className: 'key-fingerprint', textContent: key.fingerprint }), h('details', {}, h('summary', { textContent: t('keys.public') }), h('pre', { className: 'key-public', textContent: key.publicKey })), h('button', { className: 'chip', textContent: t('keys.copy'), onclick: () => navigator.clipboard.writeText(key.publicKey).catch(e => toast(errText(e), true)) })))
  }
  body.append(h('h4', { textContent: t('keys.local_title') }))
  if (K.loaded && !K.items.length) body.append(h('p', { className: 'dim', textContent: t('keys.empty') }))
  for (const key of K.items) {
    const button = (label, fn, disabled = false) => h('button', { className: 'chip', textContent: t('keys.' + label), disabled: disabled || K.busy, onclick: fn })
    body.append(h('article', { className: 'd-card key-card' }, h('b', { textContent: key.name }),
      key.error ? h('p', { className: 'err', textContent: key.error }) : h('div', {},
        h('small', { className: 'dim', textContent: `${key.type} · ${t(key.encrypted ? 'keys.encrypted' : key.hasPrivate ? 'keys.local' : 'keys.public_only')}` }),
        h('pre', { className: 'key-fingerprint', textContent: key.fingerprint }),
        h('small', { className: 'dim key-location', textContent: key.privatePath || key.publicPath }),
        h('details', {}, h('summary', { textContent: t('keys.public') }), h('pre', { className: 'key-public', textContent: key.publicKey })),
        h('div', { className: 'chips' }, button('copy', () => navigator.clipboard.writeText(key.publicKey).catch(e => toast(errText(e), true))), button('fingerprint', () => navigator.clipboard.writeText(key.fingerprint).catch(e => toast(errText(e), true))), button('install', () => installKey(tab, key)), button('use', () => useKey(tab, key), !key.hasPrivate), button('reveal', () => api.invoke('keys:reveal', key.id).catch(e => toast(errText(e), true)))))))
  }
}
async function generateKey(tab) {
  if (tab.keys.busy) return
  const options = await modal(t('keys.generate'), [
    { name: 'name', label: t('keys.name'), value: 'Cyberdog' },
    { name: 'type', label: t('keys.type'), type: 'select', value: 'ed25519', options: [['ed25519', 'Ed25519'], ['rsa', 'RSA 4096']] },
    { name: 'comment', label: t('keys.comment'), value: `${tab.server.user}@${tab.server.host}` },
    { name: 'passphrase', type: 'password', label: t('keys.passphrase') },
  ], t('keys.generate'))
  if (!options) return
  const K = tab.keys; K.busy = true; paintKeys(tab)
  try { K.items = await api.invoke('keys:generate', options); K.loaded = true; K.error = null }
  catch (e) { K.error = errText(e) }
  finally { K.busy = false; paintKeys(tab) }
}
async function importKey(tab) {
  if (tab.keys.busy) return
  try { const items = await api.invoke('keys:import'); if (items) { tab.keys.items = items; tab.keys.loaded = true; paintKeys(tab) } } catch (e) { toast(errText(e), true) }
}
async function installKey(tab, key) {
  const K = tab.keys
  if (K.busy || !confirm(t('keys.install_confirm', { name: key.name, target: `${tab.server.user}@${tab.server.host}` }))) return
  K.busy = true; paintKeys(tab)
  try { await ensure(tab); const result = await api.invoke('keys:install', tab.connId, key.id); toast(t(result.exists ? 'keys.exists' : 'keys.installed')) }
  catch (e) { toast(errText(e), true) }
  finally { K.busy = false; await loadKeys(tab) }
}
async function useKey(tab, key) {
  if (!confirm(t('keys.use_confirm', { name: key.name, server: tab.server.name }))) return
  try { servers = await api.invoke('keys:use', tab.server.id, key.id); renderServers(); toast(t('keys.used')) } catch (e) { toast(errText(e), true) }
}
const pendingKeyUnlocks = new Map()
function unlockServerKey(server, error) {
  if (!error.message?.includes('KEY_PASSPHRASE_REQUIRED')) return Promise.resolve(false)
  if (pendingKeyUnlocks.has(server.id)) return pendingKeyUnlocks.get(server.id)
  const pending = (async () => {
    for (;;) {
      const result = await modal(t('keys.unlock'), [{ name: 'passphrase', type: 'password', label: t('keys.passphrase_unlock') }], t('btn.connect'))
      if (!result) return false
      try { await api.invoke('keys:unlock', server.id, result.passphrase); return true }
      catch (e) { toast(errText(e), true) }
    }
  })().finally(() => pendingKeyUnlocks.delete(server.id))
  pendingKeyUnlocks.set(server.id, pending)
  return pending
}
