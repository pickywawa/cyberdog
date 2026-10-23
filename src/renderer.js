const $ = s => document.querySelector(s)
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e }
const uid = () => crypto.randomUUID()
const join = (a, b) => (a === '/' ? '' : a) + '/' + b
const { icon, fileIcon } = icons
const { LANGS } = i18n

let lang = 'en'
let theme = 'system'
let servers = []
let tabs = []
let activeId = null
let toastTimer
const t = (k, v) => i18n.t(lang, k, v)

// ---------- i18n / thèmes ----------
const THEMES = {
  system: ['#ffffff', '#16171d'],
  light: ['#4f6bff', '#19c3d6'],
  dark: ['#6d8bff', '#22d3c5'],
  midnight: ['#3ea6ff', '#7c5cff'],
  dracula: ['#bd93f9', '#ff79c6'],
  forest: ['#34d399', '#a3e635'],
  sunset: ['#ff7a59', '#ffc46b'],
}
const mq = matchMedia('(prefers-color-scheme: dark)')
const termTheme = () => {
  const s = getComputedStyle(document.documentElement)
  const v = n => s.getPropertyValue(n).trim()
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--accent'), selectionBackground: v('--sel') }
}
function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
  tabs.forEach(tb => tb.term && (tb.term.options.theme = termTheme()))
  $('#btn-theme .lbl').textContent = t('theme.' + theme)
}
mq.onchange = applyTheme

function applyIcons(root) { root.querySelectorAll('[data-icon]').forEach(e => (e.innerHTML = icon(e.dataset.icon))) }
function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach(e => (e.textContent = t(e.dataset.i18n)))
  root.querySelectorAll('[data-i18n-title]').forEach(e => (e.title = t(e.dataset.i18nTitle)))
  root.querySelectorAll('[data-i18n-ph]').forEach(e => (e.placeholder = t(e.dataset.i18nPh)))
}
function refreshLanguage() {
  document.documentElement.lang = lang
  applyI18n(document)
  $('#btn-theme').title = t('theme')
  $('#btn-lang').title = t('language')
  $('#btn-theme .lbl').textContent = t('theme.' + theme)
  $('#btn-lang .lbl').textContent = LANGS[lang]
  renderServers()
  tabs.forEach(tb => {
    applyI18n(tb.el)
    draw(tb)
    renderPanel(tb)
    updateBar(tb)
    paintSearch(tb)
  })
}

// messages d'erreur ssh2/Node → texte traduit
const AUTH_FAIL = /authentication methods failed|authentication failure/i
function errText(e) {
  const m = e.message || String(e)
  if (AUTH_FAIL.test(m)) return t('err.auth')
  if (/ECONNREFUSED/.test(m)) return t('err.refused')
  if (/ETIMEDOUT|timed out/i.test(m)) return t('err.timeout')
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return t('err.notfound')
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return t('err.unreachable')
  if (/permission denied/i.test(m)) return t('err.denied')
  return m
}

// ---------- UI utils ----------
function toast(msg, err, ms = 3500) {
  const el = $('#toast')
  el.textContent = msg
  el.className = err ? 'err' : ''
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), ms)
}
api.on('toast', toast)

const hideMenu = () => ($('#menu').hidden = true)
// items : { label, icon?, swatch?, checked?, danger?, fn | children } ou '-'
function menu(x, y, items, { up = false } = {}) {
  const m = $('#menu')
  m.replaceChildren()
  const build = (items, parent) => {
    for (const it of items) {
      if (it === '-') { parent.append(h('hr')); continue }
      const lead = it.swatch ? h('span', { className: 'sw', style: `background: linear-gradient(135deg, ${it.swatch[0]} 50%, ${it.swatch[1]} 50%)` }) : h('span', { className: 'mi-ic', innerHTML: it.icon ? icon(it.icon) : '' })
      const li = h('div', { className: 'mi' + (it.danger ? ' danger' : '') }, lead, h('span', { className: 'mi-t', textContent: it.label }), h('span', { className: 'mi-chk', innerHTML: it.checked ? icon('check') : '' }))
      if (it.children) {
        li.classList.add('sub')
        const sub = h('div', { className: 'submenu' })
        li.append(sub)
        li.onmouseenter = async () => { if (!sub.childElementCount) build(await it.children(), sub) }
      } else li.onclick = () => { hideMenu(); it.fn() }
      parent.append(li)
    }
  }
  build(items, m)
  m.hidden = false
  m.classList.toggle('flip', x > innerWidth - 460)
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(up ? y - m.offsetHeight : y, innerHeight - m.offsetHeight - 8)) + 'px'
}
addEventListener('mousedown', e => {
  if (!e.target.closest('#menu')) hideMenu()
  if (!e.target.closest('.searchbox, .js-search-btn')) tabs.forEach(tb => (tb.searchBox.hidden = true))
})
addEventListener('keydown', e => {
  const tab = tabs.find(tb => tb.id === activeId)
  if (tab && (e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); toggleSearch(tab, true) }
})
addEventListener('blur', hideMenu)
addEventListener('keydown', e => e.key === 'Escape' && hideMenu())
// évite que Electron navigue vers un fichier déposé hors zone
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => e.preventDefault())

