// Right panel. Uses the application's existing controls, menus, SSH and log views.
const newProcesses = () => ({ snapshot: null, history: new Map(), query: '', mode: 'name', filter: 'all', sort: 'interesting', expanded: new Set(), selected: null, details: null, detailError: null, request: 0, busy: false, signaling: false, error: null, ui: null, lv: null, explain: false })
const pt = (key, vars) => t('proc.' + key, vars)

async function processPoll(tab) {
  const P = tab.processes
  if (P.busy) return
  P.busy = true
  try {
    await ensure(tab)
    const snapshot = await api.invoke('process:list', tab.connId)
    // A server reboot invalidates every baseline, including a reused PID/start pair.
    if (P.snapshot && snapshot.uptime < P.snapshot.uptime) { P.history.clear(); P.selected = null; P.details = null; P.request++; P.lv?.stop(); P.lv = null }
    P.snapshot = processModel.observe(snapshot, P.snapshot, P.history)
    P.error = null
  } catch (e) { P.error = errText(e) }
  finally { P.busy = false }
  if (tab.panel === 'processes') { fillProcesses(tab); paintProcessDetail(tab) }
}
function leaveProcesses(tab) { tab.processes.lv?.stop(); tab.processes.lv = null; tab.processes.request++ }

function renderProcesses(tab) {
  const P = tab.processes
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => processPoll(tab)))
  const input = h('input', { className: 's-filter', placeholder: pt('search'), value: P.query, oninput: () => { P.query = input.value; fillProcesses(tab) } })
  const select = (keys, value, change) => {
    const el = h('select', { className: 'lsel', onchange: () => change(el.value) }, ...keys.map(k => h('option', { value: k, textContent: pt(k) })))
    el.value = value
    return el
  }
  const mode = select(['name', 'tree', 'user', 'service', 'container', 'individual'], P.mode, v => { P.mode = v; fillProcesses(tab) })
  mode.setAttribute('aria-label', pt('group'))
  const sort = select(['interesting', 'cpu', 'memory'], P.sort, v => { P.sort = v; fillProcesses(tab) })
  sort.setAttribute('aria-label', pt('sort'))
  const chips = ['all', 'alerts', 'cpu', 'memory', 'zombies'].map(k => h('button', { className: 'chip' + (P.filter === k ? ' on' : ''), textContent: pt(k), onclick: () => { P.filter = k; chips.forEach((c, i) => c.classList.toggle('on', ['all', 'alerts', 'cpu', 'memory', 'zombies'][i] === k)); fillProcesses(tab) } }))
  P.ui = { summary: h('div', { className: 'tiles proc-summary' }), status: h('div', { className: 'dim proc-note', role: 'status' }), list: h('div', { className: 'proc-list' }), detail: h('div', { className: 'proc-detail' }) }
  tab.rpanelBody.append(P.ui.summary, h('div', { className: 'svc-tools' }, input, h('div', { className: 'proc-controls' }, mode, sort), h('div', { className: 'chips' }, ...chips)), P.ui.status, P.ui.list, P.ui.detail)
  fillProcesses(tab)
  paintProcessDetail(tab)
  if (P.selected && !P.details && !P.detailError) {
    const selected = P.snapshot?.list.find(p => processModel.identity(p) === P.selected)
    if (selected) selectProcess(tab, selected)
  }
}
const processAlert = a => pt(a.key, { ...a, size: a.size == null ? '' : sizeOf(a.size) })
const processRank = (a, b) => b.alerts.length - a.alerts.length || (b.cpu || 0) - (a.cpu || 0) || b.rss - a.rss

