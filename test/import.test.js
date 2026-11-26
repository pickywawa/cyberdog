const assert = require('assert')
const crypto = require('crypto')
const { parseDuck } = require('../src/duck')
const imp = require('../src/client-import')
const sec = require('../src/client-secrets')
const { regFileToIni } = require('../src/client-sources')
const { normalize, serverKey } = require('../src/import-main')

// ---------- Cyberduck ----------
const duck = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Protocol</key><string>sftp</string><key>Nickname</key><string>Prod &amp; Co</string>
<key>Hostname</key><string>10.0.0.5</string><key>Port</key><string>2222</string>
<key>Username</key><string>root</string></dict></plist>`
assert.deepStrictEqual(parseDuck(duck), { name: 'Prod & Co', host: '10.0.0.5', port: 2222, user: 'root', key: undefined, pw: 'external' })
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>ftp<')).security, 'none')
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>ftp-tls<')).security, 'explicit')
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>ftp-tls<').replace('2222', '990')).security, 'implicit')
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>s3<')).url, 'https://10.0.0.5:2222')
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>davs<').replace('2222', '443')).url, 'https://10.0.0.5')
assert.strictEqual(parseDuck(duck.replace('>sftp<', '>irods<')), null)

// ---------- FileZilla ----------
const fz = `<?xml version="1.0"?><FileZilla3><Servers><Folder expanded="1">Prod
<Server><Host>a.example</Host><Port>22</Port><Protocol>1</Protocol><User>root</User><Pass encoding="base64">${Buffer.from('s3cr€t').toString('base64')}</Pass><Name>A</Name></Server>
<Server><Host>b.example</Host><Port>990</Port><Protocol>3</Protocol><User>ftp</User><Pass encoding="crypt" pubkey="x">zzz</Pass><Name>B</Name></Server>
</Folder><Server><Host>c.example</Host><Protocol>6</Protocol><User>u</User><Name>C</Name></Server></Servers></FileZilla3>`
const fzr = imp.filezilla(fz)
assert.deepStrictEqual(fzr.map(e => [e.name, e.type, e.group, e.pw, e.pass]), [['A', 'ssh', 'Prod', 'ok', 's3cr€t'], ['B', 'ftp', 'Prod', 'locked', undefined], ['C', 'ftp', undefined, 'none', undefined]])
assert.strictEqual(fzr[1].security, 'implicit')
assert.throws(() => imp.filezilla('<!DOCTYPE x><FileZilla3/>'))

// ---------- WinSCP: encoder from the documented algorithm, decoded back ----------
const winscpEncode = (pass, key) => {
  const enc = b => ((~b ^ 0xa3) & 0xff).toString(16).toUpperCase().padStart(2, '0')
  const plain = Buffer.from(key + pass, 'utf8')
  return enc(0xff) + enc(0x00) + enc(plain.length) + enc(2) + enc(7) + enc(9) + [...plain].map(enc).join('') + enc(1)
}
assert.strictEqual(sec.winscpPassword(winscpEncode('pä ss', 'rootexample.com'), 'root', 'example.com'), 'pä ss')
assert.strictEqual(sec.winscpPassword(winscpEncode('x', 'otherhost'), 'root', 'example.com'), null)
const winscpIni = `[Sessions\\Prod/web%20one]
HostName=example.com
UserName=root
PortNumber=2222
Password=${winscpEncode('pw1', 'rootexample.com')}
[Sessions\\ftp]
HostName=ftp.example.com
UserName=bob
FSProtocol=5
Ftps=1
Password=A35D0011
[Sessions\\Default Settings]
UserName=dflt`
assert.deepStrictEqual(imp.winscp(winscpIni).map(e => [e.name, e.group, e.type, e.port, e.pw, e.pass, e.security]), [['web one', 'Prod', 'ssh', 2222, 'ok', 'pw1', undefined], ['ftp', undefined, 'ftp', 990, 'locked', undefined, 'implicit']])

// ---------- registry ----------
const regOut = `
HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\my%20box
    HostName    REG_SZ    admin@10.1.1.1
    PortNumber    REG_DWORD    0x16
    Protocol    REG_SZ    ssh
