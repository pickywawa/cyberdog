// Run: npx electron test/smoke/actions-ui.cjs — quick actions against a real OpenSSH server on 127.0.0.1 (Unix).
// An action made for one server, the server's right-click "Actions" menu (run directly, or create when there is none),
// an action that downloads a file to this computer ("cyberdog:download"), "Show in Finder / Explorer" in the
// notification and in the transfer queue, and the export dialog that checks a server's actions with it.
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), cp = require('node:child_process'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-actions-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const data = path.join(temp, 'profile', 'Cyberdog'), downloads = path.join(temp, 'downloads'), remote = path.join(temp, 'remote')
for (const d of [path.join(data, 'servers'), downloads, remote]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr' }))
fs.writeFileSync(path.join(remote, 'report.txt'), 'quarterly report\n')
let sshd
app.on('quit', () => { sshd?.kill(); fs.rmSync(temp, { recursive: true, force: true }) })
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

async function startSshd() {
  const bin = ['/usr/sbin/sshd', process.env.CYBERDOG_TEST_SSHD].find(f => f && fs.existsSync(f))
  const sftp = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find(f => fs.existsSync(f))
  if (!bin || !sftp) throw Error('OpenSSH sshd and sftp-server are needed for this test')
  for (const k of ['host', 'user']) cp.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(temp, k)])
  const port = await freePort()
  fs.writeFileSync(path.join(temp, 'sshd.conf'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${temp}/host\nAuthorizedKeysFile ${temp}/user.pub\nPidFile ${temp}/sshd.pid\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nSubsystem sftp ${sftp}\n`)
  sshd = cp.spawn(bin, ['-D', '-e', '-f', path.join(temp, 'sshd.conf')], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) { if (await new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true) }); s.once('error', () => r(false)) })) return port; await new Promise(r => setTimeout(r, 100)) }
  throw Error('sshd did not start')
}

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 150) => { for (let i = 0; i < tries; i++) { if (typeof test === 'function' ? test() : await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `actions-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && servers.length === 2`, 'servers listed')
    // an action for "Lab" only, and one for every server
    const script = `echo "Report ready"\necho "cyberdog:download ${remote}/report.txt"`
    await js(`(async () => { quickActions = await api.invoke('actions:save', { name: 'Get the report', script: ${JSON.stringify(script)}, serverId: 'lab' }); quickActions = await api.invoke('actions:save', { name: 'Who am I', script: 'whoami' }) })()`)
    const menuFor = async name => {
      await js(`(() => { const li = [...document.querySelectorAll('#servers li.srv')].find(li => li.textContent.includes(${JSON.stringify(name)})); const r = li.getBoundingClientRect(); li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 8 })) })()`)
      await wait(`!document.querySelector('#menu').hidden`, 'server menu')
      await js(`[...document.querySelectorAll('#menu > .mi')].find(m => m.querySelector('.mi-t').textContent === t('qa.menu')).dispatchEvent(new MouseEvent('mouseenter'))`)
      await wait(`document.querySelectorAll('#menu .submenu .mi').length > 0`, 'actions submenu')
      return js(`[...document.querySelectorAll('#menu .submenu .mi')].map(m => m.querySelector('.mi-t').textContent + (m.classList.contains('disabled') ? ' (disabled)' : ''))`)
    }
    // Lab: its own action first, then the global one
    assert.deepEqual(await menuFor('Lab'), ['Get the report', 'Who am I', await js(`t('qa.add')`)])
    await shot('menu')
    await js(`[...document.querySelectorAll('#menu .submenu .mi')][0].click()`)
    await wait(`tabs.length === 1 && tabs[0].panel === 'actions'`, 'server opened on its actions')
    await wait(() => fs.existsSync(path.join(downloads, 'report.txt')), 'file downloaded by the action', 300)
    assert.equal(fs.readFileSync(path.join(downloads, 'report.txt'), 'utf8'), 'quarterly report\n')
    await wait(`/report\\.txt/.test(document.querySelector('#toast').textContent) && !!document.querySelector('#toast .toast-btn')`, 'notification with Show in Finder')
    assert.equal(await js(`document.querySelector('#toast .toast-btn').textContent`), await js(`revealLabel()`))
    await wait(`!!document.querySelector('.qa-files .chip')`, 'result shows the downloaded file')
    assert.match(await js(`document.querySelector('.res pre').textContent`), /Report ready/)
    await shot('result')
    // the other Cyberdog commands: open a file (editor) and a folder, terminal in a folder, refresh, notify
    fs.mkdirSync(path.join(remote, 'site')); fs.writeFileSync(path.join(remote, 'site', 'index.html'), '<h1>hello</h1>\n')
    const commands = ['echo "cyberdog:open ' + remote + '/site/index.html"', 'echo "cyberdog:terminal ' + remote + '/site"', 'echo "cyberdog:refresh"', 'echo "cyberdog:open /nowhere/at/all"', 'echo "cyberdog:notify Site ready"'].join('\n')
    await js(`(async () => { quickActions = await api.invoke('actions:save', { name: 'Site', script: ${JSON.stringify(commands)}, serverId: 'lab' }); paintActions(tabs[0]); runAction(tabs[0], quickActions.find(a => a.name === 'Site'), false) })()`)
    await wait(`tabs[0].editor?.files?.some(f => f.name === 'index.html')`, 'cyberdog:open a file: editor', 300)
    await wait(`tabs[0].active.path === ${JSON.stringify(fs.realpathSync(remote) + '/site')}`, 'explorer at the file folder') // macOS: /var is /private/var
    await wait(`!!tabs[0].term`, 'cyberdog:terminal')
    await wait(`/Site ready/.test(document.querySelector('#toast').textContent)`, 'cyberdog:notify (after a failing command)')
    await assert.rejects(js(`api.invoke('link:open', 'file:///etc/passwd')`), /http/)
    await js(`setPanel(tabs[0], 'actions')`)
    // help: the ⓘ button shows the commands
    await js(`tabs[0].rpanelActions.querySelector('.ib').click()`)
    await wait(`tabs[0].rpanelBody.querySelectorAll('.qa-help dt').length === 11`, 'help')
    await shot('help')
    // a form: pick a backup in a list, then the action runs again and downloads it
    fs.mkdirSync(path.join(remote, 'backups'))
    fs.writeFileSync(path.join(remote, 'backups', 'site-2026-11-01.tar.gz'), 'old backup'); fs.writeFileSync(path.join(remote, 'backups', 'site-2026-11-20.tar.gz'), 'new backup')
    const picker = `DIR="${remote}/backups"
