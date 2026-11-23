// Run: npx electron test/smoke/schedules-ui.cjs — the Scheduled tasks panel in a real window, with the SSH side replaced by
// an in-memory crontab and systemd timers. Lists cron and timers, describes and previews schedules, adds, edits, disables,
// runs and deletes a task, and starts a timer. Screenshots go to $CYBERDOG_SHOTS (or the temp folder).
const { app, ipcMain } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-schedules-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json')
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
const model = require(path.join(root, 'src/schedules'))

// ---------- fake server ----------
let crontab = '# Sauvegarde nocturne\n30 3 * * * /srv/backup.sh\n\nMAILTO=""\n*/10 * * * * /srv/ping.sh\n'
const calls = []
const snapshot = () => {
  const now = Math.floor(Date.now() / 1000)
  return model.parse(`@@NOW\n${now} +0100\ndeploy\n@@CRON\n${crontab}\n@@CRONRC 0\n@@FILE /etc/cron.d/certbot\n0 */12 * * * root certbot -q renew\n\n@@PERIODIC\ndaily /etc/cron.daily/logrotate\n@@CRONSVC\ncron.service\n@@TIMERS
@@T apt-daily.timer\nUnit=apt-daily.service\nDescription=Daily apt download activities\nActiveState=active\nUnitFileState=enabled\nTimersCalendar={ OnCalendar=*-*-* 6,18:00 ; next_elapse=x }\nTimersMonotonic=\nPersistent=yes\nNEXT=${now + 5400}\nLAST=${now - 3600}\nS_Result=success\nS_ExecMainStatus=0\nS_ActiveState=inactive
@@T backup-db.timer\nUnit=backup-db.service\nDescription=Database dump\nActiveState=active\nUnitFileState=enabled\nTimersCalendar={ OnCalendar=*-*-* 02:00:00 ; next_elapse=x }\nTimersMonotonic=\nPersistent=no\nNEXT=${now + 40000}\nLAST=${now - 46000}\nS_Result=exit-code\nS_ExecMainStatus=2\nS_ActiveState=failed\n`)
}
const mock = () => {
  for (const ch of ['sched:list', 'sched:edit', 'sched:run', 'sched:timer', 'log:start', 'log:stop']) ipcMain.removeHandler(ch)
  ipcMain.handle('sched:list', () => snapshot())
  ipcMain.handle('sched:edit', (_, id, op) => { calls.push(['edit', op.type]); crontab = model.applyEdit(crontab, op) })
  ipcMain.handle('sched:run', (_, id, ref) => { calls.push(['run', ref.id]); return { code: 0, out: 'backup ok\n' } })
  ipcMain.handle('sched:timer', (_, id, unit, action) => { calls.push(['timer', unit, action]) })
  ipcMain.handle('log:start', () => 'log-1')
  ipcMain.handle('log:stop', () => {})
}

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `schedules-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof renderSchedules === 'function'`, 'app ready')
    await js(`window.ensure = async tab => { const T = tab.root || tab; if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.confirm = () => true
      window.__t = { tab: () => tabs.find(t => t.id === activeId), body: () => __t.tab().rpanelBody, text: () => __t.body().innerText,
        rows: () => [...__t.body().querySelectorAll('.sched-list .proc-row')].map(r => r.querySelector('b').textContent),
        row: name => [...__t.body().querySelectorAll('.sched-list .proc-row')].find(r => r.querySelector('b').textContent === name),
        chip: label => [...__t.body().querySelectorAll('.proc-detail .chip, .sched-form .chip')].find(b => b.textContent === label),
        input: (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) } }; true`)
    await js(`void openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(os.homedir())} })`)
    await wait(`!!__t.tab()?.connId`, 'tab open')
    win.setSize(1280, 860)
    await js(`setPanel(__t.tab(), 'schedules')`)
    await wait(`__t.rows().length === 6`, 'list')

    // failed timer first, then by next run; descriptions in French
    const rows = await js(`__t.rows()`)
    assert.equal(rows[0], 'backup-db', 'failed timer first')
    assert.deepEqual(rows.slice(1, 3), ['/srv/ping.sh', 'apt-daily'])
    assert.ok(rows.includes('Sauvegarde nocturne') && rows.includes('logrotate') && rows.includes('certbot -q renew'))
    const text = await js(`__t.text()`)
    for (const s of ['Toutes les 10 minutes', 'Tous les jours à 03:30', 'Dernière exécution en échec (exit-code)', 'Tâches cron', 'Fuseau horaire du serveur : UTC+0100']) assert.ok(text.includes(s), s)
    await shot('list')

    // details: next runs, read-only system task
    await js(`__t.row('certbot -q renew').querySelector('.proc-main').click()`)
    await wait(`__t.text().includes('Prochaines exécutions')`, 'detail')
    assert.ok(await js(`__t.text().includes('Tâche système : lecture seule')`))
    assert.equal(await js(`!!__t.chip('Modifier')`), false, 'system tasks are not editable')

    // new task: invalid then valid schedule, presets, live preview
    await js(`__t.tab().rpanelActions.querySelector('.ib').click()`)
    await wait(`!!__t.body().querySelector('.sched-form')`, 'editor')
    const [nameIn, exprIn] = await js(`[...__t.body().querySelectorAll('.sched-form input')].length`).then(() => [0, 1])
    await js(`__t.input(__t.body().querySelectorAll('.sched-form input')[${exprIn}], '0 25 * * *')`)
    assert.ok(await js(`__t.body().querySelector('.sched-preview').textContent.includes('Le champ 2 est invalide')`))
    assert.equal(await js(`__t.body().querySelector('.sched-form button.primary').disabled`), true)
    await js(`__t.chip('En semaine 09:00').click()`)
    assert.ok(await js(`__t.body().querySelector('.sched-preview b').textContent === 'Du lundi au vendredi à 09:00'`))
    assert.equal(await js(`__t.body().querySelectorAll('.sched-preview small').length`), 3, 'three next runs')
    await js(`__t.input(__t.body().querySelectorAll('.sched-form input')[${nameIn}], 'Rapport disque'); __t.input(__t.body().querySelector('.sched-form textarea'), 'df -h | mail -s disque ops')`)
    await shot('editor')
    await js(`__t.body().querySelector('.sched-form button.primary').click()`)
    await wait(`__t.rows().includes('Rapport disque')`, 'added')
    assert.ok(crontab.endsWith('\n# Rapport disque\n0 9 * * 1-5 df -h | mail -s disque ops\n'), crontab)
    assert.ok(await js(`__t.text().includes('Du lundi au vendredi à 09:00')`), 'the new task is selected')

    // disable, edit, run, delete
    await js(`__t.chip('Désactiver').click()`)
    await wait(`__t.row('Rapport disque')?.classList.contains('sched-off')`, 'disabled')
    assert.ok(crontab.includes('#cyberdog-off# 0 9 * * 1-5 df -h'))
    await js(`__t.chip('Modifier').click()`)
    await wait(`!!__t.body().querySelector('.sched-form')`, 'edit form')
    assert.equal(await js(`__t.body().querySelectorAll('.sched-form input')[0].value`), 'Rapport disque')
    await js(`__t.input(__t.body().querySelectorAll('.sched-form input')[1], '15 8 * * 1'); __t.body().querySelector('.sched-form button.primary').click()`)
    await wait(`__t.text().includes('Chaque lundi à 08:15')`, 'edited')
    assert.ok(crontab.includes('# Rapport disque\n#cyberdog-off# 15 8 * * 1 df -h'), 'edited task stays disabled')
    await js(`__t.chip('Lancer maintenant').click()`)
    await wait(`__t.text().includes('backup ok')`, 'run output')
    assert.ok(await js(`__t.text().includes('Terminé avec le code 0')`))
    await shot('run')
    await js(`__t.chip('Supprimer').click()`)
    await wait(`!__t.rows().includes('Rapport disque')`, 'deleted')
    assert.ok(!crontab.includes('Rapport'))

    // timer: run now starts the service and follows its journal
    await js(`__t.row('apt-daily').querySelector('.proc-main').click()`)
    await wait(`!!__t.chip('Lancer maintenant')`, 'timer detail')
    assert.ok(await js(`__t.text().includes('*-*-* 6,18:00')`))
    await js(`__t.chip('Lancer maintenant').click()`)
    await wait(`!!__t.body().querySelector('.proc-detail .logview')`, 'timer logs')
    assert.deepEqual(calls.filter(c => c[0] === 'timer'), [['timer', 'apt-daily.service', 'start']])
    assert.deepEqual(calls.filter(c => c[0] === 'edit').map(c => c[1]), ['add', 'toggle', 'update', 'delete'])
    await shot('timer')

    // SSH servers get the panel button in the right bar
    assert.ok(await js(`barFor({ type: 'ssh' }).some(([k, ic]) => k === 'schedules' && ic === 'clock')`))
    console.log('Scheduled tasks UI passed: list, failed first, descriptions, read-only system tasks, live preview, add, disable, edit, run, delete, timer start + logs.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'schedules-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
require(path.join(root, 'src/main.js'))
mock()
