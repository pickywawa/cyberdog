// Run: npx electron test/smoke/kube-ui.cjs — the Kubernetes panel in a real window, with kubectl
// replaced by a fake cluster in main. Docker | Kubernetes switch, contexts and namespaces, pods with status and metrics,
// search, logs per container, describe / YAML, shell in the terminal, delete, workloads restart and scale, nodes, events.
const { app, ipcMain } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-kube-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json')
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
const k = require(path.join(root, 'src/kube'))

// ---------- fake cluster ----------
const now = Date.now(), iso = h => new Date(now - h * 3600e3).toISOString()
const meta = (name, namespace, hours = 30) => ({ name, namespace, creationTimestamp: iso(hours) })
const cs = (name, ready, state, restartCount = 0) => ({ name, ready, state, restartCount, lastState: restartCount ? { terminated: { reason: 'OOMKilled' } } : {} })
const cluster = {
  pods: [
    { kind: 'Pod', metadata: meta('api-7d9f-x2', 'web'), spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'api:1.4' }, { name: 'envoy', image: 'envoy:1.30' }] }, status: { phase: 'Running', containerStatuses: [cs('app', true, { running: {} }), cs('envoy', true, { running: {} })] } },
    { kind: 'Pod', metadata: meta('worker-5c-k8', 'web', 2), spec: { nodeName: 'node-2', containers: [{ name: 'worker', image: 'worker:2' }] }, status: { phase: 'Running', containerStatuses: [cs('worker', false, { waiting: { reason: 'CrashLoopBackOff' } }, 9)] } },
    { kind: 'Pod', metadata: meta('coredns-1', 'kube-system', 300), spec: { nodeName: 'node-1', containers: [{ name: 'coredns', image: 'coredns:1.11' }] }, status: { phase: 'Running', containerStatuses: [cs('coredns', true, { running: {} })] } },
  ],
  workloads: [
    { kind: 'Deployment', metadata: meta('api', 'web'), spec: { replicas: 2, template: { spec: { containers: [{ image: 'api:1.4' }] } } }, status: { readyReplicas: 2 } },
    { kind: 'Deployment', metadata: meta('worker', 'web'), spec: { replicas: 1, template: { spec: { containers: [{ image: 'worker:2' }] } } }, status: {} },
    { kind: 'DaemonSet', metadata: meta('node-exporter', 'monitoring'), spec: { template: { spec: { containers: [{ image: 'node-exporter' }] } } }, status: { desiredNumberScheduled: 2, numberReady: 2 } },
  ],
  nodes: [{ kind: 'Node', metadata: { name: 'node-1', labels: { 'node-role.kubernetes.io/control-plane': '' }, creationTimestamp: iso(900) }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.31.2+k3s1' }, capacity: { cpu: '4', memory: '8000000Ki' }, addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] } }],
  events: [{ kind: 'Event', metadata: meta('e1', 'web'), type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container worker', involvedObject: { kind: 'Pod', name: 'worker-5c-k8' }, lastTimestamp: iso(0.1), count: 14 }],
  services: [], ingresses: [],
}
const calls = []
const mock = () => {
  for (const ch of ['kube:info', 'kube:namespaces', 'kube:list', 'kube:text', 'kube:action', 'docker:list', 'log:start', 'log:stop']) ipcMain.removeHandler(ch)
  ipcMain.handle('docker:list', () => [])
  ipcMain.handle('kube:info', () => ({ bin: 'k3s kubectl', sudo: true, contexts: ['default', 'staging'], current: 'default' }))
  ipcMain.handle('kube:namespaces', () => ['kube-system', 'monitoring', 'web'])
  ipcMain.handle('kube:list', (_, id, q) => {
    calls.push(['list', q.kind, q.namespace || '*', q.context])
    k.listArgs(q) // the same validation as main
    const items = k.summarize({ items: (cluster[q.kind] || []).filter(x => !q.namespace || !x.metadata.namespace || x.metadata.namespace === q.namespace) })
    if (q.kind === 'pods') for (const p of items) Object.assign(p, { cpu: 120, memory: 96 * 1024 ** 2 })
    return { items, metrics: true, sudo: true, bin: 'k3s kubectl' }
  })
  ipcMain.handle('kube:text', (_, id, q) => { calls.push(['text', q.type, q.name, q.format]); return q.format === 'yaml' ? `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${q.name}\n` : `Name:         ${q.name}\nNamespace:    ${q.namespace}\nStatus:       Running\n` })
  ipcMain.handle('kube:action', (_, id, q) => { calls.push(['action', q.action, q.type, q.name, q.replicas]); k.actionArgs(q); return '' })
  ipcMain.handle('log:start', (_, id, spec) => { calls.push(['logs', spec.kind, spec.pod || spec.name, spec.container || '']); k.logArgs(spec); return 'log-' + calls.length })
  ipcMain.handle('log:stop', () => {})
  ipcMain.on('term:write', (_, id, text) => calls.push(['term', text]))
}

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    win.webContents.on('console-message', (...a) => { const m = a[0]?.message ?? a[2]; if ((a[0]?.level ?? a[1]) === 'error' || a[1] >= 3) console.error('renderer:', m) })
    const js = code => win.webContents.executeJavaScript(code).catch(e => { console.error('step failed:', code.slice(0, 120)); throw e }), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const until = async (test, label) => { for (let i = 0; i < 100; i++) { if (test()) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `kube-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof paintKube === 'function'`, 'app ready')
    win.setSize(1400, 900)
    await js(`window.ensure = async tab => { const T = tab.root || tab; if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.confirm = () => true
      window.__t = { tab: () => tabs.find(t => t.id === activeId), body: () => __t.tab().kubeBody || __t.tab().dockerBody, text: () => __t.body().innerText,
        rows: () => [...__t.body().querySelectorAll('.kube-list .dk')].map(r => r.querySelector('b').textContent),
        row: name => [...__t.body().querySelectorAll('.kube-list .dk')].find(r => r.querySelector('b').textContent === name),
        btn: (name, title) => [...__t.row(name).querySelectorAll('.svc-btns .ib')].find(b => b.title === title),
        seg: label => [...__t.body().querySelectorAll('.seg button')].find(b => b.textContent === label),
        chip: label => [...__t.body().querySelectorAll('.kube-kinds .chip')].find(b => b.textContent === label) }; true`)
    await js(`void openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(os.homedir())} })`)
    await wait(`!!__t.tab()?.connId`, 'tab open')
    // Docker and Kubernetes are two panels of their own, one button each in the bar (Kubernetes right below Docker)
    const barKeys = await js(`barFor({ type: 'ssh' }).map(([k]) => k)`)
    assert.equal(barKeys.indexOf('kube'), barKeys.indexOf('docker') + 1, 'Kubernetes below Docker')
    await js(`setPanel(__t.tab(), 'docker')`)
    assert.equal(await js(`__t.tab().rpanelTitle.textContent`), 'Docker')
    assert.equal(await js(`!!__t.seg('Kubernetes')`), false, 'no engine switch in the Docker panel')

    // Kubernetes: contexts, namespaces, pods (failing first), metrics, summary
    await js(`setPanel(__t.tab(), 'kube')`)
    assert.equal(await js(`__t.tab().rpanelTitle.textContent`), 'Kubernetes')
    await wait(`__t.rows().length === 3`, 'pods')
    assert.deepEqual(await js(`__t.rows()`), ['worker-5c-k8', 'coredns-1', 'api-7d9f-x2'])
    assert.deepEqual(await js(`[...__t.body().querySelectorAll('.kube-tools select')].map(s => [...s.options].map(o => o.value))`), [['default', 'staging'], ['', 'kube-system', 'monitoring', 'web']])
    const text = await js(`__t.text()`)
    for (const s of ['CrashLoopBackOff', '↻ 9 · OOMKilled', '2/2', '120m', '96.0 MB', '2 OK', '1 en échec', 'kube-system · node-1']) assert.ok(text.includes(s), s)
    await shot('pods')

    // search keeps its focus across a refresh
    await js(`(() => { const s = __t.body().querySelector('.s-filter'); s.focus(); s.value = 'api'; s.dispatchEvent(new Event('input')) })()`)
    assert.deepEqual(await js(`__t.rows()`), ['api-7d9f-x2'])
    await js(`kubePoll(__t.tab(), true)`)
    await until(() => calls.filter(c => c[0] === 'list').length >= 2, 'poll')
    await pause(200)
    assert.equal(await js(`document.activeElement === __t.body().querySelector('.s-filter')`), true, 'focus kept')
    await js(`(() => { const s = __t.body().querySelector('.s-filter'); s.value = ''; s.dispatchEvent(new Event('input')) })()`)

    // namespace
    await js(`(() => { const s = __t.body().querySelectorAll('.kube-tools select')[1]; s.value = 'web'; s.dispatchEvent(new Event('change')) })()`)
    await wait(`__t.rows().length === 2`, 'web namespace')
    assert.deepEqual(calls.filter(c => c[0] === 'list').pop(), ['list', 'pods', 'web', 'default'])
    assert.equal(await js(`__t.text().includes('web · node-1')`), false, 'no namespace shown inside one namespace')

    // pod logs, per container; shell; describe / YAML; delete
    await js(`__t.row('api-7d9f-x2').click()`)
    await wait(`!!__t.body().querySelector('.logview')`, 'logs')
    assert.deepEqual(calls.filter(c => c[0] === 'logs').pop(), ['logs', 'kube', 'api-7d9f-x2', 'app'])
    await js(`(() => { const s = __t.body().querySelector('.dk-state select'); s.value = 'envoy'; s.dispatchEvent(new Event('change')) })()`)
    await until(() => calls.filter(c => c[0] === 'logs').length === 2, 'envoy logs')
    assert.deepEqual(calls.filter(c => c[0] === 'logs').pop(), ['logs', 'kube', 'api-7d9f-x2', 'envoy'])
    await js(`Object.assign(__t.tab(), { term: { focus() {} }, termId: 'term-1' }); [...__t.body().querySelectorAll('.dback .ib')].find(b => b.title === 'Shell dans le conteneur').click()`)
    await until(() => calls.some(c => c[0] === 'term'), 'shell')
    assert.equal(calls.find(c => c[0] === 'term')[1], `sudo k3s kubectl 'exec' '-it' 'api-7d9f-x2' '-c' 'envoy' '--context' 'default' '-n' 'web' '--' 'sh' '-c' 'command -v bash >/dev/null && exec bash || exec sh'\r`)
    await js(`__t.tab().term = null; __t.tab().termId = null`)
    await shot('logs')
    await js(`[...__t.body().querySelectorAll('.dback .ib')].find(b => b.title === 'Décrire').click()`)
    await wait(`__t.text().includes('Namespace:    web')`, 'describe')
    await js(`__t.seg('YAML').click()`)
    await wait(`__t.text().includes('apiVersion: v1')`, 'yaml')
    await js(`__t.body().querySelector('.dback .ib').click()`)
    await wait(`__t.rows().length === 2`, 'back to list')
    await js(`__t.btn('worker-5c-k8', 'Supprimer le pod (il est recréé)').click()`)
    await until(() => calls.some(c => c[0] === 'action' && c[1] === 'delete'), 'delete')

    // workloads: restart and scale
    await js(`__t.chip('Workloads').click()`)
    await wait(`__t.rows().join() === 'worker,api'`, 'workloads')
    await js(`__t.btn('api', 'Redémarrage progressif').click()`)
    await until(() => calls.some(c => c[1] === 'restart'), 'restart')
    await wait(`!!__t.row('api')`, 'list again')
    await js(`__t.btn('api', 'Mettre à l’échelle').click()`)
    await wait(`!!document.querySelector('#modal input')`, 'scale dialog')
    await js(`(() => { const i = document.querySelector('#modal input'); i.value = '4'; document.querySelector('#modal form').requestSubmit() })()`)
    await until(() => calls.some(c => c[1] === 'scale'), 'scale')
    assert.deepEqual(calls.filter(c => c[0] === 'action'), [['action', 'delete', 'pod', 'worker-5c-k8', undefined], ['action', 'restart', 'deployment', 'api', undefined], ['action', 'scale', 'deployment', 'api', 4]])

    // nodes (cluster-wide) and events
    await js(`__t.chip('Nœuds').click()`)
    await wait(`__t.rows().join() === 'node-1'`, 'nodes')
    assert.ok(await js(`__t.text().includes('control-plane · v1.31.2+k3s1 · 10.0.0.1 · 4 CPU')`))
    assert.equal(await js(`__t.body().querySelectorAll('.kube-tools select')[1].disabled`), true)
    await js(`__t.chip('Événements').click()`)
    await wait(`__t.text().includes('BackOff · Pod/worker-5c-k8')`, 'events')
    assert.ok(await js(`__t.text().includes('×14')`))
    await shot('events')

    // back to Docker
    await js(`setPanel(__t.tab(), 'docker')`)
    await wait(`__t.text().includes(${JSON.stringify('Aucun conteneur')}) || !!__t.body().querySelector('.msg')`, 'docker')
    console.log('Kubernetes UI passed: own panel, contexts, namespaces, pod status + metrics, search focus, logs per container, shell, describe/YAML, delete, restart, scale, nodes, events.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'kube-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
require(path.join(root, 'src/main.js'))
mock()