`
assert.deepStrictEqual(imp.putty(imp.regToIni(regOut, 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions', 'Sessions')).map(e => [e.name, e.host, e.user, e.port]), [['my box', '10.1.1.1', 'admin', 22]])
const regFile = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\db]\r\n"HostName"="db.lan"\r\n"UserName"="pg"\r\n"PortNumber"=dword:00000822\r\n"Protocol"="ssh"\r\n'
assert.deepStrictEqual(imp.putty(regFileToIni(regFile, 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions')).map(e => [e.name, e.host, e.port]), [['db', 'db.lan', 2082]])

// ---------- OpenSSH config ----------
const ssh = imp.sshConfig(`Host *\n  User def\nHost web web2\n  HostName %h.example.com\n  Port 2200\nHost db\n  User pg\n  IdentityFile ~/.ssh/db\nHost *.internal !x\n  User nope\nMatch host x\n  User m`, { localUser: 'me' })
assert.deepStrictEqual(ssh.map(e => [e.name, e.host, e.port, e.user, e.key]), [['web', 'web.example.com', 2200, 'def', undefined], ['web2', 'web2.example.com', 2200, 'def', undefined], ['db', 'db', 22, 'def', '~/.ssh/db']])

// ---------- rclone: obscure test vectors from rclone ----------
assert.strictEqual(sec.rcloneReveal('YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ'), 'potato')
const conf = `[box]\ntype = sftp\nhost = h.example\nuser = u\npass = YWFhYWFhYWFhYWFhYWFhYXMaGgIlEQ\n[bucket]\ntype = s3\naccess_key_id = AK\nsecret_access_key = SK\nregion = eu-west-3\n[dav]\ntype = webdav\nurl = https://dav.example/remote.php\nuser = w\n[gd]\ntype = drive\n`
assert.deepStrictEqual(imp.rclone(conf).map(e => [e.name, e.type, e.pass, e.pw]), [['box', 'ssh', 'potato', 'ok'], ['bucket', 's3', 'SK', 'ok'], ['dav', 'webdav', undefined, 'none'], ['gd', 'gdrive', undefined, 'external']])
{ // encrypted rclone.conf (secretbox)
  const nacl = require('tweetnacl'), nonce = crypto.randomBytes(24), key = crypto.createHash('sha256').update('[pw][rclone-config]').digest()
  const box = Buffer.concat([nonce, Buffer.from(nacl.secretbox(new Uint8Array(Buffer.from(conf)), new Uint8Array(nonce), new Uint8Array(key)))])
  const text = `# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\n${box.toString('base64')}\n`
  assert.throws(() => imp.rclone(text), e => e.code === 'master_required')
  assert.throws(() => imp.rclone(text, { master: 'bad' }), e => e.code === 'master_wrong')
  assert.strictEqual(imp.rclone(text, { master: 'pw' }).length, 4)
}

// ---------- SecureCRT Password V2 (02 and 03), encoded as SecureCRT does ----------
const crtEncode = (pass, passphrase, v3) => {
  const p = Buffer.from(pass), body = Buffer.concat([Buffer.alloc(4), p, crypto.createHash('sha256').update(p).digest()]); body.writeUInt32LE(p.length, 0)
  let pad = 16 - (body.length % 16); if (pad < 8) pad += 16
  const plain = Buffer.concat([body, crypto.randomBytes(pad)])
  let key, iv, salt = Buffer.alloc(0)
  if (v3) { salt = crypto.randomBytes(16); const kdf = Buffer.alloc(48), pp = Buffer.from(passphrase); require('bcrypt-pbkdf').pbkdf(pp, pp.length, salt, 16, kdf, 48, 16); key = kdf.subarray(0, 32); iv = kdf.subarray(32) }
  else { key = crypto.createHash('sha256').update(passphrase).digest(); iv = Buffer.alloc(16) }
  const c = crypto.createCipheriv('aes-256-cbc', key, iv); c.setAutoPadding(false)
  return (v3 ? '03:' : '02:') + Buffer.concat([salt, c.update(plain), c.final()]).toString('hex')
}
assert.strictEqual(sec.securecrtPassword(crtEncode('hello', ''), ''), 'hello')
assert.strictEqual(sec.securecrtPassword(crtEncode('hello', 'phrase', true), 'phrase'), 'hello')
assert.strictEqual(sec.securecrtPassword(crtEncode('hello', 'phrase'), ''), null)
const crt = imp.securecrt([
  { rel: 'Prod/web.ini', text: `S:"Hostname"=web.lan\nS:"Username"=root\nD:"[SSH2] Port"=00000016\nS:"Protocol Name"=SSH2\nS:"Password V2"=${crtEncode('pw', 'phrase')}` },
  { rel: 'Prod/__FolderData__.ini', text: 'S:"Hostname"=x' },
])
assert.deepStrictEqual(crt.map(e => [e.name, e.group, e.port, e.pw]), [['web', 'Prod', 22, 'master']])
assert.strictEqual(imp.securecrt([{ rel: 'web.ini', text: `S:"Hostname"=web.lan\nS:"Password V2"=${crtEncode('pw', 'phrase')}` }], { master: 'phrase' })[0].pass, 'pw')