function fillProcesses(tab) {
  const P = tab.processes, ui = P.ui, s = P.snapshot
  if (!ui || tab.panel !== 'processes') return
  ui.status.textContent = P.error || (s ? pt('observing') : t('dash.checking'))
  ui.status.classList.toggle('err', !!P.error)
  ui.summary.replaceChildren(...(s ? [[pt('cpu'), s.cpu == null ? '—' : `${s.cpu.toFixed(1)}%`], [pt('memory'), `${sizeOf(s.memUsed)} / ${sizeOf(s.memTotal)}`], [pt('count'), String(s.list.length)]].map(([label, value]) => h('div', { className: 'tile-s' }, h('small', { textContent: label }), h('b', { textContent: value }))) : []))
  ui.list.replaceChildren()
  if (!s) return
  const q = P.query.toLowerCase()
  const matches = p => (!q || [p.name, p.pid, p.user, p.command, p.service, p.container].join(' ').toLowerCase().includes(q)) && (P.filter === 'all' || P.filter === 'alerts' && p.alerts.length || P.filter === 'cpu' && p.cpu >= 20 || P.filter === 'memory' && p.rss >= 256 * 1024 * 1024 || P.filter === 'zombies' && p.state.startsWith('Z'))
  const compare = P.sort === 'cpu' ? (a, b) => (b.cpu || 0) - (a.cpu || 0) : P.sort === 'memory' ? (a, b) => b.rss - a.rss : processRank
  const row = p => {
    const selected = P.selected === processModel.identity(p)
    const el = h('div', { className: 'proc-row' + (selected ? ' selected' : ''), oncontextmenu: e => { e.preventDefault(); processMenu(tab, p, e) } },
      h('button', { className: 'proc-main', onclick: () => selectProcess(tab, p), title: p.command },
        h('b', { textContent: p.name }), h('small', { className: 'dim', textContent: `PID ${p.pid} · ${p.user} · ${p.state}` }),
        ...p.alerts.map(a => h('small', { className: 'lv-warn', textContent: processAlert(a) }))),
      h('span', { className: 'proc-metrics', textContent: `${p.cpu == null ? '—' : p.cpu.toFixed(1) + '%'}\n${sizeOf(p.rss)}` }),
      h('button', { className: 'ib danger', innerHTML: icon('stop'), title: pt('term'), disabled: P.signaling || p.pid <= 1, onclick: () => signalProcess(tab, p, 'TERM') }))
    return el
  }
  if (P.mode === 'individual') {
    ui.list.append(...s.list.filter(matches).sort(compare).map(row))
  } else {
    // Group the full snapshot before filtering, preserving parent ancestry during search.
    let groups = processModel.group(s.list, P.mode).map(g => {
      const list = g.list.filter(matches)
      return { name: g.name, list, cpu: list.reduce((n, p) => n + (p.cpu || 0), 0), rss: list.reduce((n, p) => n + p.rss, 0), alerts: list.reduce((n, p) => n + p.alerts.length, 0) }
    }).filter(g => g.list.length)
    groups.sort((a, b) => P.sort === 'cpu' ? b.cpu - a.cpu : P.sort === 'memory' ? b.rss - a.rss : b.alerts - a.alerts || b.cpu - a.cpu || b.rss - a.rss)
    for (const g of groups) {
      const key = P.mode + ':' + g.name, open = P.expanded.has(key) || !!q
      const group = h('details', { className: 'proc-group', open, ontoggle: () => { if (group.open) P.expanded.add(key); else P.expanded.delete(key) } },
        h('summary', {}, h('b', { textContent: g.name }), h('span', { className: 'dim', textContent: `${g.list.length} · ${g.list.some(p => p.cpu != null) ? g.cpu.toFixed(1) + '%' : '—'} · ${sizeOf(g.rss)}` }), g.alerts ? h('span', { className: 'mchip lv-warn', textContent: `⚠ ${g.alerts}` }) : ''))
      // Create children lazily; large servers keep collapsed groups inexpensive.
      let filled = false
      const fill = () => { if (group.open && !filled) { group.append(...g.list.sort(compare).map(row)); filled = true } }
      group.addEventListener('toggle', fill)
      fill()
      ui.list.append(group)
    }
  }
  if (!ui.list.childElementCount) ui.list.append(h('div', { className: 'msg small', textContent: pt('none') }))
}

