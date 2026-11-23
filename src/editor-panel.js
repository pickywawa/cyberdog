// ---------- Éditeur interne ----------
// Monaco, the editor of VS Code, in the right panel of a server tab: several files open at once, one tab each, with
// syntax colours, search / replace, multiple cursors and the VS Code shortcuts. Monaco is loaded the first time a
// file is opened. Files keep their encoding and line endings (see editor-files.js and main.js editor:read / write).
const MONACO = '../node_modules/monaco-editor/min/vs'
let monacoReady = null
function loadMonaco() {
  if (monacoReady) return monacoReady
  monacoReady = (async () => {
    const workers = await api.invoke('editor:workers')
    const base = new URL(MONACO + '/assets/', location.href).href
    const worker = label => label === 'json' ? workers.json : ['css', 'scss', 'less'].includes(label) ? workers.css
      : ['html', 'handlebars', 'razor'].includes(label) ? workers.html : ['typescript', 'javascript'].includes(label) ? workers.ts : workers.editor
    window.MonacoEnvironment = { getWorker: (_, label) => new Worker(base + worker(label), { name: label }) }
    document.head.append(h('link', { rel: 'stylesheet', href: MONACO + '/editor/editor.main.css' }))
    await new Promise((resolve, reject) => document.head.append(h('script', { src: MONACO + '/loader.js', onload: resolve, onerror: () => reject(new Error('loader.js')) })))
    window.require.config({ paths: { vs: MONACO } })
    await new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], resolve, reject))
    refreshEditorTheme()
    return window.monaco
  })()
  monacoReady.catch(() => { monacoReady = null })
  return monacoReady
}

// The editor follows the app's theme: its colours come from the theme's CSS variables
function refreshEditorTheme() {
  const monaco = window.monaco
  if (!monaco) return
  const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim()
  const hex = name => /^#[0-9a-f]{6}$/i.test(v(name)) ? v(name) : undefined
  const colors = Object.fromEntries(Object.entries({
    'editor.background': hex('--bg'), 'editorGutter.background': hex('--bg'), 'minimap.background': hex('--bg'),
    'editor.lineHighlightBackground': hex('--hover'), 'editor.selectionBackground': hex('--sel'), 'editorCursor.foreground': hex('--accent'),
    'editorLineNumber.activeForeground': hex('--text'), 'editorLineNumber.foreground': hex('--dim'),
    'editorWidget.background': hex('--menu'), 'editorSuggestWidget.background': hex('--menu'), 'focusBorder': hex('--accent'),
  }).filter(([, value]) => value))
  monaco.editor.defineTheme('cyberdog', { base: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [], colors })
  monaco.editor.setTheme('cyberdog')
}

const editorOf = tab => (tab.editor ||= { files: [], active: null })
const isDirty = f => f.model.getAlternativeVersionId() !== f.saved
const editorDirty = tab => (tab.editor?.files || []).filter(isDirty)
const ENCODING_LABEL = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', 'windows-1252': 'Windows-1252' }

// A question with several answers (its own layer, so that it can show over another dialog) -> index or -1
function askChoice(title, message, buttons, { danger = -1 } = {}) {
  return new Promise(resolve => {
    const overlay = h('div', { className: 'conflict-overlay' })
    const done = i => { overlay.remove(); resolve(i) }
    const card = h('div', { className: 'card choice-card', role: 'alertdialog', ariaModal: 'true', ariaLabel: title, tabIndex: -1, onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); done(-1) } } },
      h('h3', { textContent: title }), h('p', { className: 'choice-text', textContent: message }),
      h('div', { className: 'btns' }, ...buttons.map((label, i) => h('button', { type: 'button', className: i === 0 ? 'primary' : i === danger ? 'danger-btn' : '', textContent: label, onclick: () => done(i) }))))
    overlay.onmousedown = e => { if (e.target === overlay) done(-1) }
    overlay.append(card)
    document.body.append(overlay)
    card.querySelector('button.primary')?.focus()
  })
}

