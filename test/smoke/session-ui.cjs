// Run: npx electron test/smoke/session-ui.cjs — "Reopen connections at startup" brings each tab back at its folders.
// A tab is browsed (and split) in a real window, the window is reloaded like a restart, and the tabs come back at the
// same folders; a folder deleted meanwhile falls back to the home folder.
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-session-ui-'))
app.setPath('appData', path.join(temp, 'profile'))
const data = path.join(temp, 'profile', 'Cyberdog') // the app keeps its data in <appData>/Cyberdog
fs.mkdirSync(path.join(data, 'servers'), { recursive: true })
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lang: 'fr', restoreConnections: true }))
for (const id of ['s1', 's2']) fs.writeFileSync(path.join(data, 'servers', id + '.json'), JSON.stringify({ id, name: 'Restore ' + id, type: 'ssh', host: '127.0.0.1', port: 1, user: 'test', order: +id[1] }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
const work = path.join(temp, 'work'), at = (...p) => path.join(work, ...p)
for (const d of ['www/site', 'etc/nginx', 'gone']) fs.mkdirSync(at(d), { recursive: true })
const W = (process.platform === 'win32' ? '/' : '') + work.replace(/\\/g, '/')
// every server tab browses this computer (no SSH server in this test)
const LOCAL = `window.ensure = async tab => { const T = tab.localPane ? tab : (tab.root || tab); if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = ${JSON.stringify(W)} }; true`

app.on('browser-window-created', (_, win) => {
  // after the reload, before the session is restored
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(LOCAL).catch(() => {}))
  win.webContents.once('did-finish-load', async () => {
    try {
      const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
      const wait = async (test, label) => { for (let i = 0; i < 100; i++) { if (typeof test === 'function' ? test() : await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
      const session = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'session.json'), 'utf8')).tabs } catch { return null } }
      await wait(`typeof openFiles === 'function' && servers.length === 2`, 'servers listed')
      await js(LOCAL)
      // tab 1: /www/site, split with /etc/nginx; tab 2: /gone (deleted before the restart)
      await js(`openFiles(servers.find(s => s.id === 's1'), { path: ${JSON.stringify(W + '/www/site')} })`)
      await wait(`tabs[0]?.active.path === ${JSON.stringify(W + '/www/site')}`, 'tab 1')
      await js(`toggleSplit(tabs[0].active)`)
      await wait(`tabs[0].panes[1]?.path`, 'split')
      await js(`load(tabs[0].panes[1], ${JSON.stringify(W + '/etc/nginx')})`)
      await js(`openFiles(servers.find(s => s.id === 's2'), { path: ${JSON.stringify(W + '/gone')} })`)
      await wait(() => JSON.stringify(session()) === JSON.stringify([
        { serverId: 's1', terminal: false, paths: [W + '/www/site', W + '/etc/nginx'] },
        { serverId: 's2', terminal: false, paths: [W + '/gone'] }]), 'session saved with the folders')
      fs.rmSync(at('gone'), { recursive: true })

      // "restart"
      win.webContents.reload()
      await pause(500)
      await wait(`typeof tabs !== 'undefined' && tabs.length === 2 && tabs.every(tb => !tb.opening)`, 'tabs reopened')
      await wait(`tabs[0].panes.length === 2 && tabs[0].panes[0].path === ${JSON.stringify(W + '/www/site')} && tabs[0].panes[1].path === ${JSON.stringify(W + '/etc/nginx')}`, 'tab 1 at its folders')
      await wait(`tabs[1].active.path === ${JSON.stringify(W)} && !tabs[1].active.error`, 'missing folder: home folder instead')
      console.log('Session UI passed: folders saved, tabs and split reopened at their folders, missing folder falls back to home.')
      app.exit(0)
    } catch (e) { console.error(e); app.exit(1) }
  })
})
setTimeout(() => { console.error('timeout'); app.exit(1) }, 90000).unref()
require(path.join(root, 'src/main.js'))
