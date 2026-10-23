// Génère build/icon.png (1024), build/icon.icns (macOS) et build/icon.ico (Windows) depuis src/assets/icon.svg. Usage : npm run icons (sur macOS : sips + iconutil)
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

app.dock?.hide()
app.whenReady().then(async () => {
  const dir = __dirname
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const svg = fs.readFileSync(path.join(dir, '../src/assets/icon.svg'), 'utf8')
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent"><div style="width:1024px;height:1024px">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</div></body>`))
  await new Promise(r => setTimeout(r, 500))
  const png = path.join(dir, 'icon.png')
  fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG())

  const set = path.join(dir, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', s, s, png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
    execFileSync('sips', ['-z', s * 2, s * 2, png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(dir, 'icon.icns')])
  fs.rmSync(set, { recursive: true, force: true })

  // .ico : en-tête + entrées + PNG embarqués (Windows ≥ Vista les accepte tels quels)
  const sizes = [256, 128, 64, 48, 32, 16]
  const pngs = sizes.map(sz => {
    const f = path.join(dir, `ico-${sz}.png`)
    execFileSync('sips', ['-z', sz, sz, png, '--out', f], { stdio: 'ignore' })
    const data = fs.readFileSync(f)
    fs.rmSync(f)
    return data
  })
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((sz, i) => {
    const o = 6 + 16 * i
    head[o] = sz === 256 ? 0 : sz
    head[o + 1] = sz === 256 ? 0 : sz
    head.writeUInt16LE(1, o + 4)
    head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(pngs[i].length, o + 8)
    head.writeUInt32LE(offset, o + 12)
    offset += pngs[i].length
  })
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([head, ...pngs]))
  app.quit()
})
