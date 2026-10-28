// Local backend (local pane and mounted SMB shares) and the SMB mount commands.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { local } = require('../src/local-storage')
const { smb, mountUrl } = require('../src/smb-storage')
const { sftpOver } = require('../src/object-storage')

const call = (s, m, ...a) => new Promise((ok, ko) => s[m](...a, (e, v) => e ? ko(e) : ok(v)))
const text = async stream => { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c).toString() }

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-local-'))
  try {
    const be = local({ root })
    const s = sftpOver(be)
    await be.ping()
    await call(s, 'mkdir', '/d')
    await call(s, 'writeFile', '/d/a b.txt', 'hello')
    assert.deepStrictEqual((await call(s, 'readdir', '/d')).map(e => e.filename), ['a b.txt'])
    assert.strictEqual((await call(s, 'stat', '/d/a b.txt')).size, 5)
    assert.strictEqual((await call(s, 'stat', '/d')).isDirectory(), true)
    assert(fs.existsSync(path.join(root, 'd', 'a b.txt')), 'confined to its root')
    await assert.rejects(call(s, 'stat', '/nope'), /No such file/)
    await assert.rejects(call(s, 'stat', '/../../etc/passwd'), /No such file/, 'cannot escape the root')
    // resume: reads from an offset, writes from an offset
    assert.strictEqual(await text(s.createReadStream('/d/a b.txt')), 'hello')
    assert.strictEqual(await text(await be.get('/d/a b.txt', 2)), 'llo')
    await be.putStream('/d/a b.txt', require('stream').Readable.from(['LO!']), 3)
    assert.strictEqual(fs.readFileSync(path.join(root, 'd', 'a b.txt'), 'utf8'), 'helLO!')
    await new Promise((ok, ko) => { const w = s.createWriteStream('/d/w.txt'); w.on('finish', ok).on('error', ko); w.end('streamed') })
    assert.strictEqual(fs.readFileSync(path.join(root, 'd', 'w.txt'), 'utf8'), 'streamed')
    if (process.platform !== 'win32') {
      await call(s, 'chmod', '/d/w.txt', 0o600)
      assert.strictEqual((await call(s, 'readdir', '/d')).find(e => e.filename === 'w.txt').attrs.mode & 0o777, 0o600)
    }
    await call(s, 'rename', '/d', '/d2')
    assert(fs.existsSync(path.join(root, 'd2', 'w.txt')))
    await call(s, 'unlink', '/d2/w.txt'); await call(s, 'unlink', '/d2/a b.txt'); await call(s, 'rmdir', '/d2')
    assert.deepStrictEqual(await call(s, 'readdir', '/'), [])
    // Windows: '/' lists drives and '/C:/x' maps to 'C:\x' (path mapping only)
    assert.strictEqual(local({ platform: 'win32' }).nativePath('/C:/Users/me'), 'C:\\Users\\me')
    await assert.rejects(local({ platform: 'win32' }).stat('/Users'), /No such file/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }

  // SMB: the mount command, credentials escaping and cleanup (the operating system does the protocol work)
  assert.strictEqual(mountUrl({ host: 'nas', port: 445, share: 'My Share', domain: 'CORP' }, { user: 'jo@x', secret: 'p:w/d@#' }), '//CORP;jo%40x:p%3Aw%2Fd%40%23@nas/My%20Share')
  assert.strictEqual(mountUrl({ host: 'nas', port: 4455, share: 's' }, { user: 'u', secret: 'p' }), '//u:p@nas:4455/s')
  const calls = []
  const exec = (cmd, args) => { calls.push([cmd, ...args]); if (args.some(a => a.includes(':bad@'))) return Promise.reject(new Error('mount_smbfs: server connection failed: Authentication error')); if (cmd === 'mount_smbfs') fs.writeFileSync(path.join(args.at(-1), 'f.txt'), 'x'); if (cmd === 'umount') fs.rmSync(path.join(args[0], 'f.txt'), { force: true }); return Promise.resolve('') }
  const mac = smb({ host: 'nas', port: 445, share: 'data', platform: 'darwin', exec }, { user: 'u', secret: 'p' })
  await mac.ping()
  assert.deepStrictEqual(calls[0].slice(0, 3), ['mount_smbfs', '-o', 'nobrowse'])
  assert.deepStrictEqual((await mac.list('/')).map(e => e.name), ['f.txt'])
  const dir = calls[0].at(-1)
  await mac.close()
  assert.deepStrictEqual(calls.at(-1), ['umount', dir]); assert(!fs.existsSync(dir), 'mount point removed')
  await assert.rejects(smb({ host: 'nas', share: 'data', platform: 'darwin', exec }, { user: 'u', secret: 'bad' }).ping(), /Authentication failure/)
  const winCalls = []
  const win = smb({ host: 'nas', share: 'data', domain: 'CORP', platform: 'win32', exec: (c, a) => { winCalls.push([c, ...a]); return Promise.resolve('') } }, { user: 'jo', secret: 'pw' })
  await win.ping().catch(() => {}) // the UNC path does not exist here; only the command matters
  assert.deepStrictEqual(winCalls[0], ['net', 'use', '\\\\nas\\data', 'pw', '/user:CORP\\jo', '/persistent:no'])
  assert.deepStrictEqual(winCalls.at(-1), ['net', 'use', '\\\\nas\\data', '/delete', '/y'])
  await assert.rejects(smb({ host: 'nas', share: 'data', platform: 'linux' }, {}).ping(), /macOS and Windows/)

  // Optional integration test against a real server: CYBERDOG_SMB_TEST=host:port:share:user:password
  if (process.env.CYBERDOG_SMB_TEST && process.platform === 'darwin') {
    const [host, port, share, user, secret] = process.env.CYBERDOG_SMB_TEST.split(':')
    const be = smb({ host, port: +port, share }, { user, secret })
    await be.ping()
    const dir = '/cyberdog-test-' + process.pid
    try {
      await be.mkdir(dir); await be.put(dir + '/a.txt', 'smb ok')
      assert.strictEqual(await text(await be.get(dir + '/a.txt')), 'smb ok')
      assert.deepStrictEqual((await be.list(dir)).map(e => e.name), ['a.txt'])
      await be.remove(dir + '/a.txt', false); await be.remove(dir, true)
    } finally { await be.close() }
    console.log('smb integration ok')
  }
  console.log('local ok')
})().catch(e => { console.error(e); process.exit(1) })
