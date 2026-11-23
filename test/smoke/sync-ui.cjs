// Run: npx electron test/smoke/sync-ui.cjs — synchronized folders in a real window, the "server" being a folder of this
// computer (the local server type). Fills the "Synchronize with a local folder…" dialog, reviews the comparison, runs it,
// then watches: a local change reaches the server on its own (real fs.watch). Also the Sync panel, the path bar badge and
// the comparison of the local pane with the server pane. Screenshots go to $CYBERDOG_SHOTS (or the temp folder).
const { app, ipcMain } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-sync-ui-')))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json')
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula', showLocalPane: true }))
app.on('quit', () => { if (!process.env.CYBERDOG_SHOTS) fs.rmSync(temp, { recursive: true, force: true }) })

const here = path.join(temp, 'site'), server = path.join(temp, 'server')
fs.mkdirSync(path.join(here, 'css'), { recursive: true }); fs.mkdirSync(path.join(here, '.git')); fs.mkdirSync(path.join(server, 'www'), { recursive: true })
fs.writeFileSync(path.join(here, 'index.html'), '<h1>v1</h1>'); fs.writeFileSync(path.join(here, 'css', 'site.css'), 'body{}'); fs.writeFileSync(path.join(here, '.git', 'HEAD'), 'ref')
fs.writeFileSync(path.join(server, 'www', 'index.html'), '<h1>old</h1>'); fs.writeFileSync(path.join(server, 'www', 'legacy.php'), '<?php')
const remote = path.join(server, 'www').split(path.sep).join('/')
const mock = () => { ipcMain.removeHandler('sync:pick-local'); ipcMain.handle('sync:pick-local', () => here) }

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 150) => { for (let i = 0; i < tries; i++) { if (await (typeof test === 'function' ? test() : js(test))) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `sync-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof renderSync === 'function'`, 'app ready')
    // the server tab opens the local file system (its pane connection), as the other smoke tests do
    await js(`const __ensure = ensure; window.ensure = async tab => { if (tab.localPane) return __ensure(tab); const T = tab.root || tab; if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }; true`)
    await js(`window.confirm = () => true
      window.__t = { tab: () => tabs.find(t => t.id === activeId), ex: () => __t.tab().panes[0], body: () => __t.tab().rpanelBody, modal: () => document.querySelector('#modal') }; true`)
    await js(`void openFiles({ id: 'local', type: 'local', name: 'Mon serveur' }, { path: ${JSON.stringify(remote)} })`)
    await wait(`!!__t.ex()?.connId && __t.ex().path === ${JSON.stringify(remote)}`, 'tab open')
    win.setSize(1280, 860)

    // the right bar has the Sync panel, empty for now
    await js(`setPanel(__t.tab(), 'sync')`)
    await wait(`__t.body().innerText.includes('Aucun dossier synchronisé')`, 'empty panel')

    // context menu of the explorer background -> the dialog
    await js(`ctxMenu(__t.ex(), { preventDefault() {}, target: __t.ex().table, clientX: 400, clientY: 300 })`)
    await wait(`[...document.querySelectorAll('#menu .mi-t')].some(e => e.textContent === 'Synchroniser avec un dossier local…')`, 'menu entry')
    await js(`[...document.querySelectorAll('#menu .mi')].find(e => e.innerText.includes('Synchroniser avec un dossier local')).click()`)
    await wait(`!!document.querySelector('#modal .folder-field')`, 'form')
    await js(`document.querySelector('#modal .folder-field button').click()`)
    await wait(`document.querySelector('#modal .folder-input').value === ${JSON.stringify(here)}`, 'folder picked')
    assert.equal(await js(`document.querySelectorAll('#modal input')[1].value`), remote)
    assert.equal(await js(`document.querySelector('#modal select').value`), 'watch')
    await pause(400)
    await shot('form')
    await js(`document.querySelector('#modal button.primary').click()`)

    // the preview: index.html modified, css/ + css/site.css added, legacy.php only on the server (not ticked), .git excluded
    await wait(`!!document.querySelector('.sync-preview')`, 'preview')
    const groups = await js(`[...document.querySelectorAll('.sync-group')].map(g => [g.className.match(/k-(\\w+)/)[1], [...g.querySelectorAll('.sync-row')].map(r => [r.querySelector('.sync-rel').textContent, r.querySelector('input').checked])])`)
    assert.deepEqual(groups, [['add', [['css/', true], ['css/site.css', true]]], ['modify', [['index.html', true]]], ['delete', [['legacy.php', false]]]])
    assert.equal(await js(`document.querySelector('.sync-preview button.primary').textContent`), 'Synchroniser et surveiller (3)')
    await shot('preview')
    await js(`document.querySelector('.sync-preview button.primary').click()`)
    await wait(() => fs.existsSync(path.join(server, 'www', 'css', 'site.css')) && fs.readFileSync(path.join(server, 'www', 'index.html'), 'utf8') === '<h1>v1</h1>', 'synchronized')
    assert.ok(fs.existsSync(path.join(server, 'www', 'legacy.php')), 'not deleted: it was not ticked')
    assert.ok(!fs.existsSync(path.join(server, 'www', '.git')), 'excluded')
    await wait(`syncPairs[0]?.state === 'watching'`, 'watching')

    // watching: a local change is sent on its own
    await pause(500)
    fs.writeFileSync(path.join(here, 'index.html'), '<h1>v2</h1>')
    fs.writeFileSync(path.join(here, 'css', 'print.css'), '@media print{}')
    await wait(() => fs.existsSync(path.join(server, 'www', 'css', 'print.css')) && fs.readFileSync(path.join(server, 'www', 'index.html'), 'utf8') === '<h1>v2</h1>', 'watched change sent', 200)
    await wait(`__t.body().innerText.includes('Surveillé') && __t.body().innerText.includes('dernière synchro')`, 'panel state')
    await wait(`!__t.ex().syncBadge.hidden && __t.ex().syncBadge.classList.contains('on')`, 'path bar badge')
    await js(`load(__t.ex(), __t.ex().path, false, true)`)
    await pause(400)
    await shot('panel')

    // the local pane next to the server: the compare button appears and compares the two folders
    await js(`toggleLocal(__t.ex())`)
    await wait(`__t.tab().panes.length === 2 && !!__t.tab().panes[1].path`, 'local pane (home folder first)')
    await js(`load(__t.tab().panes[1], ${JSON.stringify(here.split(path.sep).join('/'))})`)
    await wait(`__t.tab().panes[1].path === ${JSON.stringify(here.split(path.sep).join('/'))}`, 'local pane at the folder')
    assert.equal(await js(`__t.ex().compareBtn.hidden`), false)
    await js(`__t.ex().compareBtn.click()`)
    await wait(`!!document.querySelector('.sync-preview')`, 'panes preview')
    const panes = await js(`[...document.querySelectorAll('.sync-preview .sync-rel')].map(e => e.textContent)`)
    assert.deepEqual(panes, ['legacy.php'], 'in sync but the stray file; default exclusions apply (.git)')
    await shot('panes')
    await js(`document.querySelector('.sync-preview .btns button').click()`)

    // pause from the panel
    await js(`[...__t.body().querySelectorAll('.sync-pair .ib')].find(b => b.title === 'Arrêter la surveillance').click()`)
    await wait(`syncPairs[0]?.state === 'idle' && !syncPairs[0].watch`, 'paused')
    console.log('Sync UI passed: menu entry, form, preview, run + watch, live change sent, panel, badge, local pane comparison, pause.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'sync-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
require(path.join(root, 'src/main.js'))
mock()
