// Run: npx electron test/smoke/import-ui.cjs — import from other clients, on a throwaway profile.
// Reads the clients really installed on this computer (read-only) and writes screenshots to CYBERDOG_SHOTS.
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-import-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const data = path.join(temp, 'profile', 'Cyberdog')
fs.mkdirSync(path.join(data, 'servers'), { recursive: true })
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 150) => { for (let i = 0; i < tries; i++) { if (await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `import-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof importSources !== 'undefined' && importSources.length > 0`, 'sources scanned')
    const sources = await js('importSources')
    console.log('sources', JSON.stringify(sources.map(s => [s.id, s.auto, s.total, s.fresh, s.locked, s.unsupported])))
    await pause(400); await shot('home')
    const cards = await js(`[...document.querySelectorAll('#empty .cards > button')].filter(b => !b.hidden).map(b => b.textContent)`)
    console.log('cards', JSON.stringify(cards))
    assert.equal(await js(`$('#card-export').hidden`), cards.length >= 5, 'export hidden when 4 other cards')
    // Import menu
    await js(`$('#btn-import').click()`); await pause(); await shot('menu')
    console.log('menu', JSON.stringify(await js(`[...document.querySelectorAll('#menu .mi-t')].map(x => x.textContent)`)))
    await js(`hideMenu()`)
    const auto = sources.filter(s => s.auto && s.total)
    for (const s of auto) {
      await js(`importPreview(${JSON.stringify(s.id)})`)
      await wait(`!!document.querySelector('.imp-card')`, 'summary ' + s.id)
      await pause(); await shot('summary-' + s.id)
      console.log(s.id, JSON.stringify(await js(`[...document.querySelectorAll('.imp-card .imp-note')].map(x => x.textContent)`)), await js(`document.querySelector('.imp-card button.primary').textContent`))
      // tick the "already imported" ones too: they are updated (FileZilla brings the password Cyberduck could not)
      await js(`document.querySelectorAll('.imp-card .config-item input').forEach(b => { if (!b.checked) b.click() })`)
      await js(`document.querySelector('.imp-card button.primary').click()`)
      await wait(`!document.querySelector('.imp-card')`, 'imported ' + s.id)
      console.log(' toast:', await js(`$('#toast').textContent`))
    }
    await wait(`importSources.filter(s => s.auto && s.total).every(s => s.fresh === 0)`, 'all imported')
    const list = await js('servers.map(s => ({ type: s.type || "ssh", hasPass: s.hasPass, group: s.group }))')
    console.log('servers', list.length, 'with password', list.filter(s => s.hasPass).length)
    // second pass: everything is "already imported", ticking one updates it instead of duplicating
    const first = auto[0]
    if (first) {
      await js(`importPreview(${JSON.stringify(first.id)})`)
      await wait(`!!document.querySelector('.imp-card')`, 'summary again')
      await pause(); await shot('summary-again')
      assert.equal(await js(`document.querySelector('.imp-card button.primary').disabled`), true, 'nothing ticked by default')
      await js(`document.querySelector('.imp-card .config-item input').click()`)
      await js(`document.querySelector('.imp-card button.primary').click()`)
      await wait(`!document.querySelector('.imp-card')`, 'updated')
      console.log(' toast:', await js(`$('#toast').textContent`))
      assert.equal(await js('servers.length'), list.length, 'update does not duplicate')
    }
    await pause(400); await shot('home-after')
    console.log('import ui ok')
    app.exit(0)
  } catch (e) { console.error(e); await new Promise(r => setTimeout(r, 200)); app.exit(1) }
}))
require(path.join(root, 'src/main.js'))
