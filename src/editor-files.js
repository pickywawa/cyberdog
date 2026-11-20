// Text files for the built-in editor (tested in test/editor-files.test.js).
// The bytes on the server must survive an open / save untouched: the encoding is detected when the file is read and
// the same one is used to write it back (UTF-8 with or without BOM, UTF-16 LE / BE with BOM, Windows-1252 for anything
// that is not valid UTF-8: every byte maps to one character and back). A character the encoding cannot hold stops the
// save instead of being replaced. Binary files (NUL bytes) and files over 10 MB are left to an external application.
;(function () {
  const MAX_SIZE = 10 * 1024 * 1024
  const ENCODINGS = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'windows-1252']

  let cp1252
  function table() {
    if (cp1252) return cp1252
    const chars = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i))
    const back = new Map()
    for (let i = 0; i < chars.length; i++) back.set(chars[i], i)
    return (cp1252 = { chars, back })
  }

  // Line endings: the one used most; `mixed` when several kinds are present (the editor writes a single kind back)
  function lineEndings(text) {
    let crlf = 0, lf = 0, cr = 0
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) text[i - 1] === '\r' ? crlf++ : lf++
    for (let i = text.indexOf('\r'); i >= 0; i = text.indexOf('\r', i + 1)) if (text[i + 1] !== '\n') cr++
    // a lone CR (old Mac files) also counts as mixed: the editor turns it into the main line ending
    return { eol: crlf > lf ? 'crlf' : 'lf', mixed: (crlf > 0) + (lf > 0) + (cr > 0) > 1 || (cr > 0 && crlf + lf === 0) }
  }

  // bytes: Uint8Array / Buffer -> { binary } | { text, encoding, eol, mixedEol }
  function decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const strict = (label, from = 0) => { try { return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b.subarray(from)) } catch { return null } }
    let text = null, encoding
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf && (text = strict('utf-8', 3)) !== null) encoding = 'utf8bom'
    else if (b[0] === 0xff && b[1] === 0xfe && b.length % 2 === 0 && (text = strict('utf-16le', 2)) !== null) encoding = 'utf16le'
    else if (b[0] === 0xfe && b[1] === 0xff && b.length % 2 === 0 && (text = strict('utf-16be', 2)) !== null) encoding = 'utf16be'
    else {
      if (b.subarray(0, 8192).includes(0)) return { binary: true }
      text = strict('utf-8')
      if (text !== null) encoding = 'utf8'
      else { encoding = 'windows-1252'; const { chars } = table(); text = ''; for (let i = 0; i < b.length; i += 65536) text += Array.from(b.subarray(i, i + 65536), x => chars[x]).join('') }
    }
    const { eol, mixed } = lineEndings(text)
    return { text, encoding, eol, mixedEol: mixed }
  }

  // text -> Buffer in `encoding`; throws { code: 'unencodable', char } when a character does not exist in it
  function encode(text, encoding) {
    if (!ENCODINGS.includes(encoding)) throw new Error('Unknown encoding ' + encoding)
    if (encoding === 'utf8') return Buffer.from(text, 'utf8')
    if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    if (encoding === 'utf16be') { const le = Buffer.from(text, 'utf16le'); le.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), le]) }
    const { back } = table(), out = Buffer.alloc(text.length)
    for (let i = 0; i < text.length; i++) {
      const byte = back.get(text[i])
      if (byte === undefined) throw Object.assign(new Error('Character not available in ' + encoding + ': ' + text[i]), { code: 'unencodable', char: String.fromCodePoint(text.codePointAt(i)) })
      out[i] = byte
    }
    return out
  }

  // ---- Language of a file, for the syntax colours ----
  // languages: what the editor knows ([{ id, extensions, filenames }]); a few common server files are added here.
  const NAMES = { '.env': 'ini', '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell', '.zshrc': 'shell', '.zprofile': 'shell', crontab: 'shell', '.htaccess': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini', 'jenkinsfile': 'java' }
  const EXTS = { conf: 'ini', cnf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini', service: 'ini', timer: 'ini', socket: 'ini', mount: 'ini', toml: 'ini', vue: 'html', svelte: 'html', log: 'plaintext', jsonl: 'json', zsh: 'shell', bash: 'shell' }
  function languageFor(name, languages = []) {
    const lower = String(name).toLowerCase()
    if (NAMES[lower]) return NAMES[lower]
    if (lower.startsWith('.env.')) return 'ini'
    for (const l of languages) if ((l.filenames || []).some(f => f.toLowerCase() === lower)) return l.id
    let best = null, length = 0
    for (const l of languages) for (const ext of l.extensions || []) {
      const e = ext.toLowerCase()
      if (lower.endsWith(e) && lower.length > e.length && e.length > length) { best = l.id; length = e.length }
    }
    if (best) return best
    const dot = lower.lastIndexOf('.')
    return (dot > 0 && EXTS[lower.slice(dot + 1)]) || 'plaintext'
  }

  const api = { MAX_SIZE, ENCODINGS, decode, encode, lineEndings, languageFor }
  if (typeof module !== 'undefined') module.exports = api
  else window.editorFiles = api
})()
