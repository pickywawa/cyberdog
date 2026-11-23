// Right panel: scheduled tasks (crontab + systemd timers). Model in schedules.js; reuses h, t, icon, toast, ensure, hib, fmtUptime, createLogView, menu.
const newSchedules = () => ({ snap: null, at: 0, error: null, busy: false, query: '', filter: 'all', selected: null, editing: null, saving: false, run: null, lv: null, ui: null })
const ct = (key, vars) => t('cron.' + key, vars)

async function schedulePoll(tab) {
  const S = tab.schedules
  if (S.busy) return
  S.busy = true
  try {
    await ensure(tab)
    S.snap = await api.invoke('sched:list', tab.connId)
    S.at = Date.now()
    S.error = null
  } catch (e) { S.error = errText(e) }
  finally { S.busy = false }
  if (tab.panel === 'schedules') { fillSchedules(tab); if (!S.editing) paintScheduleDetail(tab) }
}
function leaveSchedules(tab) { const S = tab.schedules; S.lv?.stop(); S.lv = null; S.editing = null }

// server wall clock, in ms, read through UTC getters
const serverWall = S => (S.snap.now + S.snap.offset) * 1000 + (Date.now() - S.at)
const wallDate = (ms, opts = {}) => new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', ...opts }).format(ms)
const relTime = (ms, now) => { const s = Math.round((ms - now) / 1000); return s < 60 && s > -60 ? ct('soon') : s > 0 ? ct('in', { time: fmtUptime(s) }) : ct('ago', { time: fmtUptime(-s) }) }

function scheduleItems(S) {
  const s = S.snap, now = serverWall(S), out = []
  for (const e of s.entries) {
    let sched = null, desc = ''
    try { sched = scheduleModel.parseSchedule(e.schedule); desc = scheduleModel.describe(sched, t, lang) } catch { desc = e.schedule }
    const next = sched && !e.disabled ? scheduleModel.nextRuns(sched, now, 1)[0] ?? null : null
    out.push({ ...e, kind: 'cron', title: e.name || e.command, desc, sched, next, editable: e.source === 'user', where: e.source === 'user' ? ct('source_user', { user: e.user }) : ct('source_file', { file: e.file, user: e.user }) })
  }
  for (const p of s.periodic) out.push({ ...p, kind: 'cron', title: p.file.split('/').pop(), desc: ct('periodic', { dir: `/etc/cron.${p.period}` }), next: null, where: ct('source_file', { file: p.file, user: 'root' }) })
  for (const tm of s.timers) {
    const failed = !!tm.result && tm.result !== 'success'
    out.push({ ...tm, kind: 'timer', title: tm.name.replace(/\.timer$/, ''), desc: tm.description || tm.schedule, failed, disabled: tm.active !== 'active', next: tm.next ? (tm.next + s.offset) * 1000 : null, last: tm.last ? (tm.last + s.offset) * 1000 : null, where: ct('source_timer') })
  }
  return out
}
const SCHED_FILTERS = { all: () => true, cron: x => x.kind === 'cron', timers: x => x.kind === 'timer', failed: x => x.failed }

function renderSchedules(tab) {
  const S = tab.schedules
  tab.rpanelActions.append(hib('plus', 'cron.new', () => editSchedule(tab, null)), hib('refresh', 'tb.refresh', () => schedulePoll(tab)))
  const input = h('input', { className: 's-filter', spellcheck: false, placeholder: ct('search'), value: S.query, oninput: () => { S.query = input.value; fillSchedules(tab) } })
  const chips = Object.keys(SCHED_FILTERS).map(k => {
    const b = h('button', { className: 'chip' + (S.filter === k ? ' on' : ''), onclick: () => { S.filter = k; chips.forEach(c => c.classList.toggle('on', c.dataset.k === k)); fillSchedules(tab) } })
    b.dataset.k = k
    return b
  })
  S.ui = { chips, summary: h('div', { className: 'tiles proc-summary' }), list: h('div', { className: 'proc-list sched-list' }), detail: h('div', { className: 'proc-detail' }), note: h('div', { className: 'dim proc-note' }) }
  tab.rpanelBody.append(S.ui.summary, h('div', { className: 'svc-tools' }, input, h('div', { className: 'chips' }, ...chips)), S.ui.detail, S.ui.list, S.ui.note)
  fillSchedules(tab)
  if (S.editing) paintScheduleEditor(tab)
  else paintScheduleDetail(tab)
}

