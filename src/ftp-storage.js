// FTP / FTPS backend for object-storage's SFTP facade. A small pool of control connections lets a
// listing run while a transfer is in progress (an FTP connection handles one command at a time).
const { Client } = require('basic-ftp')
const { PassThrough, Readable } = require('stream')
const posix = require('path').posix

const MAX_CONNECTIONS = 3

const notFound = p => Object.assign(new Error('No such file: ' + p), { code: 'ENOENT', status: 404 })
function ftpError(e) {
  if ([530, 331, 332, 532].includes(e.code)) return Object.assign(new Error('Authentication failure'), { code: 'EACCES' })
  if (e.code === 550) return Object.assign(new Error(e.message.replace(/^\d+\s*/, '') || 'No such file'), { code: 'ENOENT', status: 404 })
  return e
}

// cfg: { host, port, security: 'none' | 'explicit' | 'implicit', insecureTls }, creds: { user, secret }
function ftp(cfg, creds) {
  const idle = [], waiting = []
  let total = 0, closed = false

  async function connect() {
    const c = new Client(30000)
    try {
      await c.access({
        host: cfg.host, port: cfg.port, user: creds.user, password: creds.secret,
        secure: cfg.security === 'implicit' ? 'implicit' : cfg.security !== 'none',
        secureOptions: { host: cfg.host, rejectUnauthorized: !cfg.insecureTls },
      })
    } catch (e) { c.close(); throw e }
    return c
  }
  async function acquire() {
    if (closed) throw new Error('Connection closed')
    while (idle.length) {
      const c = idle.pop()
      if (!c.closed) return c
      total--
    }
    if (total < MAX_CONNECTIONS) {
      total++
      try { return await connect() } catch (e) { total--; throw ftpError(e) }
    }
    return new Promise(ok => waiting.push(ok))
  }
  function release(c) {
    if (c.closed || closed) { total--; c.close(); if (waiting.length) acquire().then(waiting.shift(), () => {}); return }
    if (waiting.length) waiting.shift()(c)
    else idle.push(c)
  }
  // Runs fn on a free connection; one retry when a pooled connection had silently timed out.
  async function use(fn) {
    for (let attempt = 0; ; attempt++) {
      const c = await acquire()
      try { return await fn(c) } catch (e) {
        if (attempt === 0 && c.closed && !closed) continue
        throw ftpError(e)
      } finally { release(c) }
    }
  }

  const split = p => ({ dir: posix.dirname(p), name: posix.basename(p) })
  const entry = f => ({ name: f.name, dir: f.isDirectory || f.isSymbolicLink, size: f.size, mtime: f.modifiedAt ? +f.modifiedAt : 0 })
  const abs = c => p => c.protectWhitespace(p)

  const be = {
    ping: () => use(c => c.pwd()).then(() => {}),
    async stat(p) {
      if (p === '/') return { dir: true }
      const { dir, name } = split(p)
      const e = (await be.list(dir)).find(x => x.name === name)
      if (!e) throw notFound(p)
      return e
    },
    list: p => use(async c => (await c.list(await abs(c)(p))).filter(f => f.name !== '.' && f.name !== '..').map(entry)),
    mkdir: p => use(async c => void await c.send('MKD ' + await abs(c)(p))),
    remove: (p, dir) => use(async c => void await (dir ? c.removeEmptyDir(await abs(c)(p)) : c.remove(await abs(c)(p)))),
    move: (a, b) => use(async c => void await c.rename(await abs(c)(a), await abs(c)(b))),
    put: (p, body) => use(async c => void await c.uploadFrom(Readable.from([Buffer.from(body)]), await abs(c)(p))),
    putFile: (p, file) => use(async c => void await c.uploadFrom(file, await abs(c)(p))),
    // Streams the download through a pass-through; the connection is held until the transfer ends or is destroyed.
    async get(p) {
      const out = new PassThrough()
      const first = new Promise((ok, ko) => {
        use(async c => {
          const path = await abs(c)(p)
          await c.size(path) // fails early (550) when the file is missing, before any data flows
          ok(out)
          await c.downloadTo(out, path)
        }).then(() => out.end(), e => { if (out.writable) out.destroy(e); ko(e) })
      })
      return first
    },
    close() {
      closed = true
      for (const c of idle.splice(0)) c.close()
    },
  }
  return be
}

module.exports = { ftp }
