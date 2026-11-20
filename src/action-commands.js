// Cyberdog commands in the output of a quick action (tested in test/action-commands.test.js).
// A line "cyberdog:<command> <argument>" drives the app once the script has run:
//   download /path · open /path · terminal [/path] · refresh · notify text · url https://…
// and a form can ask the user for values, after which the same script runs again with them as variables:
//   title Text                          the form's title
//   select VAR|Label                    a list…
//   option VAR|value|Label              …and its choices (the label defaults to the value)
//   input VAR|Label|default             a text field
//   buttons VAR|Question|Yes=yes|No=no  buttons (Label=value; the label alone is also the value)
// Fields keep the order of the lines; their parts are separated by "|".
;(function () {
  const LINE = /^cyberdog:([a-z]+)(?:[ \t]+(.*?))?[ \t]*\r?$/
  const COMMANDS = ['download', 'open', 'terminal', 'refresh', 'notify', 'url']
  const FORM = ['title', 'select', 'option', 'input', 'buttons']
  const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
  const MAX_FIELDS = 20, MAX_OPTIONS = 500, MAX_VALUE = 4096

  // out: the action's output -> { output (without the form lines), commands: [{ name, arg }], form: { title, fields } | null }
  function parse(out) {
    const lines = String(out || '').split('\n'), keep = [], commands = []
    const fields = []
    let title = ''
    const field = (name, make) => {
      let f = fields.find(x => x.name === name)
      if (!f && fields.length < MAX_FIELDS) fields.push((f = make()))
      return f
    }
    for (const line of lines) {
      const m = line.match(LINE)
      if (!m || (!COMMANDS.includes(m[1]) && !FORM.includes(m[1]))) { keep.push(line); continue }
      const [, name, arg = ''] = m
      if (COMMANDS.includes(name)) { keep.push(line); if (commands.length < 20) commands.push({ name, arg }); continue }
      const parts = arg.split('|').map(s => s.trim()), v = parts[0]
      if (name === 'title') { title = arg.trim().slice(0, 200); continue }
      if (!VAR.test(v)) continue
      if (name === 'select') { const f = field(v, () => ({ name: v, type: 'select', label: v, options: [] })); if (f?.type === 'select') f.label = parts[1] || v }
      else if (name === 'option') {
        const value = parts[1] ?? ''
        if (!value || value.length > MAX_VALUE) continue
        const f = field(v, () => ({ name: v, type: 'select', label: v, options: [] }))
        if (f?.type === 'select' && f.options.length < MAX_OPTIONS) f.options.push({ value, label: parts.slice(2).join('|') || value })
      } else if (name === 'input') field(v, () => ({ name: v, type: 'input', label: parts[1] || v, value: (parts[2] || '').slice(0, MAX_VALUE) }))
      else if (name === 'buttons') {
        const buttons = parts.slice(2).filter(Boolean).slice(0, 10).map(b => { const i = b.indexOf('='); return i > 0 ? { label: b.slice(0, i).trim(), value: b.slice(i + 1).trim() } : { label: b, value: b } })
        if (buttons.length) field(v, () => ({ name: v, type: 'buttons', label: parts[1] || v, buttons }))
      }
    }
    const usable = fields.filter(f => f.type !== 'select' || f.options.length)
    return { output: keep.join('\n'), commands, form: usable.length ? { title, fields: usable } : null }
  }

  // Answers -> shell lines that set them, quoted: export FILE='/var/backups/a b.tgz'
  function exports(vars) {
    return Object.entries(vars || {}).filter(([k, v]) => VAR.test(k) && typeof v === 'string' && v.length <= MAX_VALUE && !v.includes('\0'))
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'\n`).join('')
  }

  const api = { parse, exports, COMMANDS, VAR }
  if (typeof module !== 'undefined') module.exports = api
  else window.actionCommands = api
})()
