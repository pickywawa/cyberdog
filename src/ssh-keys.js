const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { utils } = require('ssh2')
const { readList, writeList } = require('./persistent-list')
function publicInfo(text) {
  const line = text.trim()
  if (line.length > 64000 || /[\r\n\0]/.test(line) || !/^(ssh-|ecdsa-)/.test(line)) throw new Error('Invalid SSH public key')
  const key = utils.parseKey(line)
  if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid SSH public key')
  const blob = key.getPublicSSH()
  const comment = line.split(/\s+/).slice(2).join(' ')
  return { type: key.type, fingerprint: 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''), publicKey: `${key.type} ${blob.toString('base64')}${comment ? ' ' + comment : ''}` }
}
function createKeyStore(directory, registry) {
  const describe = item => {
    const info = publicInfo(fs.readFileSync(item.publicPath, 'utf8'))
    let encrypted = false
    if (item.privatePath && fs.existsSync(item.privatePath)) encrypted = utils.parseKey(fs.readFileSync(item.privatePath)) instanceof Error
    return { ...item, ...info, encrypted, hasPrivate: !!item.privatePath && fs.existsSync(item.privatePath) }
  }
  const get = id => { const item = readList(registry).find(x => x.id === id); if (!item) throw new Error('SSH key not found'); return describe(item) }
  const save = (item, publicKey) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(item.publicPath, publicKey + '\n', { mode: 0o644, flag: 'wx' })
    try { writeList(registry, [...readList(registry), item]) } catch (e) { fs.unlinkSync(item.publicPath); throw e }
    return describe(item)
  }
  return {
    get,
    list: () => readList(registry).map(item => { try { return describe(item) } catch (e) { return { id: item.id, name: item.name, error: e.message } } }),
    async generate({ name, type = 'ed25519', passphrase = '', comment = '' }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 100 || !['ed25519', 'rsa'].includes(type) || typeof passphrase !== 'string' || passphrase.length > 1024 || typeof comment !== 'string' || comment.length > 200 || /[\r\n\0]/.test(comment)) throw new Error('Invalid SSH key options')
      const pair = await new Promise((resolve, reject) => utils.generateKeyPair(type, { bits: 4096, comment, ...(passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 32 } : {}) }, (e, result) => e ? reject(e) : resolve(result)))
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const id = crypto.randomUUID(), file = path.join(directory, 'id_' + type + '_' + id)
      fs.writeFileSync(file, pair.private, { mode: 0o600, flag: 'wx' })
      try { return save({ id, name: name.trim(), privatePath: file, publicPath: file + '.pub', created: Date.now() }, pair.public) }
      catch (e) { fs.unlinkSync(file); throw e }
    },
    importPublic(file) {
      if (fs.statSync(file).size > 64000) throw new Error('SSH public key exceeds size limit')
      const info = publicInfo(fs.readFileSync(file, 'utf8'))
      const duplicate = this.list().find(k => k.fingerprint === info.fingerprint)
      if (duplicate) return duplicate
      const id = crypto.randomUUID(), candidate = file.endsWith('.pub') ? file.slice(0, -4) : undefined
      const privatePath = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : undefined
      return save({ id, name: path.basename(file), publicPath: path.join(directory, id + '.pub'), privatePath, created: Date.now() }, info.publicKey)
    },
  }
}
function installScript(publicKey) {
  const info = publicInfo(publicKey)
  const quote = s => `'${s.replace(/'/g, `'\\''`)}'`
  return `set -eu
umask 077
d="$HOME/.ssh"
[ ! -L "$d" ] || { echo 'Refusing a symlink for .ssh'; exit 1; }
mkdir -p "$d"
chmod 700 "$d"
lock="$d/.cyberdog-key-install"
mkdir "$lock" 2>/dev/null || { echo 'Another key installation is in progress'; exit 1; }
trap 'rmdir "$lock"' 0
f="$d/authorized_keys"
[ ! -L "$f" ] || { echo 'Refusing a symlink for authorized_keys'; exit 1; }
[ -e "$f" ] || (set -C; : > "$f")
[ -f "$f" ] || exit 1
chmod 600 "$f"
if awk -v type=${quote(info.type)} -v key=${quote(info.publicKey.split(' ')[1])} '/^[[:space:]]*#/ {next} {for(i=2;i<=NF;i++) if($i==key && $(i-1)==type) found=1} END {exit !found}' "$f"; then
 echo EXISTS
else
 printf '\\n%s\\n' ${quote(info.publicKey)} >> "$f"
 echo ADDED
fi
`
}
function parseAuthorizedKeys(contents) {
  const items = []
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    // Quoted options can contain spaces and key-like text. Consume options as tokens.
    const tokens = line.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) || []
    const keyIndex = /^(ssh-|ecdsa-)/.test(tokens[0] || '') ? 0 : 1
    if (!/^(ssh-|ecdsa-)/.test(tokens[keyIndex] || '')) continue
    try {
      const info = publicInfo(tokens.slice(keyIndex).join(' '))
      items.push({ ...info, line: index + 1, name: info.publicKey.split(/\s+/).slice(2).join(' ') || info.type })
    } catch {}
  }
  return items
}
module.exports = { publicInfo, createKeyStore, installScript, parseAuthorizedKeys }
