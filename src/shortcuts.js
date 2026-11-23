// Raccourcis clavier (issue #1). « Mod » = ⌘ sur macOS, Ctrl ailleurs.
// match() est pur (testé dans test/shortcuts.test.js) ; install() branche les actions dans le renderer.
;(function () {
  // [action, combinaisons, portée] — portée : 'files' (explorateur, hors champ de saisie) ou 'global' (partout, sauf modale)
  // Une combinaison : touches séparées par « + », la dernière est e.key (insensible à la casse) ou e.code entre crochets.
  const BINDINGS = [
    ['refresh', ['Mod+R', 'F5'], 'files'],
    ['selectAll', ['Mod+A'], 'files'],
    ['open', ['Enter', 'Mod+ArrowDown'], 'files'],
    ['parent', ['Mod+ArrowUp', 'Alt+ArrowUp'], 'files'],
    ['back', ['Mod+[BracketLeft]', 'Alt+ArrowLeft'], 'files'],
    ['rename', ['F2'], 'files'],
    ['delete', ['Delete', 'Mod+Backspace'], 'files'],
    ['newFolder', ['Mod+Shift+N'], 'files'],
    ['newFile', ['Mod+Alt+N'], 'files'],
    ['copyPath', ['Mod+Shift+C'], 'files'],
    ['copy', ['Mod+C'], 'files'],
    ['cut', ['Mod+X'], 'files'],
    ['paste', ['Mod+V'], 'files'],
    ['duplicate', ['Mod+D'], 'files'],
    ['info', ['Mod+I'], 'files'],
    ['switchPane', ['Tab', 'Shift+Tab'], 'files'],
    ['path', ['Mod+L'], 'files'],
    ['search', ['Mod+F'], 'files'],
    ['down', ['ArrowDown', 'Shift+ArrowDown'], 'files'],
    ['up', ['ArrowUp', 'Shift+ArrowUp'], 'files'],
    ['first', ['Home'], 'files'],
    ['last', ['End'], 'files'],
    ['terminal', ['Ctrl+[Backquote]'], 'global'],
    ['closeTab', ['Mod+W'], 'global'],
    ['nextTab', ['Ctrl+Tab', 'Mod+Shift+[BracketRight]'], 'global'],
    ['prevTab', ['Ctrl+Shift+Tab', 'Mod+Shift+[BracketLeft]'], 'global'],
    ['tab', ['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8', 'Mod+9'], 'global'],
    ['help', ['Mod+/', 'Mod+Shift+/', 'Mod+[Slash]', 'Mod+Shift+[Slash]'], 'global'],
    ['settings', ['Mod+,'], 'global'],
  ]
  // Dans le terminal hors macOS, Ctrl appartient au shell (Ctrl+W, Ctrl+R, Ctrl+A…) : seuls ceux-ci passent.
  const TERMINAL_OTHER = new Set(['terminal', 'nextTab', 'prevTab'])
  // Actions sur la liste de fichiers : ignorées quand le focus est ailleurs (panneau, barre latérale, bouton…)
  const LIST_ONLY = new Set(['open', 'down', 'up', 'first', 'last', 'delete', 'rename', 'selectAll', 'copy', 'cut', 'paste', 'duplicate', 'info', 'switchPane'])

  function parse(combo, mac) {
    const parts = combo.split('+')
    // « Mod+Shift++ » n'existe pas ici, mais « Mod+/ » si : la dernière partie est la touche
    const key = parts.pop()
    const mods = { meta: false, ctrl: false, alt: false, shift: false }
    for (const p of parts) {
      if (p === 'Mod') mods[mac ? 'meta' : 'ctrl'] = true
      else mods[p.toLowerCase()] = true
    }
    return { key, mods }
  }
  function matches(e, combo, mac) {
    const { key, mods } = parse(combo, mac)
    if (!!e.metaKey !== mods.meta || !!e.ctrlKey !== mods.ctrl || !!e.altKey !== mods.alt) return false
    const code = key.startsWith('[') && key.slice(1, -1)
    if (code) return e.code === code && !!e.shiftKey === mods.shift
    if (!!e.shiftKey !== mods.shift) return false
    if (String(e.key).toLowerCase() === key.toLowerCase()) return true
    // Physical position (e.code) only when the key does not give a Latin letter (Cyrillic layout, ⌥ on macOS, digits
    // on AZERTY…). Otherwise ⌘Z on AZERTY, whose code is KeyW, would be taken for ⌘W.
    if (/^[a-z]$/i.test(e.key)) return false
    return /^[a-z0-9]$/i.test(key) && e.code === (/\d/.test(key) ? 'Digit' : 'Key') + key.toUpperCase()
  }

  // e : KeyboardEvent (ou objet équivalent) ; ctx : { mac, editing, terminal, elsewhere }
  // → { action, n?, extend? } ou null
  function match(e, { mac = false, editing = false, terminal = false, elsewhere = false } = {}) {
    for (const [action, combos, scope] of BINDINGS) {
      const combo = combos.find(c => matches(e, c, mac))
      if (!combo) continue
      if (scope === 'files' && (editing || terminal)) continue
      if (elsewhere && LIST_ONLY.has(action)) continue
      if (terminal && !mac && !TERMINAL_OTHER.has(action)) continue
      if (editing && !terminal && !mac && action === 'closeTab') continue
      const r = { action }
      if (action === 'tab') r.n = +combo.slice(-1)
      if ((action === 'down' || action === 'up') && e.shiftKey) r.extend = true
      return r
    }
    return null
  }

  // Libellé lisible d'une combinaison (aide) : ⌘⇧N sur macOS, Ctrl+Shift+N ailleurs.
  const MAC_SYM = { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
  const KEY_NAME = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Delete: 'Del', Enter: '↩', BracketLeft: '[', BracketRight: ']', Backquote: '`', Slash: '/', Tab: 'Tab', Home: 'Home', End: 'End' }
  function label(combo, mac) {
    const { key, mods } = parse(combo, mac)
    const k = key.startsWith('[') ? key.slice(1, -1) : key
    const name = KEY_NAME[k] || (k.length === 1 ? k.toUpperCase() : k)
    const on = ['ctrl', 'alt', 'shift', 'meta'].filter(m => mods[m])
    if (mac) return on.map(m => MAC_SYM[m]).join('') + (mac && k === 'Delete' ? '⌦' : name)
    return [...on.map(m => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' })[m]), name].join('+')
  }

  const api = { BINDINGS, match, label }
  if (typeof module !== 'undefined') { module.exports = api; return }
  window.shortcuts = api
})()

// ---------- Branchement dans le renderer (navigateur uniquement) ----------
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  const mac = api.platform === 'darwin'
  const activeTab = () => tabs.find(tb => tb.id === activeId)
  // Monaco's text input is not always a textarea (EditContext): the code view counts as a text field
  const isEditing = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('.monaco-editor')) && !el.closest('.term-body')

  // Même convention que le Maj+clic de renderer.js : ex.last est l'ancre, ex.cursor la ligne courante au clavier.
  function cursorOf(ex) {
    const c = ex.cursor != null && ex.view[ex.cursor] && ex.sel.has(ex.view[ex.cursor].name) ? ex.cursor : ex.last
    return c != null && ex.view[c] ? c : null
  }
  function moveCursor(ex, to, extend) {
    if (!ex.view.length) return
    to = Math.max(0, Math.min(ex.view.length - 1, to))
    if (extend && ex.last != null && ex.view[ex.last]) {
      const [a, b] = [ex.last, to].sort((x, y) => x - y)
      ex.sel = new Set(ex.view.slice(a, b + 1).map(x => x.name))
    } else {
      ex.sel = new Set([ex.view[to].name])
      ex.last = to
    }
    ex.cursor = to
    paintSel(ex)
    ex.rowEls?.[to]?.scrollIntoView({ block: 'nearest' })
  }
  const selected = ex => ex.view.filter(x => ex.sel.has(x.name))
  const full = (ex, x) => join(ex.path, x.name)

  function showHelp() {
    const rows = [
      ['tb.refresh', 'refresh'], ['ex.search', 'search'], ['kb.path', 'path'],
      ['kb.open', 'open'], ['kb.parent', 'parent'], ['ex.back', 'back'],
      ['kb.move', 'down'], ['kb.select_all', 'selectAll'], ['kb.copy_path', 'copyPath'],
      ['ctx.copy', 'copy'], ['ctx.cut', 'cut'], ['ctx.paste', 'paste'], ['ctx.duplicate', 'duplicate'], ['ctx.info', 'info'],
      ['kb.switch_pane', 'switchPane'], ['kb.type_select', 'typeSelect'],
      ['ctx.rename', 'rename'], ['ctx.delete', 'delete'],
      ['tb.new_folder', 'newFolder'], ['tb.new_file', 'newFile'],
      ['bar.terminal', 'terminal'], ['kb.next_tab', 'nextTab'], ['kb.prev_tab', 'prevTab'],
      ['kb.goto_tab', 'tab'], ['kb.close_tab', 'closeTab'], ['settings.title', 'settings'], ['kb.title', 'help'],
    ]
    const combos = Object.fromEntries(shortcuts.BINDINGS.map(([a, c]) => [a, c]))
    const keysFor = action => {
      if (action === 'tab') return [shortcuts.label('Mod+1', mac).replace(/1$/, '1…9')]
      if (action === 'down') return ['↑ ↓', shortcuts.label('Shift+ArrowDown', mac).replace('↓', '↑↓')]
      if (action === 'help') return [shortcuts.label('Mod+/', mac)]
      if (action === 'switchPane') return ['Tab']
      if (action === 'typeSelect') return ['a…z']
      return [...new Set(combos[action].map(c => shortcuts.label(c, mac)))]
    }
    const m = $('#modal')
    const close = () => { m.hidden = true; m.replaceChildren(); m.onmousedown = null }
    const list = h('div', { className: 'kb-list' }, ...rows.map(([key, action]) => h('div', { className: 'kb-row' },
      h('span', { textContent: t(key) }),
      h('span', { className: 'kb-keys' }, ...keysFor(action).map(k => h('kbd', { textContent: k }))))))
    const card = h('section', { className: 'card wide kb-card', role: 'dialog', ariaModal: 'true', ariaLabel: t('kb.title'), tabIndex: -1, onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); close() } } },
      h('h3', { textContent: t('kb.title') }), list,
      h('div', { className: 'btns' }, h('button', { type: 'button', className: 'primary', textContent: 'OK', onclick: close })))
    m.onmousedown = e => { if (e.target === m) close() }
    m.replaceChildren(card)
    m.hidden = false
    card.querySelector('button.primary').focus()
  }
  window.showShortcuts = showHelp
  $('#btn-shortcuts').onclick = showHelp
  api.on('app:shortcuts', showHelp)

  function run({ action, n, extend }) {
    const tab = activeTab()
    const ex = tab?.active
    switch (action) {
      case 'help': return showHelp()
      case 'settings': return openSettingsModal()
      case 'nextTab':
      case 'prevTab': {
        if (tabs.length < 2) return
        const i = tabs.findIndex(tb => tb.id === activeId)
        return activate(tabs[(i + (action === 'nextTab' ? 1 : -1) + tabs.length) % tabs.length].id)
      }
      case 'tab': {
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]
        return target && activate(target.id)
      }
      case 'closeTab': return tab && closeTab(tab.id)
      case 'terminal':
        if (!tab || !isShell(tab.server)) return
        if (tab.term) { if (document.activeElement?.closest('.term-body')) return closeTerminal(tab); return tab.term.focus() }
        return openTerminal(tab)
    }
    if (!ex || tab.opening) return
    switch (action) {
      case 'refresh': return load(ex, ex.path || null, false)
      case 'search': return isShell(ex.server) && toggleSearch(ex, true)
      case 'path': return editPath(ex)
      case 'selectAll': ex.sel = new Set(ex.view.map(x => x.name)); return paintSel(ex)
      case 'back': return ex.hist.length && load(ex, ex.hist.pop(), false)
      case 'parent': return ex.path && ex.path !== '/' && load(ex, join(ex.path, '..'))
      case 'newFolder': return newItem(ex, 'dir')
      case 'copy': return copyFiles(ex)
      case 'cut': return copyFiles(ex, true)
      case 'paste': return pasteFiles(ex)
      case 'switchPane': {
        const other = tab.panes.find(p => p !== ex)
        if (!other) return
        tab.active = other
        tab.panes.forEach(p => p.explorer.classList.toggle('active', p === other))
        other.table.tabIndex = -1
        other.table.focus({ preventScroll: true })
        return
      }
      case 'newFile': return newItem(ex, 'file')
      case 'down':
      case 'up': {
        const cur = cursorOf(ex) ?? (action === 'down' ? -1 : ex.view.length)
        return moveCursor(ex, cur + (action === 'down' ? 1 : -1), extend)
      }
      case 'first': return moveCursor(ex, 0)
      case 'last': return moveCursor(ex, ex.view.length - 1)
    }
    const sel = selected(ex)
    if (!sel.length) return
    const one = sel.length === 1 ? sel[0] : null
    switch (action) {
      case 'duplicate': return duplicateFiles(ex, sel)
      case 'info': return showInfo(ex, sel)
      case 'open': {
        if (!one) return
        const i = ex.view.indexOf(one)
        return ex.rowEls?.[i]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      }
      case 'copyPath':
        navigator.clipboard.writeText(sel.map(x => full(ex, x)).join('\n'))
        return toast(t('kb.copied'))
      case 'rename': return one && renameItem(ex, one)
      case 'delete':
        if (confirm(one ? t('dlg.confirm_del_one', { name: one.name }) : t('dlg.confirm_del_many', { n: sel.length })))
          act(ex, () => api.invoke('sftp:rm', ex.connId, sel.map(x => full(ex, x))))
    }
  }

  // Taper le début d'un nom sélectionne la ligne (« con » → config/) ; une seule lettre répétée passe à la suivante
  let typed = '', typedAt = 0
  function typeToSelect(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || (e.key === ' ' && (!typed || Date.now() - typedAt > 900))) return false
    const tab = activeTab(), ex = tab?.panes.find(p => p.table === document.activeElement?.closest?.('.table')) || tab?.active
    if (!ex?.view?.length) return false
    const now = Date.now()
    typed = now - typedAt > 900 ? e.key : typed + e.key
    typedAt = now
    const i = fileTools.typeAhead(ex.view.map(x => x.name), typed, cursorOf(ex))
    if (i >= 0) moveCursor(ex, i)
    return true
  }

  // Un clic dans la liste lui donne le focus clavier (sinon le dernier bouton cliqué le garde)
  addEventListener('mousedown', e => {
    const table = e.target.closest?.('.explorer .table')
    if (table) { table.tabIndex = -1; table.focus({ preventScroll: true }) }
  }, true)

  // Phase de capture : passe avant xterm, qui sinon enverrait la touche au shell.
  addEventListener('keydown', e => {
    if (e.repeat && !/^Arrow/.test(e.key)) return
    if (!$('#modal').hidden || !$('#menu').hidden) return
    const el = document.activeElement
    const terminal = !!el?.closest?.('.term-body')
    // un panneau de droite ou une boîte de recherche/favoris a le focus : pas de navigation dans la liste
    const elsewhere = !!el && el !== document.body && !el.closest?.('.explorer .table')
    const hit = shortcuts.match(e, { mac, editing: isEditing(el), terminal, elsewhere })
    if (!hit) {
      if (!elsewhere && !terminal && !isEditing(el) && el?.closest?.('.explorer .table') && typeToSelect(e)) { e.preventDefault(); e.stopPropagation() }
      return
    }
    // In the editor: ⌘/ comments the line, ⌘W closes the file, Ctrl+Tab goes from file to file
    if (el?.closest?.('.editor-panel')) {
      if (hit.action === 'help') return
      if (['closeTab', 'nextTab', 'prevTab'].includes(hit.action)) {
        e.preventDefault(); e.stopPropagation()
        const tab = activeTab()
        return hit.action === 'closeTab' ? closeEditorFile(tab, tab.editor?.active) : cycleEditorFile(tab, hit.action === 'nextTab' ? 1 : -1)
      }
    }
    // Tab moves between the two panes; with a single pane it keeps its usual role
    if (hit.action === 'switchPane' && !(activeTab()?.panes.length > 1)) return
    e.preventDefault()
    e.stopPropagation()
    run(hit)
  }, true)
}
