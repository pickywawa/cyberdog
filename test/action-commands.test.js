// Cyberdog commands and forms in an action's output; answers passed back as shell variables.
const assert = require('assert')
const cp = require('child_process')
const { parse, exports: toShell } = require('../src/action-commands')

const out = [
  'Backups found: 2',
  'cyberdog:title Download a backup',
  'cyberdog:select FILE|Backup',
  'cyberdog:option FILE|/var/backups/site 1.tgz|Site (12 MB)',
  'cyberdog:option FILE|/var/backups/db.sql.gz',
  'cyberdog:input NAME|Rename to|copy.tgz',
  'cyberdog:buttons OK|Notify the team?|Yes=yes|No=no|Later',
  'cyberdog:option BAD-NAME|x',          // invalid variable: ignored
  'cyberdog:select EMPTY|Nothing',       // a list without choices is left out
  'cyberdog:notify Ready',
  'cyberdog:unknown stays as output',
].join('\n')
const r = parse(out)
assert.strictEqual(r.output, 'Backups found: 2\ncyberdog:notify Ready\ncyberdog:unknown stays as output', 'form lines are removed from the output')
assert.deepStrictEqual(r.commands, [{ name: 'notify', arg: 'Ready' }])
assert.strictEqual(r.form.title, 'Download a backup')
assert.deepStrictEqual(r.form.fields, [
  { name: 'FILE', type: 'select', label: 'Backup', options: [{ value: '/var/backups/site 1.tgz', label: 'Site (12 MB)' }, { value: '/var/backups/db.sql.gz', label: '/var/backups/db.sql.gz' }] },
  { name: 'NAME', type: 'input', label: 'Rename to', value: 'copy.tgz' },
  { name: 'OK', type: 'buttons', label: 'Notify the team?', buttons: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }, { label: 'Later', value: 'Later' }] },
])
assert.strictEqual(parse('just output\ncyberdog:download /tmp/a').form, null)
assert.strictEqual(parse('cyberdog:download /tmp/a\r').commands[0].arg, '/tmp/a', 'CRLF output')

// answers become variables, safely quoted (quotes, $, backticks, newlines stay text)
const tricky = { FILE: "/tmp/it's $(rm -rf /) `x`\nsecond", 'BAD-NAME': 'x', N: 'ok' }
const prefix = toShell(tricky)
assert(!prefix.includes('BAD-NAME'))
const echoed = cp.execFileSync('bash', ['-c', prefix + 'printf "%s|%s" "$FILE" "$N"']).toString()
assert.strictEqual(echoed, tricky.FILE + '|ok')
console.log('action commands ok')
