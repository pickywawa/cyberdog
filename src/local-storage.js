// Local file system (or a mounted folder) behind the same backend interface as the remote protocols.
// Used for the local pane, and for SMB shares, which the operating system mounts for us.
// Paths are POSIX-style ('/a/b'); on Windows '/' lists the drives and '/C:/Users' maps to 'C:\Users'.
const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream/promises')
const posix = path.posix

const notFound = p => Object.assign(new Error('No such file: ' + p), { code: 'ENOENT', status: 404 })
const wrap = (e, p) => e.code === 'ENOENT' ? notFound(p) : e

// opts: { root } folder the backend is confined to (default: the whole file system), { platform } (tests),
// { appleDouble } hide and clean up the "._name" companions macOS writes next to files on network shares
function local({ root, platform = process.platform, appleDouble = false } = {}) {
  const win = platform === 'win32'
  const nativePath = p => {
    const clean = posix.resolve('/', p)
    if (root) return path.join(root, ...clean.split('/').filter(Boolean))
    if (!win) return clean
    const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(clean)
    if (!m) throw notFound(p)
    return path.win32.normalize(m[1] + (m[2] || '/'))
  }
  const entry = (name, st) => ({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, ...(win ? {} : { mode: st.mode & 0o7777, user: String(st.uid), group: String(st.gid) }) })
  const drives = () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => fs.existsSync(`${l}:\\`)).map(l => ({ name: l + ':', dir: true, size: 0, mtime: 0 }))
  const statOf = async file => fs.promises.stat(file).catch(() => fs.promises.lstat(file)) // broken symlinks stay listable
  return {
    ping: () => fs.promises.stat(root || (win ? process.env.SystemDrive + '\\' : '/')).then(() => {}),
    async stat(p) {
      if (win && !root && posix.resolve('/', p) === '/') return { dir: true }
      try { const st = await fs.promises.stat(nativePath(p)); return { ...entry('', st), name: undefined } } catch (e) { throw wrap(e, p) }
    },
    async list(p) {
      if (win && !root && posix.resolve('/', p) === '/') return drives()
      const dir = nativePath(p)
      let names
      try { names = await fs.promises.readdir(dir) } catch (e) { throw wrap(e, p) }
      const out = []
      for (let i = 0; i < names.length; i += 64) {
        out.push(...await Promise.all(names.slice(i, i + 64).map(async name => {
          try { return entry(name, await statOf(path.join(dir, name))) } catch { return null } // vanished or unreadable entries are skipped
        })))
      }
      return out.filter(e => e && !(appleDouble && e.name.startsWith('._') && names.includes(e.name.slice(2))))
    },
    mkdir: p => fs.promises.mkdir(nativePath(p)),
    async remove(p, dir) {
      const file = nativePath(p)
      try { await (dir ? fs.promises.rmdir(file) : fs.promises.unlink(file)) } catch (e) { throw wrap(e, p) }
      if (appleDouble) await fs.promises.unlink(path.join(path.dirname(file), '._' + path.basename(file))).catch(() => {})
    },
    async move(a, b) {
      try { await fs.promises.rename(nativePath(a), nativePath(b)) } catch (e) {
        if (e.code !== 'EXDEV') throw wrap(e, a)
        await fs.promises.cp(nativePath(a), nativePath(b), { recursive: true, errorOnExist: true, force: false }) // another volume
        await fs.promises.rm(nativePath(a), { recursive: true })
      }
    },
    put: (p, body) => fs.promises.writeFile(nativePath(p), Buffer.from(body)),
    putFile: (p, file) => fs.promises.copyFile(file, nativePath(p)),
    // start: byte offset (resume); the stream reports a missing file through its 'error' event
    async get(p, start = 0) {
      const file = nativePath(p)
      const st = await fs.promises.stat(file).catch(e => { throw wrap(e, p) })
      if (st.isDirectory()) throw Object.assign(new Error('Is a directory: ' + p), { code: 'EISDIR' })
      return fs.createReadStream(file, { start })
    },
    // offset > 0 continues an interrupted upload: the file is kept and written from that position
    putStream: (p, stream, offset = 0) => pipeline(stream, fs.createWriteStream(nativePath(p), offset ? { flags: 'r+', start: offset } : {})),
    resumableWrite: true,
    chmod: (p, mode) => fs.promises.chmod(nativePath(p), mode),
    nativePath,
  }
}

module.exports = { local }
