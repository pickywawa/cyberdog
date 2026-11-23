// Configuration bar of the built-in editor: for a known file (nginx, Apache, sshd, HAProxy, Caddy, systemd units,
// Docker Compose, sudoers), a bar under the tabs shows the service and offers Test, Reload, Restart and
// "Save and apply" (save → test → apply, nothing applied when the test fails). The checker's errors become markers
// on the right lines; the version saved before the last change can be put back. Profiles: config-profiles.js.
const cft = (key, vars) => t('cfg.' + key, vars)
const CFG_MARKERS = 'cyberdog-config'

function configOf(tab, f) {
  if (!f || !isShell(tab.server)) return null
  if (f.cfg === undefined) {
    const profile = configProfiles.profileFor(f.path)
    f.cfg = profile && { profile, busy: null, status: null, result: null, open: false, failed: false }
  }
  return f.cfg
}

function paintConfigBar(tab) {
  const E = tab.editor, bar = E?.cfgbar
  if (!bar) return
  const f = E.active, C = configOf(tab, f)
  bar.hidden = !C
  if (!C) { bar.replaceChildren(); return }
  if (C.status === null) { C.status = false; configStatus(tab, f) }
  const P = C.profile, actions = configProfiles.actionsOf(P)
  const state = C.status?.state, level = !C.status ? 'idle' : state === 'active' || /^(\d+)\/\1$/.test(state) && state !== '0/0' ? 'ok' : /^(failed|inactive)$/.test(state) || /^0\//.test(state) ? 'crit' : 'warn'
  const label = a => cft('a.' + a)
  const button = (a, primary = false) => h('button', { type: 'button', className: 'chip' + (primary ? ' on' : '') + (a === 'restart' ? ' danger' : ''), disabled: !!C.busy,
    textContent: C.busy === a || primary && C.busy === 'apply' ? cft('running', { action: primary ? cft('apply') : label(a) }) : primary ? cft('apply') : label(a),
    title: primary ? cft('apply_title', { action: label(P.apply) }) : '', onclick: () => primary ? configApply(tab, f) : configRun(tab, f, a) })
  const n = C.result?.problems.length || 0
  bar.replaceChildren(
    h('span', { className: 'ed-cfg-name', innerHTML: icon('cog') }, h('b', { textContent: P.name })),
    h('span', { className: 'ed-cfg-state', title: C.status?.unit || '' }, h('span', { className: 'dot lv-' + level }), C.status ? `${C.status.unit} · ${state || cft('unknown')}` : ''),
    h('span', { className: 'ed-spacer' }),
    ...actions.map(a => button(a)),
    ...(P.apply ? [button(P.apply, true)] : []),
    ...(C.result ? [h('button', { type: 'button', className: 'ib ed-cfg-toggle' + (C.result.code === 0 ? '' : ' err'), title: cft(C.open ? 'hide_output' : 'show_output'),
      innerHTML: icon(C.open ? 'chevron-up' : 'chevron-down') + (n ? `<span>${n}</span>` : ''), onclick: () => { C.open = !C.open; paintConfigBar(tab) } })] : []))
  E.cfgout?.remove()
  E.cfgout = null
  if (C.result && C.open) {
    const R = C.result
    E.cfgout = h('div', { className: 'ed-cfg-out' + (R.code === 0 ? '' : ' err') },
      h('div', { className: 'ed-cfg-head' }, h('b', { textContent: R.title }),
        ...(C.failed && f.previousText != null ? [h('button', { type: 'button', className: 'chip danger', textContent: cft('rollback'), onclick: () => configRollback(tab, f) })] : [])),
      ...R.problems.map(p => h('button', { type: 'button', className: 'ed-cfg-problem lv-' + (p.severity === 'warning' ? 'warn' : 'crit'), onclick: () => revealLine(tab, p.line) },
        h('span', { className: 'mchip', textContent: cft('line', { line: p.line }) }), h('span', { textContent: p.message }))),
      h('pre', { textContent: R.out.trim() || cft('no_output') }))
    bar.after(E.cfgout)
  }
}

function revealLine(tab, line) {
  const ed = tab.editor?.instance
  if (!ed) return
  ed.revealLineInCenter(line)
  ed.setPosition({ lineNumber: line, column: 1 })
  ed.focus()
}

