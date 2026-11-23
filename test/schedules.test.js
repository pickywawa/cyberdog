const assert = require('assert')
const { spawnSync } = require('child_process')
const m = require('../src/schedules')

// ---------- schedule syntax ----------
const s = m.parseSchedule('*/15 9-17 * * mon-fri')
assert.deepStrictEqual([...s.minute], [0, 15, 30, 45])
assert.deepStrictEqual([...s.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17])
assert.deepStrictEqual([...s.dow], [1, 2, 3, 4, 5])
assert.deepStrictEqual([...m.parseSchedule('0 0 * * 5-7').dow].sort(), [0, 5, 6], 'Sunday is 0 or 7')
assert.deepStrictEqual([...m.parseSchedule('0 0 * jan,jul *').month], [1, 7])
assert.deepStrictEqual([...m.parseSchedule('5/20 * * * *').minute], [5, 25, 45])
assert.ok(m.parseSchedule('@reboot').reboot)
assert.deepStrictEqual(m.parseSchedule('@daily').fields, ['0', '0', '*', '*', '*'])
for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'L * * * *', '@sometimes', '* * * * * *'])
  assert.throws(() => m.parseSchedule(bad), m.CronError, bad)
try { m.parseSchedule('0 25 * * *') } catch (e) { assert.strictEqual(e.field, 1); assert.strictEqual(e.value, '25') }

// ---------- next runs (wall clock through UTC getters) ----------
const at = iso => Date.parse(iso + 'Z')
const iso = ms => new Date(ms).toISOString().slice(0, 16)
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('30 3 * * *'), at('2026-11-23T10:00'), 2).map(iso), ['2026-11-24T03:30', '2026-11-25T03:30'])
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('*/20 * * * *'), at('2026-11-23T10:05'), 3).map(iso), ['2026-11-23T10:20', '2026-11-23T10:40', '2026-11-23T11:00'])
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('0 9 * * 1-5'), at('2026-11-27T12:00'), 2).map(iso), ['2026-11-30T09:00', '2026-12-01T09:00'], 'skips the weekend')
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('0 0 29 2 *'), at('2026-01-01T00:00'), 1).map(iso), ['2028-02-29T00:00'], 'leap day')
// day-of-month and day-of-week both restricted: either matches (vixie cron)
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('0 0 1 * 1'), at('2026-11-23T12:00'), 3).map(iso), ['2026-11-30T00:00', '2026-12-01T00:00', '2026-12-07T00:00'])
// a field starting with * counts as unrestricted: both must match
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('0 0 */2 * 1'), at('2026-11-23T12:00'), 1).map(iso), ['2026-12-07T00:00'])
assert.deepStrictEqual(m.nextRuns(m.parseSchedule('@reboot'), at('2026-11-23T12:00')), [])

// ---------- descriptions ----------
const tr = (k, v = {}) => k + JSON.stringify(v)
const d = e => m.describe(m.parseSchedule(e), tr, 'en')
assert.strictEqual(d('* * * * *'), 'cron.d.every_minute{}')
assert.strictEqual(d('*/5 * * * *'), 'cron.d.every_n_minutes{"n":5}')
assert.strictEqual(d('7 * * * *'), 'cron.d.hourly{"mm":"07"}')
assert.strictEqual(d('0 */6 * * *'), 'cron.d.every_n_hours{"n":6,"mm":"00"}')
assert.strictEqual(d('@daily'), 'cron.d.daily{"times":"00:00"}')
assert.strictEqual(d('0 8,18 * * *'), 'cron.d.daily{"times":"08:00 and 18:00"}')
assert.strictEqual(d('30 9 * * 1-5'), 'cron.d.weekdays{"times":"09:30"}')
assert.strictEqual(d('0 9 * * 1,3'), 'cron.d.weekly{"days":"Monday and Wednesday","times":"09:00"}')
assert.strictEqual(d('0 4 1,15 * *'), 'cron.d.monthly{"days":"1 and 15","times":"04:00"}')
assert.strictEqual(d('0 0 1 1 *'), 'cron.d.in_months{"text":"cron.d.monthly{\\"days\\":\\"1\\",\\"times\\":\\"00:00\\"}","months":"January"}')
assert.strictEqual(d('*/10 9-17 * * *'), 'cron.d.custom{}')
assert.strictEqual(d('@reboot'), 'cron.d.reboot{}')
assert.strictEqual(m.describe(m.parseSchedule('0 9 * * 1'), tr, 'fr'), 'cron.d.weekly{"days":"lundi","times":"09:00"}')