// The editor area holds one view, or two side by side (split). Each view shows one of the open files; the tab bar
// belongs to the view that has the focus (E.current). E.active / E.instance always point to that view.
function buildEditor(tab) {
  const E = editorOf(tab)
  E.tabs = h('div', { className: 'ed-tabs', role: 'tablist' })
  E.more = h('button', { type: 'button', className: 'ed-more', hidden: true, onclick: e => editorFilesMenu(tab, e) })
  E.tabbar = h('div', { className: 'ed-tabbar' }, E.tabs, E.more)
  E.views = []
  E.current = 0
  E.split = h('div', { className: 'ed-split' })
  E.status = h('div', { className: 'ed-status' })
  E.cfgbar = h('div', { className: 'ed-cfg', hidden: true })
  E.el = h('div', { className: 'editor-panel' }, E.tabbar, E.cfgbar, E.split, E.status)
  addEditorView(tab)
  new ResizeObserver(() => fitEditorTabs(tab)).observe(E.tabbar)
}
const editorOptions = () => ({ fontSize: settings.editorFontSize || 13, wordWrap: settings.editorWrap ? 'on' : 'off', minimap: { enabled: settings.editorMinimap !== false } })
function addEditorView(tab) {
  const monaco = window.monaco, E = editorOf(tab)
  const view = { host: h('div', { className: 'ed-host' }), file: null, states: new Map() }
  E.split.append(view.host)
  view.instance = monaco.editor.create(view.host, {
    ...editorOptions(), model: null, theme: 'cyberdog', automaticLayout: true, fixedOverflowWidgets: true, scrollBeyondLastLine: false,
    fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', renderWhitespace: 'selection',
  })
  view.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => view.file && saveEditorFile(tab, view.file))
  view.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => view.file && closeEditorFile(tab, view.file))
  view.instance.onDidFocusEditorWidget(() => { if (E.views[E.current] !== view) { E.current = E.views.indexOf(view); pointAtCurrent(E); paintEditorTabs(tab); paintEditorStatus(tab); paintEditorActions(tab) } })
  view.instance.onDidChangeCursorPosition(() => { if (E.views[E.current] === view) paintEditorStatus(tab) })
  E.views.push(view)
  pointAtCurrent(E)
  return view
}
function pointAtCurrent(E) { const v = E.views[E.current] || E.views[0]; E.instance = v?.instance; E.active = v?.file || null }
function refreshEditorOptions() { tabs.forEach(tb => tb.editor?.views?.forEach(v => v.instance.updateOptions(editorOptions()))); tabs.forEach(paintEditorActions) }

// Minimap and line wrapping: one click in the editor's header, remembered like the other settings
async function toggleEditorSetting(key) {
  try { settings = await api.invoke('settings:set', { [key]: key === 'editorMinimap' ? settings.editorMinimap === false : !settings[key] }) } catch (e) { return toast(errText(e), true) }
  refreshEditorOptions()
}
function toggleEditorSplit(tab) {
  const E = tab.editor
  if (!E?.views) return
  if (E.views.length > 1) {
    const view = E.views.pop()
    view.instance.dispose(); view.host.remove()
    E.current = 0
    pointAtCurrent(E)
    showEditorFile(tab, E.views[0].file || E.files[0], 0)
  } else if (E.active) {
    addEditorView(tab)
    showEditorFile(tab, E.active, 1) // the same file on both sides, as in VS Code; a tab click changes the focused side
  }
  paintEditorActions(tab)
}
function paintEditorActions(tab) {
  const bar = tab.rpanelActions
  if (!bar?.querySelector('.js-ed-save')) return
  bar.querySelector('.js-ed-minimap').classList.toggle('on', settings.editorMinimap !== false)
  bar.querySelector('.js-ed-wrap').classList.toggle('on', !!settings.editorWrap)
  bar.querySelector('.js-ed-split').classList.toggle('on', tab.editor?.views?.length > 1)
  bar.querySelector('.js-ed-save').toggleAttribute('disabled', !(tab.editor?.active && isDirty(tab.editor.active)))
}