// ---------- MobaXterm (master password: AES-CFB8) ----------
const mobaEncode = (pass, master) => {
  const key = crypto.createHash('sha512').update(master).digest().subarray(0, 32)
  const e = crypto.createCipheriv('aes-256-ecb', key, null); e.setAutoPadding(false)
  let reg = e.update(Buffer.alloc(16)); const p = Buffer.from(pass), out = Buffer.alloc(p.length)
  for (let i = 0; i < p.length; i++) { out[i] = e.update(reg)[0] ^ p[i]; reg = Buffer.concat([reg.subarray(1), out.subarray(i, i + 1)]) }
  return out.toString('base64')
}
const moba = `[Bookmarks]\nSubRep=\nImgNum=42\nweb=#109#0%web.lan%22%root%%-1%-1%%%\n[Bookmarks_1]\nSubRep=Prod\\DB\nImgNum=41\nftp=#130#0%ftp.lan%21%bob%\n[Passwords]\nssh22:root@web.lan=${mobaEncode('mobapw', 'master!')}\n`
assert.deepStrictEqual(imp.mobaxterm(moba).map(e => [e.name, e.group, e.type, e.pw]), [['web', undefined, 'ssh', 'master'], ['ftp', 'Prod / DB', 'ftp', 'none']])
assert.strictEqual(imp.mobaxterm(moba, { master: 'master!' })[0].pass, 'mobapw')

// ---------- Tabby ----------
const tab = imp.tabby(`groups:\n  - id: g1\n    name: Lab\nprofiles:\n  - type: ssh\n    name: pi\n    group: g1\n    options:\n      host: 10.0.0.9\n      user: pi\n      privateKeys:\n        - ${require('url').pathToFileURL(require('path').resolve('/keys/id_ed25519')).href}\n  - type: local\n    name: shell\n`)
assert.deepStrictEqual(tab.map(e => [e.name, e.group, e.host, e.key, e.pw]), [['pi', 'Lab', '10.0.0.9', require('path').resolve('/keys/id_ed25519'), 'external']])

// ---------- WebSSH ----------
const rows = [['c1', 'objectType', 'connection'], ['c1', 'host', '10.30.40.20'], ['c1', 'port', 2222], ['c1', 'name', 'test'], ['c1', 'groupName', 'G'], ['c1', 'authentication.user', 'u'], ['c1', 'authentication.password', 'pw'], ['c1', 'roles', 'SSH,SFTP'], ['s1', 'objectType', 'setting'], ['d1', 'objectType', 'connection'], ['d1', 'host', 'gone'], ['d1', 'objectIsDeleted', 1]]
assert.deepStrictEqual(imp.webssh(rows.map(([key, attribute, value]) => ({ key, attribute, value }))), [{ name: 'test', group: 'G', type: 'ssh', host: '10.30.40.20', port: 2222, user: 'u', pass: 'pw', pw: 'ok' }])

// ---------- Transmit (NSKeyedArchiver) ----------
const archive = { $top: { root: { 'CF$UID': 1 } }, $objects: ['$null', { 'NS.keys': [{ 'CF$UID': 2 }], 'NS.objects': [{ 'CF$UID': 3 }] }, 'globalConnectionGroup', { name: 'GlobalSiteGroup', connections: { 'CF$UID': 4 } }, { 'NS.objects': [{ 'CF$UID': 5 }] }, { name: 'Work', connections: { 'CF$UID': 6 } }, { 'NS.objects': [{ 'CF$UID': 7 }] }, { server: 's.example', username: 'me', protocol: 'SFTP', nickname: 'S', port: 22 }] }
assert.deepStrictEqual(imp.transmitStore(imp.unarchive(archive)).map(e => [e.name, e.group, e.type, e.host]), [['S', 'Work', 'ssh', 's.example']])
assert.deepStrictEqual(imp.plistXml('<plist><dict><key>a</key><array><integer>1</integer><true/></array></dict></plist>'), { a: [1, true] })

// ---------- normalize / matching ----------
const ev = { home: '/home/me', localUser: 'me' }
const n = normalize({ name: 'x', type: 'ssh', host: 'H.example', port: 22, user: '' }, ev)
assert.strictEqual(n.data.user, 'me')
assert.strictEqual(n.match, serverKey({ host: 'h.example', port: 22, user: 'me' }))
assert.strictEqual(normalize({ type: 'ssh', host: 'bad host', user: 'u' }, ev), null)
assert.strictEqual(normalize({ type: 'ssh', host: 'h', user: 'u', key: '/nonexistent/key' }, ev).keyDropped, true)
assert.strictEqual(normalize({ type: 's3', host: 's3.amazonaws.com', url: 'https://s3.amazonaws.com', user: 'AK' }, ev).match, 's3|s3.amazonaws.com|443|ak')
console.log('ok')
