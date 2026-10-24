const validMode = value => typeof value === 'string' && /^[0-7]{3,4}$/.test(value)
const validUid = uid => Number.isSafeInteger(uid) && uid >= 0 && uid < 0xffffffff
function parseUsers(text) {
  const users = new Map()
  for (const line of text.split('\n')) {
    const [name, , rawUid] = line.split(':')
    const uid = Number(rawUid)
    if (name && /^\d+$/.test(rawUid || '') && validUid(uid) && !users.has(uid)) users.set(uid, { name, uid })
  }
  return [...users.values()].sort((a, b) => a.name.localeCompare(b.name))
}
async function applyAttributes(sftp, file, { uid, mode }) {
  if (!validMode(mode) || !validUid(uid)) throw new Error('Invalid ownership or permissions')
  const call = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, result) => error ? reject(error) : resolve(result)))
  const before = await call('stat', file)
  const ownerChanged = uid !== before.uid
  if (ownerChanged) await call('chown', file, uid, before.gid)
  // chown can clear setuid/setgid: apply the requested mode afterwards, including special bits.
  try {
    if (ownerChanged || parseInt(mode, 8) !== (before.mode & 0o7777)) await call('chmod', file, parseInt(mode, 8))
  } catch (error) { if (ownerChanged) error.ownerChanged = true; throw error }
}
module.exports = { parseUsers, applyAttributes, validMode, validUid }
