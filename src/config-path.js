const fs = require('fs')
const path = require('path')

const CONFIG_DIRS = ['servers', 'actions']
const CONFIG_FILES = ['groups.json', 'paths.json', 'paths.json.bak', 'log-favorites.json']

function hasCyberdogConfig(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  if (CONFIG_FILES.some(name => fs.existsSync(path.join(dir, name)))) return true
  return CONFIG_DIRS.some(name => {
    const target = path.join(dir, name)
    return fs.existsSync(target) && fs.readdirSync(target).some(file => file.endsWith('.json'))
  })
}

function copyCyberdogConfig(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const name of [...CONFIG_DIRS, ...CONFIG_FILES]) {
    const source = path.join(sourceDir, name)
    if (!fs.existsSync(source)) continue
    const target = path.join(targetDir, name)
    if (fs.statSync(source).isDirectory()) fs.cpSync(source, target, { recursive: true, force: true })
    else fs.copyFileSync(source, target)
  }
}

function initializeUserData(app) {
  const dir = path.join(app.getPath('appData'), 'Cyberdog')
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  return dir
}

module.exports = { hasCyberdogConfig, copyCyberdogConfig, initializeUserData }