// ---------- crontab parsing ----------
const tab = `# m h  dom mon dow   command
MAILTO=ops@example.com
PATH="/usr/local/bin:/usr/bin:/bin"
# Nightly backup
30 3 * * * /usr/local/bin/backup.sh --full > /var/log/backup.log 2>&1

@reboot /opt/app/start.sh
#cyberdog-off# */5 * * * * curl -s https://example.com/ping
# 0 4 * * * old-disabled-job
not a cron line
`
const entries = m.parseCrontab(tab)
assert.strictEqual(entries.length, 3)
assert.deepStrictEqual(entries.map(e => [e.line, e.schedule, e.name, e.disabled]), [[4, '30 3 * * *', 'Nightly backup', false], [6, '@reboot', '', false], [7, '*/5 * * * *', '', true]])
assert.strictEqual(entries[0].command, '/usr/local/bin/backup.sh --full > /var/log/backup.log 2>&1')
assert.deepStrictEqual(entries[0].env, { MAILTO: 'ops@example.com', PATH: '/usr/local/bin:/usr/bin:/bin' })
assert.strictEqual(entries[0].labelLine, 3)
const sys = m.parseCrontab('# m h dom mon dow user\tcommand\n17 *\t* * *\troot    cd / && run-parts --report /etc/cron.hourly\n', { system: true, source: 'file', file: '/etc/crontab' })
assert.deepStrictEqual(sys.map(e => [e.user, e.command, e.name]), [['root', 'cd / && run-parts --report /etc/cron.hourly', '']], 'the column header is not a name')

// ---------- edits ----------
const added = m.applyEdit(tab, { type: 'add', entry: { name: 'Cleanup', schedule: '0 2 * * 0', command: 'find /tmp -mtime +7 -delete' } })
assert.ok(added.endsWith('not a cron line\n\n# Cleanup\n0 2 * * 0 find /tmp -mtime +7 -delete\n'))
assert.strictEqual(m.applyEdit('', { type: 'add', entry: { schedule: '@hourly', command: 'date' } }), '@hourly date\n')
const e0 = entries[0]
const updated = m.applyEdit(tab, { type: 'update', line: e0.line, raw: e0.raw, entry: { name: 'Backup', schedule: '0 1 * * *', command: '/usr/local/bin/backup.sh' } })
assert.ok(updated.includes('\n# Backup\n0 1 * * * /usr/local/bin/backup.sh\n\n@reboot'))
assert.ok(!updated.includes('Nightly'))
const unnamed = m.applyEdit(tab, { type: 'update', line: e0.line, raw: e0.raw, entry: { name: '', schedule: '0 1 * * *', command: 'x' } })
assert.ok(unnamed.includes('PATH="/usr/local/bin:/usr/bin:/bin"\n0 1 * * * x\n'), 'an emptied name removes its comment')
const toggled = m.applyEdit(tab, { type: 'toggle', line: e0.line, raw: e0.raw })
assert.ok(toggled.includes('# Nightly backup\n#cyberdog-off# 30 3 * * * /usr/local/bin/backup.sh'))
const back = m.parseCrontab(toggled)
assert.ok(back[0].disabled && back[0].name === 'Nightly backup')
assert.strictEqual(m.applyEdit(toggled, { type: 'toggle', line: back[0].line, raw: back[0].raw }), tab)
const kept = m.parseCrontab(m.applyEdit(toggled, { type: 'update', line: back[0].line, raw: back[0].raw, entry: { schedule: '0 5 * * *', command: 'y' } }))
assert.ok(kept[0].disabled, 'editing a disabled task keeps it disabled')
const deleted = m.applyEdit(tab, { type: 'delete', line: e0.line, raw: e0.raw })
assert.ok(!deleted.includes('backup') && !deleted.includes('Nightly'))
assert.strictEqual(m.parseCrontab(deleted).length, 2)
assert.throws(() => m.applyEdit(tab, { type: 'delete', line: e0.line, raw: 'something else' }), /changed/)
assert.throws(() => m.applyEdit(tab, { type: 'delete', line: 0, raw: '# m h  dom mon dow   command' }), /changed/, 'comments are not entries')
assert.throws(() => m.applyEdit(tab, { type: 'add', entry: { schedule: '0 2 * * *', command: 'a\nb' } }), /invalid command/)
assert.throws(() => m.applyEdit(tab, { type: 'add', entry: { schedule: '99 * * * *', command: 'a' } }), m.CronError)
assert.throws(() => m.applyEdit(tab, { type: 'add', entry: { schedule: '* * * * *', command: ' ' } }), /command required/)

// ---------- % in commands ----------
assert.deepStrictEqual(m.cronCommand('date +\\%F'), { command: 'date +%F', stdin: undefined })
assert.deepStrictEqual(m.cronCommand('mail -s hi root%line one%line two'), { command: 'mail -s hi root', stdin: 'line one\nline two\n' })