// Opens a file of the pane `ex` in the editor (or shows its tab when it is already open)
async function openInEditor(ex, path) {
  const tab = ex.root || ex, E = editorOf(tab)
  const existing = E.files.find(f => f.ex.connId === ex.connId && f.path === path)
  if (existing) return showEditorFile(tab, existing)
  try {
    await ensure(ex)
    const loading = !window.monaco && setTimeout(() => toast(t('editor.loading'), false, 8000), 300)
    const [monaco, r] = await Promise.all([loadMonaco(), api.invoke('editor:read', ex.connId, path)])
    clearTimeout(loading)
    if (r.error === 'too_big' || r.error === 'binary') { toast(t('editor.' + r.error, { size: sizeOf(r.size || 0) })); return openExternally(ex, path) }
    if (r.error) throw new Error(r.error)
    if (!E.views) buildEditor(tab)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const model = monaco.editor.createModel(r.text, editorFiles.languageFor(name, monaco.languages.getLanguages()), monaco.Uri.from({ scheme: 'cyberdog', path: '/' + uid() + path }))
    model.setEOL(r.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
    const f = { id: uid(), ex, path, name, model, encoding: r.encoding, mixedEol: r.mixedEol, mtime: r.mtime, saved: model.getAlternativeVersionId(), diskText: r.text, previousText: null }
    model.onDidChangeContent(() => paintEditorTabs(tab))
    E.files.push(f)
    rebuildBar(tab)
    showEditorFile(tab, f)
  } catch (e) {
    $('#toast').hidden = true
    toast(window.monaco || !monacoReady ? errText(e) : t('editor.load_failed', { error: errText(e) }), true)
  }
}
function openExternally(ex, path) { return act(ex, () => api.invoke('sftp:edit', ex.connId, path), false) }

// Shows a file in a view (by default the focused one)
function showEditorFile(tab, f, index = editorOf(tab).current) {
  const E = editorOf(tab), view = E.views[index]
  if (!view || !f) return
  if (view.file && view.file !== f && E.files.includes(view.file)) view.states.set(view.file, view.instance.saveViewState())
  view.file = f
  view.instance.setModel(f.model)
  const state = view.states.get(f)
  if (state) view.instance.restoreViewState(state)
  E.current = index
  pointAtCurrent(E)
  if (tab.panel !== 'editor') setPanel(tab, 'editor')
  else renderPanel(tab)
  if (tab.id !== activeId) activate(tab.id)
  view.instance.focus()
}

function paintEditorTabs(tab) {
  const E = tab.editor
  if (!E?.tabs) return
  const other = E.views.length > 1 ? E.views[1 - E.current].file : null
  const label = f => E.files.some(o => o !== f && o.name === f.name) ? `${f.name} — ${f.path.split('/').slice(-2, -1)[0] || '/'}` : f.name
  E.tabs.replaceChildren(...E.files.map(f => {
    const dirty = isDirty(f)
    const close = h('button', { type: 'button', className: 'ed-close', innerHTML: icon('x'), title: t('editor.close'), ariaLabel: t('editor.close'), onclick: e => { e.stopPropagation(); closeEditorFile(tab, f) } })
    const el = h('div', { className: 'ed-tab' + (f === E.active ? ' active' : '') + (f === other ? ' other' : '') + (dirty ? ' dirty' : ''), role: 'tab', ariaSelected: String(f === E.active), title: f.path,
      onclick: () => showEditorFile(tab, f), onauxclick: e => { if (e.button === 1) closeEditorFile(tab, f) } },
      h('span', { className: 'fi ic-' + fileIcon({ name: f.name }, extOf({ name: f.name })).kind, innerHTML: icon(fileIcon({ name: f.name }, extOf({ name: f.name })).name) }),
      h('span', { className: 'ed-name', textContent: label(f) }), h('span', { className: 'ed-dot', textContent: '●' }), close)
    el.dataset.id = f.id
    return el
  }))
  fitEditorTabs(tab)
  paintEditorActions(tab)
  paintConfigBar(tab)
}
// Tabs that do not fit are hidden (never the current one) and a list at the end of the bar gives every open file
function fitEditorTabs(tab) {
  const E = tab.editor
  if (!E?.tabs?.isConnected) return
  const els = [...E.tabs.children]
  els.forEach(el => (el.hidden = false))
  E.more.hidden = true
  if (E.tabs.scrollWidth <= E.tabs.clientWidth) return
  E.more.hidden = false
  const room = E.tabs.clientWidth, widths = els.map(el => el.offsetWidth)
  const current = Math.max(0, els.findIndex(el => el.classList.contains('active')))
  const keep = new Set([current])
  let used = widths[current]
  for (let i = 0; i < els.length; i++) {
    if (i === current) continue
    if (used + widths[i] > room) break
    keep.add(i); used += widths[i]
  }
  els.forEach((el, i) => (el.hidden = !keep.has(i)))
  const hidden = els.length - keep.size
  E.more.innerHTML = `<span>${hidden}</span>` + icon('chevron-down')
  E.more.title = t('editor.files')
  E.more.ariaLabel = t('editor.files')
}
function editorFilesMenu(tab, e) {
  const E = tab.editor, r = e.currentTarget.getBoundingClientRect()
  menu(r.right - 260, r.bottom + 4, E.files.map(f => ({ label: f.name + (isDirty(f) ? ' ●' : ''), icon: fileIcon({ name: f.name }, extOf({ name: f.name })).name, checked: f === E.active, fn: () => showEditorFile(tab, f) })))
}

function paintEditorStatus(tab) {
  const E = tab.editor, f = E?.active
  if (!E?.status || !f) return
  const monaco = window.monaco, pos = E.instance.getPosition() || { lineNumber: 1, column: 1 }
  if (!E.language) {
    E.language = h('select', { className: 'ed-lang', title: t('editor.language'), ariaLabel: t('editor.language'), onchange: () => { monaco.editor.setModelLanguage(E.active.model, E.language.value); E.instance.focus() } },
      ...monaco.languages.getLanguages().map(l => [l.id, (l.aliases && l.aliases[0]) || l.id]).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => h('option', { value: id, textContent: name })))
    E.position = h('span')
    E.encoding = h('span', { title: t('editor.encoding') })
    E.eol = h('button', { type: 'button', className: 'ed-eol', title: t('editor.eol_toggle'), onclick: () => {
      const m = E.active.model, crlf = m.getEOL() === '\r\n'
      m.pushEOL(crlf ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF)
      paintEditorStatus(tab); paintEditorTabs(tab)
    } })
    E.mixed = h('span', { className: 'ed-warn' })
    E.status.replaceChildren(E.position, E.mixed, h('span', { className: 'ed-spacer' }), E.encoding, E.eol, E.language)
  }
  E.language.value = f.model.getLanguageId()
  E.position.textContent = t('editor.line_col', { line: pos.lineNumber, col: pos.column })
  E.encoding.textContent = ENCODING_LABEL[f.encoding] || f.encoding
  E.eol.textContent = f.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  E.mixed.textContent = f.mixedEol ? '⚠ ' + t('editor.mixed_eol') : ''
  E.mixed.title = f.mixedEol ? t('editor.mixed_eol_save', { eol: E.eol.textContent }) : ''
}

