const fs = require('fs')
const path = require('path')
const posix = path.posix
const { pipeline } = require('stream/promises')
const P = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (e, value) => e ? reject(e) : resolve(value)))

// A side is one end of a copy: the local disk (OS paths) or an SFTP-like session (SFTP, FTP, S3, ... or the local pane).
// canRead / canWrite tell whether a transfer can continue in the middle of a file on that end.
const diskSide = {
  join: path.join, name: path.basename, canRead: true, canWrite: true,
  stat: async p => { const st = await fs.promises.stat(p); return { isDirectory: st.isDirectory(), size: st.size } },
  real: p => fs.promises.realpath(p),
  list: p => fs.promises.readdir(p),
  mkdir: p => fs.promises.mkdir(p, { recursive: true }),
  size: p => fs.promises.stat(p).then(st => st.size, () => null),
  read: (p, start) => fs.createReadStream(p, start ? { start } : {}),
  write: (p, start) => fs.createWriteStream(p, start ? { flags: 'r+', start } : {}),
}
const sftpSide = s => ({
  join: posix.join, name: posix.basename,
  canRead: s.canResume?.read ?? true, canWrite: s.canResume?.write ?? true,
  stat: async p => { const st = await P(s, 'stat', p); return { isDirectory: st.isDirectory(), size: st.size } },
  real: p => P(s, 'realpath', p),
  list: async p => (await P(s, 'readdir', p)).map(e => e.filename).filter(n => n !== '.' && n !== '..'),
  mkdir: p => P(s, 'mkdir', p).catch(async e => { if (!(await P(s, 'stat', p)).isDirectory()) throw e }), // already there is fine
  size: p => P(s, 'stat', p).then(st => st.size, () => null),
  read: (p, start) => s.createReadStream(p, start ? { start } : {}),
  write: (p, start) => s.createWriteStream(p, start ? { flags: 'r+', start } : {}),
})

// transfers: the job registry; resolve(ref, job) gives the session for an endpoint ({ serverId, connId } -> sftp, { disk: true } -> null),
// reconnecting when the connection of an interrupted job is gone.
module.exports = (transfers, resolve) => {
  const sideOf = async (ref, job) => { const s = await resolve(ref, job); return s ? sftpSide(s) : diskSide }

  // Build the complete plan before writing; byte counts include nested directories.
  async function plan(src, dst, source, target, job, out, ancestors = new Set()) {
    transfers.check(job)
    const st = await src.stat(source)
    if (st.isDirectory) {
      const canonical = await src.real(source)
      if (ancestors.has(canonical)) throw new Error('Directory symlink cycle: ' + source)
      const next = new Set([...ancestors, canonical])
      out.push({ source, target, directory: true })
      for (const name of await src.list(source)) await plan(src, dst, src.join(source, name), dst.join(target, name), job, out, next)
    } else { out.push({ source, target, size: st.size }); job.total += st.size }
  }

  // Run (or, when resuming, continue) a job. Finished items are skipped; the item that was in flight continues at the size
  // already written when both ends can seek, if the source did not change; otherwise it is copied again from the start.
  async function runJob(job, resuming) {
    const src = await sideOf(job.refs.src, job), dst = await sideOf(job.refs.dst, job)
    if (!job.plan) {
      job.plan = []; job.total = 0
      for (const t of job.top) await plan(src, dst, t.source, t.target, job, job.plan)
      job.scanned = true; transfers.emit(job, true)
    }
    const finished = () => job.plan.reduce((n, i) => n + (i.done && !i.directory ? i.size : 0), 0)
    for (const item of job.plan) {
      if (item.done) continue
      transfers.check(job)
      if (item.directory) { await dst.mkdir(item.target); item.done = true; continue }
      let offset = 0
      if (resuming && item.started) {
        const have = await dst.size(item.target), now = await src.size(item.source)
        if (now === item.size && have === item.size) { item.done = true; continue } // it had completed just before the interruption
        if (now === item.size && have > 0 && have < item.size && src.canRead && dst.canWrite) offset = have
      }
      item.started = true
      job.name = src.name(item.source)
      job.done = finished() + offset
      const reader = src.read(item.source, offset), writer = dst.write(item.target, offset)
      job.stream = writer
      reader.on('data', chunk => { job.done += chunk.length; transfers.emit(job) })
      try { await pipeline(reader, writer) } finally { job.stream = null }
      item.done = true
    }
  }

  return { runJob, sftpSide, diskSide }
}