// ---------- run script, executed by a real shell ----------
const script = m.runScript({ command: `printf '\\%s|\\%s' "$GREETING" "$(pwd)"; echo; echo it\\'s \\% ok`, env: { GREETING: "it's me", 'BAD-NAME': 'x' } })
const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { HOME: __dirname, PATH: process.env.PATH } })
assert.strictEqual(r.stdout, `it's me|${__dirname}\nit's % ok\n`)

// ---------- snapshot ----------
const raw = `@@NOW
1795435200 +0100
deploy
@@CRON
# Nightly backup
30 3 * * * /srv/backup.sh

@@CRONRC 0
@@FILE /etc/crontab
SHELL=/bin/sh
17 * * * * root cd / && run-parts --report /etc/cron.hourly

@@FILE /etc/cron.d/certbot
0 */12 * * * root test -x /usr/bin/certbot && certbot -q renew

@@PERIODIC
daily /etc/cron.daily/logrotate
weekly /etc/cron.weekly/man-db
@@CRONSVC
cron.service
@@TIMERS
@@T logrotate.timer
Unit=logrotate.service
Description=Daily rotation of log files
ActiveState=active
UnitFileState=enabled
TimersCalendar={ OnCalendar=*-*-* 00:00:00 ; next_elapse=@1795478400 }
TimersMonotonic=
Persistent=yes
NEXT=1795478400
LAST=1795392000
S_Result=success
S_ExecMainStatus=0
S_ActiveState=inactive
S_FragmentPath=/lib/systemd/system/logrotate.service
@@T fstrim.timer
Unit=fstrim.service
Description=Discard unused blocks once a week
ActiveState=inactive
UnitFileState=disabled
TimersCalendar={ OnCalendar=weekly ; next_elapse=n/a }
TimersMonotonic={ OnBootUSec=15min ; next_elapse=0 }
Persistent=no
NEXT=
LAST=
S_Result=exit-code
S_ExecMainStatus=1
S_ActiveState=failed
@@T bad name.timer
Unit=x
`
const snap = m.parse(raw)
assert.strictEqual(snap.now, 1795435200)
assert.strictEqual(snap.offset, 3600)
assert.strictEqual(snap.me, 'deploy')
assert.ok(snap.cron.available)
assert.deepStrictEqual(snap.entries.map(e => [e.source, e.file, e.user, e.name]), [['user', null, 'deploy', 'Nightly backup'], ['file', '/etc/crontab', 'root', ''], ['file', '/etc/cron.d/certbot', 'root', '']])
assert.deepStrictEqual(snap.entries[1].env, { SHELL: '/bin/sh' })
assert.deepStrictEqual(snap.periodic.map(p => [p.period, p.file]), [['daily', '/etc/cron.daily/logrotate'], ['weekly', '/etc/cron.weekly/man-db']])
assert.strictEqual(snap.cronService, 'cron.service')
assert.strictEqual(snap.timers.length, 2, 'invalid unit names are dropped')
assert.deepStrictEqual(snap.timers.map(t => [t.name, t.unit, t.schedule, t.next, t.last, t.result, t.status, t.enabled]), [
  ['logrotate.timer', 'logrotate.service', '*-*-* 00:00:00', 1795478400, 1795392000, 'success', 0, 'enabled'],
  ['fstrim.timer', 'fstrim.service', 'weekly · OnBootSec=15min', null, null, 'exit-code', 1, 'disabled']])
const none = m.parse('@@NOW\n1795435200 -0430\nbob\n@@CRON\n\n@@CRONRC 1\n@@PERIODIC\n@@CRONSVC\n@@TIMERS\n')
assert.strictEqual(none.offset, -(4 * 3600 + 30 * 60))
assert.deepStrictEqual([none.cron.available, none.entries.length, none.timers.length], [true, 0, 0], 'no crontab for user')
assert.strictEqual(m.parse('@@NOW\n1 +0000\nx\n@@CRON\n@@CRONRC 127\n@@PERIODIC\n@@CRONSVC\n@@TIMERS\n').cron.available, false)
assert.throws(() => m.parse('garbage'), /Incomplete/)

// The snapshot script is valid POSIX sh and runs where crontab/systemd may be missing.
const syntax = spawnSync('sh', ['-n'], { input: m.SNAPSHOT, encoding: 'utf8' })
assert.strictEqual(syntax.status, 0, syntax.stderr)
const local = spawnSync('sh', ['-s'], { input: m.SNAPSHOT, encoding: 'utf8', timeout: 20000 })
assert.strictEqual(local.status, 0, local.stderr)
assert.ok(m.parse(local.stdout).me)

console.log('ok')
