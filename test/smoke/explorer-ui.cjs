// Run: npx electron test/smoke/explorer-ui.cjs — real window, the explorer on a temporary local folder.
// Copy / cut / paste, conflict question, duplicate, drag to a folder, Move to…, filter, type to select, properties,
// recursive permissions, Tab between panes, new tab at a folder, transfer queue and settings.
// Screenshots go to $CYBERDOG_SHOTS (or the temp folder).
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-explorer-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile')); fs.mkdirSync(app.getPath('userData'), { recursive: true })
fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
const work = path.join(temp, 'work'), at = (...p) => path.join(work, ...p)
fs.mkdirSync(at('config'), { recursive: true }); fs.mkdirSync(at('sub'))
fs.writeFileSync(at('a.txt'), 'A'); fs.writeFileSync(at('b.txt'), 'BB'); fs.writeFileSync(at('app.log'), 'log'); fs.writeFileSync(at('.hidden'), 'h')
fs.writeFileSync(at('config', 'inner.txt'), 'x'.repeat(5000))
const remotePath = p => (process.platform === 'win32' ? '/' : '') + p.replace(/\\/g, '/')

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label) => { for (let i = 0; i < 80; i++) { if (typeof test === 'function' ? test() : await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    const shot = async name => fs.writeFileSync(path.join(shots, `explorer-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && !!document.querySelector('#servers')`, 'app ready')
    // every server tab of this test browses this computer
    await js(`window.ensure = async tab => { const T = tab.localPane ? tab : (tab.root || tab); if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.__t = {
        pane: () => tabs.find(t => t.id === activeId).active,
        names: () => __t.pane().view.map(x => x.name),
        key: (key, m = {}) => { const ex = __t.pane(); ex.table.tabIndex = -1; ex.table.focus(); ex.table.dispatchEvent(new KeyboardEvent('keydown', { key, code: m.code || '', metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, bubbles: true, cancelable: true })) },
        mod: key => __t.key(key, api.platform === 'darwin' ? { meta: true } : { ctrl: true }),
        select: name => { const ex = __t.pane(); ex.sel = new Set([name]); ex.last = ex.view.findIndex(x => x.name === name); paintSel(ex) },
        go: p => load(__t.pane(), p, true),
        row: name => __t.pane().rowEls.find(r => r.dataset.name === name),
      }; true`)
    const W = remotePath(work)
    await js(`void openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(W)} })`)
    await wait(`__t.pane()?.path === ${JSON.stringify(W)} && __t.names().includes('a.txt')`, 'listing')
    const go = async p => { await js(`__t.go(${JSON.stringify(p)})`); await wait(`__t.pane().path === ${JSON.stringify(p)} && !__t.pane().explorer.classList.contains('loading')`, 'go ' + p) }

    // copy, paste into another folder
    await js(`__t.select('a.txt'); __t.mod('c')`)
    assert.equal(await js(`fileClipboard.mode + ':' + fileClipboard.names.join()`), 'copy:a.txt')
    await go(W + '/sub')
    await js(`__t.mod('v')`)
    await wait(() => fs.existsSync(at('sub', 'a.txt')), 'pasted copy')
    await wait(`__t.names().includes('a.txt')`, 'pane refreshed after paste')
    // pasting again: the file exists -> question; keep both
    await js(`__t.mod('v')`)
    await wait(`!!document.querySelector('.conflict-overlay')`, 'conflict question')
    await shot('conflict')
    assert.equal(await js(`document.querySelectorAll('.conflict-card input[type=radio]').length`), 6)
    await js(`document.querySelector('.conflict-card input[value=rename]').click(); document.querySelector('.conflict-card button.primary').click()`)
    await wait(() => fs.existsSync(at('sub', 'a (1).txt')), 'kept both')
    assert.equal(fs.readFileSync(at('a.txt'), 'utf8'), 'A', 'the source is untouched')
    // cut, paste: a move (rename on the same server)
    await go(W)
    await js(`__t.select('b.txt'); __t.mod('x')`)
    await wait(`__t.row('b.txt').classList.contains('cut')`, 'cut row dimmed')
    await go(W + '/sub')
    await js(`__t.mod('v')`)
    await wait(() => fs.existsSync(at('sub', 'b.txt')) && !fs.existsSync(at('b.txt')), 'moved')
    // duplicate
    await wait(`__t.names().includes('b.txt')`, 'b listed')
    await js(`__t.select('b.txt'); __t.mod('d')`)
    await wait(() => fs.existsSync(at('sub', 'b (1).txt')), 'duplicated')

    // drag a file onto a folder row: moved into it
    await go(W)
    await js(`(() => { const dt = new DataTransfer(); __t.row('a.txt').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      __t.row('config').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      __t.row('config').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })) })()`)
    await wait(() => fs.existsSync(at('config', 'a.txt')) && !fs.existsSync(at('a.txt')), 'dragged into config')
    // Move to…
    await wait(`__t.names().includes('app.log')`, 'app.log listed')
    await js(`__t.select('app.log'); moveTo(__t.pane()); setTimeout(() => { const i = document.querySelector('#modal input'); i.value = 'sub'; i.form.requestSubmit() }, 100)`)
    await wait(() => fs.existsSync(at('sub', 'app.log')), 'moved to sub')

    // context menu
    await wait(`!!__t.row('config')`, 'config row')
    await js(`(() => { const r = __t.row('config').getBoundingClientRect(); __t.row('config').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 10 })) })()`)
    await wait(`!document.querySelector('#menu').hidden`, 'menu')
    const items = await js(`[...document.querySelectorAll('#menu > .mi .mi-t')].map(x => x.textContent)`)
    await shot('context-menu')
    for (const label of ['ctx.copy', 'ctx.cut', 'ctx.duplicate', 'ctx.move_to', 'ctx.copy_text', 'ctx.info', 'ctx.open_tab'])
      assert(items.includes(await js(`t(${JSON.stringify(label)})`)), 'menu has ' + label + ': ' + items.join(' | '))
    await js(`hideMenu()`)

    // type to select
    await js(`__t.key('c'); __t.key('o')`)
    assert.deepEqual(await js(`[...__t.pane().sel]`), ['config'])
    await js(`__t.key('s')`); await pause(950); await js(`__t.key('s')`)
    assert.deepEqual(await js(`[...__t.pane().sel]`), ['sub'])
    // properties
    await js(`__t.select('config'); __t.mod('i')`)
    await wait(`/5[\\s ,.]?00[0-9]/.test(document.querySelector('.info-card')?.textContent || '')`, 'folder size')
    await shot('properties')
    await js(`document.querySelector('.info-card button.primary').click()`)

    // filter
    await js(`__t.pane().filterBtn.click()`)
    await wait(`!__t.pane().filterBox.hidden`, 'filter box')
    await js(`(() => { const i = __t.pane().filterInput; i.value = 'sub, .*'; i.dispatchEvent(new Event('input')) })()`)
    await wait(`!__t.names().includes('sub') && !__t.names().includes('.hidden')`, 'filtered')
    assert(/1|2/.test(await js(`__t.pane().statusL.textContent`)))
    await shot('filter')
    assert.equal(await js(`__t.pane().filterBtn.classList.contains('on')`), true)
    await js(`setFilter({ enabled: false }); __t.pane().filterBox.hidden = true`)
    await wait(`__t.names().includes('sub')`, 'filter off')

    // breadcrumb: a folder per button, click to go up, Cmd/Ctrl+L or a click on the current folder to type a path
    await go(W + '/sub')
    const crumbs = await js(`[...__t.pane().crumbs.querySelectorAll('.crumb:not(.more)')].map(b => b.textContent)`)
    assert.deepEqual(crumbs.slice(-2), ['work', 'sub'])
    await js(`[...__t.pane().crumbs.querySelectorAll('.crumb')].find(b => b.textContent === 'work').click()`)
    await wait(`__t.pane().path === ${JSON.stringify(W)}`, 'crumb click')
    await js(`__t.mod('l')`)
    assert.equal(await js(`__t.pane().pathBox.classList.contains('editing') && document.activeElement === __t.pane().pathInput`), true)
    await js(`(() => { const i = __t.pane().pathInput; i.value = ${JSON.stringify(W + '/config')}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await wait(`__t.pane().path === ${JSON.stringify(W + '/config')} && !__t.pane().pathBox.classList.contains('editing')`, 'typed path')
    await js(`__t.pane().crumbs.querySelector('.crumb.current').click()`)
    assert.equal(await js(`__t.pane().pathBox.classList.contains('editing')`), true)
    await js(`__t.pane().pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    assert.equal(await js(`__t.pane().pathBox.classList.contains('editing')`), false)
    // drop a file on a crumb: moved to that folder
    await wait(`__t.names().includes('inner.txt')`, 'inner listed')
    await js(`(() => { const dt = new DataTransfer(); __t.row('inner.txt').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      const b = [...__t.pane().crumbs.querySelectorAll('.crumb')].find(b => b.textContent === 'work')
      b.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); b.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })) })()`)
    await wait(() => fs.existsSync(at('inner.txt')) && !fs.existsSync(at('config', 'inner.txt')), 'dropped on a crumb')
    fs.renameSync(at('inner.txt'), at('config', 'inner.txt'))
    await go(W)
    await shot('breadcrumb')

    // recursive permissions (Unix)
    if (process.platform !== 'win32') {
      await js(`(() => { const ex = __t.pane(); permissionDialog(ex, ex.view.find(x => x.name === 'config'), ${JSON.stringify(W + '/config')}) })()`)
      await wait(`!document.querySelector('.permission-card input[pattern]')?.disabled`, 'permissions ready')
      await js(`(() => { const c = document.querySelector('.permission-card'); const m = c.querySelector('input[pattern]'); m.value = '0700'; m.dispatchEvent(new Event('input'))
        const r = c.querySelector('.permission-recursive input'); r.click(); const s = c.querySelector('.permission-recursive select'); s.value = 'files' })()`)
      await shot('permissions')
      await js(`document.querySelector('.permission-card').requestSubmit()`)
      await wait(() => (fs.statSync(at('config', 'inner.txt')).mode & 0o777) === 0o700 && (fs.statSync(at('config')).mode & 0o777) === 0o700, 'recursive chmod')
    }

    // split view, Tab moves to the other pane
    await js(`toggleSplit(__t.pane())`)
    await wait(`tabs.find(t => t.id === activeId).panes.length === 2 && tabs.find(t => t.id === activeId).panes[1].path`, 'split')
    await js(`(() => { const tb = tabs.find(t => t.id === activeId); tb.active = tb.panes[0]; tb.panes[0].table.tabIndex = -1; tb.panes[0].table.focus(); tb.panes[0].table.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })()`)
    assert.equal(await js(`document.activeElement === tabs.find(t => t.id === activeId).panes[1].table`), true)
    // narrow panes: the first folders fold into "…"
    await go(W + '/config')
    await wait(`!__t.pane().crumbMore.hidden`, 'folded crumbs')
    await shot('breadcrumb-split')
    // transfer queue popover
    await js(`document.querySelectorAll('.transfer-widget').forEach(w => w.classList.add('expanded'))`)
    await pause(200)
    assert(await js(`[...document.querySelectorAll('.transfer-tabs .chip')].length >= 3`), 'queue tabs')
    await shot('transfers')
    await js(`document.querySelectorAll('.transfer-widget').forEach(w => w.classList.remove('expanded'))`)

    // a second click on the name of the selected file renames it; a double-click does not
    fs.writeFileSync(at('rename-me.txt'), 'r')
    await js(`(() => { const tb = tabs.find(t => t.id === activeId); tb.active = tb.panes[0] })()`)
    await go(W)
    await wait(`!!__t.row('rename-me.txt')`, 'rename-me listed')
    const clickName = detail => js(`(() => { const n = __t.row('rename-me.txt').querySelector('.nt'); n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); n.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: ${detail} })) })()`)
    await clickName(1)                      // selects it
    await pause(700)
    assert.equal(await js(`document.querySelector('#modal').hidden`), true, 'the first click only selects')
    await clickName(1); await clickName(2); await js(`__t.row('rename-me.txt').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await pause(800)
    assert.equal(await js(`document.querySelector('#modal').hidden`), true, 'a double-click does not rename')
    await clickName(1)
    await wait(`!document.querySelector('#modal').hidden && document.querySelector('#modal input').value === 'rename-me.txt'`, 'rename dialog')
    assert.equal(await js(`(() => { const i = document.querySelector('#modal input'); return i.selectionStart + ':' + i.selectionEnd })()`), '0:9', 'name selected without the extension')
    await js(`(() => { const i = document.querySelector('#modal input'); i.value = 'renamed.txt'; i.form.requestSubmit() })()`)
    await wait(() => fs.existsSync(at('renamed.txt')) && !fs.existsSync(at('rename-me.txt')), 'renamed')

    // a new tab at a folder
    const before = await js(`tabs.length`)
    await js(`void openFiles(tabs.find(t => t.id === activeId).server, { path: ${JSON.stringify(W + '/sub')} })`)
    await wait(`tabs.length === ${before + 1} && __t.pane().path === ${JSON.stringify(W + '/sub')}`, 'new tab')

    // settings: simultaneous transfers
    await js(`openSettingsModal()`)
    await wait(`!!document.querySelector('.inline-setting select')`, 'settings')
    await js(`document.querySelector('.inline-setting select').value = '4'; document.querySelector('.settings-save').click()`)
    await wait(() => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).maxTransfers === 4, 'max transfers saved')
    console.log('Explorer UI passed: copy/paste, conflict, cut/move, duplicate, drag into folder, move to, context menu, type to select, properties, filter, breadcrumb, recursive permissions, Tab, queue, click to rename, new tab, settings.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'explorer-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 90000).unref()
require(path.join(root, 'src/main.js'))
