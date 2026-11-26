// Password decoders for bookmarks saved by other clients. Each returns the clear password, or null when the
// value cannot be decoded (wrong master password, unknown format). Nothing here touches the disk.
const crypto = require('crypto')

// ---------- WinSCP (no master password): fixed substitution, key = user name + host name ----------
const WINSCP_MAGIC = 0xa3, WINSCP_FLAG = 0xff
function winscpBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9A-F]*$/.test(hex) || hex.length % 2) return null
  const out = []
  for (let i = 0; i < hex.length; i += 2) out.push(~(parseInt(hex.slice(i, i + 2), 16) ^ WINSCP_MAGIC) & 0xff)
  return out
}
// A master-password protected value starts with the flag then 0x01 ("A35D"): it cannot be read without it.
const winscpIsMaster = hex => /^A35D/.test(hex || '')
function winscpPassword(hex, user, host) {
  const b = winscpBytes(hex)
  if (!b || !b.length || winscpIsMaster(hex)) return null
  let i = 0, len
  const flag = b[i++]
  if (flag === WINSCP_FLAG) {
    const version = b[i++]
    if (version === 0x00) len = b[i++]
    else if (version === 0x02) { len = (b[i] << 8) + b[i + 1]; i += 2 }
    else return null
  } else len = flag
  i += 1 + b[i] // shift byte, then that many random bytes
  if (len === undefined || i + len > b.length) return null
  let text = Buffer.from(b.slice(i, i + len)).toString('utf8')
  if (flag === WINSCP_FLAG) {
    const key = (user || '') + (host || '')
    if (!text.startsWith(key)) return null
    text = text.slice(key.length)
  }
  return text
}

// ---------- FileZilla: base64 in clear unless a master password is set ----------
// no encoding attribute: clear text (FileZilla before 3.26)
const filezillaPassword = (value, encoding) => !encoding ? String(value || '') : encoding === 'base64' ? Buffer.from(value || '', 'base64').toString('utf8') : null

// ---------- rclone: "obscured" values use a fixed AES-CTR key (rclone/fs/config/obscure) ----------
const RCLONE_KEY = Buffer.from('9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638', 'hex')
function rcloneReveal(value) {
  try {
    const b = Buffer.from(String(value).trim(), 'base64url')
    if (b.length < 16) return null
    const d = crypto.createDecipheriv('aes-256-ctr', RCLONE_KEY, b.subarray(0, 16))
    return Buffer.concat([d.update(b.subarray(16)), d.final()]).toString('utf8')
  } catch { return null }
}
// An encrypted rclone.conf: NaCl secretbox, key = sha256("[" + password + "][rclone-config]"), 24-byte nonce first.
const RCLONE_HEADER = 'RCLONE_ENCRYPT_V0:'
const rcloneIsEncrypted = text => String(text).split(/\r?\n/).some(l => l.trim() === RCLONE_HEADER)
function rcloneDecryptConfig(text, password) {
  const lines = String(text).split(/\r?\n/), at = lines.findIndex(l => l.trim() === RCLONE_HEADER)
  if (at < 0 || !password) return null
  const box = Buffer.from(lines.slice(at + 1).join(''), 'base64')
  if (box.length < 24 + 16) return null
  const nacl = require('tweetnacl')
  const key = crypto.createHash('sha256').update(`[${password}][rclone-config]`).digest()
  const out = nacl.secretbox.open(new Uint8Array(box.subarray(24)), new Uint8Array(box.subarray(0, 24)), new Uint8Array(key))
  return out ? Buffer.from(out).toString('utf8') : null
}

// ---------- SecureCRT "Password V2" ----------
// 02: AES-256-CBC, key = sha256(config passphrase, empty when none), zero IV.
// 03: key and IV from bcrypt_pbkdf(passphrase, 16-byte salt, 48 bytes, 16 rounds).
// Plain text: uint32 LE length, password, sha256(password), random padding.
function securecrtPassword(value, passphrase = '') {
  const m = /^(0[23]):([0-9a-f]+)$/i.exec(String(value || '').trim())
  if (!m) return null
  let data = Buffer.from(m[2], 'hex'), key, iv
  if (m[1] === '02') { key = crypto.createHash('sha256').update(passphrase, 'utf8').digest(); iv = Buffer.alloc(16) }
  else {
    if (data.length < 32) return null
    const salt = data.subarray(0, 16), kdf = Buffer.alloc(48), pass = Buffer.from(passphrase, 'utf8')
    data = data.subarray(16)
    require('bcrypt-pbkdf').pbkdf(pass, pass.length, salt, salt.length, kdf, kdf.length, 16)
    key = kdf.subarray(0, 32); iv = kdf.subarray(32, 48)
  }
  if (!data.length || data.length % 16) return null
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv)
    d.setAutoPadding(false)
    const plain = Buffer.concat([d.update(data), d.final()])
    const len = plain.readUInt32LE(0)
    if (4 + len + 32 > plain.length) return null
    const pw = plain.subarray(4, 4 + len), sum = plain.subarray(4 + len, 4 + len + 32)
    return crypto.createHash('sha256').update(pw).digest().equals(sum) ? pw.toString('utf8') : null
  } catch { return null }
}

// ---------- MobaXterm with a master password: AES-256-CFB8, key = sha512(master)[0:32], IV = AES-ECB(key, 0) ----------
// No integrity check exists: a wrong master password yields bytes that are not readable text.
function mobaxtermPassword(value, master) {
  if (!master || !value) return null
  try {
    const key = crypto.createHash('sha512').update(master, 'utf8').digest().subarray(0, 32)
    // CFB8 by hand on top of ECB: Electron's BoringSSL does not always expose aes-256-cfb8
    const e = crypto.createCipheriv('aes-256-ecb', key, null); e.setAutoPadding(false)
    let reg = e.update(Buffer.alloc(16))
    const cipher = Buffer.from(value, 'base64'), plain = Buffer.alloc(cipher.length)
    for (let i = 0; i < cipher.length; i++) {
      plain[i] = e.update(reg)[0] ^ cipher[i]
      reg = Buffer.concat([reg.subarray(1), cipher.subarray(i, i + 1)])
    }
    const text = plain.toString('utf8')
    return !plain.length || text.includes('�') || /[\x00-\x08\x0e-\x1f\x7f]/.test(text) ? null : text
  } catch { return null }
}

module.exports = { winscpPassword, winscpIsMaster, filezillaPassword, rcloneReveal, rcloneIsEncrypted, rcloneDecryptConfig, securecrtPassword, mobaxtermPassword }