// NB : un handler on* qui renvoie false annule l'action par défaut (focus, saisie) : toujours des blocs ici.
function modal(title, fields, okLabel, { wide = false } = {}) {
  return new Promise(resolve => {
    const m = $('#modal')
    const inputs = fields.map(f => f.type === 'textarea'
      ? h('textarea', { value: f.value || '', placeholder: f.placeholder || '', rows: 12, spellcheck: false })
      : h('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' }))
    const close = v => { m.hidden = true; m.replaceChildren(); resolve(v) }
    const form = h('form', {
      className: 'card' + (wide ? ' wide' : ''),
      onsubmit: e => { e.preventDefault(); close(Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value]))) },
      onkeydown: e => { if (e.key === 'Escape') close(null) },
    },
      h('h3', { textContent: title }),
      ...fields.map((f, i) => h('label', {}, f.label, inputs[i])),
      h('div', { className: 'btns' },
        h('button', { type: 'button', textContent: t('btn.cancel'), onclick: () => close(null) }),
        h('button', { className: 'primary', textContent: okLabel })))
    m.onmousedown = e => { if (e.target === m) close(null) }
    m.replaceChildren(form)
    m.hidden = false
    inputs[0].focus()
    inputs[0].select()
  })
}

// ---------- Serveurs ----------
async function serverForm(s) {
  const v = await modal(s ? t('form.edit_title') : t('form.add_title'), [
    { name: 'name', label: t('f.name'), value: s?.name, placeholder: t('f.name_ph') },
    { name: 'host', label: t('f.host'), value: s?.host, placeholder: '192.168.1.10' },
    { name: 'port', label: t('f.port'), value: s?.port ?? 22 },
    { name: 'user', label: t('f.user'), value: s?.user, placeholder: 'root' },
    { name: 'pass', label: t('f.pass'), type: 'password', placeholder: s?.hasPass ? t('f.pass_keep') : t('f.pass_ph') },
  ], s ? t('btn.save') : t('btn.add_ok'))
  if (!v) return
  try { servers = await api.invoke('servers:save', { ...v, id: s?.id }); renderServers() } catch (e) { toast(errText(e), true) }
}

// mot de passe manquant ou refusé : on le demande, on l'enregistre, l'appelant réessaie
async function askPassword(s) {
  const v = await modal(t('pw.title', { target: `${s.user}@${s.host}` }), [{ name: 'pass', label: t('f.pass'), type: 'password' }], t('btn.connect'))
  if (!v?.pass) return false
  try { servers = await api.invoke('servers:save', { ...s, pass: v.pass }); renderServers(); return true } catch (e) { toast(errText(e), true); return false }
}

