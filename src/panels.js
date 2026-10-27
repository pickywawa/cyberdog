// Panneaux de droite : tableau de bord santé et actions rapides (services, logs et docker : ops.js).
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
const newDash = () => ({ status: 'checking', data: null, error: null, history: [], last: null, busy: false })

// Sondage périodique du panneau affiché dans l'onglet actif (santé, services, docker) ; un seul sondage par onglet.
const POLLS = {
  certificates: { every: 60000, run: t => certificatePoll(t) },
  processes: { every: 5000, run: t => processPoll(t) },
  dashboard: { every: 10000, run: t => dashCheck(t) },
  services: { every: 10000, run: t => svcPoll(t) },
  docker: { every: 6000, run: t => dockerPoll(t) },
}
function pollStop(tab) {
  clearTimeout(tab.pollTimer)
  tab.pollTimer = null
  tab.pollKey = null
}
function pollStart(tab) {
  const P = POLLS[tab.panel]
  if (!P) return pollStop(tab)
  if (tab.pollKey === tab.panel) return
  pollStop(tab)
  const key = (tab.pollKey = tab.panel)
  const loop = async () => {
    await P.run(tab)
    if (tab.pollKey === key) tab.pollTimer = setTimeout(loop, P.every)
  }
  loop()
}
const syncPanels = () => tabs.forEach(tb => (tb.id === activeId ? pollStart(tb) : pollStop(tb)))

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
  D.busy = false
  if (tab.panel === 'dashboard') paintDash(tab)
}

function renderDashboard(tab) {
  tab.dashView = h('div', { className: 'dash-view' })
  tab.rpanelBody.append(tab.dashView)
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => dashCheck(tab)))
  paintHealth(tab)
}
const paintDash = tab => { if (tab.dashView && tab.panel === 'dashboard') paintHealth(tab) }

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
  for (const cert of tab.certificates?.data?.certificates || []) {
    const state = certificateState(cert, tab.certificates.days)
    if (state.level !== 'ok') out.push({ lvl: state.level, text: certificateAlert(cert, state) })
  }
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

// ---------- Actions rapides ----------
let quickActions = []
const repaintActions = () => tabs.forEach(tb => { if (tb.panel === 'actions') paintActions(tb) })

async function actionForm(a) {
  const v = await modal(a ? t('qa.edit_title') : t('qa.new_title'), [
    ...(sharedLocationField(a)?[sharedLocationField(a)]:[]),
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
  const targets = (all ? openServerTabs() : [tab]).filter(tb=>sharedVisible(a,tb))
  if(!await beforeActionRun(a))return
  if (all && !confirm(t('qa.confirm_all', { name: a.name, n: targets.length }))) return
  const runs = targets.map(tb => ({ tb, res: { server: tb.server.name, name: a.name, status: 'running', open: true } }))
  tab.results.unshift(...runs.map(r => r.res))
  paintActions(tab)
  await Promise.all(runs.map(async ({ tb, res }) => {
    try {
      await ensure(tb)
      Object.assign(res, await api.invoke('action:run', tb.connId, actionPayload(a)), { status: 'done' })
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
  for (const a of quickActions.filter(a=>sharedVisible(a,tab))) {
    const preview = a.script.split('\n').filter(l => l.trim()).slice(0, 3).join('\n')
    const btn = (name, key, fn, cls = '') => h('button', { className: ('ib ' + cls).trim(), innerHTML: icon(name), title: t(key), onclick: fn })
    body.append(h('div', { className: 'qa-card' },
      h('div', { className: 'qa-head' }, h('b', { textContent: a.name }),h('small',{className:'dim',textContent:sharedScopeName(a)}),
        h('span', { className: 'qa-btns' },
          btn('play', 'qa.run', () => runAction(tab, a, false), 'accent'),
          btn('grid', 'qa.run_all', () => runAction(tab, a, true)),
          ...(!a.teamId||a.canEditServers?[btn('pencil', 'qa.edit', () => actionForm(a)),
          btn('trash', 'qa.delete', async () => { if (confirm(t('qa.confirm_delete', { name: a.name }))) { quickActions = await api.invoke('actions:delete', a.id); repaintActions() } })]:[]))),
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
