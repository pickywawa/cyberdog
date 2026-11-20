// Run: npx electron test/smoke/editor-ui.cjs — the built-in editor in a real window, on a temporary local folder.
// Monaco loads, files open by double-click in tabs, saving keeps each file's encoding and line endings, a file changed
// meanwhile is not overwritten silently, Cmd/Ctrl+W closes a file, unsaved changes are asked about, the old
// "system default" setting moves to the internal editor. Screenshots go to $CYBERDOG_SHOTS (or the temp folder).
const { app } = require('electron'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-editor-ui-'))
const shots = process.env.CYBERDOG_SHOTS || temp
app.setPath('appData', path.join(temp, 'profile'))
const settingsFile = path.join(temp, 'profile', 'Cyberdog', 'settings.json') // the app keeps its data in <appData>/Cyberdog
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ lang: process.env.CYBERDOG_LANG || 'fr', theme: 'dracula', defaultEditor: 'system' }))
app.on('quit', () => fs.rmSync(temp, { recursive: true, force: true }))
const work = path.join(temp, 'work'), at = (...p) => path.join(work, ...p)
fs.mkdirSync(work)
const files = {
  'app.js': Buffer.from('// hello\nconst answer = 42\nconsole.log(answer)\n'),
  'latin1.conf': Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(' \x80\r\nkey=valeur\r\n')]),
  'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ünïcode ✓\r\n', 'utf16le')]),
  'bom.yml': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name: été\n')]),
  'image.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]),
}
for (let i = 1; i <= 4; i++) files[`a-rather-long-configuration-file-name-${i}.yml`] = Buffer.from(`key${i}: value\n`)
for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(at(name), bytes)
const remotePath = p => (process.platform === 'win32' ? '/' : '') + p.replace(/\\/g, '/')