const hue = name => Math.abs([...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360
let dragId = null
function renderServers() {
  const ul = $('#servers')
  ul.replaceChildren()
  const activeServer = tabs.find(tb => tb.id === activeId)?.server.id
  for (const s of servers) {
    const hh = hue(s.name)
    const li = h('li', { className: s.id === activeServer ? 'active' : '', draggable: true },
      h('span', { className: 'tile', innerHTML: icon('server'), style: `background: linear-gradient(135deg, hsl(${hh} 75% 58%), hsl(${(hh + 45) % 360} 75% 48%))` }),
      h('div', { className: 'txt' }, h('span', { className: 'name', textContent: s.name }), h('span', { className: 'host', textContent: `${s.user}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` })),
      h('button', { className: 'ib edit', innerHTML: icon('pencil'), title: t('srv.edit_tip'), onclick: e => { e.stopPropagation(); serverForm(s) } }))
    li.onclick = () => openFiles(s)
    li.oncontextmenu = e => {
      e.preventDefault()
      menu(e.clientX, e.clientY, [
        { label: t('srv.open'), icon: 'folder', fn: () => openFiles(s) },
        { label: t('srv.terminal'), icon: 'terminal', fn: () => openFiles(s, { terminal: true }) },
        '-',
        { label: t('srv.edit'), icon: 'pencil', fn: () => serverForm(s) },
        { label: t('srv.delete'), icon: 'trash', danger: true, fn: async () => { if (confirm(t('srv.confirm_delete', { name: s.name }))) { servers = await api.invoke('servers:delete', s.id); renderServers() } } },
      ])
    }
    li.ondragstart = e => { dragId = s.id; e.dataTransfer.effectAllowed = 'move' }
    li.ondragend = () => { dragId = null }
    li.ondragover = e => { if (dragId) { e.preventDefault(); li.classList.add('over') } }
    li.ondragleave = () => li.classList.remove('over')
    li.ondrop = async e => {
      e.preventDefault()
      li.classList.remove('over')
      if (!dragId || dragId === s.id) return
      const ids = servers.map(x => x.id)
      ids.splice(ids.indexOf(s.id), 0, ...ids.splice(ids.indexOf(dragId), 1))
      servers = await api.invoke('servers:reorder', ids)
      renderServers()
    }
    ul.append(li)
  }
  $('#card-export').hidden = !servers.length
}

async function sortServers() {
  servers = await api.invoke('servers:reorder', [...servers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(s => s.id))
  renderServers()
}
const importFrom = ch => async () => {
  try {
    const r = await api.invoke(ch)
    if (!r) return
    servers = r.servers
    renderServers()
    toast(r.added ? `${t('t.imported', { n: r.added })} ${t('t.pw_hint')}` : t('t.nothing'), false, 6000)
  } catch (e) { toast(errText(e), true) }
}
const importZip = importFrom('servers:importZip')
const importCyberduck = importFrom('servers:import')
async function exportZip() {
  try {
    const r = await api.invoke('servers:exportZip')
    if (r) toast(t('t.exported', { n: r.count, path: r.path }), false, 6000)
  } catch (e) { toast(errText(e), true) }
}

$('#btn-add').onclick = $('#card-add').onclick = () => serverForm()
$('#btn-sort').onclick = sortServers
$('#btn-export').onclick = $('#card-export').onclick = exportZip
$('#card-cyberduck').onclick = importCyberduck
$('#card-zip').onclick = importZip
$('#btn-import').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect()
  menu(r.left, r.bottom + 4, [
    { label: t('menu.import_zip'), icon: 'archive', fn: importZip },
    { label: t('menu.import_cyberduck'), icon: 'download', fn: importCyberduck },
  ])
}
$('#btn-theme').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect()
  menu(r.left, r.top - 4, Object.keys(THEMES).map(k => ({ label: t('theme.' + k), swatch: THEMES[k], checked: k === theme, fn: () => setTheme(k) })), { up: true })
}
$('#btn-lang').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect()
  menu(r.left, r.top - 4, Object.entries(LANGS).map(([k, name]) => ({ label: name, checked: k === lang, fn: () => setLang(k) })), { up: true })
}
function setTheme(name) { theme = name; applyTheme(); api.invoke('settings:set', { theme }) }
function setLang(code) { lang = code; refreshLanguage(); api.invoke('settings:set', { lang }) }

// ---------- Onglets ----------
function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map(tb => h('div', { className: 'tab' + (tb.id === activeId ? ' active' : ''), onclick: () => activate(tb.id), onauxclick: e => { if (e.button === 1) closeTab(tb.id) } },
    h('span', { innerHTML: icon('folder'), style: 'display:inline-flex' }),
    h('span', { className: 't', textContent: tb.server.name }),
    h('span', { className: 'x', innerHTML: icon('x'), onclick: e => { e.stopPropagation(); closeTab(tb.id) } }))))
}

function activate(id) {
  activeId = id
  tabs.forEach(tb => (tb.el.hidden = tb.id !== id))
  $('#empty').hidden = tabs.length > 0
  renderTabs()
  renderServers()
  tabs.find(tb => tb.id === id)?.fit?.fit()
  syncPanels()
}

function closeTab(id) {
  const i = tabs.findIndex(tb => tb.id === id)
  const tb = tabs[i]
  if (tb.connId) api.invoke('conn:close', tb.connId)
  closeTerminal(tb)
  dashStop(tb)
  tb.el.remove()
  tabs.splice(i, 1)
  activate(activeId === id ? tabs[Math.min(i, tabs.length - 1)]?.id : activeId)
}

function addTab(tb) {
  tabs.push(tb)
  $('#panes').append(tb.el)
  activate(tb.id)
}