function fillSchedules(tab) {
  const S = tab.schedules, ui = S.ui
  if (!ui || tab.panel !== 'schedules') return
  ui.list.replaceChildren()
  const msg = (text, cls = '') => ui.list.append(h('div', { className: 'msg small ' + cls, textContent: text }))
  if (!S.snap) { ui.summary.replaceChildren(); ui.chips.forEach(c => { c.textContent = ct(c.dataset.k) }); return S.error ? msg(S.error, 'err') : msg(t('dash.checking')) }
  const items = scheduleItems(S), now = serverWall(S)
  ui.chips.forEach(c => { c.textContent = `${ct(c.dataset.k)} ${items.filter(SCHED_FILTERS[c.dataset.k]).length}` })
  const soonest = items.filter(x => x.next).sort((a, b) => a.next - b.next)[0]
  ui.summary.replaceChildren(...[[ct('count_cron'), String(items.filter(x => x.kind === 'cron').length)], [ct('count_timers'), String(S.snap.timers.length)], [ct('next'), soonest ? relTime(soonest.next, now) : '—']]
    .map(([label, value]) => h('div', { className: 'tile-s' }, h('small', { textContent: label }), h('b', { textContent: value }))))
  ui.note.textContent = [S.error, ct('timezone', { tz: S.snap.tz }), S.snap.cron.available ? '' : ct('no_crontab')].filter(Boolean).join(' · ')
  ui.note.classList.toggle('err', !!S.error)
  const q = S.query.toLowerCase()
  const shown = items.filter(x => SCHED_FILTERS[S.filter](x) && (!q || [x.title, x.desc, x.command, x.schedule, x.name, x.unit, x.where].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.failed ? 1 : 0) - (a.failed ? 1 : 0) || (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || (a.next ?? Infinity) - (b.next ?? Infinity) || a.title.localeCompare(b.title))
  if (!shown.length) return msg(ct(items.length ? 'no_match' : 'none'))
  for (const x of shown) {
    const row = h('div', { className: 'proc-row' + (S.selected === x.id ? ' selected' : '') + (x.disabled ? ' sched-off' : ''), oncontextmenu: e => { e.preventDefault(); scheduleMenu(tab, x, e) } },
      h('span', { className: 'dot lv-' + (x.failed ? 'crit' : x.disabled ? 'idle' : 'ok') }),
      h('button', { className: 'proc-main', title: x.command || x.unit || '', onclick: () => selectSchedule(tab, x) },
        h('b', { textContent: x.title }),
        h('small', { className: 'dim', textContent: [x.desc, x.kind === 'timer' ? 'systemd' : x.editable ? '' : x.user].filter(Boolean).join(' · ') }),
        ...(x.failed ? [h('small', { className: 'lv-warn', textContent: ct('result_failed', { result: x.result }) })] : [])),
      h('span', { className: 'proc-metrics', textContent: x.disabled ? ct('disabled') : x.next ? relTime(x.next, now) : x.sched?.reboot ? ct('at_boot') : '—' }))
    ui.list.append(row)
  }
}

const findSchedule = (S, id) => S.snap && scheduleItems(S).find(x => x.id === id)
function selectSchedule(tab, x) {
  const S = tab.schedules
  if (S.selected !== x.id) { S.lv?.stop(); S.lv = null; S.run = null }
  S.selected = x.id; S.editing = null
  fillSchedules(tab); paintScheduleDetail(tab)
}

function paintScheduleDetail(tab) {
  const S = tab.schedules
  if (tab.panel !== 'schedules' || !S.ui || S.editing) return
  const body = S.ui.detail
  body.replaceChildren()
  if (!S.selected) return
  const x = findSchedule(S, S.selected)
  if (!x) { S.lv?.stop(); S.lv = null; return body.append(h('div', { className: 'msg small', textContent: ct('gone') })) }
  const now = serverWall(S)
  const close = h('button', { className: 'ib', innerHTML: icon('x'), title: t('panel.close'), onclick: () => { S.selected = null; S.run = null; S.lv?.stop(); S.lv = null; fillSchedules(tab); paintScheduleDetail(tab) } })
  body.append(h('div', { className: 'proc-detail-head' }, h('b', { textContent: x.title }), close))
  body.append(h('pre', { className: 'proc-command', textContent: x.kind === 'timer' ? [x.name + ' → ' + x.unit, x.fragment].filter(Boolean).join('\n') : x.command }))
  const runs = x.sched && !x.disabled ? scheduleModel.nextRuns(x.sched, now, 5) : x.next ? [x.next] : []
  const rows = [
    [ct('schedule'), x.kind === 'timer' ? x.schedule || '—' : x.schedule || ct('periodic', { dir: `/etc/cron.${x.period}` })],
    [ct('when'), x.desc],
    [ct('where'), x.where],
    ...(x.kind === 'timer' ? [[ct('state'), `${x.active} · ${x.enabled}${x.persistent ? ' · Persistent' : ''}`], [ct('last'), x.last ? `${relTime(x.last, now)} · ${x.failed ? ct('result_failed', { result: x.result }) : x.result ? ct('result_ok') : ''}` : ct('never')]] : []),
    [ct('next_runs'), x.disabled ? ct('disabled') : x.sched?.reboot ? ct('at_boot') : runs.length ? runs.map(r => `${wallDate(r)} (${relTime(r, now)})`).join('\n') : '—'],
  ]
  body.append(h('div', { className: 'kvtable' }, ...rows.map(([k, v]) => h('div', { className: 'kvrow' }, h('span', { className: 'k', textContent: k }), h('span', { className: 'v sched-v', textContent: v })))))
  const btn = (key, fn, { danger = false, disabled = false } = {}) => h('button', { className: 'chip' + (danger ? ' danger' : ''), textContent: ct(key), disabled, onclick: fn })
  const running = S.run?.id === x.id && S.run.running
  const buttons = [btn(running ? 'running' : 'run', () => runSchedule(tab, x), { disabled: running })]
  if (x.editable) buttons.push(btn('edit', () => editSchedule(tab, x)), btn(x.disabled ? 'enable' : 'disable', () => editCrontab(tab, x, { type: 'toggle' })), btn('delete', () => deleteSchedule(tab, x), { danger: true }))
  if (x.kind === 'timer') buttons.push(btn(x.enabled === 'enabled' ? 'disable' : 'enable', () => timerAction(tab, x, x.enabled === 'enabled' ? 'disable' : 'enable')))
  const logUnit = x.kind === 'timer' ? x.unit : S.snap.cronService
  if (logUnit) buttons.push(btn('logs', () => scheduleLogs(tab, logUnit)))
  if (x.command) buttons.push(btn('copy', () => navigator.clipboard.writeText(x.command).then(() => toast(ct('copied')))))
  body.append(h('div', { className: 'chips' }, ...buttons))
  if (!x.editable && x.kind === 'cron') body.append(h('p', { className: 'dim small', textContent: ct('readonly') }))
  if (S.run?.id === x.id && !S.run.running) {
    body.append(h('small', { className: S.run.code === 0 ? 'dim' : 'lv-warn', textContent: S.run.error || ct('exit', { code: S.run.code }) }),
      h('pre', { className: 'proc-diagnosis sched-output', textContent: S.run.out?.trim() || ct('no_output') }))
  }
  if (S.lv) { body.append(S.lv.el); S.lv.render() }
}

function scheduleMenu(tab, x, e) {
  menu(e.clientX, e.clientY, [
    { label: ct('details'), icon: 'info', fn: () => selectSchedule(tab, x) },
    { label: ct('run'), icon: 'play', fn: () => runSchedule(tab, x) },
    ...(x.editable ? [{ label: ct('edit'), icon: 'pencil', fn: () => editSchedule(tab, x) }, { label: ct(x.disabled ? 'enable' : 'disable'), icon: x.disabled ? 'play' : 'pause', fn: () => editCrontab(tab, x, { type: 'toggle' }) }] : []),
    ...(x.command ? [{ label: ct('copy'), icon: 'copy', fn: () => navigator.clipboard.writeText(x.command) }] : []),
    ...(x.editable ? ['-', { label: ct('delete'), icon: 'trash', danger: true, fn: () => deleteSchedule(tab, x) }] : []),
  ])
}

async function runSchedule(tab, x) {
  const S = tab.schedules
  if (!confirm(ct('run_confirm', { name: x.title }))) return
  S.selected = x.id; S.editing = null
  if (x.kind === 'timer') return timerAction(tab, x, 'start')
  S.run = { id: x.id, running: true }
  fillSchedules(tab); paintScheduleDetail(tab)
  try { Object.assign(S.run, await api.invoke('sched:run', tab.connId, { id: x.id, source: x.source, raw: x.raw })) }
  catch (e) { S.run.error = errText(e); S.run.code = -1 }
  S.run.running = false
  if (S.run.id === x.id) toast(S.run.code === 0 ? ct('done', { name: x.title }) : S.run.error || ct('exit', { code: S.run.code }), S.run.code !== 0)
  paintScheduleDetail(tab)
}

async function timerAction(tab, x, action) {
  const S = tab.schedules
  try {
    await api.invoke('sched:timer', tab.connId, action === 'start' ? x.unit : x.name, action)
    toast(ct('ok_' + action, { unit: action === 'start' ? x.unit : x.name }))
    if (action === 'start') scheduleLogs(tab, x.unit)
  } catch (e) { toast(errText(e), true) }
  await schedulePoll(tab)
  if (S.selected === x.id) paintScheduleDetail(tab)
}

function scheduleLogs(tab, unit) {
  const S = tab.schedules
  S.lv?.stop(); S.lv = createLogView(tab)
  paintScheduleDetail(tab)
  S.lv.start({ kind: 'journal', unit })
}

const crontabError = e => { const m = errText(e); return /crontab changed/.test(m) ? ct('changed') : m }
async function editCrontab(tab, x, op) {
  const S = tab.schedules
  try {
    await ensure(tab)
    await api.invoke('sched:edit', tab.connId, { ...op, line: x?.line, raw: x?.raw })
    toast(ct('saved'))
    await schedulePoll(tab)
    return true
  } catch (e) { toast(crontabError(e), true); await schedulePoll(tab); return false }
}
async function deleteSchedule(tab, x) {
  if (!confirm(ct('delete_confirm', { name: x.title }))) return
  if (await editCrontab(tab, x, { type: 'delete' })) { tab.schedules.selected = null; paintScheduleDetail(tab) }
}

// ---------- editor (inline, with a live preview of the schedule) ----------
const SCHED_PRESETS = [['every_5', '*/5 * * * *'], ['hourly', '0 * * * *'], ['daily', '0 3 * * *'], ['weekdays', '0 9 * * 1-5'], ['weekly', '0 9 * * 1'], ['monthly', '0 4 1 * *'], ['reboot', '@reboot']]
function editSchedule(tab, x) {
  const S = tab.schedules
  if (!S.snap) return
  if (!S.snap.cron.available) return toast(ct('no_crontab'), true)
  S.lv?.stop(); S.lv = null; S.run = null
  S.editing = { entry: x, name: x?.name || '', schedule: x?.schedule || '0 3 * * *', command: x?.command || '' }
  S.selected = x?.id || null
  fillSchedules(tab); paintScheduleEditor(tab)
}
function paintScheduleEditor(tab) {
  const S = tab.schedules, E = S.editing, body = S.ui?.detail
  if (!body || tab.panel !== 'schedules') return
  const name = h('input', { value: E.name, placeholder: ct('name_ph'), oninput: () => { E.name = name.value } })
  const expr = h('input', { className: 'mono', value: E.schedule, spellcheck: false, placeholder: '*/15 * * * *', oninput: () => { E.schedule = expr.value; preview() } })
  const command = h('textarea', { className: 'mono', rows: 3, spellcheck: false, value: E.command, placeholder: '/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1', oninput: () => { E.command = command.value } })
  const out = h('div', { className: 'sched-preview', role: 'status' })
  const save = h('button', { className: 'primary', type: 'submit', textContent: t('btn.save') })
  const preview = () => {
    out.replaceChildren()
    try {
      const s = scheduleModel.parseSchedule(E.schedule), now = serverWall(S)
      out.classList.remove('err')
      out.append(h('b', { textContent: scheduleModel.describe(s, t, lang) }),
        ...scheduleModel.nextRuns(s, now, 3).map(r => h('small', { className: 'dim', textContent: `${wallDate(r)} · ${relTime(r, now)}` })))
      save.disabled = false
    } catch (e) {
      out.classList.add('err')
      out.append(h('span', { textContent: e instanceof scheduleModel.CronError && E.schedule.trim() ? ct('invalid_field', { n: e.field + 1, value: e.value }) : ct('invalid') }))
      save.disabled = true
    }
  }
  const presets = SCHED_PRESETS.map(([k, v]) => h('button', { type: 'button', className: 'chip', textContent: ct('p.' + k), onclick: () => { expr.value = E.schedule = v; preview(); expr.focus() } }))
  const cancel = () => { S.editing = null; fillSchedules(tab); paintScheduleDetail(tab) }
  const form = h('form', { className: 'sched-form', onkeydown: e => { if (e.key === 'Escape') cancel() }, onsubmit: async e => {
    e.preventDefault()
    if (!E.command.trim()) return toast(ct('command_required'), true)
    if (S.saving) return
    S.saving = true; save.disabled = true
    const entry = { name: E.name, schedule: E.schedule.trim(), command: E.command.trim() }
    const ok = await editCrontab(tab, E.entry, E.entry ? { type: 'update', entry } : { type: 'add', entry })
    S.saving = false; save.disabled = false
    if (!ok) return
    S.editing = null
    const fresh = S.snap && scheduleItems(S).filter(x => x.source === 'user' && x.command === entry.command && x.schedule === entry.schedule).pop()
    S.selected = fresh?.id || null
    fillSchedules(tab); paintScheduleDetail(tab)
  } },
    h('div', { className: 'proc-detail-head' }, h('b', { textContent: ct(E.entry ? 'edit_title' : 'new') }), h('button', { type: 'button', className: 'ib', innerHTML: icon('x'), title: t('btn.cancel'), onclick: cancel })),
    h('label', {}, ct('name'), name),
    h('label', {}, ct('schedule'), expr),
    h('div', { className: 'chips' }, ...presets),
    out,
    h('label', {}, ct('command'), command),
    h('small', { className: 'dim', textContent: ct('command_help') }),
    h('div', { className: 'btns' }, h('button', { type: 'button', textContent: t('btn.cancel'), onclick: cancel }), save))
  body.replaceChildren(form)
  preview()
  ;(E.entry ? expr : name).focus()
}