async function configInvoke(f, action) {
  await ensure(f.ex)
  return api.invoke('editor:config', f.ex.connId, f.path, f.cfg.profile.id, action)
}
async function configStatus(tab, f) {
  try {
    const r = await configInvoke(f, 'status')
    const [unit, state] = r.out.trim().split('\n').pop().split(/\s+/)
    f.cfg.status = r.code === 0 && unit ? { unit, state } : false
  } catch { f.cfg.status = false }
  if (tab.editor?.active === f) paintConfigBar(tab)
}

// markers on the file for the problems the checker reported in it
function configMarkers(f, problems) {
  const monaco = window.monaco
  if (!monaco || f.model.isDisposed()) return
  monaco.editor.setModelMarkers(f.model, CFG_MARKERS, problems.filter(p => p.line <= f.model.getLineCount()).map(p => ({
    startLineNumber: p.line, endLineNumber: p.line, startColumn: 1, endColumn: f.model.getLineMaxColumn(p.line),
    message: p.message, severity: p.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error, source: f.cfg.profile.name })))
}

// The actions work on the file saved on the server: unsaved changes are saved first.
async function configSaved(tab, f) { return !isDirty(f) || await saveEditorFile(tab, f) }
function configConfirm(C, action) {
  const name = C.status?.unit || C.profile.name
  if (action === 'restart') return confirm(cft('confirm_restart', { name }))
  if (action === 'up') return confirm(cft('confirm_up'))
  if (C.profile.careful && action === 'reload') return confirm(cft('confirm_ssh'))
  return true
}

async function configStep(tab, f, action) {
  const C = f.cfg
  let r
  try { r = await configInvoke(f, action) } catch (e) { r = { code: -1, out: errText(e) } }
  const problems = action === 'test' ? configProfiles.problems(r.out, f.path) : []
  if (action === 'test') configMarkers(f, problems)
  C.result = { action, code: r.code, out: r.out, problems, title: r.code === 0 ? (action === 'test' ? cft('test_ok') : cft('done', { action: cft('a.' + action) })) : action === 'test' ? cft('test_failed') : cft('action_failed', { action: cft('a.' + action), code: r.code }) }
  return r.code === 0
}

async function configRun(tab, f, action) {
  const C = f.cfg
  if (C.busy || !configConfirm(C, action) || !(await configSaved(tab, f))) return
  C.busy = action; C.failed = false
  paintConfigBar(tab)
  const ok = await configStep(tab, f, action)
  C.busy = null
  C.open = !ok || C.result.problems.length > 0 || C.open
  C.failed = !ok
  toast(C.result.title, !ok)
  paintConfigBar(tab)
  if (action !== 'test') configStatus(tab, f)
}

// Save → test → apply. A failed test applies nothing and offers the previous version back.
async function configApply(tab, f) {
  const C = f.cfg, apply = C.profile.apply
  if (C.busy || !configConfirm(C, apply) || !(await configSaved(tab, f))) return
  C.busy = 'apply'; C.failed = false
  paintConfigBar(tab)
  let ok = await configStep(tab, f, 'test')
  if (!ok) { C.failed = true; C.result.title = cft('test_failed') }
  else {
    const warnings = C.result.problems
    ok = await configStep(tab, f, apply)
    if (ok) C.result.problems = warnings
    else C.failed = true
  }
  C.busy = null
  C.open = !ok || C.result.problems.length > 0
  toast(ok ? cft('applied', { action: cft('a.' + apply) }) : C.result.title, !ok)
  paintConfigBar(tab)
  configStatus(tab, f)
}

// Puts back the content saved before the last save (only the editor's own last save is known).
async function configRollback(tab, f) {
  if (f.previousText == null || !confirm(cft('rollback_confirm', { name: f.name }))) return
  const previous = f.previousText
  f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: previous }], () => null)
  if (!(await saveEditorFile(tab, f))) return
  f.previousText = null
  f.cfg.failed = false
  configMarkers(f, [])
  toast(cft('rolled_back'))
  const reapply = f.cfg.profile.apply
  if (reapply && confirm(cft('reapply', { action: cft('a.' + reapply) }))) return configApply(tab, f)
  f.cfg.result = null
  paintConfigBar(tab)
}
