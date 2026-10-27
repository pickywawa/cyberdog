// Panneaux « exploitation » : services systemd, logs en direct (journalctl, nginx, fichiers) et Docker.
// Chargé après panels.js : réutilise h, t, icon, toast, ensure, tabs, modal, errText, hib, lvl…

// ============================================================ Services systemd
const newSvc = () => ({ list: [], filter: 'all', query: '', busy: new Set(), error: null, loaded: false, ui: null })

async function svcLoad(tab) {
  const S = tab.svc
  try { await ensure(tab); S.list = await api.invoke('svc:list', tab.connId); S.error = null } catch (e) { S.error = errText(e) }
  S.loaded = true
}
async function svcPoll(tab) {
  await svcLoad(tab)
  if (tab.panel === 'services') fillSvcList(tab)
}

async function svcAct(tab, unit, action) {
  if (action !== 'start' && !confirm(t('svc.confirm.' + action, { unit }))) return
  const S = tab.svc
  S.busy.add(unit)
  fillSvcList(tab)
  try {
    await api.invoke('svc:action', tab.connId, unit, action)
    toast(t('svc.ok.' + action, { unit }))
  } catch (e) { toast(t('svc.err', { action: t('svc.' + action), unit, error: errText(e) }), true) }
  S.busy.delete(unit)
  await svcLoad(tab)
  if (tab.panel === 'services') fillSvcList(tab)
}

const SVC_FILTERS = { all: () => true, running: s => s.active === 'active', failed: s => s.active === 'failed', stopped: s => s.active !== 'active' && s.active !== 'failed' }

function renderServices(tab) {
  const S = tab.svc
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => svcPoll(tab)))
  const input = h('input', { className: 's-filter', spellcheck: false, value: S.query, oninput: () => { S.query = input.value; fillSvcList(tab) } })
  input.placeholder = t('svc.search')
  const chips = Object.keys(SVC_FILTERS).map(k => {
    const b = h('button', { className: 'chip' + (S.filter === k ? ' on' : ''), onclick: () => { S.filter = k; chips.forEach(c => c.classList.toggle('on', c.dataset.k === k)); fillSvcList(tab) } })
    b.dataset.k = k
    return b
  })
  const list = h('div', { className: 'svc-list' })
  S.ui = { input, chips, list }
  tab.rpanelBody.append(h('div', { className: 'svc-tools' }, input, h('div', { className: 'chips' }, ...chips)), list)
  fillSvcList(tab)
}

function fillSvcList(tab) {
  const S = tab.svc, ui = S.ui
  if (!ui || tab.panel !== 'services') return
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
    const btn = (name, action, fn) => h('button', { className: 'ib', innerHTML: icon(name), title: t(action), disabled: busy, onclick: fn })
    ui.list.append(h('div', { className: 'svc' },
      h('span', { className: 'dot lv-' + (s.active === 'active' ? 'ok' : s.active === 'failed' ? 'crit' : 'idle'), title: `${s.active} / ${s.sub}` }),
      h('div', { className: 'svc-main' }, h('b', { textContent: s.unit.replace(/\.service$/, '') }), h('small', { className: 'dim', textContent: s.desc })),
      h('span', { className: 'svc-btns' },
        btn('scroll', 'svc.logs', () => openUnitLogs(tab, s.unit)),
        ...(s.active === 'active'
          ? [btn('refresh', 'svc.restart', () => svcAct(tab, s.unit, 'restart')), btn('stop', 'svc.stop', () => svcAct(tab, s.unit, 'stop'))]
          : [btn('play', 'svc.start', () => svcAct(tab, s.unit, 'start')), ...(s.active === 'failed' ? [btn('refresh', 'svc.restart', () => svcAct(tab, s.unit, 'restart'))] : [])]))))
  }
}

// ============================================================ Logs en direct
const logViews = new Map() // id de flux -> vue
let logFavs = []

const newLogs = () => ({ src: 'journal', unit: '', path: '', lv: null })

const LOG_SOURCES = {
  journal: { kind: 'journal' },
  unit: { kind: 'journal', needs: 'unit' },
  nginx_error: { kind: 'file', path: '/var/log/nginx/error.log' },
  nginx_access: { kind: 'file', path: '/var/log/nginx/access.log' },
  syslog: { kind: 'file', path: '/var/log/syslog' },
  auth: { kind: 'file', path: '/var/log/auth.log' },
  file: { kind: 'file', needs: 'path' },
}