async function selectProcess(tab, p) {
  const P = tab.processes, request = ++P.request
  P.lv?.stop(); P.lv = null
  Object.assign(P, { selected: processModel.identity(p), details: null, detailError: null, explain: false })
  fillProcesses(tab); paintProcessDetail(tab)
  try {
    await ensure(tab)
    const raw = await api.invoke('process:details', tab.connId, { pid: p.pid, start: p.start })
    if (request !== P.request) return
    const section = key => raw.split('@@' + key + '\n')[1]?.split(/@@[A-Z]+\n/)[0]?.trim() || ''
    P.details = { cwd: section('CWD'), command: section('COMMAND'), ports: section('PORTS'), cgroup: section('CGROUP'), restarts: section('RESTARTS') }
  } catch (e) { if (request === P.request) P.detailError = errText(e) }
  if (request === P.request) paintProcessDetail(tab)
}

function processDiagnosis(p, d) {
  const n = p.name.toLowerCase()
  const role = /nginx|apache|httpd|caddy/.test(n) ? 'web' : /postgres|mysql|mariadb|redis|mongo/.test(n) ? 'database' : /node|java|python|ruby|php|gunicorn|uvicorn/.test(n) ? 'runtime' : /sshd/.test(n) ? 'ssh' : /systemd|init/.test(n) ? 'system' : 'unknown'
  return [pt('role.' + role), pt('resources', { cpu: p.cpu == null ? '—' : p.cpu.toFixed(1) + '%', memory: sizeOf(p.rss), age: fmtUptime(p.age) }), ...p.alerts.map(processAlert), ...(Number(d?.restarts) >= 3 ? [pt('restarts', { n: d.restarts })] : []), pt('checks'), ...(p.state.startsWith('Z') ? [pt('zombieHelp')] : []), ...(role === 'ssh' || role === 'system' ? [pt('critical')] : [])].join('\n\n')
}
function processGraph(history, key, title) {
  const data = history.map(x => x[key]).filter(x => x != null)
  const max = Math.max(0, ...data), scale = Math.max(1, max), min = Math.min(...data)
  const points = data.map((v, i) => `${i / Math.max(1, data.length - 1) * 240},${42 - v / scale * 38}`).join(' ')
  return h('div', { className: 'proc-chart' }, h('small', { className: 'dim', textContent: title }),
    h('div', { innerHTML: `<svg viewBox="0 0 240 48" role="img" aria-label="${key === 'cpu' ? 'CPU' : 'RAM'}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/></svg>` }),
    h('small', { className: 'dim', textContent: data.length ? key === 'cpu' ? `${min.toFixed(1)}–${max.toFixed(1)}%` : `${sizeOf(min)}–${sizeOf(max)}` : '—' }))
}
function paintProcessDetail(tab) {
  const P = tab.processes
  if (tab.panel !== 'processes' || !P.ui) return
  const body = P.ui.detail
  body.replaceChildren()
  if (!P.selected) return
  const p = P.snapshot?.list.find(p => processModel.identity(p) === P.selected)
  if (!p) { P.lv?.stop(); P.lv = null; return body.append(h('div', { className: 'msg small', textContent: pt('exited') })) }
  const d = P.details, btn = (key, fn, danger = false) => h('button', { className: 'chip' + (danger ? ' danger' : ''), textContent: pt(key), disabled: danger && (P.signaling || p.pid <= 1), onclick: fn })
  body.append(h('div', { className: 'proc-detail-head' }, h('b', { textContent: `${p.name} · PID ${p.pid}` }), h('button', { className: 'ib', innerHTML: icon('x'), title: t('panel.close'), onclick: () => { P.request++; P.selected = null; P.lv?.stop(); P.lv = null; fillProcesses(tab); paintProcessDetail(tab) } })),
    h('pre', { className: 'proc-command', textContent: d?.command || p.command }),
    h('div', { className: 'proc-charts' }, processGraph(P.history.get(P.selected) || [], 'cpu', pt('cpu')), processGraph(P.history.get(P.selected) || [], 'rss', pt('memory'))),
    h('small', { className: 'dim', textContent: pt('history') }))
  if (P.detailError) body.append(h('p', { className: 'err', textContent: P.detailError }))
  else if (!d) body.append(h('p', { className: 'dim', textContent: t('dash.checking') }))
  if (d) body.append(h('div', { className: 'kvtable' }, ...[['PID / PPID', `${p.pid} / ${p.ppid}`], [pt('user'), p.user], [pt('folder'), d.cwd || pt('restricted')], [pt('service'), p.service || '—'], [pt('container'), p.container || '—'], [pt('ports'), d.ports || pt('restricted')], [pt('restartCount'), d.restarts || '—']].map(([k, v]) => h('div', { className: 'kvrow' }, h('span', { className: 'k', textContent: k }), h('span', { className: 'v', textContent: v })))))
  body.append(h('div', { className: 'chips' }, btn('understand', () => { P.explain = !P.explain; paintProcessDetail(tab) }), btn('folder', () => processFolder(tab, p)), btn('logs', () => processLogs(tab, p)), btn('ssh', () => { if (!tab.term) openTerminal(tab) }), btn('term', () => signalProcess(tab, p, 'TERM'), true), btn('kill', () => signalProcess(tab, p, 'KILL'), true)))
  if (P.explain) body.append(h('pre', { className: 'proc-diagnosis', textContent: processDiagnosis(p, d) }))
  if (P.lv) { body.append(P.lv.el); P.lv.render() }
}
async function signalProcess(tab, p, signal) {
  const P = tab.processes
  if (P.signaling || !confirm(pt('confirm', { name: p.name, pid: p.pid, signal: 'SIG' + signal }))) return
  P.signaling = true
  fillProcesses(tab)
  paintProcessDetail(tab)
  try {
    await ensure(tab)
    await api.invoke('process:signal', tab.connId, { pid: p.pid, start: p.start }, signal)
    toast(pt('sent', { signal: 'SIG' + signal, pid: p.pid }))
  } catch (e) { toast(errText(e), true) }
  finally { P.signaling = false }
  await processPoll(tab)
}
async function processFolder(tab, p) {
  if (tab.processes.selected !== processModel.identity(p) || !tab.processes.details) await selectProcess(tab, p)
  if (tab.panel !== 'processes' || tab.processes.selected !== processModel.identity(p)) return
  const cwd = tab.processes.details?.cwd
  if (cwd?.startsWith('/')) load(tab.active, cwd)
  else toast(pt('restricted'), true)
}
async function processLogs(tab, p) {
  if (tab.processes.selected !== processModel.identity(p)) await selectProcess(tab, p)
  if (tab.panel !== 'processes' || tab.processes.selected !== processModel.identity(p)) return
  const P = tab.processes
  P.lv?.stop(); P.lv = createLogView(tab)
  paintProcessDetail(tab)
  P.lv.start({ kind: 'journal', ...(p.service ? { unit: p.service } : { pid: p.pid }) })
}
function processMenu(tab, p, e) {
  menu(e.clientX, e.clientY, [
    { label: pt('details'), icon: 'info', fn: () => selectProcess(tab, p) },
    { label: pt('copyPid'), icon: 'copy', fn: () => navigator.clipboard.writeText(String(p.pid)) },
    { label: pt('copyCommand'), icon: 'copy', fn: () => navigator.clipboard.writeText(p.command) },
    { label: pt('folder'), icon: 'folder', fn: () => processFolder(tab, p) },
    { label: pt('logs'), icon: 'scroll', fn: () => processLogs(tab, p) },
    { label: pt('ports'), icon: 'globe', fn: () => selectProcess(tab, p) },
    { label: pt('ssh'), icon: 'terminal', fn: () => { if (!tab.term) openTerminal(tab) } }, '-',
    { label: pt('term'), icon: 'stop', danger: true, fn: () => signalProcess(tab, p, 'TERM') },
    { label: pt('kill'), icon: 'trash', danger: true, fn: () => signalProcess(tab, p, 'KILL') },
  ])
}
