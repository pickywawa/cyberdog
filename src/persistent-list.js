const fs = require('fs')
const path = require('path')
const parse = file => { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(value)) throw new Error('Invalid saved list: ' + file); return value }
function readList(file) {
  try { return parse(file) } catch (error) {
    try { return parse(file + '.bak') } catch (backupError) {
      if (error.code === 'ENOENT' && backupError.code === 'ENOENT') return []
      if (error.code === 'ENOENT') throw backupError
    }
    throw error // never replace unreadable data with an empty list on the next save
  }
}
function writeList(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.tmp'
  try {
    try { parse(file); fs.copyFileSync(file, file + '.bak') } catch {}
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak')
  } finally { if (fs.existsSync(temp)) fs.rmSync(temp) }
}
module.exports = { readList, writeList }
