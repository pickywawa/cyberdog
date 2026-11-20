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

// An action is for every server, or for one (the server of the tab it is created from)
const actionServer = a => a.serverId && servers.find(s => s.id === a.serverId)
const actionFor = (a, server) => (!a.serverId || a.serverId === server.id) && (!a.teamId || a.teamId === accountState.personalSpaceId || a.teamId === server.teamId)
async function actionForm(a, tab) {
  const own = actionServer(a || {}), here = tab?.server && isShell(tab.server) ? tab.server : null
  const targets = [['', t('qa.all_servers')], ...[here, own].filter((x, i, all) => x && all.indexOf(x) === i).map(x => [x.id, t('qa.only_server', { name: x.name })])]
  const v = await modal(a ? t('qa.edit_title') : t('qa.new_title'), [
    ...(sharedLocationField(a)?[sharedLocationField(a)]:[]),
    ...(targets.length > 1 ? [{ name: 'serverId', label: t('qa.for'), type: 'select', value: a?.serverId || '', options: targets }] : []),
    { name: 'name', label: t('qa.name'), value: a?.name, placeholder: t('qa.name_ph') },
    { name: 'script', label: t('qa.script'), type: 'textarea', rows: 18, value: a?.script, placeholder: t('qa.script_ph') + '\n\n' + t('qa.download_hint') + '\necho "cyberdog:download /var/backups/site.tar.gz"\necho "cyberdog:notify Done"' },
  ], a ? t('btn.save') : t('btn.add_ok'), { wide: true, cls: 'action-card', expandable: true })
  if (!v) return
  try { quickActions = await api.invoke('actions:save', { ...v, serverId: v.serverId || null, id: a?.id }); repaintActions() } catch (e) { toast(errText(e), true) }
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
const openServerTabs = () => [...new Map(tabs.filter(tb => isShell(tb.server)).map(tb => [tb.server.id, tb])).values()]

async function runAction(tab, a, all) {
  const targets = (all ? openServerTabs() : [tab]).filter(tb => actionFor(a, tb.server))
  if(!await beforeActionRun(a))return
  if (all && !confirm(t('qa.confirm_all', { name: a.name, n: targets.length }))) return
  const repaint = () => paintActions(tab)
  await Promise.all(targets.map(async tb => {
    // An action that asks (cyberdog:select / input / buttons) runs again with the answers, up to 10 times
    let vars = {}
    for (let round = 0; round < 10; round++) {
      const res = { server: tb.server.name, name: a.name + (round ? ' · ' + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 120) : ''), status: 'running', open: true }
      tab.results.unshift(res)
      repaint()
      try {
        await ensure(tb)
        Object.assign(res, await api.invoke('action:run', tb.connId, actionPayload(a), vars), { status: 'done' })
      } catch (e) { Object.assign(res, { status: 'done', code: -1, out: errText(e) }); return repaint() }
      const parsed = actionCommands.parse(res.out)
      res.out = parsed.output
      repaint()
      await runCommands(tb, res, parsed.commands, repaint)
      if (!parsed.form || res.code !== 0) return
      const answers = await askForm(tb, a, parsed.form)
      if (!answers) { res.out = (res.out.trim() ? res.out.trim() + '\n' : '') + t('qa.form_cancelled'); return repaint() }
      vars = { ...vars, ...answers }
    }
  }))
}

// The form an action asked for; one at a time when several servers ask together -> { VAR: value } or null
let formQueue = Promise.resolve()
function askForm(tb, a, form) {
  const shown = formQueue.then(() => new Promise(resolve => {
    const values = {}
    const overlay = h('div', { className: 'conflict-overlay' })
    const done = v => { overlay.remove(); resolve(v) }
    const only = form.fields.length === 1 && form.fields[0].type === 'buttons' // one question with buttons: a click answers
    const rows = form.fields.map(f => {
      if (f.type === 'select') {
        const select = h('select', { className: 'lsel full', onchange: () => (values[f.name] = select.value) }, ...f.options.map(o => h('option', { value: o.value, textContent: o.label })))
        values[f.name] = f.options[0].value
        return h('label', {}, f.label, select)
      }
      if (f.type === 'input') {
        const input = h('input', { type: 'text', value: f.value, spellcheck: false, oninput: () => (values[f.name] = input.value) })
        values[f.name] = f.value
        return h('label', {}, f.label, input)
      }
      const group = h('div', { className: 'form-buttons', role: 'radiogroup', ariaLabel: f.label },
        ...f.buttons.map(b => h('button', { type: only ? 'submit' : 'button', className: only ? '' : 'chip', textContent: b.label, onclick: e => {
          values[f.name] = b.value
          group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === e.currentTarget))
          if (only) { e.preventDefault(); done({ ...values }) }
        } })))
      return h('div', { className: 'form-field' }, h('span', { className: 'form-label', textContent: f.label }), group)
    })
    const card = h('form', { className: 'card action-form', role: 'dialog', ariaModal: 'true', ariaLabel: form.title || a.name,
      onsubmit: e => {
        e.preventDefault()
        const missing = form.fields.find(f => f.type === 'buttons' && values[f.name] === undefined)
        if (missing) return toast(t('qa.form_choose', { label: missing.label }), true)
        done({ ...values })
      },
      onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); done(null) } } },
      h('h3', { textContent: form.title || a.name }), h('small', { className: 'dim', textContent: `${a.name} · ${tb.server.name}` }),
      ...rows,
      h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: () => done(null) }), ...(only ? [] : [h('button', { type: 'submit', className: 'primary', textContent: t('qa.form_ok') })])))
    overlay.onmousedown = e => { if (e.target === overlay) done(null) }
    overlay.append(card)
    document.body.append(overlay)
    card.querySelector('select, input, button')?.focus()
  }))
  formQueue = shown.catch(() => {})
  return shown
}