const hhmmss = ts => new Date(ts).toLocaleTimeString(lang, { hour12: false })

// surligne les occurrences du filtre dans le message
function highlight(msg, text) {
  if (!text) return [msg]
  const out = []
  const lo = msg.toLowerCase(), q = text.toLowerCase()
  let i = 0
  for (let j; (j = lo.indexOf(q, i)) >= 0; i = j + q.length) {
    out.push(msg.slice(i, j), h('mark', { textContent: msg.slice(j, j + q.length) }))
  }
  out.push(msg.slice(i))
  return out
}

// Vue de logs réutilisable (panneau logs et logs d'un conteneur) : flux, filtre texte, niveau, suivi, compteurs.
function createLogView(tab, { favorite = false } = {}) {
  const S = { lines: [], text: '', level: 'all', follow: true, id: null, spec: null, state: 'idle', code: null, perm: false, errors: 0, warns: 0 }
  const lv = { S }
  const MAX = 3000

  const input = h('input', { className: 'lf', spellcheck: false, oninput: () => { S.text = input.value; lv.render() } })
  input.placeholder = t('log.filter_ph')
  const levelSel = h('select', { className: 'lsel', onchange: () => { S.level = levelSel.value; lv.render() } },
    ...['all', 'warn', 'error'].map(k => h('option', { value: k, textContent: t('log.level.' + k) })))
  const followBtn = h('button', { className: 'ib on', innerHTML: icon('arrow-down'), title: t('log.follow'), onclick: () => { S.follow = true; lv.render() } })
  const clearBtn = h('button', { className: 'ib', innerHTML: icon('trash'), title: t('log.clear'), onclick: () => { S.lines = []; S.errors = S.warns = 0; lv.render() } })
  const counters = h('div', { className: 'lcount' })
  const banner = h('div', { className: 'lbanner', hidden: true })
  const list = h('div', { className: 'llist' })
  list.addEventListener('scroll', () => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24
    if (atBottom !== S.follow) { S.follow = atBottom; followBtn.classList.toggle('on', S.follow) }
  })

  lv.favBtn = h('button', { className: 'ib', innerHTML: icon('star'), title: t('log.fav_save') })
  lv.el = h('div', { className: 'logview' }, h('div', { className: 'ltools' }, input, levelSel, ...(favorite ? [lv.favBtn] : []), followBtn, clearBtn), counters, banner, list)
  lv.syncInputs = () => { input.value = S.text; levelSel.value = S.level }

  const matches = l => (S.level === 'all' || (S.level === 'warn' ? l.lv === 'warn' || l.lv === 'error' : l.lv === 'error'))
    && (!S.text || l.m.toLowerCase().includes(S.text.toLowerCase()) || (l.src || '').toLowerCase().includes(S.text.toLowerCase()))

  let raf = 0
  lv.render = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      followBtn.classList.toggle('on', S.follow)
      counters.replaceChildren(
        h('span', { className: 'mchip lv-' + (S.errors ? 'crit' : 'idle'), textContent: t('log.errors', { n: S.errors }) }),
        h('span', { className: 'mchip lv-' + (S.warns ? 'warn' : 'idle'), textContent: t('log.warnings', { n: S.warns }) }),
        h('span', { className: 'dim', textContent: t('log.lines', { n: S.lines.length }) }),
        S.state === 'live' ? h('span', { className: 'live', textContent: '● ' + t('log.live') }) : S.state === 'ended' ? h('span', { className: 'dim', textContent: t('log.ended', { code: S.code ?? '?' }) }) : '')
      banner.hidden = !S.perm
      banner.replaceChildren(...(S.perm ? [h('span', { textContent: t('log.permission') }), h('button', { textContent: t('log.use_sudo'), onclick: () => lv.start({ ...S.spec, sudo: true }) })] : []))
      const shown = S.lines.filter(matches).slice(-500)
      list.replaceChildren(...(shown.length
        ? shown.map(l => h('div', { className: 'll ll-' + l.lv },
          h('span', { className: 'lt', textContent: l.ts ? hhmmss(l.ts) : '' }),
          l.src ? h('span', { className: 'ls' }, ...highlight(l.src, S.text)) : '',
          h('span', { className: 'lm' }, ...highlight(l.m, S.text))))
        : [h('div', { className: 'msg small', textContent: t('log.waiting') })]))
      if (S.follow) list.scrollTop = list.scrollHeight
    })
  }

  lv.add = lines => {
    for (const l of lines) {
      // stderr (docker logs, tail…) : « warn » par défaut, mais un vrai niveau lisible dans le texte l'emporte
      const guess = logfmt.levelOf(l.m)
      l.lv ??= l.err && guess === 'info' ? 'warn' : guess
      if (l.lv === 'error') S.errors++
      else if (l.lv === 'warn') S.warns++
      if (S.lines.length < 20 && /permission denied|insufficient permissions|not seeing messages from other users/i.test(l.m)) S.perm = true
      S.lines.push(l)
    }
    if (S.lines.length > MAX) S.lines.splice(0, S.lines.length - MAX)
    lv.render()
  }

  lv.stop = () => {
    if (S.id) { logViews.delete(S.id); api.invoke('log:stop', S.id) }
    S.id = null
    if (S.state === 'live') S.state = 'idle'
  }

  lv.start = async spec => {
    lv.stop()
    Object.assign(S, { lines: [], errors: 0, warns: 0, perm: false, spec, state: 'live', code: null })
    lv.render()
    try {
      await ensure(tab)
      const id = await api.invoke('log:start', tab.connId, spec)
      if (S.state !== 'live') return api.invoke('log:stop', id) // arrêté pendant le démarrage
      S.id = id
      logViews.set(id, lv)
    } catch (e) {
      S.state = 'ended'
      lv.add([{ m: errText(e), err: true }])
    }
  }
  lv.ended = code => { logViews.delete(S.id); S.id = null; S.state = 'ended'; S.code = code; lv.render() }
  lv.syncInputs()
  return lv
}

