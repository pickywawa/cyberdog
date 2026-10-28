// SMB / CIFS shares through the operating system's own client (mount_smbfs on macOS, UNC paths + `net use` on Windows),
// then browsed like a local folder. The system client brings SMB 2/3, signing, encryption and NTLMv2 or Kerberos;
// no pure-JavaScript SMB client does that reliably without legacy OpenSSL algorithms.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { local } = require('./local-storage')

const PREFIX = 'cyberdog-smb-'
const run = (cmd, args) => new Promise((ok, ko) => execFile(cmd, args, { timeout: 60000, windowsHide: true }, (e, out, err) => e ? ko(Object.assign(new Error((err || out || e.message).trim().split('\n').pop()), { code: e.code })) : ok(out)))
const enc = encodeURIComponent
const authFailure = msg => /authentication|logon failure|password|access is denied|LOGON_FAILURE|error 1326|system error 5\b/i.test(msg) ? Object.assign(new Error('Authentication failure: ' + msg), { code: 'EACCES' }) : null

// URL understood by mount_smbfs: //[domain;]user:password@host[:port]/share
const mountUrl = ({ host, port, share, domain }, { user, secret }) =>
  `//${domain ? enc(domain) + ';' : ''}${enc(user || 'guest')}:${enc(secret || '')}@${host}${port && port !== 445 ? ':' + port : ''}/${enc(share)}`

// The mount point of a share already mounted by this user, from the `mount` listing: //user@host[:port]/share on /path (smbfs
async function findMount(exec, { host, port, share }, { user }) {
  const out = await exec('mount', []).catch(() => '')
  const want = `//${(user || 'guest').toLowerCase()}@${host.toLowerCase()}${port && port !== 445 ? ':' + port : ''}/${share.toLowerCase()}`
  for (const m of out.matchAll(/^(\S+) on (.+) \(smbfs/gm)) if (decodeURIComponent(m[1]).toLowerCase() === want) return m[2]
}

// cfg: { host, port, share, domain, platform, exec (tests) }, creds: { user, secret }
function smb(cfg, creds) {
  const platform = cfg.platform || process.platform, exec = cfg.exec || run
  let mountPoint, unc, be
  async function connect() {
    if (platform === 'darwin') {
      mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
      try { await exec('mount_smbfs', ['-o', 'nobrowse', mountUrl(cfg, creds), mountPoint]) } catch (e) {
        fs.rmdirSync(mountPoint); mountPoint = undefined
        // the same share is already mounted for this user (Finder, another tab): use that mount and leave it in place
        const existing = /File exists/.test(e.message) && await findMount(exec, cfg, creds)
        if (existing) return existing
        throw authFailure(e.message) || e
      }
      return mountPoint
    }
    if (platform === 'win32') {
      if (cfg.port && cfg.port !== 445) throw new Error('Windows reaches SMB shares on port 445 only')
      unc = `\\\\${cfg.host}\\${cfg.share}`
      if (creds.user && creds.secret) {
        try { await exec('net', ['use', unc, creds.secret, `/user:${cfg.domain ? cfg.domain + '\\' : ''}${creds.user}`, '/persistent:no']) } catch (e) { throw authFailure(e.message) || e }
      }
      return unc
    }
    throw new Error('SMB shares are supported on macOS and Windows')
  }
  return {
    async ping() {
      const root = await connect()
      be = local({ root, platform, appleDouble: platform === 'darwin' })
      try { await be.ping() } catch (e) { await this.close(); throw e }
    },
    close: async () => {
      be = undefined
      if (mountPoint) {
        const dir = mountPoint; mountPoint = undefined
        await exec('umount', [dir]).catch(() => exec('diskutil', ['unmount', 'force', dir]).catch(() => {}))
        try { fs.rmdirSync(dir) } catch {}
      }
      if (unc) { const share = unc; unc = undefined; await exec('net', ['use', share, '/delete', '/y']).catch(() => {}) }
    },
    // every file operation is the local backend's, on the mounted share
    ...Object.fromEntries(['stat', 'list', 'mkdir', 'remove', 'move', 'put', 'putFile', 'get', 'putStream'].map(m => [m, (...a) => be[m](...a)])),
  }
}

// Mounts left behind by a crash: unmount and remove them (macOS)
async function cleanupStaleMounts(exec = run) {
  if (process.platform !== 'darwin') return
  let mounts = ''
  try { mounts = await exec('mount', []) } catch {}
  for (const m of mounts.matchAll(new RegExp(`on (\\S*${PREFIX}\\S*) \\(smbfs`, 'g'))) await exec('umount', [m[1]]).catch(() => {})
  for (const name of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(PREFIX))) try { fs.rmdirSync(path.join(os.tmpdir(), name)) } catch {}
}

module.exports = { smb, mountUrl, cleanupStaleMounts }