api.on('conn:closed', id => {
  const tb = tabs.find(x => x.connId === id || x.termId === id)
  if (!tb) return
  if (tb.connId === id) tb.connId = null
  else tb.term?.write(`\r\n\x1b[31m${t('term.closed')}\x1b[0m\r\n`)
})
api.on('term:data', (id, d) => tabs.find(tb => tb.termId === id)?.term?.write(d))

// ---------- Terminal (panneau du bas) ----------
async function openTerminal(tab) {
  if (tab.term) return
  const { server } = tab
  const term = new Terminal({ fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, theme: termTheme() })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  Object.assign(tab, { term, fit, termId: uid() })
  const id = tab.termId
  tab.termWrap.hidden = false
  updateBar(tab)
  term.open(tab.termBody)
  fit.fit()
  tab.termRO = new ResizeObserver(() => tab.termBody.offsetParent && fit.fit())
  tab.termRO.observe(tab.termBody)
  term.onData(d => api.send('term:write', id, d))
  term.onResize(({ cols, rows }) => api.send('term:resize', id, cols, rows))
  term.focus()
  term.write(t('term.connecting', { target: `${server.user}@${server.host}` }) + '\r\n')
  for (;;) {
    try { await api.invoke('term:open', id, server.id, term.cols, term.rows, tab.path || undefined); break } catch (e) {
      if (tab.termId !== id) return
      if (AUTH_FAIL.test(e.message) && (await askPassword(server))) continue
      term.write(`\x1b[31m${errText(e)}\x1b[0m\r\n`)
      break
    }
  }
}

function closeTerminal(tab) {
  if (!tab.term) return
  api.invoke('conn:close', tab.termId)
  tab.termRO.disconnect()
  tab.term.dispose()
  Object.assign(tab, { term: null, fit: null, termId: null })
  tab.termWrap.hidden = true
  updateBar(tab)
}
const toggleTerminal = tab => (tab.term ? closeTerminal(tab) : openTerminal(tab))

// ---------- Panneau de droite (un seul à la fois) ----------
function setPanel(tab, name) {
  tab.panel = tab.panel === name ? null : name
  renderPanel(tab)
  updateBar(tab)
  syncPanels()
}
function renderPanel(tab) {
  tab.rpanel.hidden = !tab.panel
  tab.rpanelActions.replaceChildren()
  tab.rpanelBody.replaceChildren()
  if (!tab.panel) return
  tab.rpanelTitle.textContent = t(tab.panel === 'dashboard' ? 'dash.title' : 'qa.title')
  if (tab.panel === 'dashboard') renderDashboard(tab)
  else renderActions(tab)
}
function updateBar(tab) {
  tab.bar.term.classList.toggle('on', !!tab.term)
  tab.bar.dashboard.classList.toggle('on', tab.panel === 'dashboard')
  tab.bar.actions.classList.toggle('on', tab.panel === 'actions')
  tab.termTitle.textContent = `${t('term.title')} — ${tab.server.user}@${tab.server.host}`
}

// ---------- Explorateur ----------
const COLS = [['name', 'col.name'], ['size', 'col.size'], ['mtime', 'col.modified'], ['owner', 'col.owner'], ['group', 'col.group'], ['mode', 'col.perms'], ['type', 'col.type'], ['ext', 'col.ext']]
const typeOf = e => t(e.isLink ? 'type.link' : e.isDir ? 'type.folder' : 'type.file')
const extOf = e => (!e.isDir && e.name.lastIndexOf('.') > 0 ? e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() : '')
const permsOf = e => (e.isLink ? 'l' : e.isDir ? 'd' : '-') + [6, 3, 0].map(s => 'rwx'.split('').map((c, i) => (e.mode >> s) & (4 >> i) ? c : '-').join('')).join('')
const sizeOf = n => { let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++ } return (i ? n.toFixed(1) : n) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i] }
const dateOf = ms => new Date(ms).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })
const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), lang, { numeric: true, sensitivity: 'base' }))
const nameCell = (iconHtml, kind, text) => h('div', { className: 'nm' }, h('span', { className: 'fi ic-' + kind, innerHTML: iconHtml }), h('span', { className: 'nt', textContent: text }))

async function ensure(tab) {
  if (tab.connId) return
  const r = await api.invoke('files:open', tab.server.id)
  tab.connId = r.id
  tab.home = r.home
}