api.on('log:data', (id, lines) => logViews.get(id)?.add(lines))
api.on('log:end', (id, code) => logViews.get(id)?.ended(code))

function specOf(L) {
  const src = LOG_SOURCES[L.src]
  if (src.needs === 'unit') return { kind: 'journal', unit: L.unit.trim() }
  if (src.needs === 'path') return { kind: 'file', path: L.path.trim() }
  return src.path ? { kind: 'file', path: src.path } : { kind: 'journal' }
}

function startLogs(tab) {
  const L = tab.logs
  const spec = specOf(L)
  const needs = LOG_SOURCES[L.src].needs
  if ((needs === 'unit' && !spec.unit) || (needs === 'path' && !spec.path.startsWith('/'))) return
  L.lv.start(spec)
}

// le bouton « logs » d'un service ouvre le panneau logs sur cette unité
function openUnitLogs(tab, unit) {
  Object.assign(tab.logs, { src: 'unit', unit })
  if (tab.panel !== 'logs') setPanel(tab, 'logs')
  else renderPanel(tab)
  startLogs(tab)
}

function renderLogs(tab) {
  const L = tab.logs
  L.lv ??= createLogView(tab, { favorite: true })
  const lv = L.lv
  lv.syncInputs()

  const sel = h('select', { className: 'lsel src', onchange: () => { L.src = sel.value; renderPanel(tab); startLogs(tab) } },
    ...Object.keys(LOG_SOURCES).map(k => h('option', { value: k, textContent: t('log.src.' + k) })))
  sel.value = L.src
  const needs = LOG_SOURCES[L.src].needs
  const extra = needs ? h('input', { className: 'lf', spellcheck: false, value: L[needs], placeholder: t(needs === 'unit' ? 'log.unit_ph' : 'log.path_ph'), oninput: () => { L[needs] = extra.value }, onkeydown: e => { if (e.key === 'Enter') startLogs(tab) } }) : null
  const live = lv.S.state === 'live'
  const run = h('button', { className: 'ib', innerHTML: icon(live ? 'stop' : 'play'), title: t(live ? 'log.stop' : 'log.start'), onclick: () => { L.userStopped = live; if (live) lv.stop(); else startLogs(tab); renderPanel(tab) } })

  const favs = h('div', { className: 'favs' })
  const paintFavs = () => {
    favs.replaceChildren(h('small', { className: 'dim', textContent: t('log.favs') }),
      ...(logFavs.length
        ? logFavs.map(f => h('span', { className: 'fav' },
          h('button', { className: 'chip', textContent: f.name, title: [f.text, f.level !== 'all' ? t('log.level.' + f.level) : ''].filter(Boolean).join(' · '), onclick: () => applyFav(f) }),
          h('button', { className: 'fx', innerHTML: icon('x'), onclick: async () => { logFavs = await api.invoke('favs:delete', f.id); paintFavs() } })))
        : [h('small', { className: 'dim', textContent: t('log.no_favs') })]))
  }
  const applyFav = f => {
    Object.assign(L, { src: f.source.key, unit: f.source.unit || '', path: f.source.path || '' })
    Object.assign(lv.S, { text: f.text, level: f.level })
    renderPanel(tab)
    startLogs(tab)
  }
  lv.favBtn.onclick = async () => {
    const v = await modal(t('log.fav_save'), [{ name: 'name', label: t('log.fav_name'), value: lv.S.text || t('log.src.' + L.src) }], t('btn.save'))
    if (v?.name.trim()) { logFavs = await api.invoke('favs:save', { name: v.name.trim(), text: lv.S.text, level: lv.S.level, source: { key: L.src, unit: L.unit, path: L.path } }); paintFavs() }
  }
  paintFavs()

  tab.rpanelBody.classList.add('flush')
  tab.rpanelBody.append(h('div', { className: 'lsrc' }, sel, ...(extra ? [extra] : []), run), favs, lv.el)
  lv.syncInputs()
  lv.render()
  if (lv.S.state !== 'live' && !L.userStopped) startLogs(tab)
}