if [ -z "$FILE" ]; then
  echo "cyberdog:title Download a backup"
  echo "cyberdog:select FILE|Backup"
  ls -1t "$DIR"/*.tar.gz | while read -r f; do
    echo "cyberdog:option FILE|$f|$(basename "$f") ($(du -h "$f" | cut -f1))"
  done
  exit 0
fi
echo "cyberdog:download $FILE"`
    await js(`(async () => { quickActions = await api.invoke('actions:save', { name: 'Backup', script: ${JSON.stringify(picker)}, serverId: 'lab' }); runAction(tabs[0], quickActions.find(a => a.name === 'Backup'), false) })(); true`)
    await wait(`document.querySelectorAll('.action-form select option').length === 2`, 'backup list')
    await shot('form-select')
    await js(`(() => { const s = document.querySelector('.action-form select'); s.value = [...s.options].find(o => o.textContent.startsWith('site-2026-11-01')).value; s.dispatchEvent(new Event('change')); document.querySelector('.action-form button.primary').click() })()`)
    await wait(() => fs.existsSync(path.join(downloads, 'site-2026-11-01.tar.gz')), 'chosen backup downloaded', 300)
    assert.equal(fs.readFileSync(path.join(downloads, 'site-2026-11-01.tar.gz'), 'utf8'), 'old backup')
    assert.equal(fs.existsSync(path.join(downloads, 'site-2026-11-20.tar.gz')), false)
    // text field + buttons in one form; a lone buttons question answers with one click; cancelling stops
    const combo = `if [ -z "$NAME" ]; then
  echo "cyberdog:input NAME|Archive name|nightly"
  echo "cyberdog:buttons KEEP|Keep the old one?|Yes=1|No=0"
  exit 0
fi
if [ -z "$GO" ]; then echo "cyberdog:buttons GO|Really create $NAME.tar.gz?|Create=yes|Not now=no"; exit 0; fi
echo "name=$NAME keep=$KEEP go=$GO"`
    await js(`(async () => { quickActions = await api.invoke('actions:save', { name: 'Combo', script: ${JSON.stringify(combo)}, serverId: 'lab' }); runAction(tabs[0], quickActions.find(a => a.name === 'Combo'), false) })(); true`)
    await wait(`!!document.querySelector('.action-form input[type=text]')`, 'combo form')
    await js(`(() => { const i = document.querySelector('.action-form input[type=text]'); i.value = "it's done"; i.dispatchEvent(new Event('input')); [...document.querySelectorAll('.action-form .form-buttons button')].find(b => b.textContent === 'No').click() })()`)
    await shot('form-combo')
    await js(`document.querySelector('.action-form button.primary').click()`)
    await wait(`[...document.querySelectorAll('.action-form .form-buttons button')].some(b => b.textContent === 'Create')`, 'second question')
    assert.equal(await js(`!!document.querySelector('.action-form button.primary')`), false, 'buttons only: no Continue button')
    await js(`[...document.querySelectorAll('.action-form .form-buttons button')].find(b => b.textContent === 'Create').click()`)
    await wait(`[...document.querySelectorAll('.res pre')].some(p => p.textContent.includes("name=it's done keep=0 go=yes"))`, 'answers in the variables')
    await js(`runAction(tabs[0], quickActions.find(a => a.name === 'Combo'), false); true`)
    await wait(`!!document.querySelector('.action-form')`, 'form again')
    await js(`[...document.querySelectorAll('.action-form .btns button')][0].click()`)
    await wait(`[...document.querySelectorAll('.res pre')][0].textContent.includes(t('qa.form_cancelled'))`, 'cancelled')

    // the transfer queue: a finished download has its "Show in Finder" button
    await js(`document.querySelectorAll('.transfer-widget').forEach(w => w.classList.add('expanded'))`)
    await wait(`!!document.querySelector('.transfer-reveal')`, 'reveal button in the queue')
    assert.match(await js(`[...document.querySelectorAll('.transfer-row small')].map(x => x.textContent).join('|')`), /\d{2}:\d{2} → \d{2}:\d{2} · /, 'start, end and duration')
    await shot('queue')
    await js(`document.querySelectorAll('.transfer-widget').forEach(w => w.classList.remove('expanded'))`)
    // the actions view of Lab lists both; the server action is marked
    assert.deepEqual((await js(`[...document.querySelectorAll('.qa-card .qa-head b')].map(b => b.textContent)`)).sort(), ['Backup', 'Combo', 'Get the report', 'Site', 'Who am I'].sort())

    // Other: only the global action; with no action at all, "No action" and a way to create one
    assert.deepEqual(await menuFor('Other'), ['Who am I', await js(`t('qa.add')`)])
    await js(`hideMenu()`)
    await js(`(async () => { quickActions = await api.invoke('actions:delete', quickActions.find(a => a.name === 'Who am I').id) })()`)
    assert.deepEqual(await menuFor('Other'), [await js(`t('qa.none')`) + ' (disabled)', await js(`t('qa.add')`)])
    await js(`[...document.querySelectorAll('#menu .submenu .mi')].at(-1).click()`)
    await wait(`tabs.length === 2 && tabs[1].server.id === 'other' && tabs[1].panel === 'actions' && !!document.querySelector('#modal form textarea')`, 'create form on Other')
    assert.equal(await js(`tabs[1].rpanelBody.querySelectorAll('.qa-help dt').length`), 11, 'no action yet: the commands are explained')
    assert.equal(await js(`document.querySelector('#modal select[name], #modal select') ? [...document.querySelectorAll('#modal select')].some(s => [...s.options].some(o => o.value === 'other')) : false`), true, 'the form offers "only this server"')
    await shot('create')
    await js(`document.querySelector('#modal form button:not(.primary)').click()`)

    // export: checking a server checks its actions
    await js(`exportConfiguration()`)
    await wait(`!!document.querySelector('.config-card')`, 'export dialog')
    const box = (kind, label) => `[...document.querySelectorAll('.config-section[data-kind=${kind}] .config-item')].find(l => l.textContent.includes(${JSON.stringify(label)})).querySelector('input')`
    await js(`(() => { const b = ${box('actions', 'Get the report')}; b.checked = false; b.dispatchEvent(new Event('change')); const s = ${box('servers', 'Lab')}; s.checked = false; s.dispatchEvent(new Event('change')); s.checked = true; s.dispatchEvent(new Event('change')) })()`)
    assert.equal(await js(`${box('actions', 'Get the report')}.checked`), true)
    console.log('Actions UI passed: server action, Actions menu (run / none / create), download from an action, Show in Finder in the notification and the queue, export follows the server.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'actions-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
startSshd().then(port => {
  const user = os.userInfo().username
  for (const [id, name, order] of [['lab', 'Lab', 1], ['other', 'Other', 2]])
    fs.writeFileSync(path.join(data, 'servers', id + '.json'), JSON.stringify({ id, name, host: '127.0.0.1', port, user, key: path.join(temp, 'user'), authMode: 'key', downloadDir: downloads, order }))
  require(path.join(root, 'src/main.js'))
}, e => { console.error(e); process.exit(1) })