async function load(tab, p, push = true) {
  tab.el.classList.add('loading')
  try {
    await ensure(tab)
    const r = await api.invoke('sftp:list', tab.connId, p ?? tab.home)
    if (push && tab.path && tab.path !== r.path) tab.hist.push(tab.path)
    Object.assign(tab, { path: r.path, entries: r.entries, sel: new Set(), last: null, error: null })
  } catch (e) {
    tab.pendingSelect = null
    if (AUTH_FAIL.test(e.message) && !tab.connId && (await askPassword(tab.server))) return load(tab, p, push)
    if (tab.path) toast(errText(e), true)
    else tab.error = errText(e)
  } finally {
    tab.el.classList.remove('loading')
  }
  draw(tab)
}

// exécute une action distante puis rafraîchit
async function act(tab, fn, refresh = true) {
  try { await ensure(tab); await fn(); if (refresh) await load(tab, tab.path, false) } catch (e) { toast(errText(e), true) }
}

function updateStatus(tab) {
  const n = tab.sel.size
  tab.statusL.textContent = t('ex.items', { n: tab.entries.length }) + (n ? ' · ' + t('ex.selected', { n }) : '')
}

function draw(tab) {
  tab.pathInput.value = tab.path || ''
  tab.back.disabled = !tab.hist.length
  tab.statusR.textContent = `${tab.server.user}@${tab.server.host}`
  const { key, dir } = tab.sort
  const val = e => (key === 'type' ? typeOf(e) : key === 'ext' ? extOf(e) : e[key])
  tab.view = [...tab.entries].sort((a, b) => b.isDir - a.isDir || cmp(val(a), val(b)) * dir)
  tab.head.replaceChildren(...COLS.map(([k, label]) => h('div', { onclick: () => { tab.sort = { key: k, dir: k === key ? -dir : 1 }; draw(tab) } },
    h('span', { textContent: t(label) }), h('span', { innerHTML: k === key ? icon(dir > 0 ? 'chevron-up' : 'chevron-down') : '', style: 'display:inline-flex' }))))
  tab.body.replaceChildren()
  if (tab.error) {
    tab.body.append(h('div', { className: 'msg err' }, tab.error, h('br'), h('br'), h('button', { textContent: t('btn.retry'), onclick: () => load(tab, null, false) })))
    return updateStatus(tab)
  }
  if (tab.path && tab.path !== '/') {
    tab.body.append(h('div', { className: 'row', ondblclick: () => load(tab, join(tab.path, '..')) }, nameCell(icon('up'), 'up', '..')))
  }
  tab.rowEls = tab.view.map((e, i) => {
    const fi = fileIcon(e, extOf(e))
    const row = h('div', { className: 'row' },
      nameCell(icon(fi.name), fi.kind, e.name),
      h('div', { className: 'dim', textContent: e.isDir ? '—' : sizeOf(e.size) }),
      h('div', { className: 'dim', textContent: dateOf(e.mtime) }),
      h('div', { textContent: e.owner }),
      h('div', { textContent: e.group }),
      h('div', { className: 'mono', textContent: permsOf(e) }),
      h('div', { className: 'dim', textContent: typeOf(e) }),
      h('div', { className: 'dim', textContent: extOf(e) }))
    row.dataset.name = e.name
    row.onclick = ev => {
      if (ev.shiftKey && tab.last != null) {
        const [a, b] = [tab.last, i].sort((x, y) => x - y)
        tab.sel = new Set(tab.view.slice(a, b + 1).map(x => x.name))
      } else if (ev.metaKey || ev.ctrlKey) {
        tab.sel.has(e.name) ? tab.sel.delete(e.name) : tab.sel.add(e.name)
        tab.last = i
      } else {
        tab.sel = new Set([e.name])
        tab.last = i
      }
      paintSel(tab)
    }
    row.ondblclick = () => { if (e.isDir) load(tab, join(tab.path, e.name)) }
    // glisser vers le Finder : préparation locale après 120 ms d'appui, drag natif au dragstart
    row.draggable = true
    row.onmousedown = ev => { if (ev.button === 0) { clearTimeout(tab.dragTimer); tab.dragTimer = setTimeout(() => prepareDrag(tab, e), 120) } }
    row.onmouseup = () => clearTimeout(tab.dragTimer)
    row.ondragstart = async ev => {
      ev.preventDefault()
      clearTimeout(tab.dragTimer)
      const prep = prepareDrag(tab, e)
      if (!prep.files) {
        toast(t('t.drag_preparing', { name: e.name }), false, 60000)
        await prep.promise
        $('#toast').hidden = true
      }
      if (prep.files) { tab.lastDragAt = Date.now(); api.send('drag:start', prep.files) }
    }
    return row
  })
  tab.body.append(...tab.rowEls)
  if (!tab.entries.length) tab.body.append(h('div', { className: 'msg', textContent: t('ex.empty') }))
  paintSel(tab)
  if (tab.pendingSelect) {
    const i = tab.view.findIndex(x => x.name === tab.pendingSelect)
    tab.pendingSelect = null
    if (i >= 0) { tab.sel = new Set([tab.view[i].name]); tab.last = i; paintSel(tab); tab.rowEls[i].scrollIntoView({ block: 'center' }) }
  }
}