const leaveLogs = tab => { tab.logs.lv?.stop(); tab.logs.userStopped = false }

// ============================================================ Docker
const newDocker = () => ({ sub: 'containers', containers: [], images: [], error: null, loaded: false, busy: new Set(), view: null, polling: false })

async function dockerPoll(tab) {
  const D = tab.docker
  if (D.view || D.polling) return
  D.polling = true
  try {
    await ensure(tab)
    if (D.sub === 'containers') D.containers = await api.invoke('docker:list', tab.connId)
    else D.images = await api.invoke('docker:images', tab.connId)
    D.error = null
  } catch (e) { D.error = errText(e) }
  D.loaded = true
  D.polling = false
  if (tab.panel === 'docker' && !D.view) paintDocker(tab)
}

function leaveDocker(tab) {
  const D = tab.docker
  D.view?.lv?.stop()
  D.view = null
}

async function dockerAct(tab, c, action) {
  if (action !== 'start' && !confirm(t('docker.confirm.' + action, { name: c.name }))) return
  const D = tab.docker
  D.busy.add(c.id)
  paintDocker(tab)
  try {
    await api.invoke('docker:action', tab.connId, c.id, action)
    toast(t('docker.ok.' + action, { name: c.name }))
  } catch (e) { toast(t('svc.err', { action: t('svc.' + action), unit: c.name, error: errText(e) }), true) }
  D.busy.delete(c.id)
  D.polling = false
  await dockerPoll(tab)
}

function dockerLogs(tab, c) {
  const lv = createLogView(tab)
  tab.docker.view = { type: 'logs', title: t('docker.logs_of', { name: c.name }), lv }
  paintDocker(tab)
  lv.start({ kind: 'docker', id: c.id })
}

async function dockerInspect(tab, kind, id, name) {
  const D = tab.docker
  const view = (D.view = { type: 'inspect', title: t('docker.inspect_of', { name }), data: null, error: null })
  paintDocker(tab)
  try { view.data = await api.invoke('docker:inspect', tab.connId, kind, id) } catch (e) { view.error = errText(e) }
  if (tab.panel === 'docker' && D.view === view) paintDocker(tab)
}

function renderDocker(tab) {
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => { tab.docker.polling = false; dockerPoll(tab) }))
  tab.dockerBody = h('div', { className: 'docker-view' })
  tab.rpanelBody.append(tab.dockerBody)
  paintDocker(tab)
}

const stateLevel = s => (s === 'running' ? 'ok' : s === 'exited' || s === 'created' ? 'idle' : s === 'dead' ? 'crit' : 'warn')