async function saveEditorFile(tab, f, force = false) {
  if (!f) return false
  const monaco = window.monaco
  if (f.mixedEol && !force && !f.mixedOk) {
    const eol = f.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
    if ((await askChoice(t('editor.mixed_eol'), t('editor.mixed_eol_save', { eol }), [t('editor.save'), t('btn.cancel')])) !== 0) return false
    f.mixedOk = true
  }
  const version = f.model.getAlternativeVersionId(), text = f.model.getValue(monaco.editor.EndOfLinePreference.TextDefined)
  try {
    await ensure(f.ex)
    const r = await api.invoke('editor:write', f.ex.connId, f.path, text, f.encoding, f.mtime, force)
    if (r.conflict) {
      const c = await askChoice(t('editor.changed_title'), t('editor.changed', { name: f.name }), [t('editor.overwrite'), t('editor.reload'), t('btn.cancel')], { danger: 0 })
      if (c === 0) return saveEditorFile(tab, f, true)
      if (c === 1) await reloadEditorFile(tab, f)
      return false
    }
    Object.assign(f, { mtime: r.mtime, saved: version, mixedEol: false, previousText: f.diskText, diskText: text })
    paintEditorTabs(tab); paintEditorStatus(tab)
    toast(t('editor.saved', { name: f.name }))
    return true
  } catch (e) { toast(errText(e), true); return false }
}