function prepareDrag(tab, e) {
  const names = tab.sel.has(e.name) ? [...tab.sel] : [e.name]
  const key = tab.path + '\0' + names.join('\0')
  if (tab.dragPrep?.key === key) return tab.dragPrep
  const prep = { key, files: null }
  prep.promise = api.invoke('drag:prepare', tab.connId, names.map(n => join(tab.path, n)))
    .then(f => (prep.files = f))
    .catch(err => { tab.dragPrep = null; toast(errText(err), true) })
  tab.dragPrep = prep
  return prep
}

function paintSel(tab) {
  tab.rowEls?.forEach(r => r.classList.toggle('sel', tab.sel.has(r.dataset.name)))
  updateStatus(tab)
}

async function newItem(tab, kind) {
  const title = t(kind === 'dir' ? 'tb.new_folder' : 'tb.new_file')
  const v = await modal(title, [{ name: 'name', label: t('dlg.name') }], t('btn.create'))
  const name = v?.name.trim()
  if (name) act(tab, () => api.invoke(kind === 'dir' ? 'sftp:mkdir' : 'sftp:touch', tab.connId, join(tab.path, name)))
}

async function upload(tab, paths) {
  toast(t('t.uploading'), false, 60000)
  await act(tab, async () => {
    if (await api.invoke('sftp:upload', tab.connId, paths, tab.path)) toast(t('t.uploaded'))
    else $('#toast').hidden = true
  })
}

const appsMenu = (tab, remote) => async () => [
  ...(await api.invoke('apps:list')).map(a => ({ label: a.label, fn: () => act(tab, () => api.invoke('sftp:edit', tab.connId, remote, a.target), false) })),
  { label: t('ctx.default_app'), fn: () => act(tab, () => api.invoke('sftp:edit', tab.connId, remote), false) },
  '-',
  { label: t('ctx.other'), fn: async () => { const p = await api.invoke('apps:pick'); if (p) act(tab, () => api.invoke('sftp:edit', tab.connId, remote, p), false) } },
]

function ctxMenu(tab, e) {
  e.preventDefault()
  const base = [
    { label: t('tb.new_folder'), icon: 'folder-plus', fn: () => newItem(tab, 'dir') },
    { label: t('tb.new_file'), icon: 'file-plus', fn: () => newItem(tab, 'file') },
    { label: t('tb.refresh'), icon: 'refresh', fn: () => load(tab, tab.path, false) },
  ]
  const row = e.target.closest('[data-name]')
  if (!row) { tab.sel.clear(); paintSel(tab); return menu(e.clientX, e.clientY, base) }
  if (!tab.sel.has(row.dataset.name)) { tab.sel = new Set([row.dataset.name]); paintSel(tab) }
  const sel = tab.view.filter(x => tab.sel.has(x.name))
  const one = sel.length === 1 ? sel[0] : null
  const full = x => join(tab.path, x.name)
  menu(e.clientX, e.clientY, [
    { label: t('ctx.download'), icon: 'download', fn: () => act(tab, async () => { const r = await api.invoke('sftp:download', tab.connId, sel.map(full)); if (r) toast(t('t.downloaded', { path: r })) }, false) },
    { label: t('ctx.copy_name'), icon: 'copy', fn: () => navigator.clipboard.writeText(sel.map(x => x.name).join('\n')) },
    { label: t('ctx.copy_path'), icon: 'copy', fn: () => navigator.clipboard.writeText(sel.map(full).join('\n')) },
    ...(one && !one.isDir ? [{ label: t('ctx.edit_with'), icon: 'edit', children: appsMenu(tab, full(one)) }] : []),
    ...(one ? [{ label: t('ctx.rename'), icon: 'pencil', fn: async () => {
      const v = await modal(t('ctx.rename'), [{ name: 'name', label: t('dlg.new_name'), value: one.name }], t('btn.rename'))
      const n = v?.name.trim()
      if (n && n !== one.name) act(tab, () => api.invoke('sftp:rename', tab.connId, full(one), join(tab.path, n)))
    } }] : []),
    { label: t('ctx.delete'), icon: 'trash', danger: true, fn: () => confirm(one ? t('dlg.confirm_del_one', { name: one.name }) : t('dlg.confirm_del_many', { n: sel.length })) && act(tab, () => api.invoke('sftp:rm', tab.connId, sel.map(full))) },
    '-',
    ...base,
  ])
}

