const $ = s => document.querySelector(s)
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e }
const uid = () => crypto.randomUUID()
const join = (a, b) => (a === '/' ? '' : a) + '/' + b
const { icon, fileIcon } = icons

// Poignée de redimensionnement : get() lit la taille de départ, set(px) l'applique (bornée), dir = -1 si tirer vers la gauche/haut agrandit.
function dragResize(handle, { axis = 'x', dir = 1, min, max, get, set, done }) {
  handle.onmousedown = ev => {
    ev.preventDefault()
    const p0 = axis === 'x' ? ev.clientX : ev.clientY
    const v0 = get()
    document.body.classList.add('resizing', 'resizing-' + axis)
    const move = e => set(Math.max(min, Math.min(typeof max === 'function' ? max() : max, v0 + dir * ((axis === 'x' ? e.clientX : e.clientY) - p0))))
    const up = () => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', up)
      document.body.classList.remove('resizing', 'resizing-' + axis)
      done?.()
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
  }
}
const root = document.documentElement
const saveSize = (key, v) => localStorage.setItem('cyberdog.' + key, v)
const loadSize = (key, def) => +localStorage.getItem('cyberdog.' + key) || def
const { LANGS } = i18n

let lang = 'en'
let theme = 'dracula'
let settings = { lang: 'en', theme: 'dracula', defaultEditor: 'system', configPath: '', autoDownload: false }
let servers = []
let tabs = []
let restoringConnections = false
function rememberConnections() {
  if (!restoringConnections && settings.restoreConnections) api.send('session:update', tabs.filter(tb => !tb.closed).map(tb => ({ serverId: tb.server.id, terminal: !!tb.term })))
}
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
  paintUpdateBadge()
  $('#btn-theme').title = t('theme')
  $('#btn-lang').title = t('language')
  $('#btn-theme .lbl').textContent = t('theme.' + theme)
  $('#btn-lang .lbl').textContent = LANGS[lang]
  updateAccount(accountState)
  renderServers()
  tabs.forEach(tb => {
    applyI18n(tb.el)
    tb.panes.forEach(p => { draw(p); paintSearch(p); paintPathsBox(p) })
    renderPanel(tb)
    updateBar(tb)
  })
}

// messages d'erreur ssh2/Node → texte traduit
const AUTH_FAIL = /authentication methods failed|authentication failure/i
function errText(e) {
  const m = e.message || String(e)
  if(m.startsWith('vault.'))return t(m)
  if (['server_write_required','access_denied','owner_required','premium_required'].includes(m)) return t('err.denied')
  if(['group_in_use','invalid_group','invalid_asset','script_changed'].includes(m))return t('shared.'+m)
  if (m.includes('KEY_PASSPHRASE_REQUIRED')) return t('keys.unlock')
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

let updateState
let paintSettingsUpdate = () => {}
function paintUpdateBadge() {
  const button = $('#app-update')
  const state = updateState
  button.hidden = !state || state.state === 'current' || state.state === 'error'
  if (button.hidden) return
  button.textContent = state.state === 'downloading'
    ? t('update.downloading', { percent: state.percent ?? 0 })
    : t('update.new')
  button.title = t('update.title', { version: state.version })
  button.disabled = state.state === 'downloading'
}
api.on('app:update', state => {
  updateState = state
  paintUpdateBadge()
  paintSettingsUpdate()
})
$('#app-update').onclick = () => api.invoke('app:update:action').catch(e => toast(errText(e), true))

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
  if (!e.target.closest('.searchbox, .js-search-btn')) tabs.forEach(tb => tb.panes.forEach(p => (p.searchBox.hidden = true)))
  if (!e.target.closest('.pathsbox, .js-paths-btn')) hidePathsBoxes()
})
addEventListener('keydown', e => {
  const tab = tabs.find(tb => tb.id === activeId)
  if (tab && (e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); toggleSearch(tab.active, true) }
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
    const previous = !m.hidden ? {nodes:[...m.childNodes],mousedown:m.onmousedown} : null
    const inputs = fields.map(f => {
      if (f.type === 'checkbox') return h('input', { type: 'checkbox', checked: !!f.value })
      if (f.type === 'textarea') return h('textarea', { value: f.value || '', placeholder: f.placeholder || '', rows: 12, spellcheck: false, readOnly:!!f.readOnly })
      if (f.type === 'select') {
        const sel = h('select', { className: 'lsel full', disabled:!!f.disabled }, ...f.options.map(([v, label, scope]) => Object.assign(h('option', { value: v, textContent: label }),{_scope:scope})))
        sel.value = f.value || ''
        return sel
      }
      return h('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' })
    })
    const locationIndex=fields.findIndex(f=>f.name==='teamId')
    if(locationIndex>=0){const sync=()=>{const scope=inputs[locationIndex].value;fields.forEach((f,i)=>{if(f.name==='group'){for(const option of inputs[i].options){option.disabled=!!option.value&&option._scope!==scope;option.hidden=option.disabled}if(inputs[i].selectedOptions[0]?.disabled)inputs[i].value=''}if(f.requireScope!==undefined){inputs[i].disabled=f.requireScope!==scope;if(inputs[i].disabled)inputs[i].checked=true}})};inputs[locationIndex].onchange=sync;sync()}
    const close = v => { if(previous){m.replaceChildren(...previous.nodes);m.hidden=false;m.onmousedown=previous.mousedown}else{m.hidden=true;m.replaceChildren()} resolve(v) }
    const form = h('form', {
      className: 'card' + (wide ? ' wide' : ''),
      onsubmit: e => { e.preventDefault(); close(Object.fromEntries(fields.map((f, i) => [f.name, f.type === 'checkbox' ? inputs[i].checked : inputs[i].value]))) },
      onkeydown: e => { if (e.key === 'Escape') close(null) },
    },
      h('h3', { textContent: title }),
      ...fields.map((f, i) => f.type === 'checkbox' ? h('label', { className: 'check' }, inputs[i], h('span', { textContent: f.label })) : h('label', {}, f.label, inputs[i])),
      h('div', { className: 'btns' },
        h('button', { type: 'button', textContent: t('btn.cancel'), onclick: () => close(null) }),
        h('button', { className: 'primary', textContent: okLabel })))
    m.onmousedown = e => { if (e.target === m) close(null) }
    m.replaceChildren(form)
    m.hidden = false
    inputs[0].focus()
    inputs[0].select?.()
  })
}

