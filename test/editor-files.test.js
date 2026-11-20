// Built-in editor files: whatever the encoding, an open / save without edits gives back the same bytes, and an edit
// is written in the file's own encoding. Binary files are refused; unknown characters stop the save.
const assert = require('assert')
const { decode, encode, languageFor, MAX_SIZE } = require('../src/editor-files')

const roundTrip = (bytes, expected) => {
  const d = decode(bytes)
  assert.strictEqual(d.encoding, expected, 'encoding of ' + bytes.toString('hex').slice(0, 40))
  assert.deepStrictEqual(encode(d.text, d.encoding), bytes, 'same bytes back for ' + expected)
  return d
}
// UTF-8, with and without BOM, CRLF kept in the text
let d = roundTrip(Buffer.from('été €\r\nligne 2\r\n', 'utf8'), 'utf8')
assert.strictEqual(d.eol, 'crlf'); assert.strictEqual(d.mixedEol, false)
d = roundTrip(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a = 1\n')]), 'utf8bom')
assert.strictEqual(d.text, 'a = 1\n', 'the BOM is not part of the text')
// UTF-16 with BOM
roundTrip(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ünïcode ✓\r\n', 'utf16le')]), 'utf16le')
const be = Buffer.from('Ünïcode ✓\n', 'utf16le'); be.swap16()
roundTrip(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'utf16be')
// not UTF-8: Windows-1252 / Latin-1, every byte comes back the same
const legacy = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9, 0x20, 0x80, 0x20, 0x81, 0x9d, 0xff, 0x0d, 0x0a])])
d = roundTrip(legacy, 'windows-1252')
assert.strictEqual(d.text.slice(0, 6), 'café €')
const allBytes = Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1))
roundTrip(allBytes, 'windows-1252')
// an edit is written in the same encoding; a character it cannot hold stops the save
assert.deepStrictEqual(encode(d.text.replace('café', 'thé'), 'windows-1252').subarray(0, 3), Buffer.from([0x74, 0x68, 0xe9]))
assert.throws(() => encode('漢字', 'windows-1252'), e => e.code === 'unencodable' && e.char === '漢')
assert.throws(() => encode('x', 'ebcdic'), /Unknown encoding/)
// binary, mixed line endings, empty file
assert.deepStrictEqual(decode(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), { binary: true })
assert.strictEqual(decode(Buffer.from('a\r\nb\nc\r\n')).mixedEol, true)
assert.strictEqual(decode(Buffer.from('a\rb\rc')).mixedEol, true, 'old Mac line endings are flagged')
assert.strictEqual(decode(Buffer.from('a\nb\n')).mixedEol, false)
roundTrip(Buffer.alloc(0), 'utf8')
assert.strictEqual(MAX_SIZE, 10 * 1024 * 1024)

// languages
const languages = [{ id: 'javascript', extensions: ['.js'] }, { id: 'typescript', extensions: ['.ts', '.d.ts'] }, { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] }, { id: 'yaml', extensions: ['.yml', '.yaml'] }, { id: 'shell', extensions: ['.sh'] }, { id: 'ini', extensions: ['.ini'] }]
assert.strictEqual(languageFor('app.js', languages), 'javascript')
assert.strictEqual(languageFor('types.d.ts', languages), 'typescript')
assert.strictEqual(languageFor('Dockerfile', languages), 'dockerfile')
assert.strictEqual(languageFor('docker-compose.YML', languages), 'yaml')
assert.strictEqual(languageFor('nginx.conf', languages), 'ini')
assert.strictEqual(languageFor('.env.production', languages), 'ini')
assert.strictEqual(languageFor('.bashrc', languages), 'shell')
assert.strictEqual(languageFor('README', languages), 'plaintext')
console.log('editor files ok')