// ---------- Recherche ----------
function paintSearch(tab) {
  const { search: S, searchList: list } = tab
  list.replaceChildren()
  const note = key => list.append(h('div', { className: 'msg small', textContent: t(key) }))
  if (S.state === 'hint') return note('search.hint')
  if (S.state === 'loading') return note('search.searching')
  if (S.state === 'error') return list.append(h('div', { className: 'msg small err', textContent: S.error }))
  if (!S.results.length) return note('search.none')
  S.results.forEach((r, i) => {
    const slash = r.path.lastIndexOf('/')
    const fi = fileIcon({ isDir: r.isDir, isLink: false }, extOf({ name: r.path, isDir: r.isDir }))
    list.append(h('div', { className: 'sr' + (i === S.active ? ' active' : ''), onclick: () => reveal(tab, r) },
      h('span', { className: 'fi ic-' + fi.kind, innerHTML: icon(fi.name) }),
      h('span', { className: 'sn', textContent: r.path.slice(slash + 1) }),
      h('span', { className: 'sp', textContent: slash > 0 ? r.path.slice(0, slash) : '/' })))
  })
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}

async function runSearch(tab) {
  const S = tab.search
  const q = tab.searchInput.value.trim()
  const seq = ++S.seq
  if (!q) { S.state = 'hint'; return paintSearch(tab) }
  S.state = 'loading'
  paintSearch(tab)
  try {
    await ensure(tab)
    const r = await api.invoke('search:find', tab.connId, tab.path, q, S.scope)
    if (seq !== S.seq) return
    Object.assign(S, { results: r, state: 'done', active: 0 })
  } catch (e) {
    if (seq !== S.seq) return
    Object.assign(S, { results: [], state: 'error', error: errText(e) })
  }
  paintSearch(tab)
}

function toggleSearch(tab, open = tab.searchBox.hidden) {
  tab.searchBox.hidden = !open
  if (open) { tab.searchInput.focus(); tab.searchInput.select(); runSearch(tab) }
}

// va dans le dossier parent du résultat et le sélectionne
function reveal(tab, r) {
  const i = r.path.lastIndexOf('/')
  tab.pendingSelect = r.path.slice(i + 1)
  toggleSearch(tab, false)
  load(tab, i <= 0 ? '/' : r.path.slice(0, i))
}

function buildSearch(tab) {
  const S = (tab.search = { scope: 'here', seq: 0, state: 'hint', results: [], active: 0 })
  tab.searchInput = h('input', {
    spellcheck: false,
    oninput: () => { clearTimeout(S.timer); S.timer = setTimeout(() => runSearch(tab), 250) },
    onkeydown: e => {
      if (e.key === 'Escape') toggleSearch(tab, false)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (S.results.length) { S.active = (S.active + (e.key === 'ArrowDown' ? 1 : -1) + S.results.length) % S.results.length; paintSearch(tab) }
      } else if (e.key === 'Enter' && S.results[S.active]) reveal(tab, S.results[S.active])
    },
  })
  tab.searchInput.dataset.i18nPh = 'search.placeholder'
  const chip = (scope, key) => {
    const b = h('button', { className: 'chip', onclick: () => { S.scope = scope; chips.forEach(c => c.classList.toggle('on', c.dataset.scope === scope)); tab.searchInput.focus(); runSearch(tab) } })
    b.dataset.scope = scope
    b.dataset.i18n = key
    return b
  }
  const chips = [chip('here', 'search.here'), chip('all', 'search.all')]
  chips[0].classList.add('on')
  tab.searchList = h('div', { className: 'sresults' })
  tab.searchBox = h('div', { className: 'searchbox', hidden: true },
    h('div', { className: 'srow', innerHTML: icon('search') }, tab.searchInput),
    h('div', { className: 'chips' }, ...chips),
    tab.searchList)
}