// ---------- Serveurs ----------
let groups = []
let srvQuery = ''

// s : serveur à modifier ; duplicate : s sert de modèle pour un NOUVEAU serveur (mot de passe repris si laissé vide)
async function serverForm(s, { duplicate = false } = {}) {
  const edit = s && !duplicate
  const v = await modal(edit ? t('form.edit_title') : t('form.add_title'), [
    ...(sharedLocationField(duplicate?null:s)?[sharedLocationField(duplicate?null:s)]:[]),
    { name: 'name', label: t('f.name'), value: duplicate ? t('srv.copy_name', { name: s.name }) : s?.name, placeholder: t('f.name_ph') },
    { name: 'host', label: t('f.host'), value: s?.host, placeholder: '192.168.1.10' },
    { name: 'port', label: t('f.port'), value: s?.port ?? 22 },
    { name: 'user', label: t('f.user'), value: s?.user, placeholder: 'root' },
    { name: 'pass', label: t('f.pass'), type: 'password', placeholder: s?.hasPass ? t(duplicate ? 'f.pass_same' : 'f.pass_keep') : t('f.pass_ph') },
    ...(groups.length ? [{ name: 'group', label: t('f.group'), type: 'select', value: s?.group || '', options: [['', t('f.group_none')], ...groups.map(g => [g.id, g.name,g.teamId||''])] }] : []),
  ], edit ? t('btn.save') : t('btn.add_ok'))
  if (!v) return
  try { servers = await api.invoke('servers:save', { ...v, id: edit ? s.id : undefined, copyFrom: duplicate ? s.id : undefined }); renderServers() } catch (e) { toast(errText(e), true) }
}

// mot de passe manquant ou refusé : on le demande, on l'enregistre, l'appelant réessaie
async function askPassword(s) {
  if(s.vaultId){toast(t('vault.ssh_failed'),true);return false}
  const v = await modal(t('pw.title', { target: `${s.user}@${s.host}` }), [{ name: 'pass', label: t('f.pass'), type: 'password' }], t('btn.connect'))
  if (!v?.pass) return false
  try { servers = await api.invoke('servers:save', { ...s, pass: v.pass }); renderServers(); return true } catch (e) { toast(errText(e), true); return false }
}