function paintDocker(tab) {
  const D = tab.docker, body = tab.dockerBody
  if (!body || tab.panel !== 'docker') return
  body.replaceChildren()
  const back = () => h('div', { className: 'dback' },
    h('button', { className: 'ib', innerHTML: icon('arrow-left'), title: t('docker.back'), onclick: () => { D.view?.lv?.stop(); D.view = null; D.polling = false; paintDocker(tab); dockerPoll(tab) } }),
    h('b', { textContent: D.view.title }))

  tab.rpanelBody.classList.toggle('flush', D.view?.type === 'logs')
  if (D.view?.type === 'logs') {
    body.append(back(), D.view.lv.el)
    return D.view.lv.render()
  }
  if (D.view?.type === 'inspect') {
    const v = D.view
    body.append(back())
    if (v.error) return body.append(h('div', { className: 'msg small err', textContent: v.error }))
    if (!v.data) return body.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
    return body.append(
      h('div', { className: 'kvtable' }, ...v.data.rows.map(([k, val]) => h('div', { className: 'kvrow' }, h('span', { className: 'k', textContent: k }), h('span', { className: 'v', textContent: Array.isArray(val) ? val.join('\n') : val })))),
      h('details', { className: 'res' }, h('summary', { textContent: t('docker.raw') }), h('pre', { textContent: v.data.raw })))
  }

  const seg = h('div', { className: 'seg' }, ...[['containers', 'box', 'docker.tab.containers'], ['images', 'archive', 'docker.tab.images']].map(([k, ic, key]) =>
    h('button', { className: k === D.sub ? 'on' : '', innerHTML: icon(ic) + `<span>${t(key)}</span>`, onclick: () => { D.sub = k; D.loaded = false; D.polling = false; paintDocker(tab); dockerPoll(tab) } })))
  body.append(seg)
  const msg = (text, cls = '') => body.append(h('div', { className: 'msg small ' + cls, textContent: text }))
  if (D.error) return msg(D.error, 'err')
  if (!D.loaded) return msg(t('dash.checking'))

  if (D.sub === 'images') {
    if (!D.images.length) return msg(t('docker.no_images'))
    for (const im of D.images) {
      const name = im.repo === '<none>' ? im.id : `${im.repo}:${im.tag}`
      body.append(h('div', { className: 'dk click', onclick: () => dockerInspect(tab, 'image', im.id, name), title: t('docker.inspect') },
        h('span', { className: 'dk-ic', innerHTML: icon('archive') }),
        h('div', { className: 'svc-main' }, h('b', { textContent: name }), h('small', { className: 'dim', textContent: `${im.id} · ${im.created}` })),
        h('span', { className: 'mchip lv-idle', textContent: im.size })))
    }
    return
  }

  if (!D.containers.length) return msg(t('docker.none'))
  const rank = c => (c.state === 'running' ? 0 : 1)
  for (const c of [...D.containers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))) {
    const busy = D.busy.has(c.id)
    const btn = (name, key, fn) => h('button', { className: 'ib', innerHTML: icon(name), title: t(key), disabled: busy, onclick: fn })
    const running = c.state === 'running'
    body.append(h('div', { className: 'dk' },
      h('span', { className: 'dot lv-' + stateLevel(c.state), title: c.state }),
      h('div', { className: 'svc-main' },
        h('b', { textContent: c.name }),
        h('small', { className: 'dim', textContent: `${c.image} · ${c.status}` }),
        running && c.cpu != null ? h('span', { className: 'dk-res' },
          h('span', { className: 'mchip lv-' + lvl(c.cpu, 70, 90), textContent: `CPU ${c.cpu.toFixed(1)}%` }),
          h('span', { className: 'mchip lv-' + lvl(c.mem, 70, 90), textContent: `RAM ${c.mem.toFixed(1)}%${c.memUsage ? ' · ' + c.memUsage.split(' / ')[0] : ''}` })) : ''),
      h('span', { className: 'svc-btns' },
        btn('scroll', 'docker.logs', () => dockerLogs(tab, c)),
        btn('info', 'docker.inspect', () => dockerInspect(tab, 'container', c.id, c.name)),
        ...(running
          ? [btn('refresh', 'svc.restart', () => dockerAct(tab, c, 'restart')), btn('stop', 'svc.stop', () => dockerAct(tab, c, 'stop'))]
          : [btn('play', 'svc.start', () => dockerAct(tab, c, 'start'))]))))
  }
}

// ============================================================ Chemins enregistrés
// { id, name, path, serverId } ; sans serverId = valable pour tous les serveurs
let savedPaths = []
const pathsOf = tab => ({ here: savedPaths.filter(p => sharedVisible(p,tab)&&p.serverId === tab.server.id), all: savedPaths.filter(p => sharedVisible(p,tab)&&!p.serverId) })

