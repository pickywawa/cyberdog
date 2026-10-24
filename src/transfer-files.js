const fs = require('fs')
const path = require('path')
const posix = path.posix
const { pipeline } = require('stream/promises')
const P = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (e, value) => e ? reject(e) : resolve(value)))
module.exports = transfers => {
// Build a complete plan before writing; byte counts include nested directories.
async function transferPlan(s, direction, source, target, job, plan = [], ancestors = new Set()) {
  transfers.check(job)
  const st = direction === 'upload' ? await fs.promises.stat(source) : await P(s, 'stat', source)
  if (st.isDirectory()) {
    const canonical = direction === 'upload' ? await fs.promises.realpath(source) : await P(s, 'realpath', source)
    if (ancestors.has(canonical)) throw new Error('Directory symlink cycle: ' + source)
    const nextAncestors = new Set([...ancestors, canonical])
    plan.push({ source, target, directory: true })
    const names = direction === 'upload' ? await fs.promises.readdir(source) : (await P(s, 'readdir', source)).map(e => e.filename).filter(n => n !== '.' && n !== '..')
    for (const name of names) await transferPlan(s, direction, (direction === 'upload' ? path : posix).join(source, name), (direction === 'upload' ? posix : path).join(target, name), job, plan, nextAncestors)
  } else { plan.push({ source, target, size: st.size }); job.total += st.size }
  return plan
}
async function executeTransfer(s, direction, sources, targetFor, job) {
  const plan = []
  for (const source of sources) await transferPlan(s, direction, source, targetFor(source), job, plan)
  job.scanned = true; transfers.emit(job, true)
  for (const item of plan) {
    transfers.check(job)
    if (item.directory) {
      if (direction === 'upload') { try { await P(s, 'mkdir', item.target) } catch (e) { if (!(await P(s, 'stat', item.target)).isDirectory()) throw e } }
      else await fs.promises.mkdir(item.target, { recursive: true })
      continue
    }
    job.name = (direction === 'upload' ? path : posix).basename(item.source)
    const reader = direction === 'upload' ? fs.createReadStream(item.source) : s.createReadStream(item.source)
    const writer = direction === 'upload' ? s.createWriteStream(item.target) : fs.createWriteStream(item.target)
    job.stream = writer
    reader.on('data', chunk => { job.done += chunk.length; transfers.emit(job) })
    try { await pipeline(reader, writer) } finally { job.stream = null }
  }
}
return { executeTransfer }
}
