// Run: npx electron test/smoke/editor-config-ui.cjs — the configuration bar of the built-in editor in a real window.
// Files live in a temporary local folder; the server side of editor:config is replaced by a fake nginx / Compose that
// reads the saved file. Checks: bar per file type, service state, save → test → reload, a failed test applies nothing
// and puts markers on the right line, rollback to the previous version, Compose apply, no bar for other files.
const { app, ipcMain } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-editor-config-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json')
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula', defaultEditor: 'internal' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
fs.mkdirSync(path.join(temp, 'work'))
const work = fs.realpathSync(path.join(temp, 'work')), at = n => path.join(work, n)
const NGINX = 'events {}\nhttp {\n  server {\n    listen 80;\n    server_name example.com;\n  }\n}\n'
fs.writeFileSync(at('nginx.conf'), NGINX)
fs.writeFileSync(at('docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
fs.writeFileSync(at('notes.txt'), 'hello\n')

const calls = []
const mock = () => {
  ipcMain.removeHandler('editor:config')
  ipcMain.handle('editor:config', (_, id, p, profile, action) => {
    calls.push([profile, action])
    if (action === 'status') return profile === 'compose' ? { code: 0, out: 'compose 2/3\n' } : { code: 0, out: 'nginx.service active\n' }
    if (profile === 'nginx' && action === 'test') {
      const lines = fs.readFileSync(p, 'utf8').split('\n'), bad = lines.findIndex(l => l.includes('server_nme'))
      return bad < 0 ? { code: 0, out: `nginx: the configuration file ${p} syntax is ok\nnginx: configuration file ${p} test is successful\n` }
        : { code: 1, out: `nginx: [emerg] unknown directive "server_nme" in ${p}:${bad + 1}\nnginx: configuration file ${p} test failed\n` }
    }
    return { code: 0, out: action === 'up' ? 'Container app-web-1  Started\n' : '' }
  })
}

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    win.webContents.on('console-message', (...a) => { const m = a[0]?.message ?? a[2]; if ((a[0]?.level ?? a[1]) === 'error' || a[1] >= 3) console.error('renderer:', m) })
    const js = code => win.webContents.executeJavaScript(code).catch(e => { console.error('step failed:', code.slice(0, 120)); throw e }), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 150) => { for (let i = 0; i < tries; i++) { if (await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const until = async (test, label) => { for (let i = 0; i < 150; i++) { if (test()) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `editor-config-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof paintConfigBar === 'function'`, 'app ready')
    win.setSize(1400, 900)
    await js(`window.ensure = async tab => { const T = tab.localPane ? tab : (tab.root || tab); if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.confirm = () => true
      window.__t = { tab: () => tabs.find(t => t.id === activeId), pane: () => __t.tab().active, E: () => __t.tab().editor, bar: () => __t.E().cfgbar,
        row: name => __t.pane().rowEls.find(r => r.dataset.name === name),
        open: name => __t.row(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
        chip: label => [...document.querySelectorAll('.ed-cfg .chip, .ed-cfg-out .chip')].find(b => b.textContent === label),
        markers: () => monaco.editor.getModelMarkers({ owner: 'cyberdog-config' }).map(m => [m.startLineNumber, m.severity]) }; true`)
    const W = (process.platform === 'win32' ? '/' : '') + work.replace(/\\/g, '/')
    await js(`void openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(W)} })`)
    await wait(`!!__t.pane()?.rowEls?.length && !!__t.row('nginx.conf')`, 'listing')
    await js(`__t.tab().server = { ...__t.tab().server, type: 'ssh' }; true`) // the bar is for shell servers

    // nginx.conf: bar, service state, buttons
    await js(`__t.open('nginx.conf')`)
    await wait(`!!window.monaco && __t.E()?.active?.name === 'nginx.conf' && !__t.bar().hidden`, 'nginx bar', 300)
    await wait(`__t.bar().textContent.includes('nginx.service · active')`, 'status')
    assert.equal(await js(`[...__t.bar().querySelectorAll('.chip')].map(b => b.textContent).join('|')`), 'Tester|Recharger|Redémarrer|Enregistrer et appliquer')
    assert.equal(await js(`!!__t.bar().querySelector('.dot.lv-ok')`), true)

    // a typo: save and apply → test fails, nothing reloaded, marker on line 5
    await js(`__t.E().active.model.setValue(${JSON.stringify(NGINX.replace('server_name', 'server_nme'))})`)
    await js(`__t.chip('Enregistrer et appliquer').click()`)
    await wait(`!!document.querySelector('.ed-cfg-out.err')`, 'failed output')
    assert.ok(fs.readFileSync(at('nginx.conf'), 'utf8').includes('server_nme'), 'saved before testing')
    assert.equal(calls.some(c => c[1] === 'reload'), false, 'nothing reloaded after a failed test')
    assert.deepEqual(await js(`__t.markers()`), [[5, 8]], 'error marker on line 5')
    const out = await js(`document.querySelector('.ed-cfg-out').innerText`)
    assert.ok(out.includes('Configuration invalide') && out.includes('Ligne 5') && out.includes('unknown directive'), out)
    assert.equal(await js(`__t.bar().querySelector('.ed-cfg-toggle span').textContent`), '1')
    await js(`document.querySelector('.ed-cfg-problem').click()`)
    assert.equal(await js(`__t.E().instance.getPosition().lineNumber`), 5, 'a problem jumps to its line')
    await pause(300)
    await shot('failed')

    // rollback: the previous version goes back, then is applied (test + reload)
    await js(`__t.chip('Restaurer la version précédente').click()`)
    await until(() => calls.some(c => c[1] === 'reload'), 'reapplied')
    await wait(`!document.querySelector('.ed-cfg-out.err') && !__t.bar().querySelector('.chip:disabled')`, 'rolled back and applied')
    assert.equal(fs.readFileSync(at('nginx.conf'), 'utf8'), NGINX)
    assert.deepEqual(calls.filter(c => c[1] !== 'status'), [['nginx', 'test'], ['nginx', 'test'], ['nginx', 'reload']])
    assert.deepEqual(await js(`__t.markers()`), [], 'markers cleared')

    // test alone, with unsaved changes: saved first
    await js(`__t.E().active.model.setValue(${JSON.stringify(NGINX.replace('80', '8080'))})`)
    const tests = calls.filter(c => c[1] === 'test').length
    await js(`__t.chip('Tester').click()`)
    await until(() => calls.filter(c => c[1] === 'test').length > tests, 'tested')
    await wait(`!__t.bar().querySelector('.chip:disabled')`, 'idle')
    assert.ok(fs.readFileSync(at('nginx.conf'), 'utf8').includes('8080'))
    assert.equal(await js(`__t.E().active && isDirty(__t.E().active)`), false)
    await js(`__t.bar().querySelector('.ed-cfg-toggle').click()`)
    assert.ok((await js(`document.querySelector('.ed-cfg-out').innerText`)).includes('Configuration valide'))
    await shot('ok')

    // Compose: its own actions, apply = up -d
    await js(`__t.open('docker-compose.yml')`)
    await wait(`__t.E().active?.name === 'docker-compose.yml' && __t.bar().textContent.includes('Docker Compose')`, 'compose bar')
    await wait(`__t.bar().textContent.includes('compose · 2/3')`, 'compose status')
    assert.equal(await js(`!!__t.bar().querySelector('.dot.lv-warn')`), true, 'some services stopped')
    assert.equal(await js(`[...__t.bar().querySelectorAll('.chip')].map(b => b.textContent).join('|')`), 'Tester|Appliquer (up -d)|Redémarrer|Enregistrer et appliquer')
    await js(`__t.chip('Enregistrer et appliquer').click()`)
    await until(() => calls.some(c => c[1] === 'up'), 'compose applied')
    await wait(`!__t.bar().querySelector('.chip:disabled')`, 'compose idle')
    assert.deepEqual(calls.filter(c => c[0] === 'compose' && c[1] !== 'status'), [['compose', 'test'], ['compose', 'up']])

    // a file without profile: no bar; back to nginx: the bar comes back with its state
    await js(`__t.open('notes.txt')`)
    await wait(`__t.E().active?.name === 'notes.txt'`, 'notes')
    assert.equal(await js(`__t.bar().hidden`), true)
    await js(`showEditorFile(__t.tab(), __t.E().files[0])`)
    assert.equal(await js(`__t.bar().hidden`), false)
    console.log('Editor configuration bar passed: profiles, status, save → test → reload, failed test applies nothing, markers + jump to line, rollback, Compose up, no bar for other files.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'editor-config-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
require(path.join(root, 'src/main.js'))
mock()