async function pathForm(tab, entry, scope) {
  const v = await modal(entry ? t('paths.edit_title') : t('paths.new_title'), [
    ...(sharedLocationField(entry,tab.server.teamId||'')?[sharedLocationField(entry,tab.server.teamId||'')]:[]),
    { name: 'name', label: t('paths.name'), value: entry?.name, placeholder: t('paths.name_ph') },
    { name: 'path', label: t('paths.path'), value: entry?.path ?? (tab.path || tab.active?.path || ''), placeholder: '/var/log/app' },
    { name: 'allServers', type: 'checkbox', requireScope:entry?.serverId?(entry.teamId||''):(tab.server.teamId||''), label: t('paths.share_all'), value: entry ? !entry.serverId : scope === 'all' },
  ], entry ? t('btn.save') : t('btn.add_ok'))
  if (!v) return
  try {
    const serverId = v.allServers ? null : (entry?.serverId || tab.server.id)
    savedPaths = await api.invoke('paths:save', { id: entry?.id, teamId:v.teamId, name: v.name, path: v.path, serverId })
    repaintPaths()
  } catch (e) { toast(errText(e), true) }
}

async function deletePath(p) {
  if (!confirm(t('paths.confirm_delete', { name: p.name || p.path }))) return
  savedPaths = await api.invoke('paths:delete', p.id)
  repaintPaths()
}

// emmène un volet de l'explorateur sur le chemin enregistré
function gotoPath(pane, p) {
  hidePathsBoxes()
  load(pane, p.path)
}

function repaintPaths() {
  tabs.forEach(tb => {
    if (tb.panel === 'paths') paintPaths(tb)
    tb.panes.forEach(paintPathsBox)
  })
}
const hidePathsBoxes = () => tabs.forEach(tb => tb.panes.forEach(p => (p.pathsBox.hidden = true)))

// panneau de droite : deux sections (ce serveur / tous les serveurs)
function renderPaths(tab) {
  tab.rpanelActions.append(hib('bookmark', 'paths.current', () => pathForm(tab, null, 'here')))
  paintPaths(tab)
}

function paintPaths(tab) {
  if (tab.panel !== 'paths') return
  const body = tab.rpanelBody
  body.replaceChildren()
  const { here, all } = pathsOf(tab)
  const section = (titleKey, list, scope) => {
    body.append(h('div', { className: 'ps-head' }, h('h4', { textContent: t(titleKey) }), hib('plus', 'paths.add', () => pathForm(tab, null, scope))))
    if (!list.length) body.append(h('div', { className: 'msg small', textContent: t('paths.none') }))
    for (const p of list) {
      body.append(h('div', { className: 'ps-row', title: p.path, onclick: () => gotoPath(tab.active, p) },
        h('span', { className: 'ps-ic', innerHTML: icon('folder') }),
        h('div', { className: 'svc-main' }, h('b', { textContent: p.name || p.path }),h('small',{className:'dim',textContent:sharedScopeName(p)}), p.name ? h('small', { className: 'dim mono', textContent: p.path }) : ''),
        h('span', { className: 'svc-btns' },
          ...(!p.teamId||p.canEditServers?[hib('pencil', 'qa.edit', e => { e.stopPropagation(); pathForm(tab, p) }),
          hib('trash', 'qa.delete', e => { e.stopPropagation(); deletePath(p) })]:[]))))
    }
  }
  section('paths.this', here, 'here')
  section('paths.all', all, 'all')
}

// liste déroulante accrochée à la barre de chemin de chaque volet
function paintPathsBox(ex) {
  const box = ex.pathsBox
  if (!box) return
  box.replaceChildren()
  const { here, all } = pathsOf(ex)
  const rows = [...here, ...all]
  if (!rows.length) box.append(h('div', { className: 'msg small', textContent: t('paths.none') }))
  for (const p of rows) {
    box.append(h('div', { className: 'pb-row', title: p.path, onclick: () => gotoPath(ex, p) },
      h('span', { className: 'ps-ic', innerHTML: icon(p.serverId ? 'bookmark' : 'globe') }),
      h('b', { textContent: p.name || p.path }),
      p.name ? h('span', { className: 'pb-path', textContent: p.path }) : ''))
  }
  box.append(h('hr'),
    h('div', { className: 'pb-act', onclick: () => { hidePathsBoxes(); pathForm(ex, null, 'here') } }, h('span', { innerHTML: icon('plus') }), h('span', { textContent: t('paths.current') })),
    h('div', { className: 'pb-act', onclick: () => { hidePathsBoxes(); if (ex.root.panel !== 'paths') setPanel(ex.root, 'paths') } }, h('span', { innerHTML: icon('cog') }), h('span', { textContent: t('paths.manage') })))
}
