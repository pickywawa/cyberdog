const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')
const { Transfers } = require('../src/transfers')
const { resolveDirectory } = require('../src/sftp-navigation')
const { parseAuthorizedKeys } = require('../src/ssh-keys')
;(async () => {
  let engine
  const events = [], manager = new Transfers((_, e) => events.push(e), null, (job, resuming) => engine.runJob(job, resuming))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdog-transfers-'))
  try {
    const local = path.join(root, 'local'), remote = path.join(root, 'remote'), result = path.join(root, 'result')
    fs.mkdirSync(path.join(local, 'nested'), { recursive: true }); fs.mkdirSync(remote)
    fs.writeFileSync(path.join(local, 'nested/data'), Buffer.alloc(512000, 42)); fs.writeFileSync(path.join(local, 'empty'), '')
    const s = {
      stat: (p, cb) => fs.stat(p, cb), realpath: (p, cb) => fs.realpath(p, cb),
      readdir: (p, cb) => fs.readdir(p, (e, names) => cb(e, names?.map(filename => ({ filename })))),
      mkdir: (p, cb) => fs.mkdir(p, cb), createReadStream: p => fs.createReadStream(p), createWriteStream: p => fs.createWriteStream(p),
    }
    engine = require('../src/transfer-files')(manager, ref => ref.disk ? null : s)
    const up = (name, source, target) => manager.run('c', 'upload', name, { refs: { src: { disk: true }, dst: { connId: 'c' } }, top: [{ source, target }] })
    const down = (name, source, target) => manager.run('c', 'download', name, { refs: { src: { connId: 'c' }, dst: { disk: true } }, top: [{ source, target }] })
    assert.equal(await up('local', local, path.join(remote, 'copy')), true)
    let last = manager.list().at(-1); assert.equal(last.total, 512000); assert.equal(last.done, 512000); assert.equal(last.state, 'done'); assert(!('stream' in last))
    await down('copy', path.join(remote, 'copy'), result)
    assert.deepEqual(fs.readFileSync(path.join(result, 'nested/data')), fs.readFileSync(path.join(local, 'nested/data')))
    assert(fs.existsSync(path.join(result, 'empty')))
    await assert.rejects(down('missing', path.join(root, 'missing'), result), /ENOENT/)
    assert.equal(manager.list().at(-1).state, 'error')
    engine = require('../src/transfer-files')(manager, ref => ref.disk ? null : s)
    const cancelling = new Transfers(() => {}, null, async job => { const stream = job.stream = new PassThrough(); const error = new Promise((resolve, reject) => stream.on('error', reject)); cancelling.cancel(job.id); await error })
    assert.equal(await cancelling.run('c', 'upload', 'slow', {}), false); assert.equal(cancelling.list().at(-1).state, 'cancelled')
    fs.symlinkSync(local, path.join(local, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(up('cycle', local, path.join(remote, 'cycle')), /symlink cycle/)
    const nav = { realpath: (p, cb) => cb(null, p === '.' ? '/home/test' : p), stat: (p, cb) => cb(null, { isDirectory: () => !p.endsWith('authorized_keys') }) }
    assert.deepEqual(await resolveDirectory(nav, '~/.ssh/'), { path:'/home/test/.ssh/', selected:null })
    assert.deepEqual(await resolveDirectory(nav, '~/.ssh/authorized_keys'), { path:'/home/test/.ssh', selected:'authorized_keys' })
    assert.equal((await resolveDirectory(nav, '~')).path, '/home/test')
    const pair = { public: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINOQPaeUgba8wP7tRpDrmqf0Kpe4mVxlg5naDmaiZn5p laptop' }
    const keys = parseAuthorizedKeys(`# ignore\n${pair.public}\ncommand="echo hello world",no-pty ${pair.public}\ninvalid\n`)
    assert.equal(keys.length, 2); assert.equal(keys[0].fingerprint, keys[1].fingerprint); assert.equal(keys[1].name, 'laptop')
    assert(events.some(e => e.scanned && e.state === 'running'))
  } finally { fs.rmSync(root, { recursive:true, force:true }) }
  console.log('transfers, cancellation, remote paths and authorized keys ok')
})().catch(e => { console.error(e); process.exitCode = 1 })