// Cyberdog commands: lines of an action's output that drive the app once the script has run, in order (20 at most).
//   cyberdog:download /path   download the file to this computer (the server's download folder, or Downloads)
//   cyberdog:open /path       a file opens in the editor, a folder in the explorer
//   cyberdog:terminal [/path] open the terminal (in that folder)
//   cyberdog:refresh          refresh the explorer
//   cyberdog:notify message   show a message
//   cyberdog:url https://…    open a web link in the browser
const absolute = p => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
const quoteShell = p => `'${p.replace(/'/g, `'\\''`)}'`
async function runCommands(tb, res, commands, repaint) {
  if (!commands.length) return
  const ex = tb.active
  try {
    // every download of the run goes in one transfer
    const downloads = commands.filter(c => c.name === 'download' && absolute(c.arg)).map(c => c.arg)
    if (downloads.length) {
      const files = await api.invoke('files:fetch', tb.connId, downloads)
      if (files.length) { res.files = files; downloadedToast(files[0]); repaint() }
    }
  } catch (e) { toast(errText(e), true) }
  // one command that fails does not stop the next ones
  for (const { name, arg } of commands) {
    try {
      if (name === 'notify') toast(arg || '…', false, 6000)
      else if (name === 'url') await api.invoke('link:open', arg)
      else if (name === 'refresh') tb.panes.forEach(p => p.path && load(p, p.path, false, true))
      else if (name === 'open' && absolute(arg)) {
        const kind = await api.invoke('files:kind', tb.connId, arg)
        if (!kind) throw new Error(t('qa.not_found', { path: arg }))
        if (kind === 'dir') await load(ex, arg)
        else { ex.pendingSelect = arg.slice(arg.lastIndexOf('/') + 1); await load(ex, parentOf(arg)); await openFile(ex, arg) }
      } else if (name === 'terminal') {
        if (absolute(arg)) await load(ex, arg)
        if (!tb.term) await openTerminal(tb)
        else { if (absolute(arg)) api.send('term:write', tb.termId, `cd ${quoteShell(arg)}\r`); tb.term.focus() }
      }
    } catch (e) { toast(errText(e), true) }
  }
}

// Help of the actions view: what the Cyberdog commands are
function actionsHelp() {
  return h('div', { className: 'qa-help' },
    h('p', { textContent: t('qa.help_intro') }),
    h('dl', {}, ...actionCommands.COMMANDS.flatMap(name => [
      h('dt', {}, h('code', { textContent: `cyberdog:${name}${{ download: ' /path/file', open: ' /path', terminal: ' [/path]', notify: ' text', url: ' https://…' }[name] || ''}` })),
      h('dd', { textContent: t('qa.help_' + name) })])),
    h('p', { className: 'dim', textContent: t('qa.help_note') }),
    h('p', { textContent: t('qa.help_form_intro') }),
    h('dl', {}, ...[['title', ' Title'], ['select', ' VAR|Label'], ['option', ' VAR|value|Label'], ['input', ' VAR|Label|default'], ['buttons', ' VAR|Question|Yes=yes|No=no']].flatMap(([name, syntax]) => [
      h('dt', {}, h('code', { textContent: `cyberdog:${name}${syntax}` })),
      h('dd', { textContent: t('qa.help_' + name) })])),
    h('pre', { textContent: '# ' + t('qa.help_example') + '\nif [ -z "$FILE" ]; then\n  echo "cyberdog:select FILE|Backup"\n  for f in /var/backups/*.tar.gz; do\n    echo "cyberdog:option FILE|$f|$(basename "$f")"\n  done\n  exit 0\nfi\necho "cyberdog:download $FILE"' }))
}

// Right-click on a server > Actions: its actions and the global ones; running one opens the server, its Actions view,
// and runs it there. No action yet: a way to create one.
function serverActionsMenu(server) {
  const list = quickActions.filter(a => actionFor(a, server)).sort((x, y) => !!y.serverId - !!x.serverId || x.name.localeCompare(y.name))
  return [
    ...(list.length ? list.map(a => ({ label: a.name, icon: a.serverId ? 'server' : 'zap', fn: () => openActions(server, tab => runAction(tab, a, false)) }))
      : [{ label: t('qa.none'), disabled: true }]),
    '-',
    { label: t('qa.add'), icon: 'plus', fn: () => openActions(server, tab => actionForm(null, tab)) },
  ]
}
function openActions(server, then) {
  const tab = tabs.find(tb => tb.server.id === server.id) || openFiles(server)
  if (!tab) return
  activate(tab.id)
  if (tab.panel !== 'actions') setPanel(tab, 'actions')
  then?.(tab)
}

function paintActions(tab) {
  const body = tab.rpanelBody
  body.replaceChildren()
  if (!tab.rpanelActions.childElementCount) tab.rpanelActions.append(hib('info', 'qa.help', () => { tab.actionsHelp = !tab.actionsHelp; paintActions(tab) }), hib('plus', 'qa.add', () => actionForm(null, tab)), hib('download', 'qa.import', importActions), hib('upload', 'qa.export', exportActions))
  tab.rpanelActions.querySelector('.ib')?.classList.toggle('on', !!tab.actionsHelp)
  const shown = quickActions.filter(a => actionFor(a, tab.server)).sort((x, y) => !!y.serverId - !!x.serverId)
  if (!shown.length) {
    body.append(h('div', { className: 'qa-empty' }, h('span', { innerHTML: icon('zap') }), h('p', { textContent: t('qa.empty') }), h('button', { className: 'primary', textContent: t('qa.add'), onclick: () => actionForm(null, tab) })))
  }
  // the commands are explained with no action yet, or on demand (ⓘ)
  if (!shown.length || tab.actionsHelp) body.append(actionsHelp())
  for (const a of shown) {
    const preview = a.script.split('\n').filter(l => l.trim()).slice(0, 3).join('\n')
    const btn = (name, key, fn, cls = '') => h('button', { className: ('ib ' + cls).trim(), innerHTML: icon(name), title: t(key), onclick: fn })
    body.append(h('div', { className: 'qa-card' },
      h('div', { className: 'qa-head' }, h('b', { textContent: a.name }),h('small',{className:'dim',textContent:a.serverId ? t('qa.this_server') : sharedScopeName(a)}),
        h('span', { className: 'qa-btns' },
          btn('play', 'qa.run', () => runAction(tab, a, false), 'accent'),
          btn('grid', 'qa.run_all', () => runAction(tab, a, true)),
          ...(!a.teamId||a.canEditServers?[btn('pencil', 'qa.edit', () => actionForm(a, tab)),
          btn('trash', 'qa.delete', async () => { if (confirm(t('qa.confirm_delete', { name: a.name }))) { quickActions = await api.invoke('actions:delete', a.id); repaintActions() } })]:[]))),
      h('pre', { className: 'qa-prev', textContent: preview })))
  }
  if (tab.results.length) {
    body.append(h('div', { className: 'qa-results-head' }, h('h4', { textContent: t('qa.results') }), h('button', { className: 'chip', textContent: t('qa.clear'), onclick: () => { tab.results = []; paintActions(tab) } })))
    for (const r of tab.results) {
      const d = h('details', { className: 'res', open: r.open, ontoggle: () => { r.open = d.open } },
        h('summary', {}, h('span', { className: 'res-title', textContent: `${r.server} · ${r.name}` }),
          h('span', { className: 'mchip lv-' + (r.status === 'running' ? 'idle' : r.code === 0 ? 'ok' : 'crit'), textContent: r.status === 'running' ? t('qa.running') : `${t('qa.exit', { code: r.code })} · ${r.ms ?? 0} ms` })),
        h('pre', { textContent: r.status === 'running' ? '' : r.out?.trim() || t('qa.no_output') }),
        ...(r.files?.length ? [h('div', { className: 'qa-files' }, ...r.files.map(f => h('button', { type: 'button', className: 'chip', title: f, onclick: () => revealFile(f) }, h('span', { innerHTML: icon('download') }), h('span', { textContent: `${f.split(/[\\/]/).pop()} · ${revealLabel()}` }))))] : []))
      body.append(d)
    }
  }
}

function renderActions(tab) {
  paintActions(tab)
}