const hue = name => Math.abs([...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360
let dragId = null
let dragGroup = null
const groupOf = s => groups.find(g => g.id === s.group)

const setFavorite = async (s, on) => { servers = await api.invoke('servers:update', s.id, { favorite: on }); renderServers() }
const setGroupFav = async (g, on) => { groups = await api.invoke('groups:update', g.id, { favorite: on }); renderServers() }
const moveToGroup = async (s, gid) => { if(gid&&(groups.find(g=>g.id===gid)?.teamId||'')!==(s.teamId||''))return; servers = await api.invoke('servers:update', s.id, { group: gid }); renderServers() }

async function groupForm(g) {
  const v = await modal(g ? t('grp.rename') : t('grp.new'), [...(sharedLocationField(g)?[sharedLocationField(g)]:[]),{ name: 'name', label: t('grp.name'), value: g?.name }], g ? t('btn.save') : t('btn.create'))
  if (!v) return
  try { groups = await api.invoke('groups:save', { id: g?.id, ...v }); renderServers() } catch (e) { toast(errText(e), true) }
}
async function deleteGroup(g) {
  if (!confirm(t('grp.confirm_delete', { name: g.name }))) return
  const r = await api.invoke('groups:delete', g.id)
  groups = r.groups
  servers = r.servers
  renderServers()
}

const starBtn = (on, onclick) => h('button', { className: 'ib fav' + (on ? ' favon' : ''), innerHTML: icon('star'), title: t(on ? 'fav.remove' : 'fav.add'), onclick: e => { e.stopPropagation(); onclick() } })

function serverRow(s, activeServer) {
  const canManage = !s.vaultId && (!s.teamId || !!s.canEditServers)
  const hh = hue(s.name)
  const li = h('li', { className: 'srv' + (s.id === activeServer ? ' active' : ''), draggable: !s.teamId&&!s.vaultId },
    h('span', { className: 'tile', innerHTML: icon('server'), style: `background: linear-gradient(135deg, hsl(${hh} 75% 58%), hsl(${(hh + 45) % 360} 75% 48%))` }),
    h('div', { className: 'txt' }, h('span', { className: 'name', textContent: s.name }), h('span', { className: 'host', textContent: `${s.user}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` })),
    ...(!s.teamId&&!s.vaultId ? [starBtn(s.favorite, () => setFavorite(s, !s.favorite))] : []),
    h('button', { className: 'ib edit', innerHTML: icon('pencil'), disabled:!canManage&&!s.vaultId, title: t(s.vaultId?'vault.edit_server':canManage?'srv.edit_tip':'team.permissions'), onclick: e => { e.stopPropagation(); s.vaultId?editVaultServer(s):serverForm(s) } }))
  li.onclick = e => { if (!e.target.closest('button')) openFiles(s) }
  li.tabIndex = 0
  li.onkeydown = e => { if (e.key === 'Enter' && e.target === li) openFiles(s) }
  li.oncontextmenu = e => {
    e.preventDefault()
    menu(e.clientX, e.clientY, [
      { label: t('srv.open'), icon: 'folder', fn: () => openFiles(s) },
      { label: t('srv.terminal'), icon: 'terminal', fn: () => openFiles(s, { terminal: true }) },
      '-',
      ...(!s.teamId&&!s.vaultId ? [{ label: t(s.favorite ? 'fav.remove' : 'fav.add'), icon: 'star', fn: () => setFavorite(s, !s.favorite) }] : []),
      ...(canManage && groups.some(g=>(g.teamId||'')===(s.teamId||'')) ? [{ label: t('f.group'), icon: 'folder', children: async () => [{ label: t('f.group_none'), checked: !groupOf(s), fn: () => moveToGroup(s, '') }, ...groups.filter(g=>(g.teamId||'')===(s.teamId||'')).map(g => ({ label: g.name, checked: s.group === g.id, fn: () => moveToGroup(s, g.id) }))] }] : []),
      '-',
      ...(canManage ? [{ label: t('srv.edit'), icon: 'pencil', fn: () => serverForm(s) }] : []),
      ...(s.teamId?[{label:t('history.title'),icon:'server',fn:()=>showServerHistory(s)}]:[]),
      ...(!s.vaultId?[{ label: t('srv.duplicate'), icon: 'copy', fn: () => serverForm(s, { duplicate: true }) }]:[{label:t('vault.edit_server'),icon:'pencil',fn:()=>editVaultServer(s)},{label:t('vault.unpin'),icon:'trash',fn:async()=>{if(confirm(t('vault.confirm_unpin'))){servers=await api.invoke('vaults:unpin',s.id);renderServers()}}}]),
      ...(canManage ? [{ label: t('srv.delete'), icon: 'trash', danger: true, fn: async () => { if (confirm(t('srv.confirm_delete', { name: s.name }))) { servers = await api.invoke('servers:delete', s.id); renderServers() } } }] : []),
    ])
  }
  li.ondragstart = e => { dragId = s.id; dragGroup = null; e.dataTransfer.effectAllowed = 'move' }
  li.ondragend = () => { dragId = null }
  li.ondragover = e => { if (dragId) { e.preventDefault(); li.classList.add('over') } }
  li.ondragleave = () => li.classList.remove('over')
  li.ondrop = async e => {
    e.preventDefault()
    e.stopPropagation()
    li.classList.remove('over')
    if (!dragId || dragId === s.id) return
    const dragged = servers.find(x => x.id === dragId)
    if(s.teamId||s.vaultId||dragged?.teamId)return
    const ids = servers.map(x => x.id)
    ids.splice(ids.indexOf(s.id), 0, ...ids.splice(ids.indexOf(dragId), 1))
    servers = await api.invoke('servers:reorder', ids)
    // déposé sur un serveur d'un autre groupe : il rejoint ce groupe
    if ((dragged.group || '') !== (s.group || '')) servers = await api.invoke('servers:update', dragId, { group: s.group || '' })
    renderServers()
  }
  return li
}

function groupRow(g, count, q) {
  const collapsed = g.collapsed && !q // une recherche déplie les groupes pour montrer les résultats
  const li = h('li', { className: 'grp' + (collapsed ? ' collapsed' : ''), draggable: !g.teamId },
    h('span', { className: 'chev', innerHTML: icon('chevron-right') }),
    h('span', { className: 'gname', textContent: g.name }),
    h('span', { className: 'gcount', textContent: String(count) }),
    starBtn(g.favorite, () => setGroupFav(g, !g.favorite)),
    h('button', { className: 'ib edit', innerHTML: icon('pencil'), title: t('grp.rename'), disabled:!!g.teamId&&!g.canEditServers, onclick: e => { e.stopPropagation(); groupForm(g) } }))
  li.title = t('grp.collapse')
  li.onclick = async () => { groups = await api.invoke('groups:update', g.id, { collapsed: !g.collapsed }); renderServers() }
  li.oncontextmenu = e => {
    e.preventDefault()
    menu(e.clientX, e.clientY, [
      { label: t(g.favorite ? 'fav.remove' : 'fav.add'), icon: 'star', fn: () => setGroupFav(g, !g.favorite) },
      ...(!g.teamId||g.canEditServers?[{ label: t('grp.rename'), icon: 'pencil', fn: () => groupForm(g) },{ label: t('grp.delete'), icon: 'trash', danger: true, fn: () => deleteGroup(g) }]:[]),
    ])
  }
  li.ondragstart = e => { dragGroup = g.id; dragId = null; e.dataTransfer.effectAllowed = 'move' }
  li.ondragend = () => { dragGroup = null }
  li.ondragover = e => { if (dragId || (dragGroup && dragGroup !== g.id)) { e.preventDefault(); li.classList.add('over') } }
  li.ondragleave = () => li.classList.remove('over')
  li.ondrop = async e => {
    e.preventDefault()
    li.classList.remove('over')
    if (dragId) return moveToGroup(servers.find(x => x.id === dragId), g.id) // un serveur déposé sur un groupe y entre
    if (dragGroup && dragGroup !== g.id) {
      const ids = groups.map(x => x.id)
      ids.splice(ids.indexOf(g.id), 0, ...ids.splice(ids.indexOf(dragGroup), 1))
      groups = await api.invoke('groups:reorder', ids)
      renderServers()
    }
  }
  return li
}

// Liste : favoris (groupes puis serveurs) en tête, puis groupes, puis serveurs sans groupe. Le filtre de recherche agit en direct.
function renderServers() {
  const ul = $('#servers')
  ul.replaceChildren()
  const activeServer = tabs.find(tb => tb.id === activeId)?.server.id
  const q = srvQuery.trim().toLowerCase()
  const has = (x, str) => str.toLowerCase().includes(x)
  const srvMatch = s => !q || [s.name, s.host, s.user, s.vaultName||'', groupOf(s)?.name || ''].some(x => has(q, x))
  const grpMatch = g => !!q && has(q, g.name)
  const localServers=servers.filter(s=>!s.teamId&&!s.vaultId)
  const sharedServers=servers.filter(s=>s.teamId)
  if(sharedServers.length&&localServers.length)ul.append(h('li',{className:'sep-label plain'},h('span',{textContent:t('team.local_list')})))
  const inGroup = g => localServers.filter(s => s.group === g.id)
  const visibleIn = g => (grpMatch(g) ? inGroup(g) : inGroup(g).filter(srvMatch))
  const showGroup = g => !q || grpMatch(g) || visibleIn(g).length > 0

  const pushGroup = g => {
    // les serveurs favoris d'un groupe non favori remontent dans « Favoris » : on ne les répète pas ici
    const kids = visibleIn(g).filter(s => g.favorite || !s.favorite)
    ul.append(groupRow(g, kids.length, q))
    if (!g.collapsed || q) kids.forEach(s => { const li = serverRow(s, activeServer); li.classList.add('in-group'); ul.append(li) })
  }

  const favGroups = groups.filter(g => !g.teamId && g.favorite && showGroup(g))
  const favServers = localServers.filter(s => s.favorite && !groupOf(s)?.favorite && srvMatch(s))
  const restGroups = groups.filter(g => !g.teamId && !g.favorite && showGroup(g))
  const loose = localServers.filter(s => !s.favorite && !groupOf(s) && srvMatch(s))

  if (favGroups.length || favServers.length) {
    ul.append(h('li', { className: 'sep-label', innerHTML: icon('star') + `<span>${t('fav.title')}</span>` }))
    favGroups.forEach(pushGroup)
    favServers.forEach(s => ul.append(serverRow(s, activeServer)))
    if (restGroups.length || loose.length) ul.append(h('li', { className: 'sep-line' }))
  }
  restGroups.forEach(pushGroup)
  if (loose.length) {
    if (groups.length) {
      const lab = h('li', { className: 'sep-label plain' }, h('span', { textContent: t('grp.none') }))
      lab.ondragover = e => { if (dragId) { e.preventDefault(); lab.classList.add('over') } }
      lab.ondragleave = () => lab.classList.remove('over')
      lab.ondrop = e => { e.preventDefault(); if (dragId) moveToGroup(servers.find(x => x.id === dragId), '') }
      ul.append(lab)
    }
    loose.forEach(s => ul.append(serverRow(s, activeServer)))
  }
  appendExtensionServers(ul,{sharedServers,srvMatch,grpMatch,q,activeServer})
  if (q && !ul.childElementCount) ul.append(h('li', { className: 'srv-empty', textContent: t('srvs.no_match') }))
  $('#card-export').hidden = false
}

async function sortServers() {
  if (groups.length) groups = await api.invoke('groups:reorder', [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(g => g.id))
  servers = await api.invoke('servers:reorder', [...servers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(s => s.id))
  renderServers()
}

function toggleSrvSearch(open = $('#srv-search').hidden) {
  $('#srv-search').hidden = !open
  $('#btn-search').classList.toggle('on', open)
  if (open) $('#srv-q').focus()
  else { srvQuery = ''; $('#srv-q').value = ''; renderServers() }
}
$('#btn-search').onclick = () => toggleSrvSearch()
$('#btn-group').onclick = () => groupForm()
$('#srv-q').oninput = e => { srvQuery = e.target.value; renderServers() }
$('#srv-q').onkeydown = e => { if (e.key === 'Escape') toggleSrvSearch(false) }

const importFrom = ch => async () => {
  try {
    const r = await api.invoke(ch)
    if (!r) return
    servers = r.servers
    renderServers()
    toast(r.added ? `${t('t.imported', { n: r.added })} ${t('t.pw_hint')}` : t('t.nothing'), false, 6000)
  } catch (e) { toast(errText(e), true) }
}
const importZip = () => importConfiguration()
const importCyberduck = importFrom('servers:import')
const exportZip = () => exportConfiguration()

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
    { label: 'FileZilla (XML)…', icon: 'download', fn: () => importConfiguration('filezilla') },
    { label: 'WinSCP (INI)…', icon: 'download', fn: () => importConfiguration('winscp') },
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
$('#btn-premium').onclick = () => openPremiumDialog()
$('#btn-settings').onclick = () => openSettingsModal()
api.on('app:open-settings', openSettingsModal)
function setTheme(name) { theme = name; settings.theme = name; applyTheme(); api.invoke('settings:set', { theme }) }
function setLang(code) { lang = code; settings.lang = code; refreshLanguage(); api.invoke('settings:set', { lang }) }
async function openSettingsModal(initialPage = 'general') {
  const [current, editors, currentUpdate] = await Promise.all([
    api.invoke('settings:get'),
    api.invoke('apps:list'),
    api.invoke('app:update:status'),
  ])
  updateState = currentUpdate
  const m = $('#modal')
  const close = () => { paintSettingsUpdate = () => {}; m.hidden = true; m.replaceChildren() }

  const langSel = h('select', { className: 'lsel full' }, ...Object.entries(LANGS).map(([k, label]) => h('option', { value: k, selected: k === current.lang, textContent: label })))
  const themeSel = h('select', { className: 'lsel full' }, ...Object.keys(THEMES).map(k => h('option', { value: k, selected: k === (current.theme || 'dracula'), textContent: t('theme.' + k) })))
  const configInput = h('input', { type: 'text', value: current.configPath || '', placeholder: t('settings.config_path_ph'), spellcheck: false })
  const browseConfig = h('button', { type: 'button', textContent: t('settings.browse'), onclick: async () => { const dir = await api.invoke('settings:pick-config'); if (dir) configInput.value = dir } })
  const editorValue = current.defaultEditor || 'system'
  const editorOptions = [['system', t('settings.editor_system')], ...editors.map(editor => [editor.target, editor.label])]
  if (!editorOptions.some(([value]) => value === editorValue)) editorOptions.push([editorValue, editorValue])
  editorOptions.push(['__other__', t('settings.editor_other')])
  const editorInput = h('select', { className: 'lsel full' }, ...editorOptions.map(([value, label]) => h('option', { value, textContent: label })))
  editorInput.value = editorValue
  editorInput.onchange = async () => {
    if (editorInput.value !== '__other__') return
    const target = await api.invoke('apps:pick')
    if (!target) return (editorInput.value = editorValue)
    editorInput.insertBefore(h('option', { value: target, textContent: target }), editorInput.lastElementChild)
    editorInput.value = target
  }
  const restoreInput = h('input', { type: 'checkbox', checked: !!current.restoreConnections })
  const autoDownloadInput = h('input', { type: 'checkbox', checked: !!current.autoDownload })
  const settingsPage = (name, display, ...children) => {
    const page = h('div', { className: 'settings-page', style: `display: ${display}; flex-direction: column; gap: 12px;` }, ...children)
    page.dataset.page = name
    return page
  }

  const generalPage = settingsPage('general', 'flex',
    h('label', { className: 'check' }, restoreInput, h('span', { textContent: t('settings.restore_connections') })),
    h('div', { className: 'note', textContent: t('settings.restore_help') }),
    h('label', {}, t('settings.lang'), langSel),
    h('label', {}, t('settings.theme'), themeSel),
    h('label', {}, t('settings.config_path'), h('span', { className: 'set-row' }, configInput, browseConfig)),
    h('div', { className: 'note', textContent: t('settings.config_help') }))
  const editorPage = settingsPage('editor', 'none',
    h('label', {}, t('settings.editor'), editorInput),
    h('div', { className: 'note', textContent: t('settings.editor_help') }))
  const updateSummary = h('div', { className: 'update-summary' })
  const updateNotes = h('div', { className: 'update-notes' })
  const updateButton = h('button', {
    type: 'button',
    className: 'primary',
    onclick: () => api.invoke('app:update:action').catch(e => toast(errText(e), true)),
  })
  const updatesPage = settingsPage('updates', 'none',
    h('label', { className: 'check' }, autoDownloadInput, h('span', { textContent: t('settings.auto_download') })),
    h('div', { className: 'note', textContent: t('settings.update_help') }),
    updateSummary,
    updateNotes,
    h('div', { className: 'update-actions' }, updateButton))
  paintSettingsUpdate = () => {
    const state = updateState || { state: 'current' }
    updateSummary.textContent = state.state === 'current'
      ? t('settings.update_current', { version: $('#app-version').textContent })
      : state.state === 'error'
        ? t('settings.update_error')
        : state.state === 'downloading'
          ? t('settings.update_downloading', { percent: state.percent ?? 0 })
          : state.state === 'ready'
            ? t('settings.update_ready', { version: state.version })
            : t('settings.update_available', { version: state.version })
    updateNotes.hidden = !state.notes
    updateNotes.textContent = state.notes || ''
    updateButton.hidden = !['available', 'ready'].includes(state.state)
    updateButton.textContent = t(state.state === 'ready'
      ? state.mode === 'install' ? 'settings.update_install' : 'settings.update_open'
      : 'settings.update_download')
  }
  paintSettingsUpdate()

  const vaultsPage=settingsPage('vaults','none')
  let vaultsMounted=false
  const pages=[generalPage,editorPage,updatesPage,vaultsPage]
  const sections=[['general','cog','settings.tab.general'],['editor','file','settings.tab.editor'],['updates','download','settings.tab.updates'],['vaults','key','settings.vaults']]
  const buttons=new Map()
  const sidebar=h('nav',{className:'settings-nav',role:'tablist',ariaLabel:t('settings.title'),ariaOrientation:'vertical'})
  const switchTab=name=>{
    for(const [key,button] of buttons){const active=key===name;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1}
    for(const page of pages)page.style.display=page.dataset.page===name?'flex':'none'
    if(name==='vaults'&&!vaultsMounted){vaultsMounted=true;vaultsPage.append(buildVaultSettings())}
  }
  for(const [name,symbol,label] of sections){
    const button=h('button',{type:'button',className:'settings-nav-item',role:'tab',id:'settings-tab-'+name,ariaControls:'settings-page-'+name,onclick:()=>switchTab(name)},h('span',{innerHTML:icon(symbol)}),h('span',{textContent:t(label)}),...(name==='vaults'?[h('span',{className:'settings-premium-mark',innerHTML:icon('star'),title:t('premium.title'),ariaLabel:t('premium.title')})]:[]))
    button.onkeydown=event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const index=sections.findIndex(section=>section[0]===name),next=event.key==='Home'?0:event.key==='End'?sections.length-1:(index+(event.key==='ArrowDown'?1:-1)+sections.length)%sections.length;switchTab(sections[next][0]);buttons.get(sections[next][0]).focus()}
    buttons.set(name,button);sidebar.append(button)
  }
  for(const page of pages){page.id='settings-page-'+page.dataset.page;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby','settings-tab-'+page.dataset.page)}
  switchTab(sections.some(section=>section[0]===initialPage)?initialPage:'general')

  const save = async () => {
    try {
      const patch = {
        lang: langSel.value,
        theme: themeSel.value,
        configPath: configInput.value.trim(),
        defaultEditor: editorInput.value,
        autoDownload: autoDownloadInput.checked,
        restoreConnections: restoreInput.checked,
      }
      const configChanged = patch.configPath !== current.configPath
      if (patch.configPath && configChanged) {
        const status = await api.invoke('settings:config-status', patch.configPath)
        patch.configPath = status.path
        patch.copyConfigOnChange = !status.hasConfig && confirm(t('settings.copy_confirm'))
      }
      const next = await api.invoke('settings:set', patch)
      settings = next
      rememberConnections()
      lang = next.lang || 'en'
      theme = next.theme in THEMES ? next.theme : 'dracula'
      if (configChanged) {
        servers = await api.invoke('servers:list')
        groups = await api.invoke('groups:list')
        quickActions = await api.invoke('actions:list')
        logFavs = await api.invoke('favs:list')
        savedPaths = await api.invoke('paths:list')
        renderServers()
      }
      if (!current.autoDownload && next.autoDownload && updateState?.state === 'available') {
        api.invoke('app:update:download').catch(e => toast(errText(e), true))
      }
      applyTheme(); refreshLanguage(); close()
    } catch (e) {
      toast(errText(e), true)
    }
  }

  const content=h('section',{className:'card settings-card',role:'dialog',ariaModal:'true',ariaLabel:t('settings.title'),onkeydown:event=>{if(event.key==='Escape'){event.stopPropagation();close()}}},
    h('div',{className:'settings-head'},h('div',{},h('small',{className:'settings-eyebrow',textContent:'CYBERDOG'}),h('h3',{textContent:t('settings.title')})),h('button',{type:'button',className:'ib',innerHTML:icon('x'),title:t('btn.cancel'),ariaLabel:t('btn.cancel'),onclick:close})),
    h('div',{className:'settings-layout'},sidebar,h('div',{className:'settings-panels'},...pages)),
    h('div',{className:'btns'},h('button',{type:'button',textContent:t('btn.cancel'),onclick:close}),h('button',{type:'button',className:'primary settings-save',onclick:save},h('span',{innerHTML:icon('save')}),h('span',{textContent:t('btn.save')}))))

  m.hidden = false
  m.replaceChildren(content)
  m.onmousedown = e => { if (e.target === m) close() }
}

// ---------- Onglets ----------
function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map(tb => h('div', { className: 'tab' + (tb.id === activeId ? ' active' : ''), title: tb.server.name, onclick: () => activate(tb.id), onauxclick: e => { if (e.button === 1) closeTab(tb.id) } },
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
  tb.closed = true
  if (tb.connId) api.invoke('conn:close', tb.connId)
  closeTerminal(tb)
  pollStop(tb)
  leavePanel(tb)
  tb.el.remove()
  tabs.splice(i, 1)
  rememberConnections()
  activate(activeId === id ? tabs[Math.min(i, tabs.length - 1)]?.id : activeId)
}

function addTab(tb) {
  tabs.push(tb)
  rememberConnections()
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
  rememberConnections()
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
    try { await api.invoke('term:open', id, server.id, term.cols, term.rows, tab.active?.path || undefined);
      if (tab.termId !== id) { api.invoke('conn:close', id); return }
      fit.fit()
      api.send('term:resize', id, term.cols, term.rows)
      break } catch (e) {
      if (tab.termId !== id) return
      if (await unlockServerKey(server, e)) continue
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
  rememberConnections()
  tab.termWrap.hidden = true
  updateBar(tab)
}
const toggleTerminal = tab => (tab.term ? closeTerminal(tab) : openTerminal(tab))

// ---------- Panneau de droite (un seul à la fois) ----------
// Les fonctions render*/leave* vivent dans panels.js et ops.js (chargés après ce fichier).
const PANELS = {
  dashboard: { title: 'dash.title', render: t => renderDashboard(t) },
  processes: { title: 'proc.title', render: t => renderProcesses(t), leave: t => leaveProcesses(t) },
  services: { title: 'svc.title', render: t => renderServices(t) },
  logs: { title: 'log.title', render: t => renderLogs(t), leave: t => leaveLogs(t) },
  docker: { title: 'docker.title', render: t => renderDocker(t), leave: t => leaveDocker(t) },
  certificates: { title: 'cert.title', render: t => renderCertificates(t) },
  keys: { title: 'keys.title', render: t => renderKeys(t) },
  paths: { title: 'paths.title', render: t => renderPaths(t) },
  actions: { title: 'qa.title', render: t => renderActions(t) },
}
const BAR = [['term', 'terminal', 'bar.terminal'], ['dashboard', 'activity', 'bar.dashboard'], ['processes', 'processes', 'proc.title'], ['services', 'cog', 'bar.services'], ['logs', 'scroll', 'bar.logs'], ['docker', 'box', 'bar.docker'], ['certificates', 'shield', 'cert.title'], ['keys', 'key', 'keys.title'], ['paths', 'bookmark', 'bar.paths'], ['actions', 'zap', 'bar.actions']]

const leavePanel = tab => { if (tab.panel) PANELS[tab.panel].leave?.(tab) }
function setPanel(tab, name) {
  leavePanel(tab)
  tab.panel = tab.panel === name ? null : name
  renderPanel(tab)
  updateBar(tab)
  syncPanels()
}
function renderPanel(tab) {
  tab.rpanel.hidden = !tab.panel
  tab.rpanelActions.replaceChildren()
  tab.rpanelBody.replaceChildren()
  tab.rpanelBody.classList.remove('flush')
  if (!tab.panel) return
  tab.rpanelTitle.textContent = t(PANELS[tab.panel].title)
  PANELS[tab.panel].render(tab)
}
let rightBarExpanded = localStorage.getItem('cyberdog.rbarExpanded') === 'true'
function toggleRightBar() {
  rightBarExpanded = !rightBarExpanded
  localStorage.setItem('cyberdog.rbarExpanded', String(rightBarExpanded))
  tabs.forEach(updateBar)
}
function updateBar(tab) {
  tab.rightBar.ariaLabel = t('bar.views')
  tab.rightBar.classList.toggle('expanded', rightBarExpanded)
  tab.barToggle.innerHTML = icon('chevron-right') + `<span class="rbar-label">${t('bar.collapse')}</span>`
  tab.barToggle.title = t(rightBarExpanded ? 'bar.collapse' : 'bar.expand')
  tab.barToggle.ariaExpanded = String(rightBarExpanded)
  for (const [key, ic, title] of BAR) {
    tab.bar[key].title = t(title)
    tab.bar[key].innerHTML = icon(ic)
    tab.bar[key].append(h('span', { className: 'rbar-label', textContent: t(title) }))
  }
  tab.bar.term.classList.toggle('on', !!tab.term)
  for (const [key] of BAR.slice(1)) tab.bar[key].classList.toggle('on', tab.panel === key)
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

// la connexion SFTP est partagée par tout l'onglet : on l'écrit toujours sur l'onglet racine, jamais sur un volet
async function ensure(tab) {
  const T = tab.root || tab
  if (T.connId) return
  if (T.connecting) return T.connecting
  T.connecting = (async () => {
    let r
    for (;;) {
      try { r = await api.invoke('files:open', T.server.id); break }
      catch (e) { if (T.closed || !(await unlockServerKey(T.server, e))) throw e }
    }
    if (T.closed) { await api.invoke('conn:close', r.id); throw new Error(t('term.closed')) }
    T.connId = r.id
    T.home = r.home
  })()
  try { await T.connecting } finally { T.connecting = null }
}

async function load(tab, p, push = true) {
  tab.explorer.classList.add('loading')
  try {
    await ensure(tab)
    const r = await api.invoke('sftp:list', tab.connId, p ?? tab.home)
    if (push && tab.path && tab.path !== r.path) tab.hist.push(tab.path)
    if (r.selected) tab.pendingSelect = r.selected
    Object.assign(tab, { path: r.path, entries: r.entries, sel: new Set(), last: null, error: null })
  } catch (e) {
    tab.pendingSelect = null
    if (AUTH_FAIL.test(e.message) && !tab.connId && (await askPassword(tab.server))) return load(tab, p, push)
    if (tab.path) toast(errText(e), true)
    else tab.error = errText(e)
  } finally {
    tab.explorer.classList.remove('loading')
  }
  draw(tab)
}

// exécute une action distante puis rafraîchit
async function act(tab, fn, refresh = true) {
  try { await ensure(tab); await fn(); if (refresh) await load(tab, tab.path, false) } catch (e) { toast(errText(e), true) }
}

function updateStatus(tab) {
  paintTransfers()
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
    row.ondblclick = () => {
      if (e.isDir) return load(tab, join(tab.path, e.name))
      const editor = settings.defaultEditor && settings.defaultEditor !== 'system' ? settings.defaultEditor : undefined
      act(tab, () => api.invoke('sftp:edit', tab.connId, join(tab.path, e.name), editor), false)
    }
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
  await act(tab, async () => {
    if (await api.invoke('sftp:upload', tab.connId, paths, tab.path)) toast(t('t.uploaded'))
  })
}

const appsMenu = (tab, remote) => async () => [
  ...(await api.invoke('apps:list')).map(a => ({ label: a.label, fn: () => act(tab, () => api.invoke('sftp:edit', tab.connId, remote, a.target), false) })),
  { label: t('ctx.default_app'), fn: () => act(tab, () => api.invoke('sftp:edit', tab.connId, remote), false) },
  '-',
  { label: t('ctx.other'), fn: async () => { const p = await api.invoke('apps:pick'); if (p) act(tab, () => api.invoke('sftp:edit', tab.connId, remote, p), false) } },
]

async function extractArchive(tab, file, toFolder) {
  if (!toFolder && !confirm(t('dlg.confirm_extract', { name: file.name }))) return
  toast(t('t.extracting', { name: file.name }), false, 600000)
  await act(tab, async () => { await api.invoke('sftp:extract', tab.connId, join(tab.path, file.name), toFolder); toast(t('t.extracted', { name: file.name })) })
  if ($('#toast').textContent.startsWith(t('t.extracting', { name: file.name }))) $('#toast').hidden = true
}

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
    ...(one ? [{ label: t('ctx.permissions'), icon: 'lock', fn: () => permissionDialog(tab, one, full(one)) }] : []),
    ...(one && !one.isDir ? [{ label: t('ctx.edit_with'), icon: 'edit', children: appsMenu(tab, full(one)) }] : []),
    ...(one && !one.isDir && archive.kind(one.name)
      ? [{ label: t('ctx.extract_here'), icon: 'archive', fn: () => extractArchive(tab, one, false) },
         ...(archive.kind(one.name).single ? [] : [{ label: t('ctx.extract_to', { name: archive.folderName(one.name) }), icon: 'folder-plus', fn: () => extractArchive(tab, one, true) }])]
      : []),
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

// ---------- Explorateur (un « volet » ; l'onglet peut en avoir deux côte à côte) ----------
// Un volet hérite de l'onglet (connexion, serveur) mais possède son propre état : chemin, historique, sélection, tri, recherche.
const ib = (name, titleKey, onclick, cls = '') => { const b = h('button', { className: ('ib ' + cls).trim(), innerHTML: icon(name), onclick }); b.dataset.i18nTitle = titleKey; return b }

function makeExplorer(tab) {
  const ex = Object.create(tab)
  Object.assign(ex, { root: tab, path: '', hist: [], entries: [], view: [], sel: new Set(), sort: { key: 'name', dir: 1 } })
  ex.back = ib('arrow-left', 'ex.back', () => load(ex, ex.hist.pop(), false))
  ex.pathInput = h('input', { className: 'path', spellcheck: false, onkeydown: e => { if (e.key === 'Enter') load(ex, e.target.value.trim()) } })
  ex.head = h('div', { className: 'row head' })
  ex.body = h('div')
  ex.statusL = h('span')
  ex.statusR = h('span')
  ex.transfer = buildTransfers(ex)
  ex.splitBtn = ib('split', 'ex.split', () => toggleSplit(ex))
  ex.pathsBtn = ib('bookmark', 'paths.title', () => { ex.pathsBox.hidden = !ex.pathsBox.hidden; if (!ex.pathsBox.hidden) paintPathsBox(ex) }, 'pbtn js-paths-btn')
  ex.pathsBox = h('div', { className: 'pathsbox', hidden: true })
  buildSearch(ex)
  const table = h('div', { className: 'table', oncontextmenu: e => ctxMenu(ex, e), onclick: e => { if (!e.target.closest('.row')) { ex.sel.clear(); paintSel(ex) } } }, ex.head, ex.body)
  ex.explorer = h('div', { className: 'explorer' },
    h('div', { className: 'toolbar' },
      ex.back, h('div', { className: 'pathbox' }, ex.pathInput, ex.pathsBtn),
      ib('search', 'ex.search', () => toggleSearch(ex), 'js-search-btn'),
      ex.splitBtn,
      ib('folder-plus', 'tb.new_folder', () => newItem(ex, 'dir')),
      ib('file-plus', 'tb.new_file', () => newItem(ex, 'file')),
      ib('refresh', 'tb.refresh', () => load(ex, ex.path || null, false))),
    ex.searchBox,
    ex.pathsBox,
    table,
    h('div', { className: 'status' }, ex.statusL, ex.transfer, ex.statusR))
  ex.explorer.addEventListener('mousedown', () => { tab.active = ex; tab.panes.forEach(p => p.explorer.classList.toggle('active', p === ex && tab.panes.length > 1)) })
  ex.explorer.ondragover = e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); ex.explorer.classList.add('drop') } }
  ex.explorer.ondragleave = e => { if (!ex.explorer.contains(e.relatedTarget)) ex.explorer.classList.remove('drop') }
  ex.explorer.ondrop = e => {
    e.preventDefault()
    ex.explorer.classList.remove('drop')
    const paths = [...e.dataTransfer.files].map(api.pathOf)
    // retour d'un glisser sorti de ce volet : ne pas se renvoyer ses propres fichiers (l'autre volet, lui, les reçoit)
    if (Date.now() - (ex.lastDragAt || 0) < 120000 && paths.every(p => p.includes('cyberdog-drag-'))) return
    if (paths.length && ex.path) upload(ex, paths)
  }
  applyI18n(ex.explorer)
  return ex
}

// Fenêtre scindée en deux explorateurs indépendants (comparer, copier d'un dossier à l'autre par glisser-déposer)
function layoutExplorers(tab) {
  const [a, b] = tab.panes
  const split = !!b
  const divider = h('div', { className: 'pane-rz' })
  if (split) {
    dragResize(divider, { axis: 'x', min: 240, max: () => tab.explorers.offsetWidth - 240, get: () => a.explorer.offsetWidth, set: w => (a.explorer.style.flex = `0 0 ${w}px`) })
  }
  a.explorer.style.flex = ''
  tab.explorers.replaceChildren(...(split ? [a.explorer, divider, b.explorer] : [a.explorer]))
  tab.panes.forEach(p => { p.splitBtn.classList.toggle('on', split); p.explorer.classList.toggle('active', split && p === tab.active) })
}

function toggleSplit(ex) {
  const tab = ex.root
  if (tab.panes.length === 1) {
    const p = makeExplorer(tab)
    p.sort = { ...ex.sort }
    tab.panes.push(p)
    tab.active = p
    layoutExplorers(tab)
    load(p, ex.path || null)
  } else {
    tab.panes.splice(tab.panes.indexOf(ex), 1)
    tab.active = tab.panes[0]
    layoutExplorers(tab)
  }
}

// ---------- Onglet serveur : explorateur(s) + terminal (bas) + panneau (droite) + barre d'outils ----------
function openFiles(server, { terminal = false } = {}) {
  const tab = { id: uid(), kind: 'files', opening: true, server, connId: null, panes: [], panel: null, term: null, termId: null, results: [], certificates: newCertificates(), keys: newKeys(), dash: newDash(), processes: newProcesses(), svc: newSvc(), docker: newDocker(), logs: newLogs() }
  tab.panes.push((tab.active = makeExplorer(tab)))
  tab.explorers = h('div', { className: 'explorers' })
  layoutExplorers(tab)

  // terminal (bas)
  tab.termBody = h('div', { className: 'term-body' })
  tab.termTitle = h('span', { className: 'term-title' })
  const splitter = h('div', { className: 'splitter' })
  dragResize(splitter, { axis: 'y', dir: -1, min: 120, max: () => tab.wsMain.offsetHeight - 160, get: () => tab.termWrap.offsetHeight, set: v => (tab.termWrap.style.height = v + 'px'), done: () => tab.fit?.fit() })
  tab.termWrap = h('div', { className: 'term-wrap', hidden: true }, splitter,
    h('div', { className: 'term-head' }, tab.termTitle, ib('x', 'term.close', () => closeTerminal(tab))),
    tab.termBody)
  const openingTitle = h('b', { textContent: t('srv.opening') })
  openingTitle.dataset.i18n = 'srv.opening'
  tab.openLoader = h('div', { className: 'connection-loader', role: 'status', ariaLive: 'polite' },
    h('img', { className: 'connection-dog', src: 'assets/icon.svg', alt: '' }), openingTitle,
    h('small', { textContent: `${server.name} · ${server.user}@${server.host}` }))
  tab.wsMain = h('div', { className: 'ws-main opening', ariaBusy: 'true' }, tab.explorers, tab.termWrap, tab.openLoader)

  // panneau de droite (largeur commune à tous les panneaux, redimensionnable)
  tab.rpanelTitle = h('span', { className: 'rp-title' })
  tab.rpanelActions = h('span', { className: 'rp-actions' })
  tab.rpanelBody = h('div', { className: 'rp-body' })
  const rz = h('div', { className: 'rz rz-left' })
  dragResize(rz, { axis: 'x', dir: -1, min: 290, max: () => Math.max(290, innerWidth - 560), get: () => tab.rpanel.offsetWidth, set: w => root.style.setProperty('--rpw', w + 'px'), done: () => saveSize('rpw', tab.rpanel.offsetWidth) })
  tab.rpanel = h('div', { className: 'rpanel', hidden: true }, rz,
    h('div', { className: 'rp-head' }, tab.rpanelTitle, tab.rpanelActions, ib('x', 'panel.close', () => setPanel(tab, tab.panel))),
    tab.rpanelBody)

  // barre d'outils (tout à droite)
  tab.bar = {}
  for (const [key, ic, title] of BAR) tab.bar[key] = ib(ic, title, () => (key === 'term' ? toggleTerminal(tab) : setPanel(tab, key)))
  tab.barToggle = h('button', { className: 'ib rbar-toggle', onclick: toggleRightBar })
  tab.rightBar = h('nav', { className: 'rbar', ariaLabel: t('bar.views') }, tab.barToggle, ...BAR.map(([k]) => tab.bar[k]))
  tab.el = h('div', { className: 'pane ws' }, tab.wsMain, tab.rpanel, tab.rightBar)
  applyI18n(tab.el)
  updateBar(tab)

  addTab(tab)
  load(tab.active, null).finally(() => {
    tab.opening = false
    tab.wsMain.classList.remove('opening')
    tab.wsMain.ariaBusy = 'false'
    tab.openLoader.remove()
  })
  if (terminal) openTerminal(tab)
}

// ---------- Init ----------
;(async () => {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
  document.body.classList.add(api.platform === 'darwin' ? 'mac' : 'other')
  $('#app-version').textContent = 'v' + await api.invoke('app:version')
  root.style.setProperty('--sbw', loadSize('sbw', 290) + 'px')
  root.style.setProperty('--rpw', Math.max(290, loadSize('rpw', 480)) + 'px')
  dragResize($('#sb-rz'), { axis: 'x', min: 200, max: 480, get: () => $('#sidebar').offsetWidth, set: w => root.style.setProperty('--sbw', w + 'px'), done: () => saveSize('sbw', $('#sidebar').offsetWidth) })
  const s = await api.invoke('settings:get')
  settings = s
  lang = s.lang
  theme = s.theme in THEMES ? s.theme : 'dracula'
  applyIcons(document)
  applyTheme()
  refreshLanguage()
  servers = await api.invoke('servers:list')
  quickActions = await api.invoke('actions:list')
  logFavs = await api.invoke('favs:list')
  groups = await api.invoke('groups:list')
  savedPaths = await api.invoke('paths:list')
  renderServers()
  api.invoke('premium:status').then(updatePremium).catch(() => {})
  await api.invoke('teams:status').then(updateAccount).catch(()=>{})
  renderServers()
  if (settings.restoreConnections) {
    const session = await api.invoke('session:get')
    restoringConnections = true
    try { for (const item of session) { const server = servers.find(s => s.id === item.serverId); if (server) openFiles(server, { terminal: item.terminal }) } }
    finally { restoringConnections = false; rememberConnections() }
  }
})()
