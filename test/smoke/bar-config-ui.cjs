// Run: npx electron test/smoke/bar-config-ui.cjs — the customizable right bar in a real window: configuration mode,
// hide / show a view, reorder by drag and drop, saved layout shared by every tab, reset.
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-bar-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json')
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code).catch(e => { console.error('step failed:', code.slice(0, 120)); throw e }), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `bar-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof rebuildBar === 'function'`, 'app ready')
    win.setSize(1400, 900)
    await js(`window.ensure = async tab => { const T = tab.root || tab; if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.__t = { tab: () => tabs.find(t => t.id === activeId), keys: () => [...__t.tab().rightBar.querySelectorAll('[data-key]')].map(b => b.dataset.key) }; true`)
    await js(`void openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(os.homedir())} })`)
    await wait(`!!__t.tab()?.connId`, 'tab open')
    // the bar of an SSH server: every view
    await js(`const T = __t.tab(); T.server = { ...T.server, type: 'ssh' }; rebuildBar(T); true`)
    const all = await js(`__t.keys()`)
    assert.deepEqual(all, BAR_KEYS())

    // configuration mode: labels shown, an eye on each view, the button becomes "Terminé"
    await js(`__t.tab().barConfigBtn.click()`)
    assert.equal(await js(`__t.tab().rightBar.classList.contains('config')`), true)
    assert.equal(await js(`__t.tab().barConfigBtn.title`), 'Terminé')
    assert.equal(await js(`__t.tab().bar.keys.textContent`), 'Clés SSH')
    // hide the processes, it stays listed (struck out) while configuring
    await js(`__t.tab().bar.processes.click()`)
    assert.equal(await js(`__t.tab().bar.processes.classList.contains('off')`), true)
    assert.ok((await js(`__t.keys()`)).includes('processes'))
    // drag Kubernetes above the terminal
    await js(`(() => { const T = __t.tab(), dt = new DataTransfer(), src = T.bar.kube, dst = T.bar.term, r = dst.getBoundingClientRect()
      src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 2 })) })(); true`)
    // the dragged view already moved in the bar (live), as a dashed placeholder, before it is dropped
    assert.equal((await js(`__t.keys()`))[0], 'kube')
    await pause(100)
    assert.equal(await js(`__t.tab().bar.kube.classList.contains('dragging')`), true)
    await shot('dragging')
    await js(`(() => { const T = __t.tab(), dt = new DataTransfer()
      T.rightBar.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      T.bar.kube.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true })) })(); true`)
    assert.equal((await js(`__t.keys()`))[0], 'kube')
    // a drag let go outside the bar puts the view back
    await js(`(() => { const T = __t.tab(), dt = new DataTransfer(), r = T.bar.actions.getBoundingClientRect()
      T.bar.term.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      T.bar.actions.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.bottom - 2 }))
      T.bar.term.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true })) })(); true`)
    assert.equal((await js(`__t.keys()`))[1], 'term', 'cancelled drag')
    await pause(400); await shot('config')

    // done: the hidden view leaves the bar, the order is kept and saved
    await js(`__t.tab().barConfigBtn.click()`)
    const keys = await js(`__t.keys()`)
    assert.equal(keys.includes('processes'), false)
    assert.equal(keys[0], 'kube')
    assert.deepEqual(await js(`JSON.parse(localStorage.getItem('cyberdog.rbarLayout')).hidden`), ['processes'])
    await shot('custom')

    // reset
    await js(`__t.tab().barConfigBtn.click(); __t.tab().barReset.click(); __t.tab().barConfigBtn.click(); true`)
    assert.deepEqual(await js(`__t.keys()`), all)
    console.log('Bar config UI passed: configuration mode, hide, drag to reorder, saved layout, reset.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'bar-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
const BAR_KEYS = () => ['term', 'dashboard', 'processes', 'services', 'schedules', 'logs', 'docker', 'kube', 'databases', 'certificates', 'keys', 'paths', 'sync', 'actions']
require(path.join(root, 'src/main.js'))
