// Kubernetes tab of the Docker panel: the server's kubectl (kubectl, k3s or microk8s) over SSH. Contexts and
// namespaces, pods / workloads / services / ingresses / nodes / events, live logs, shell, describe / YAML, restart
// and scale. Model: kube.js; reuses h, t, icon, toast, ensure, createLogView, openTerminal, modal, fmtUptime, sizeOf.
const newKube = () => ({ info: null, context: '', namespace: '', namespaces: [], kind: 'pods', items: [], metrics: false, query: '', error: null, loaded: false, at: 0, busy: new Set(), view: null, polling: false })
const kt = (key, vars) => t('kube.' + key, vars)
const KUBE_KINDS = [['pods', 'box'], ['workloads', 'grid'], ['services', 'link'], ['ingresses', 'globe'], ['nodes', 'server'], ['events', 'alert']]
const kubeAge = ms => (ms ? fmtUptime(Math.max(0, (Date.now() - ms) / 1000)) : '—')
const kubeCpu = m => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)} CPU` : `${Math.round(m)}m`)
const kubeScope = K => ({ context: K.context || undefined, namespace: K.namespace || undefined })

async function kubeLoadInfo(tab) {
  const K = tab.kube
  K.info = await api.invoke('kube:info', tab.connId)
  if (!K.context || !K.info.contexts.includes(K.context)) K.context = K.info.current || K.info.contexts[0] || ''
  try { K.namespaces = await api.invoke('kube:namespaces', tab.connId, kubeScope(K)) } catch { K.namespaces = [] }
}
async function kubePoll(tab, force = false) {
  const K = tab.kube
  if (K.view || K.polling || (!force && K.loaded && Date.now() - K.at < 9000)) return
  K.polling = true
  let kind = K.kind, context, namespace, first = !K.info
  try {
    await ensure(tab)
    if (first) await kubeLoadInfo(tab)
    context = K.context; namespace = K.namespace
    const r = await api.invoke('kube:list', tab.connId, { kind, ...kubeScope(K) })
    if (kind === K.kind && context === K.context && namespace === K.namespace) Object.assign(K, { items: r.items, metrics: r.metrics, error: null })
    K.info.sudo = r.sudo
  } catch (e) { K.error = errText(e); K.items = [] }
  Object.assign(K, { loaded: true, polling: false, at: Date.now() })
  if (tab.panel !== 'docker' || tab.docker.engine !== 'kube' || K.view) return
  // the list alone is repainted, so that the search box keeps its focus
  if (K.ui?.list.isConnected && kind === K.kind && !first) fillKube(tab)
  else paintDocker(tab)
}
function leaveKube(tab) { tab.kube.view?.lv?.stop(); tab.kube.view = null }
const kubeRefresh = tab => { const K = tab.kube; K.polling = false; K.loaded = false; paintDocker(tab); kubePoll(tab, true) }

// ---------- actions ----------
const kubeTarget = (K, x) => ({ ...kubeScope(K), namespace: x.namespace || undefined, type: x.type, name: x.name })
async function kubeAction(tab, x, action, extra = {}) {
  const K = tab.kube, key = `${x.type}/${x.namespace}/${x.name}`
  const confirmKey = action === 'delete' ? 'confirm_delete' : action === 'restart' ? 'confirm_restart' : null
  if (confirmKey && !confirm(kt(confirmKey, { name: x.name }))) return
  K.busy.add(key)
  paintDocker(tab)
  try {
    await api.invoke('kube:action', tab.connId, { ...kubeTarget(K, x), action, ...extra })
    toast(kt('ok_' + action, { name: x.name, n: extra.replicas }))
  } catch (e) { toast(errText(e), true) }
  K.busy.delete(key)
  if (K.view) paintDocker(tab)
  else kubeRefresh(tab)
}
async function kubeScale(tab, x) {
  const v = await modal(kt('scale_title', { name: x.name }), [{ name: 'replicas', label: kt('replicas'), type: 'number', value: String(x.desired ?? 1) }], kt('scale'))
  if (!v) return
  const n = Number(v.replicas)
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000) return toast(kt('replicas_invalid'), true)
  kubeAction(tab, x, 'scale', { replicas: n })
}
async function kubeShell(tab, pod, container) {
  const K = tab.kube
  let cmd
  try { cmd = kubeModel.execCommand({ bin: K.info?.bin, sudo: K.info?.sudo, ...kubeScope(K), namespace: pod.namespace, pod: pod.name, container }) } catch (e) { return toast(errText(e), true) }
  if (!tab.term) { await openTerminal(tab); if (!tab.termId) return }
  api.send('term:write', tab.termId, cmd + '\r')
  tab.term.focus()
}

// ---------- views ----------
function kubeLogs(tab, x, container) {
  const K = tab.kube
  K.view?.lv?.stop()
  const lv = createLogView(tab)
  const c = x.type === 'pod' ? container ?? (x.containers.length > 1 ? x.containers[0] : undefined) : undefined
  K.view = { type: 'logs', x, container: c, lv, title: kt('logs_of', { name: x.name }) }
  paintDocker(tab)
  lv.start(x.type === 'pod' ? { kind: 'kube', ...kubeScope(K), namespace: x.namespace, pod: x.name, container: c } : { kind: 'kube', ...kubeTarget(K, x) })
}
async function kubeText(tab, x, format = 'describe') {
  const K = tab.kube
  K.view?.lv?.stop()
  const view = (K.view = { type: 'text', x, format, text: null, error: null, title: `${x.kind || x.type} · ${x.name}` })
  paintDocker(tab)
  try { view.text = await api.invoke('kube:text', tab.connId, { ...kubeTarget(K, x), format }) } catch (e) { view.error = errText(e) }
  if (K.view === view) paintDocker(tab)
}

function kubeActions(tab, x, { inView = false } = {}) {
  const K = tab.kube, busy = K.busy.has(`${x.type}/${x.namespace}/${x.name}`)
  const btn = (name, key, fn, extra = {}) => h('button', { className: 'ib', innerHTML: icon(name), title: kt(key), disabled: busy, onclick: e => { e.stopPropagation(); fn() }, ...extra })
  const out = []
  if (x.type === 'pod') {
    out.push(btn('terminal', 'shell', () => kubeShell(tab, x, K.view?.x === x ? K.view.container : undefined), { disabled: busy || x.status !== 'Running' }))
    if (!inView) out.push(btn('scroll', 'logs', () => kubeLogs(tab, x)))
    out.push(btn('info', 'describe', () => kubeText(tab, x)), btn('refresh', 'delete', () => kubeAction(tab, x, 'delete')))
  } else if (/^(deployment|statefulset|daemonset)$/.test(x.type)) {
    if (!inView) out.push(btn('scroll', 'logs', () => kubeLogs(tab, x)))
    if (x.scalable) out.push(btn('sliders', 'scale', () => kubeScale(tab, x)))
    out.push(btn('info', 'describe', () => kubeText(tab, x)), btn('refresh', 'restart', () => kubeAction(tab, x, 'restart')))
  } else if (x.type !== 'event') out.push(btn('info', 'describe', () => kubeText(tab, x)))
  return h('span', { className: 'svc-btns' }, ...out)
}

// ---------- painting (inside the Docker panel body) ----------
function paintKube(tab, body) {
  const K = tab.kube
  tab.rpanelBody.classList.toggle('flush', K.view?.type === 'logs')
  if (K.view) return paintKubeView(tab, body)
  const select = (value, options, change, label) => {
    const el = h('select', { className: 'lsel', ariaLabel: label, title: label, onchange: () => change(el.value) }, ...options.map(([v, text]) => h('option', { value: v, textContent: text })))
    el.value = value
    return el
  }
  const ctx = K.info?.contexts?.length ? select(K.context, K.info.contexts.map(c => [c, c]), v => { K.context = v; K.namespace = ''; K.info = { ...K.info, current: v }; K.namespaces = []; kubeLoadInfo(tab).catch(() => {}).finally(() => kubeRefresh(tab)) }, kt('context')) : null
  const ns = select(K.namespace, [['', kt('all_namespaces')], ...K.namespaces.map(n => [n, n])], v => { K.namespace = v; kubeRefresh(tab) }, kt('namespace'))
  ns.disabled = K.kind === 'nodes'
  const search = h('input', { className: 's-filter', spellcheck: false, placeholder: kt('search'), value: K.query, oninput: () => { K.query = search.value; fillKube(tab) } })
  const kinds = h('div', { className: 'chips kube-kinds' }, ...KUBE_KINDS.map(([k, ic]) => h('button', { className: 'chip' + (K.kind === k ? ' on' : ''), innerHTML: icon(ic) + `<span>${kt('kind.' + k)}</span>`, onclick: () => { if (K.kind !== k) { K.kind = k; K.items = []; kubeRefresh(tab) } } })))
  K.ui = { list: h('div', { className: 'kube-list' }), summary: h('div', { className: 'kube-summary' }) }
  body.append(h('div', { className: 'kube-tools' }, ...(ctx ? [ctx] : []), ns), search, kinds, K.ui.summary, K.ui.list)
  fillKube(tab)
}

function fillKube(tab) {
  const K = tab.kube, ui = K.ui
  if (!ui) return
  ui.list.replaceChildren(); ui.summary.replaceChildren()
  const msg = (text, cls = '') => ui.list.append(h('div', { className: 'msg small ' + cls, textContent: text }))
  if (K.error) return msg(K.error, 'err')
  if (!K.loaded) return msg(t('dash.checking'))
  const q = K.query.toLowerCase()
  const items = K.items.filter(x => !q || [x.name, x.namespace, x.status, x.reason, x.message, x.object, x.node, ...(x.images || []), ...(x.hosts || [])].join(' ').toLowerCase().includes(q))
  const count = lv => K.items.filter(x => x.level === lv).length
  if (K.items.length) ui.summary.append(...[['ok', 'ok'], ['warn', 'warn'], ['crit', 'crit']].filter(([lv]) => count(lv)).map(([lv, key]) => h('span', { className: 'mchip lv-' + lv, textContent: kt('count.' + key, { n: count(lv) }) })),
    ...(K.kind === 'pods' && !K.metrics ? [h('span', { className: 'dim', textContent: kt('no_metrics') })] : []))
  if (!items.length) return msg(kt(K.items.length ? 'no_match' : 'none'))
  const showNs = !K.namespace
  for (const x of items) ui.list.append(kubeRow(tab, x, showNs))
}

function kubeRow(tab, x, showNs) {
  const K = tab.kube, ns = showNs && x.namespace ? x.namespace + ' · ' : ''
  const chip = (text, lv = 'idle') => h('span', { className: 'mchip lv-' + lv, textContent: text })
  let sub, chips = [], open = () => kubeText(tab, x)
  if (x.type === 'pod') {
    sub = `${ns}${x.node ? x.node + ' · ' : ''}${kubeAge(x.created)}`
    chips = [chip(x.status, x.level), chip(x.ready, x.level === 'ok' ? 'ok' : 'idle'), ...(x.restarts ? [chip('↻ ' + x.restarts + (x.lastTerm ? ' · ' + x.lastTerm : ''), x.restarts >= 5 ? 'crit' : 'warn')] : []),
      ...(x.cpu != null ? [chip(kubeCpu(x.cpu)), chip(sizeOf(x.memory))] : [])]
    open = () => kubeLogs(tab, x)
  } else if (x.type === 'event') {
    return h('div', { className: 'dk click kube-event', title: x.message, onclick: () => x.objectType && kubeText(tab, { type: x.objectType, name: x.objectName, namespace: x.namespace, kind: x.object.split('/')[0] }) },
      h('span', { className: 'dot lv-' + x.level }),
      h('div', { className: 'svc-main' }, h('b', { textContent: `${x.reason} · ${x.object}` }), h('small', { className: 'kube-msg', textContent: x.message }), h('small', { className: 'dim', textContent: `${ns}${kt('ago', { time: kubeAge(x.last) })}${x.count > 1 ? ' · ×' + x.count : ''}` })))
  } else if (x.kind === 'Service') {
    sub = `${ns}${x.svcType} · ${x.clusterIP}${x.ports.length ? ' · ' + x.ports.join(', ') : ''}`
    chips = x.external.length ? [chip(x.external.join(', '), 'ok')] : x.svcType === 'LoadBalancer' ? [chip(kt('pending'), 'warn')] : []
  } else if (x.kind === 'Ingress') {
    sub = `${ns}${x.routes.join(' · ') || '—'}`
    chips = [...(x.className ? [chip(x.className)] : []), ...(x.tls ? [chip('TLS', 'ok')] : []), chip(x.address.join(', ') || kt('pending'), x.address.length ? 'ok' : 'warn')]
  } else if (x.kind === 'Node') {
    sub = `${x.roles.join(', ')} · ${x.version} · ${x.ip}${x.cpu ? ` · ${x.cpu} CPU` : ''}${x.memory ? ' · ' + sizeOf(kubeModel.bytes(x.memory) || 0) : ''}`
    chips = [chip(x.status, x.level), ...x.pressure.map(p => chip(p, 'warn'))]
  } else {
    sub = `${x.kind} · ${ns}${x.images.join(', ') || '—'} · ${kubeAge(x.created)}`
    chips = [chip(x.ready, x.level)]
  }
  return h('div', { className: 'dk click', onclick: open, title: x.type === 'pod' ? kt('logs') : kt('describe') },
    h('span', { className: 'dot lv-' + x.level, title: x.status || x.ready || '' }),
    h('div', { className: 'svc-main' }, h('b', { textContent: x.name }), h('small', { className: 'dim', textContent: sub }), h('span', { className: 'dk-res' }, ...chips)),
    kubeActions(tab, x))
}

function paintKubeView(tab, body) {
  const K = tab.kube, v = K.view, x = v.x
  const back = h('div', { className: 'dback' },
    h('button', { className: 'ib', innerHTML: icon('arrow-left'), title: t('docker.back'), onclick: () => { v.lv?.stop(); K.view = null; kubeRefresh(tab) } }),
    h('b', { textContent: v.title }), kubeActions(tab, x, { inView: true }))
  body.append(back)
  if (v.type === 'logs') {
    const extra = []
    if (x.type === 'pod' && x.containers.length > 1) {
      const sel = h('select', { className: 'lsel', ariaLabel: kt('container'), onchange: () => kubeLogs(tab, x, sel.value) }, ...x.containers.map(c => h('option', { value: c, textContent: c })))
      sel.value = v.container
      extra.push(sel)
    }
    body.append(h('div', { className: 'dk-state' }, h('span', { className: 'dot lv-' + x.level }), h('span', { className: 'dim', textContent: `${x.namespace} · ${x.status || x.kind} · ${x.ready}` }), ...extra), v.lv.el)
    return v.lv.render()
  }
  const seg = h('div', { className: 'seg' }, ...[['describe', 'info'], ['yaml', 'code']].map(([f, ic]) => h('button', { className: v.format === f ? 'on' : '', innerHTML: icon(ic) + `<span>${kt(f)}</span>`, onclick: () => v.format !== f && kubeText(tab, x, f) })))
  body.append(seg)
  if (v.error) return body.append(h('div', { className: 'msg small err', textContent: v.error }))
  if (v.text == null) return body.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
  body.append(h('pre', { className: 'kube-text', textContent: v.text }))
}
