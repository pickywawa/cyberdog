// Explorer helpers: name filters, file URLs, type to select.
const assert = require('assert')
const { apply, active, fileUrl, typeAhead } = require('../src/file-tools')

const entries = ['node_modules', 'app.log', 'App.LOG', '.env', '.git', 'index.js', 'a.log.gz', 'x1.txt', 'x10.txt'].map(name => ({ name }))
const names = f => apply(entries, f).map(e => e.name)
assert.deepStrictEqual(names({ enabled: true, patterns: '*.log, node_modules' }), ['.env', '.git', 'index.js', 'a.log.gz', 'x1.txt', 'x10.txt'])
assert.deepStrictEqual(names({ enabled: true, patterns: '', dotfiles: true }).includes('.env'), false)
assert.deepStrictEqual(names({ enabled: true, patterns: 'x?.txt' }).includes('x1.txt'), false)
assert.deepStrictEqual(names({ enabled: true, patterns: 'x?.txt' }).includes('x10.txt'), true)
assert.deepStrictEqual(names({ enabled: true, patterns: 'a.(log)+' }).length, entries.length) // regex characters are plain text
assert.deepStrictEqual(names({ enabled: false, patterns: '*', dotfiles: true }).length, entries.length)
assert.strictEqual(active({ enabled: true, patterns: ' , ' }), false)
assert.strictEqual(active({ enabled: true, patterns: '', dotfiles: true }), true)

assert.strictEqual(fileUrl({ type: 'ssh', user: 'deploy', host: 'example.test', port: 22 }, '/var/www/my file.html'), 'sftp://deploy@example.test/var/www/my%20file.html')
assert.strictEqual(fileUrl({ host: 'example.test', user: 'a@b', port: 2222 }, '/x'), 'sftp://a%40b@example.test:2222/x')
assert.strictEqual(fileUrl({ type: 'ftp', security: 'none', user: 'u', host: 'h', port: 21 }, '/a'), 'ftp://u@h/a')
assert.strictEqual(fileUrl({ type: 'ftp', security: 'implicit', user: 'u', host: 'h', port: 990 }, '/a'), 'ftps://u@h/a')
assert.strictEqual(fileUrl({ type: 'ftp', user: 'u', host: 'h', port: 2121 }, '/a'), 'ftpes://u@h:2121/a')
assert.strictEqual(fileUrl({ type: 'webdav', url: 'https://dav.test/remote.php/' }, '/Docs/a b'), 'https://dav.test/remote.php/Docs/a%20b')
assert.strictEqual(fileUrl({ type: 's3', bucket: 'site' }, '/img/a.png'), 's3://site/img/a.png')
assert.strictEqual(fileUrl({ type: 's3' }, '/site/img/a.png'), 's3://site/img/a.png')
assert.strictEqual(fileUrl({ type: 'smb', host: 'nas', bucket: 'share' }, '/a'), 'smb://nas/share/a')
assert.strictEqual(fileUrl({ type: 'azure', user: 'acct', bucket: 'c' }, '/a'), 'https://acct.blob.core.windows.net/c/a')
assert.strictEqual(fileUrl({ type: 'local' }, '/C:/Users/me/a.txt'), 'file:///C:/Users/me/a.txt')
assert.strictEqual(fileUrl({ type: 'gdrive' }, '/a'), null)

const list = ['bin', 'config', 'conf.d', 'Cache', 'docs', 'data']
assert.strictEqual(typeAhead(list, 'con', null), 1)
assert.strictEqual(typeAhead(list, 'conf.', 1), 2)
assert.strictEqual(typeAhead(list, 'c', null), 1)
assert.strictEqual(typeAhead(list, 'c', 1), 2) // the same letter again: next name starting with it
assert.strictEqual(typeAhead(list, 'c', 3), 1) // wraps around
assert.strictEqual(typeAhead(list, 'd', 0), 4)
assert.strictEqual(typeAhead(list, 'zz', 0), -1)
console.log('file tools ok')