async function reloadEditorFile(tab, f) {
  try {
    await ensure(f.ex)
    const r = await api.invoke('editor:read', f.ex.connId, f.path)
    if (r.error) throw new Error(t('editor.' + r.error, { size: sizeOf(r.size || 0) }))
    f.model.setValue(r.text)
    f.model.setEOL(r.eol === 'crlf' ? window.monaco.editor.EndOfLineSequence.CRLF : window.monaco.editor.EndOfLineSequence.LF)
    Object.assign(f, { encoding: r.encoding, mixedEol: r.mixedEol, mixedOk: false, mtime: r.mtime, saved: f.model.getAlternativeVersionId(), diskText: r.text, previousText: null })
    paintEditorTabs(tab); paintEditorStatus(tab)
  } catch (e) { toast(errText(e), true) }
}

async function closeEditorFile(tab, f) {
  const E = tab.editor
  if (!E?.files.includes(f)) return
  if (isDirty(f)) {
    const c = await askChoice(t('editor.unsaved_title'), t('editor.unsaved', { name: f.name }), [t('editor.save'), t('editor.discard'), t('btn.cancel')], { danger: 1 })
    if (c === 0 && !(await saveEditorFile(tab, f))) return
    if (c !== 0 && c !== 1) return
  }
  const i = E.files.indexOf(f), current = E.current
  E.files.splice(i, 1)
  const next = E.files[Math.min(i, E.files.length - 1)]
  E.views.forEach((v, index) => {
    v.states.delete(f)
    if (v.file !== f) return
    v.file = null
    if (next) showEditorFile(tab, next, index)
    else v.instance.setModel(null)
  })
  E.current = Math.min(current, E.views.length - 1)
  pointAtCurrent(E)
  f.model.dispose()
  if (!E.files.length) {
    if (E.views.length > 1) { const v = E.views.pop(); v.instance.dispose(); v.host.remove(); E.current = 0; pointAtCurrent(E) }
    if (tab.panel === 'editor') setPanel(tab, 'editor')
  }
  paintEditorTabs(tab)
  paintEditorStatus(tab)
  rebuildBar(tab)
}
function cycleEditorFile(tab, step) {
  const E = tab.editor
  if (!E?.files.length) return
  showEditorFile(tab, E.files[(E.files.indexOf(E.active) + step + E.files.length) % E.files.length])
}
// Before a server tab closes: unsaved files make it ask first; then everything is released
function editorBeforeClose(tab) {
  const dirty = editorDirty(tab)
  if (dirty.length && !confirm(t('editor.unsaved_tab', { n: dirty.length }))) return false
  for (const f of tab.editor?.files || []) f.model.dispose()
  tab.editor?.views?.forEach(v => v.instance.dispose())
  return true
}
addEventListener('beforeunload', e => { if (tabs.some(tb => editorDirty(tb).length)) { e.preventDefault(); e.returnValue = '' } })

PANELS.editor = {
  title: 'editor.title',
  render: tab => {
    const E = editorOf(tab)
    if (!E.el) return
    tab.rpanelBody.classList.add('flush')
    tab.rpanelBody.append(E.el)
    const button = (cls, name, title, onclick) => h('button', { type: 'button', className: 'ib ' + cls, innerHTML: icon(name), title: t(title), ariaLabel: t(title), onclick })
    tab.rpanelActions.append(
      button('js-ed-minimap', 'minimap', 'editor.minimap', () => toggleEditorSetting('editorMinimap')),
      button('js-ed-wrap', 'wrap', 'editor.wrap', () => toggleEditorSetting('editorWrap')),
      button('js-ed-split', 'split', 'editor.split', () => toggleEditorSplit(tab)),
      button('js-ed-save', 'save', 'editor.save', () => saveEditorFile(tab, E.active)))
    E.language = null // rebuilt in the current language
    paintEditorTabs(tab); paintEditorStatus(tab)
    E.views.forEach(v => v.instance.layout())
  },
  leave: tab => { tab.editor?.views?.forEach(v => { if (v.file) v.states.set(v.file, v.instance.saveViewState()) }) },
}