// ---------- Onglet serveur : explorateur + terminal (bas) + panneau (droite) + barre d'outils ----------
function openFiles(server, { terminal = false } = {}) {
  const tab = {
    id: uid(), kind: 'files', server, connId: null, path: '', hist: [], entries: [], view: [], sel: new Set(), sort: { key: 'name', dir: 1 },
    panel: null, term: null, termId: null, results: [], dash: newDash(),
  }
  const ib = (name, titleKey, onclick, cls = '') => { const b = h('button', { className: ('ib ' + cls).trim(), innerHTML: icon(name), onclick }); b.dataset.i18nTitle = titleKey; return b }
  tab.back = ib('arrow-left', 'ex.back', () => load(tab, tab.hist.pop(), false))
  tab.pathInput = h('input', { className: 'path', spellcheck: false, onkeydown: e => { if (e.key === 'Enter') load(tab, e.target.value.trim()) } })
  tab.head = h('div', { className: 'row head' })
  tab.body = h('div')
  tab.statusL = h('span')
  tab.statusR = h('span')
  buildSearch(tab)
  const table = h('div', { className: 'table', oncontextmenu: e => ctxMenu(tab, e), onclick: e => { if (!e.target.closest('.row')) { tab.sel.clear(); paintSel(tab) } } }, tab.head, tab.body)
  tab.explorer = h('div', { className: 'explorer' },
    h('div', { className: 'toolbar' },
      tab.back, tab.pathInput,
      ib('search', 'ex.search', () => toggleSearch(tab), 'js-search-btn'),
      ib('folder-plus', 'tb.new_folder', () => newItem(tab, 'dir')),
      ib('file-plus', 'tb.new_file', () => newItem(tab, 'file')),
      ib('refresh', 'tb.refresh', () => load(tab, tab.path || null, false))),
    tab.searchBox,
    table,
    h('div', { className: 'status' }, tab.statusL, tab.statusR))

  // terminal (bas)
  tab.termBody = h('div', { className: 'term-body' })
  tab.termTitle = h('span', { className: 'term-title' })
  const splitter = h('div', { className: 'splitter' })
  splitter.onmousedown = ev => {
    ev.preventDefault()
    const y0 = ev.clientY
    const h0 = tab.termWrap.offsetHeight
    const move = e => { tab.termWrap.style.height = Math.max(120, Math.min(h0 + y0 - e.clientY, tab.wsMain.offsetHeight - 160)) + 'px' }
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); tab.fit?.fit() }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
  }
  tab.termWrap = h('div', { className: 'term-wrap', hidden: true }, splitter,
    h('div', { className: 'term-head' }, tab.termTitle, ib('x', 'term.close', () => closeTerminal(tab))),
    tab.termBody)
  tab.wsMain = h('div', { className: 'ws-main' }, tab.explorer, tab.termWrap)

  // panneau de droite
  tab.rpanelTitle = h('span', { className: 'rp-title' })
  tab.rpanelActions = h('span', { className: 'rp-actions' })
  tab.rpanelBody = h('div', { className: 'rp-body' })
  tab.rpanel = h('div', { className: 'rpanel', hidden: true },
    h('div', { className: 'rp-head' }, tab.rpanelTitle, tab.rpanelActions, ib('x', 'panel.close', () => setPanel(tab, tab.panel))),
    tab.rpanelBody)

  // barre d'outils (tout à droite)
  tab.bar = {
    term: ib('terminal', 'bar.terminal', () => toggleTerminal(tab)),
    dashboard: ib('activity', 'bar.dashboard', () => setPanel(tab, 'dashboard')),
    actions: ib('zap', 'bar.actions', () => setPanel(tab, 'actions')),
  }
  tab.el = h('div', { className: 'pane ws' }, tab.wsMain, tab.rpanel, h('div', { className: 'rbar' }, tab.bar.term, tab.bar.dashboard, tab.bar.actions))
  applyI18n(tab.el)
  updateBar(tab)

  tab.explorer.ondragover = e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); tab.explorer.classList.add('drop') } }
  tab.explorer.ondragleave = e => { if (!tab.explorer.contains(e.relatedTarget)) tab.explorer.classList.remove('drop') }
  tab.explorer.ondrop = e => {
    e.preventDefault()
    tab.explorer.classList.remove('drop')
    const paths = [...e.dataTransfer.files].map(api.pathOf)
    // retour d'un glisser sorti de cet onglet : ne pas se renvoyer ses propres fichiers
    if (Date.now() - (tab.lastDragAt || 0) < 120000 && paths.every(p => p.includes('cyberdog-drag-'))) return
    if (paths.length && tab.path) upload(tab, paths)
  }
  addTab(tab)
  load(tab, null)
  if (terminal) openTerminal(tab)
}

// ---------- Init ----------
;(async () => {
  document.body.classList.add(api.platform === 'darwin' ? 'mac' : 'other')
  const s = await api.invoke('settings:get')
  lang = s.lang
  theme = s.theme in THEMES ? s.theme : 'system'
  applyIcons(document)
  applyTheme()
  refreshLanguage()
  servers = await api.invoke('servers:list')
  quickActions = await api.invoke('actions:list')
  renderServers()
})()
