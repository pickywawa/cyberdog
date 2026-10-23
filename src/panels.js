// Panneaux de droite : tableau de bord santé (+ services, vue globale) et actions rapides.
// Chargé après renderer.js : réutilise h, t, icon, toast, ensure, tabs, servers, askPassword, modal, errText, sizeOf…

// ---------- Utilitaires ----------
const lvl = (pct, warn, crit) => (pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok')
const fmtUptime = s => {
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}${t('time.d')} ${hh}${t('time.h')}` : hh ? `${hh}${t('time.h')} ${m}${t('time.m')}` : `${m}${t('time.m')}`
}
const msText = ms => (ms == null ? '—' : `${ms} ms`)
const hib = (name, key, onclick) => h('button', { className: 'ib', innerHTML: icon(name), title: t(key), onclick })

function gauge(pct, label, sub, level) {
  const R = 26, C = 2 * Math.PI * R
  const p = Math.max(0, Math.min(100, pct))
  return h('div', { className: 'gauge' },
    h('div', { className: 'ring', innerHTML: `<svg viewBox="0 0 64 64"><circle class="g-bg" cx="32" cy="32" r="${R}"/><circle class="g-fg lv-${level}" cx="32" cy="32" r="${R}" stroke-dasharray="${(C * p) / 100} ${C}" transform="rotate(-90 32 32)"/></svg><span>${Math.round(pct)}%</span>` }),
    h('b', { textContent: label }),
    h('small', { textContent: sub || '' }))
}
const bar = (pct, level) => h('div', { className: 'bar' }, h('i', { className: 'lv-' + level, style: `width:${Math.max(2, Math.min(100, pct))}%` }))

// ---------- Tableau de bord ----------
const newDash = () => ({
  sub: 'health', status: 'checking', data: null, error: null, history: [], last: null, busy: false, timer: null,
  svc: { list: [], filter: 'all', query: '', busy: new Set(), error: null, loaded: false }, svcUi: null,
})

function dashStart(tab) {
  const D = tab.dash
  if (D.timer) return
  D.timer = -1
  const loop = async () => {
    await dashCheck(tab)
    if (D.timer) D.timer = setTimeout(loop, 10000)
  }
  loop()
}
function dashStop(tab) {
  clearTimeout(tab.dash.timer)
  tab.dash.timer = null
}
// le tableau de bord ne sonde que s'il est affiché dans l'onglet actif
const syncPanels = () => tabs.forEach(tb => (tb.panel === 'dashboard' && tb.id === activeId ? dashStart(tb) : dashStop(tb)))

async function dashCheck(tab) {
  const D = tab.dash
  if (D.busy) return
  D.busy = true
  const ts = Date.now()
  try {
    await ensure(tab)
    D.data = await api.invoke('health:check', tab.connId)
    Object.assign(D, { status: 'online', error: null })
    D.history.push({ ts, ok: true, ms: D.data.latencyMs })
  } catch (e) {
    Object.assign(D, { status: 'offline', error: errText(e) })
    D.history.push({ ts, ok: false })
  }
  D.history = D.history.slice(-40)
  D.last = ts
  if (D.status === 'online' && D.sub === 'services') await svcLoad(tab)
  D.busy = false
  if (tab.panel === 'dashboard') paintDash(tab)
}

function renderDashboard(tab) {
  const D = tab.dash
  const seg = h('div', { className: 'seg' }, ...[['health', 'activity', 'dash.tab.health'], ['services', 'server', 'dash.tab.services'], ['overview', 'grid', 'dash.tab.overview']].map(([k, ic, key]) =>
    h('button', {
      className: k === D.sub ? 'on' : '',
      innerHTML: icon(ic) + `<span>${t(key)}</span>`,
      onclick: () => { D.sub = k; D.svcUi = null; renderPanel(tab); if (k === 'services') dashRefreshServices(tab) },
    })))
  tab.dashView = h('div', { className: 'dash-view' })
  tab.rpanelBody.append(seg, tab.dashView)
  paintDash(tab)
}

function paintDash(tab) {
  if (!tab.dashView) return
  const sub = tab.dash.sub
  if (sub === 'health') paintHealth(tab)
  else if (sub === 'services') paintServices(tab)
  else paintOverview(tab)
}

function alertsOf(tab) {
  const D = tab.dash, d = D.data, out = []
  if (D.status === 'offline') out.push({ lvl: 'crit', text: t('dash.alert.offline', { error: D.error || '' }) })
  if (!d) return out
  for (const k of dedupeDisks(d.disks)) {
    if (k.pct >= 80) out.push({ lvl: k.pct >= 90 ? 'crit' : 'warn', text: t(k.pct >= 90 ? 'dash.alert.disk_crit' : 'dash.alert.disk_warn', { mount: k.mount, pct: k.pct }) })
  }
  if (d.cpu >= 90) out.push({ lvl: d.cpu >= 95 ? 'crit' : 'warn', text: t('dash.alert.cpu', { pct: d.cpu }) })
  const ram = d.mem && (d.mem.used / d.mem.total) * 100
  if (ram >= 90) out.push({ lvl: ram >= 95 ? 'crit' : 'warn', text: t('dash.alert.ram', { pct: Math.round(ram) }) })
  if (d.load && d.cores && d.load[0] >= d.cores * 1.5) out.push({ lvl: d.load[0] >= d.cores * 3 ? 'crit' : 'warn', text: t('dash.alert.load', { load: d.load[0], n: d.cores }) })
  return out.sort((a, b) => (a.lvl === 'crit' ? 0 : 1) - (b.lvl === 'crit' ? 0 : 1))
}
// même volume monté plusieurs fois (bind mounts) : une seule ligne, point de montage le plus court
const dedupeDisks = disks => [...new Map([...disks].sort((a, b) => a.mount.length - b.mount.length).map(k => [k.fs + k.size, k])).values()]

function paintHealth(tab) {
  const D = tab.dash, d = D.data
  const view = tab.dashView
  view.replaceChildren()
  const online = D.status === 'online'
  const st = online ? 'ok' : D.status === 'offline' ? 'crit' : 'idle'

  view.append(h('div', { className: 'd-card d-status' },
    h('span', { className: 'dot lv-' + st }),
    h('div', { className: 'd-main' },
      h('b', { textContent: t(D.status === 'checking' ? 'dash.checking' : online ? 'dash.online' : 'dash.offline') }),
      h('small', { textContent: d?.hostname ? [d.hostname, d.os || d.kernel].filter(Boolean).join(' · ') : `${tab.server.user}@${tab.server.host}` })),
    D.last ? h('small', { className: 'dim', textContent: t('dash.last_check', { time: new Date(D.last).toLocaleTimeString(lang) }) }) : ''))

  const al = alertsOf(tab)
  view.append(h('div', { className: 'd-card' },
    h('h4', { textContent: t('dash.alerts') }),
    ...(al.length ? al.map(a => h('div', { className: 'alert lv-' + a.lvl }, h('span', { innerHTML: icon('alert') }), h('span', { textContent: a.text }))) : [h('div', { className: 'ok-line', textContent: t('dash.no_alerts') })])))

  if (d) {
    const ram = d.mem ? (d.mem.used / d.mem.total) * 100 : null
    const loadPct = d.load && d.cores ? (d.load[0] / d.cores) * 100 : null
    view.append(h('div', { className: 'gauges' },
      d.cpu != null ? gauge(d.cpu, t('dash.cpu'), d.cores ? t('dash.cores', { n: d.cores }) : '', lvl(d.cpu, 80, 90)) : '',
      ram != null ? gauge(ram, t('dash.ram'), `${sizeOf(d.mem.used)} / ${sizeOf(d.mem.total)}`, lvl(ram, 80, 90)) : '',
      loadPct != null ? gauge(Math.min(loadPct, 100), t('dash.load'), d.load.join(' · '), lvl(loadPct, 100, 200)) : ''))
    if (d.mem?.swapTotal) view.append(h('div', { className: 'd-card slim' }, h('div', { className: 'kv' }, h('span', { textContent: t('dash.swap') }), h('span', { className: 'dim', textContent: `${sizeOf(d.mem.swapUsed)} / ${sizeOf(d.mem.swapTotal)}` })), bar((d.mem.swapUsed / d.mem.swapTotal) * 100, lvl((d.mem.swapUsed / d.mem.swapTotal) * 100, 50, 80))))

    view.append(h('div', { className: 'tiles' },
      h('div', { className: 'tile-s' }, h('small', { textContent: t('dash.latency') }), h('b', { className: 'lv-' + lvl(d.latencyMs, 150, 400), textContent: msText(d.latencyMs) })),
      h('div', { className: 'tile-s' }, h('small', { textContent: t('dash.connect_time') }), h('b', { textContent: msText(d.connectMs) })),
      h('div', { className: 'tile-s' }, h('small', { textContent: t('dash.uptime') }), h('b', { textContent: d.uptime != null ? fmtUptime(d.uptime) : '—' }))))

    const disks = dedupeDisks(d.disks)
    if (disks.length) {
      view.append(h('div', { className: 'd-card' }, h('h4', { textContent: t('dash.disks') }),
        ...disks.map(k => h('div', { className: 'disk' },
          h('div', { className: 'kv' }, h('b', { textContent: k.mount }), h('span', { className: 'lv-' + lvl(k.pct, 80, 90), textContent: `${k.pct}%` })),
          bar(k.pct, lvl(k.pct, 80, 90)),
          h('small', { className: 'dim', textContent: `${t('dash.free', { size: sizeOf(k.avail) })} · ${sizeOf(k.used)} / ${sizeOf(k.size)} · ${k.fs}` })))))
    }
  }

  const max = Math.max(50, ...D.history.map(x => x.ms || 0))
  view.append(h('div', { className: 'd-card' }, h('h4', { textContent: t('dash.history') }),
    h('div', { className: 'hist' }, ...D.history.map(x => h('span', {
      className: 'hb lv-' + (x.ok ? 'ok' : 'crit'),
      style: `height:${x.ok ? Math.max(4, Math.round((x.ms / max) * 34)) : 34}px`,
      title: `${new Date(x.ts).toLocaleTimeString(lang)} · ${x.ok ? msText(x.ms) : t('dash.offline')}`,
    })))))
}

// ----- Services systemctl -----
async function svcLoad(tab) {
  const S = tab.dash.svc
  try { S.list = await api.invoke('svc:list', tab.connId); S.error = null } catch (e) { S.error = errText(e) }
  S.loaded = true
}
async function dashRefreshServices(tab) {
  await ensure(tab).catch(() => {})
  if (tab.connId) await svcLoad(tab)
  if (tab.panel === 'dashboard') paintDash(tab)
}

async function svcAct(tab, unit, action) {
  if (action !== 'start' && !confirm(t('svc.confirm.' + action, { unit }))) return
  const S = tab.dash.svc
  S.busy.add(unit)
  fillSvcList(tab)
  try {
    await api.invoke('svc:action', tab.connId, unit, action)
    toast(t('svc.ok.' + action, { unit }))
  } catch (e) { toast(t('svc.err', { action: t('svc.' + action), unit, error: errText(e) }), true) }
  S.busy.delete(unit)
  await svcLoad(tab)
  if (tab.panel === 'dashboard' && tab.dash.sub === 'services') fillSvcList(tab)
}

const SVC_FILTERS = { all: () => true, running: s => s.active === 'active', failed: s => s.active === 'failed', stopped: s => s.active !== 'active' && s.active !== 'failed' }

function paintServices(tab) {
  const D = tab.dash, S = D.svc
  if (!D.svcUi) {
    const input = h('input', { className: 's-filter', spellcheck: false, value: S.query, oninput: () => { S.query = input.value; fillSvcList(tab) } })
    input.placeholder = t('svc.search')
    const chips = Object.keys(SVC_FILTERS).map(k => {
      const b = h('button', { className: 'chip' + (S.filter === k ? ' on' : ''), onclick: () => { S.filter = k; chips.forEach(c => c.classList.toggle('on', c.dataset.k === k)); fillSvcList(tab) } })
      b.dataset.k = k
      return b
    })
    const list = h('div', { className: 'svc-list' })
    D.svcUi = { input, chips, list }
    tab.dashView.replaceChildren(h('div', { className: 'svc-tools' }, input, h('div', { className: 'chips' }, ...chips)), list)
  }
  fillSvcList(tab)
}

function fillSvcList(tab) {
  const S = tab.dash.svc, ui = tab.dash.svcUi
  if (!ui) return
  ui.chips.forEach(c => { c.textContent = `${t('svc.' + c.dataset.k)} ${S.loaded ? S.list.filter(SVC_FILTERS[c.dataset.k]).length : ''}`.trim() })
  ui.list.replaceChildren()
  const msg = (text, cls = '') => ui.list.append(h('div', { className: 'msg small ' + cls, textContent: text }))
  if (S.error) return msg(S.error, 'err')
  if (!S.loaded) return msg(t('dash.checking'))
  const q = S.query.toLowerCase()
  const rank = s => (s.active === 'failed' ? 0 : s.active === 'active' ? 1 : 2)
  const items = S.list.filter(s => SVC_FILTERS[S.filter](s) && (!q || s.unit.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q))).sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit))
  if (!items.length) return msg(t('svc.none'))
  for (const s of items) {
    const busy = S.busy.has(s.unit)
    const btn = (name, action) => h('button', { className: 'ib', innerHTML: icon(name), title: t('svc.' + action), disabled: busy, onclick: () => svcAct(tab, s.unit, action) })
    ui.list.append(h('div', { className: 'svc' },
      h('span', { className: 'dot lv-' + (s.active === 'active' ? 'ok' : s.active === 'failed' ? 'crit' : 'idle'), title: `${s.active} / ${s.sub}` }),
      h('div', { className: 'svc-main' }, h('b', { textContent: s.unit.replace(/\.service$/, '') }), h('small', { className: 'dim', textContent: s.desc })),
      h('span', { className: 'svc-btns' },
        ...(s.active === 'active' ? [btn('refresh', 'restart'), btn('stop', 'stop')] : [btn('play', 'start'), ...(s.active === 'failed' ? [btn('refresh', 'restart')] : [])]))))
  }
}

// ----- Vue globale -----
const overview = new Map() // serverId -> résultat de health:overview
const ovState = { running: false, done: 0, total: 0 }
const repaintOverviews = () => tabs.forEach(tb => { if (tb.panel === 'dashboard' && tb.dash.sub === 'overview') paintOverview(tb) })

async function runOverview() {
  if (ovState.running) return
  Object.assign(ovState, { running: true, done: 0, total: servers.length })
  repaintOverviews()
  const queue = [...servers]
  const worker = async () => {
    for (let s; (s = queue.shift()); ) {
      overview.set(s.id, { ...(await api.invoke('health:overview', s.id)), ts: Date.now() })
      ovState.done++
      repaintOverviews()
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  ovState.running = false
  repaintOverviews()
}

function paintOverview(tab) {
  const view = tab.dashView
  view.replaceChildren()
  const res = servers.map(s => overview.get(s.id))
  const online = res.filter(r => r?.ok).length
  const offline = res.filter(r => r && !r.ok).length
  view.append(h('div', { className: 'ov-head' },
    h('span', { className: 'dim', textContent: ovState.running ? t('ov.checking', { done: ovState.done, total: ovState.total }) : res.some(Boolean) ? t('ov.summary', { online, offline }) : t('ov.hint') }),
    h('button', { className: 'primary', textContent: t('ov.check_all'), disabled: ovState.running, onclick: runOverview })))
  for (const s of servers) {
    const r = overview.get(s.id)
    const auth = r && !r.ok && AUTH_FAIL.test(r.error || '')
    const st = !r ? 'idle' : r.ok ? 'ok' : auth ? 'warn' : 'crit'
    const ram = r?.ok && r.mem ? Math.round((r.mem.used / r.mem.total) * 100) : null
    const disk = r?.ok && r.disks?.length ? Math.max(...r.disks.map(k => k.pct)) : null
    const chip = (label, v, w, c) => (v == null ? '' : h('span', { className: 'mchip lv-' + lvl(v, w, c), textContent: `${label} ${Math.round(v)}%` }))
    const open = () => { const ex = tabs.find(tb => tb.server.id === s.id); if (ex) activate(ex.id); else openFiles(s) }
    view.append(h('div', { className: 'ov-row', onclick: open, title: r && !r.ok ? errText({ message: r.error }) : '' },
      h('span', { className: 'dot lv-' + st }),
      h('div', { className: 'svc-main' }, h('b', { textContent: s.name }), h('small', { className: 'dim', textContent: !r ? t('ov.pending') : r.ok ? `${s.user}@${s.host}` : auth ? t('ov.auth') : t('dash.offline') })),
      r?.ok ? h('span', { className: 'ov-metrics' }, h('span', { className: 'mchip lv-' + lvl(r.latencyMs, 150, 400), textContent: msText(r.latencyMs) }), chip('CPU', r.cpu, 80, 90), chip('RAM', ram, 80, 90), chip('Disk', disk, 80, 90)) : ''))
  }
}

// ---------- Actions rapides ----------
let quickActions = []
const repaintActions = () => tabs.forEach(tb => { if (tb.panel === 'actions') paintActions(tb) })

async function actionForm(a) {
  const v = await modal(a ? t('qa.edit_title') : t('qa.new_title'), [
    { name: 'name', label: t('qa.name'), value: a?.name, placeholder: t('qa.name_ph') },
    { name: 'script', label: t('qa.script'), type: 'textarea', value: a?.script, placeholder: t('qa.script_ph') },
  ], a ? t('btn.save') : t('btn.add_ok'), { wide: true })
  if (!v) return
  try { quickActions = await api.invoke('actions:save', { ...v, id: a?.id }); repaintActions() } catch (e) { toast(errText(e), true) }
}

async function importActions() {
  try {
    const r = await api.invoke('actions:importZip')
    if (!r) return
    quickActions = r.actions
    repaintActions()
    toast(r.added ? t('t.actions_imported', { n: r.added }) : t('t.nothing_actions'))
  } catch (e) { toast(errText(e), true) }
}
async function exportActions() {
  try {
    const r = await api.invoke('actions:exportZip')
    if (r) toast(t('t.actions_exported', { n: r.count, path: r.path }), false, 6000)
  } catch (e) { toast(errText(e), true) }
}

// un onglet par serveur (le premier ouvert)
const openServerTabs = () => [...new Map(tabs.map(tb => [tb.server.id, tb])).values()]

async function runAction(tab, a, all) {
  const targets = all ? openServerTabs() : [tab]
  if (all && !confirm(t('qa.confirm_all', { name: a.name, n: targets.length }))) return
  const runs = targets.map(tb => ({ tb, res: { server: tb.server.name, name: a.name, status: 'running', open: true } }))
  tab.results.unshift(...runs.map(r => r.res))
  paintActions(tab)
  await Promise.all(runs.map(async ({ tb, res }) => {
    try {
      await ensure(tb)
      Object.assign(res, await api.invoke('action:run', tb.connId, a.script), { status: 'done' })
    } catch (e) { Object.assign(res, { status: 'done', code: -1, out: errText(e) }) }
    paintActions(tab)
  }))
}

function paintActions(tab) {
  const body = tab.rpanelBody
  body.replaceChildren()
  if (!tab.rpanelActions.childElementCount) tab.rpanelActions.append(hib('plus', 'qa.add', () => actionForm()), hib('download', 'qa.import', importActions), hib('upload', 'qa.export', exportActions))
  if (!quickActions.length) {
    body.append(h('div', { className: 'qa-empty' }, h('span', { innerHTML: icon('zap') }), h('p', { textContent: t('qa.empty') }), h('button', { className: 'primary', textContent: t('qa.add'), onclick: () => actionForm() })))
  }
  for (const a of quickActions) {
    const preview = a.script.split('\n').filter(l => l.trim()).slice(0, 3).join('\n')
    const btn = (name, key, fn, cls = '') => h('button', { className: ('ib ' + cls).trim(), innerHTML: icon(name), title: t(key), onclick: fn })
    body.append(h('div', { className: 'qa-card' },
      h('div', { className: 'qa-head' }, h('b', { textContent: a.name }),
        h('span', { className: 'qa-btns' },
          btn('play', 'qa.run', () => runAction(tab, a, false), 'accent'),
          btn('grid', 'qa.run_all', () => runAction(tab, a, true)),
          btn('pencil', 'qa.edit', () => actionForm(a)),
          btn('trash', 'qa.delete', async () => { if (confirm(t('qa.confirm_delete', { name: a.name }))) { quickActions = await api.invoke('actions:delete', a.id); repaintActions() } }))),
      h('pre', { className: 'qa-prev', textContent: preview })))
  }
  if (tab.results.length) {
    body.append(h('div', { className: 'qa-results-head' }, h('h4', { textContent: t('qa.results') }), h('button', { className: 'chip', textContent: t('qa.clear'), onclick: () => { tab.results = []; paintActions(tab) } })))
    for (const r of tab.results) {
      const d = h('details', { className: 'res', open: r.open, ontoggle: () => { r.open = d.open } },
        h('summary', {}, h('span', { className: 'res-title', textContent: `${r.server} · ${r.name}` }),
          h('span', { className: 'mchip lv-' + (r.status === 'running' ? 'idle' : r.code === 0 ? 'ok' : 'crit'), textContent: r.status === 'running' ? t('qa.running') : `${t('qa.exit', { code: r.code })} · ${r.ms ?? 0} ms` })),
        h('pre', { textContent: r.status === 'running' ? '' : r.out?.trim() || t('qa.no_output') }))
      body.append(d)
    }
  }
}

function renderActions(tab) {
  paintActions(tab)
}