app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
  try {
    const js = code => win.webContents.executeJavaScript(code), pause = (ms = 250) => new Promise(r => setTimeout(r, ms))
    const wait = async (test, label, tries = 100) => { for (let i = 0; i < tries; i++) { if (typeof test === 'function' ? test() : await js(test)) return; await pause(100) } throw Error('timeout: ' + label) }
    // real key presses (trusted events, as typed by a person)
    const press = (key, mods = [process.platform === 'darwin' ? 'meta' : 'control']) => { win.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods }) }
    const shot = async name => fs.writeFileSync(path.join(shots, `editor-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await wait(`typeof openFiles === 'function' && typeof openInEditor === 'function'`, 'app ready')
    assert.equal(await js(`settings.defaultEditor`), 'internal', 'the old "system default" choice moved to the internal editor')
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).editorMigrated, true)
    await js(`window.ensure = async tab => { const T = tab.localPane ? tab : (tab.root || tab); if (T.connId) return; const r = await api.invoke('files:openLocal'); T.connId = r.id; T.home = r.home }
      window.__t = {
        tab: () => tabs.find(t => t.id === activeId), pane: () => __t.tab().active, E: () => __t.tab().editor,
        row: name => __t.pane().rowEls.find(r => r.dataset.name === name),
        open: name => __t.row(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
        key: (key, m = {}) => { const ta = document.activeElement; ta.dispatchEvent(new KeyboardEvent('keydown', { key, code: m.code || '', metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, bubbles: true, cancelable: true })) },
        mod: (key, code) => __t.key(key, { code, ...(api.platform === 'darwin' ? { meta: true } : { ctrl: true }) }),
      }; true`)
    const W = remotePath(work)
    await js(`openFiles({ id: 'smoke', type: 'local', name: 'Smoke', host: 'localhost' }, { path: ${JSON.stringify(W)} })`)
    await wait(`!!__t.pane()?.rowEls?.length && !!__t.row('app.js')`, 'listing')
    assert.equal(await js(`!!__t.tab().bar.editor && __t.tab().rightBar.contains(__t.tab().bar.editor)`), false, 'no editor button before a file is open')

    // double-click opens the internal editor
    await js(`__t.open('app.js')`)
    await wait(`!!window.monaco && __t.E()?.files.length === 1 && __t.tab().panel === 'editor'`, 'editor open', 200)
    assert.equal(await js(`__t.E().active.model.getLanguageId()`), 'javascript')
    assert.equal(await js(`__t.tab().rightBar.contains(__t.tab().bar.editor)`), true, 'editor button shown')
    assert(await js(`__t.tab().rpanel.offsetWidth`) >= 500, 'the editor panel is wide'); assert(await js(`__t.pane().explorer.offsetWidth`) >= 400, 'the explorer keeps room')
    assert(await js(`document.querySelectorAll('.editor-panel .view-line .mtk1, .editor-panel .view-line span span').length`) > 0, 'text is rendered')
    await pause(400)
    await shot('open')

    // edit and save with Cmd/Ctrl+S
    await js(`(() => { const ed = __t.E().instance; ed.focus(); ed.setPosition({ lineNumber: 2, column: 1 }); ed.trigger('test', 'type', { text: '// edited\\n' }) })()`)
    await wait(`document.querySelector('.ed-tab.active')?.classList.contains('dirty')`, 'dirty mark')
    await js(`__t.E().instance.focus()`); press('S')
    await wait(() => fs.readFileSync(at('app.js'), 'utf8').includes('// edited\nconst answer'), 'saved with Cmd/Ctrl+S')
    await wait(`!document.querySelector('.ed-tab.active').classList.contains('dirty')`, 'clean after save')

    // other encodings: opening and saving without edits gives the same bytes; an edit keeps the encoding
    for (const name of ['latin1.conf', 'utf16.txt', 'bom.yml']) {
      await js(`__t.open(${JSON.stringify(name)})`)
      await wait(`__t.E().active?.name === ${JSON.stringify(name)}`, 'open ' + name)
      await js(`saveEditorFile(__t.tab(), __t.E().active, true)`)
      await pause(300)
      assert.deepEqual(fs.readFileSync(at(name)).toString('hex'), files[name].toString('hex'), name + ' untouched by a save: ' + JSON.stringify(await js(`({ enc: __t.E().active.encoding, text: __t.E().active.model.getValue(), eol: __t.E().active.model.getEOL() })`)))
    }
    assert.equal(await js(`__t.E().files.length`), 4, 'one tab per file')
    assert.equal(await js(`document.querySelectorAll('.ed-tab').length`), 4)

    // header buttons: minimap (on by default) and line wrapping
    const option = name => js(`(() => { const o = __t.E().instance.getOption(monaco.editor.EditorOption.${name}); return typeof o === 'object' ? o.enabled : o })()`)
    assert.equal(await option('minimap'), true, 'minimap shown by default')
    assert.equal(await js(`document.querySelector('.js-ed-minimap').classList.contains('on')`), true)
    await js(`document.querySelector('.js-ed-wrap').click()`)
    await wait(async () => (await option('wordWrap')) === 'on', 'wrap on')
    await js(`document.querySelector('.js-ed-minimap').click()`)
    await wait(async () => (await option('minimap')) === false, 'minimap off')
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).editorWrap, true, 'remembered')
    await js(`document.querySelector('.js-ed-minimap').click()`)

    // more tabs than the bar can hold: a list of the files at the end, no horizontal scrollbar
    for (let i = 1; i <= 4; i++) {
      await js(`__t.open('a-rather-long-configuration-file-name-${i}.yml')`)
      await wait(`__t.E().files.length === ${4 + i}`, 'open long ' + i)
    }
    await wait(`!__t.E().more.hidden`, 'file list button')
    assert.equal(await js(`__t.E().tabs.scrollWidth <= __t.E().tabs.clientWidth`), true, 'no overflow')
    assert.equal(await js(`!document.querySelector('.ed-tab.active').hidden`), true, 'the current file stays visible')
    const hiddenName = await js(`(() => { const el = [...document.querySelectorAll('.ed-tab')].find(el => el.hidden); return __t.E().files.find(f => f.id === el.dataset.id).name })()`)
    await js(`__t.E().more.click()`)
    await wait(`!document.querySelector('#menu').hidden`, 'file list')
    assert.equal(await js(`document.querySelectorAll('#menu .mi').length`), 8)
    await shot('tabs-list')
    await js(`[...document.querySelectorAll('#menu .mi')].find(m => m.textContent.startsWith(${JSON.stringify(hiddenName)})).click()`)
    await wait(`__t.E().active.name === ${JSON.stringify(hiddenName)} && !document.querySelector('.ed-tab.active').hidden`, 'picked from the list')

    // split: the same file on both sides, then a tab click changes the focused side only
    await js(`document.querySelector('.js-ed-split').click()`)
    await wait(`__t.E().views.length === 2 && document.querySelectorAll('.ed-split .ed-host').length === 2`, 'split')
    assert.equal(await js(`__t.E().views[0].file === __t.E().views[1].file && __t.E().current === 1`), true)
    await js(`showEditorFile(__t.tab(), __t.E().files.find(f => f.name === 'bom.yml'))`)
    assert.deepEqual(await js(`__t.E().views.map(v => v.file.name)`), [hiddenName, 'bom.yml'])
    await pause(400)
    await shot('split')
    await js(`document.querySelector('.js-ed-split').click()`)
    await wait(`__t.E().views.length === 1 && document.querySelectorAll('.ed-split .ed-host').length === 1`, 'unsplit')
    for (let i = 1; i <= 4; i++) await js(`closeEditorFile(__t.tab(), __t.E().files.find(f => f.name === 'a-rather-long-configuration-file-name-${i}.yml'))`)
    await wait(`__t.E().files.length === 4`, 'long files closed')
    await js(`showEditorFile(__t.tab(), __t.E().files.find(f => f.name === 'latin1.conf'))`)
    assert.equal(await js(`document.querySelector('.ed-status').textContent.includes('Windows-1252') && document.querySelector('.ed-status').textContent.includes('CRLF')`), true)
    await js(`(() => { const m = __t.E().active.model; m.pushEditOperations([], [{ range: new monaco.Range(2, 1, 2, 4), text: 'clé' }], () => null) })()`)
    await js(`saveEditorFile(__t.tab(), __t.E().active)`)
    await wait(() => fs.readFileSync(at('latin1.conf')).includes(Buffer.from([0x63, 0x6c, 0xe9, 0x3d])), 'edit written in Windows-1252')
    assert(fs.readFileSync(at('latin1.conf')).includes(Buffer.from([0x80, 0x0d, 0x0a])), 'CRLF and other bytes kept')
    // a character Windows-1252 does not have: the save stops, the file is unchanged
    const before = fs.readFileSync(at('latin1.conf'))
    await js(`(() => { const m = __t.E().active.model; m.pushStackElement(); m.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '漢' }], () => null); m.pushStackElement() })()`)
    await js(`saveEditorFile(__t.tab(), __t.E().active)`)
    await wait(`/漢/.test(document.querySelector('#toast').textContent)`, 'unencodable message')
    assert.deepEqual(fs.readFileSync(at('latin1.conf')), before)
    await js(`__t.E().active.model.undo()`)
    assert.equal(await js(`isDirty(__t.E().active)`), false, 'undo back to the saved text: not modified')

    // binary: not opened in the editor
    await js(`window.__external = []; window.openExternally = (ex, p) => { __external.push(p) }; __t.open('image.bin')`)
    await wait(`__external.length === 1`, 'binary goes outside')
    assert.equal(await js(`__t.E().files.length`), 4)

    // changed on the server meanwhile: asked before overwriting
    await js(`showEditorFile(__t.tab(), __t.E().files.find(f => f.name === 'app.js'))`)
    const later = new Date(Date.now() + 120000)
    fs.writeFileSync(at('app.js'), 'changed elsewhere\n'); fs.utimesSync(at('app.js'), later, later)
    await js(`__t.E().instance.trigger('test', 'type', { text: 'x' }); saveEditorFile(__t.tab(), __t.E().active); true`) // answered below
    await wait(`!!document.querySelector('.choice-card')`, 'conflict question')
    await shot('conflict')
    await js(`[...document.querySelectorAll('.choice-card button')][1].click()`) // reload from the server
    await wait(`__t.E().active.model.getValue() === 'changed elsewhere\\n'`, 'reloaded')
    assert.equal(fs.readFileSync(at('app.js'), 'utf8'), 'changed elsewhere\n')

    // Cmd/Ctrl+W closes the file (asks when it has unsaved changes)
    await js(`__t.E().instance.trigger('test', 'type', { text: 'y' }); __t.E().instance.focus()`); press('W')
    await wait(`!!document.querySelector('.choice-card')`, 'unsaved question')
    await js(`[...document.querySelectorAll('.choice-card button')][1].click()`) // don't save
    await wait(`__t.E().files.length === 3`, 'closed')
    assert.equal(fs.readFileSync(at('app.js'), 'utf8'), 'changed elsewhere\n')
    assert.equal(await js(`tabs.length`), 1, 'the server tab is still open')
    // the editor button goes away with the last file
    await js(`for (const f of [...__t.E().files]) closeEditorFile(__t.tab(), f)`)
    await wait(`__t.E().files.length === 0`, 'all closed')
    assert.equal(await js(`__t.tab().rightBar.contains(__t.tab().bar.editor) || __t.tab().panel === 'editor'`), false)

    // an external application chosen in Settings is used instead
    await js(`settings.defaultEditor = 'system'; window.__external = []; window.act = (ex, fn) => { __external.push('act'); }; __t.open('bom.yml')`)
    await wait(`__external.length === 1`, 'external editor')
    assert.equal(await js(`__t.E().files.length`), 0)
    console.log('Editor UI passed: Monaco, double-click, tabs, Cmd/Ctrl+S, encodings kept (UTF-8, BOM, UTF-16, Windows-1252), unencodable stop, binary outside, conflict, Cmd/Ctrl+W, editor button, settings migration.')
    app.exit(0)
  } catch (e) { console.error(e); await win.webContents.capturePage().then(i => fs.writeFileSync(path.join(shots, 'editor-failure.png'), i.toPNG())).catch(() => {}); app.exit(1) }
}))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref()
require(path.join(root, 'src/main.js'))
