// Scheduled tasks: crontab (user + system files) and systemd timers, over SSH without an agent.
// Pure model shared by main (snapshot, edits) and renderer (descriptions, next runs).
;(function () {
  // Shell snapshot. Sections are delimited by @@ markers; timestamps are converted to epoch seconds on the server.
  const SNAPSHOT = `
export LC_ALL=C
echo '@@NOW'
date '+%s %z'
id -un
echo '@@CRON'
if command -v crontab >/dev/null 2>&1; then crontab -l 2>/dev/null; rc=$?; echo; echo "@@CRONRC $rc"; else echo '@@CRONRC 127'; fi
for f in /etc/crontab /etc/cron.d/*; do
  [ -f "$f" ] && [ -r "$f" ] || continue
  echo "@@FILE $f"
  cat "$f"
  echo
done
echo '@@PERIODIC'
for d in hourly daily weekly monthly; do
  [ -d "/etc/cron.$d" ] || continue
  for f in /etc/cron.$d/*; do [ -f "$f" ] && [ -x "$f" ] && echo "$d $f"; done
done
echo '@@CRONSVC'
if command -v systemctl >/dev/null 2>&1; then
  for u in cron.service crond.service cronie.service; do
    [ "$(systemctl show -p LoadState --value "$u" 2>/dev/null)" = loaded ] && { echo "$u"; break; }
  done
fi
echo '@@TIMERS'
command -v systemctl >/dev/null 2>&1 || exit 0
ts() { case "$1" in @*) echo "$1" | cut -c2-;; ''|n/a|0) echo;; *) date -d "$1" +%s 2>/dev/null || echo;; esac; }
show() { systemctl show --timestamp=unix "$@" 2>/dev/null || systemctl show "$@" 2>/dev/null; }
{ systemctl list-units --type=timer --all --no-legend --plain --no-pager 2>/dev/null; systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null; } | awk '$1 ~ /\\.timer$/ {print $1}' | sort -u | while read -r t; do
  case "$t" in *@.timer) continue;; esac
  echo "@@T $t"
  show "$t" -p Unit -p Description -p ActiveState -p UnitFileState -p TimersCalendar -p TimersMonotonic -p Persistent --no-pager
  echo "NEXT=$(ts "$(show "$t" -p NextElapseUSecRealtime --value)")"
  echo "LAST=$(ts "$(show "$t" -p LastTriggerUSec --value)")"
  u=$(systemctl show -p Unit --value "$t" 2>/dev/null)
  [ -n "$u" ] || continue
  show "$u" -p Result -p ExecMainStatus -p ActiveState -p FragmentPath --no-pager | sed 's/^/S_/'
done
exit 0
`

  // ---------- crontab syntax ----------
  const OFF = '#cyberdog-off# '
  const KEYWORDS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

  class CronError extends Error { constructor(field, value) { super(`Invalid field ${field + 1}: ${value}`); this.field = field; this.value = value } }

  function parseField(text, i) {
    const [min, max] = FIELDS[i], names = i === 3 ? MONTHS : i === 4 ? DAYS : null
    const num = s => {
      const n = names && names.indexOf(s.toLowerCase())
      const v = n >= 0 && names ? n + (i === 3 ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN
      if (!(v >= min && v <= max)) throw new CronError(i, text)
      return v
    }
    const out = new Set()
    for (const part of text.split(',')) {
      const m = part.match(/^(\*|[^-/]+(?:-[^-/]+)?)(?:\/(\d+))?$/)
      if (!m) throw new CronError(i, text)
      const step = m[2] == null ? 1 : Number(m[2])
      if (!(step >= 1)) throw new CronError(i, text)
      let lo, hi
      if (m[1] === '*') { lo = min; hi = i === 4 ? 6 : max }
      else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(num) }
      else { lo = num(m[1]); hi = m[2] == null ? lo : i === 4 ? 6 : max }
      if (lo > hi) throw new CronError(i, text)
      for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v)
    }
    return out
  }

  // "0 3 * * 1-5" or "@daily" → schedule; throws CronError
  function parseSchedule(expr) {
    const text = String(expr || '').trim()
    if (text === '@reboot') return { reboot: true, expr: text }
    const fields = (KEYWORDS[text.toLowerCase()] || text).split(/\s+/)
    if (fields.length !== 5 || !fields[0]) throw new CronError(fields.length > 5 ? 5 : Math.max(0, fields.length - 1), text)
    const sets = fields.map(parseField)
    return { expr: text, fields, minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domStar: fields[2].startsWith('*'), dowStar: fields[4].startsWith('*') }
  }

  const SCHEDULE = /^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/
  const ENV = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
  function parseLine(line, system) {
    const m = line.trim().match(SCHEDULE)
    if (!m) return null
    let rest = m[2], user = null
    if (system) { const u = rest.match(/^(\S+)\s+(.*)$/); if (!u) return null; user = u[1]; rest = u[2] }
    if (!rest.trim()) return null
    try { parseSchedule(m[1]) } catch { return null }
    return { schedule: m[1], user, command: rest }
  }
  const unquote = v => { v = v.trim(); return /^(['"]).*\1$/.test(v) && v.length > 1 ? v.slice(1, -1) : v }

  // text of one crontab → entries with their line index, label (comment just above) and environment
  function parseCrontab(text, { system = false, source = 'user', file = null } = {}) {
    const lines = String(text).replace(/\r/g, '').split('\n'), entries = [], env = {}
    lines.forEach((raw, line) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      const off = raw.startsWith(OFF)
      if (trimmed.startsWith('#') && !off) return
      const e = !off && ENV.exec(trimmed)
      if (e && !SCHEDULE.test(trimmed.split('=')[0])) { env[e[1]] = unquote(e[2]); return }
      const entry = parseLine(off ? raw.slice(OFF.length) : raw, system)
      if (!entry) return
      const above = line > 0 ? lines[line - 1] : ''
      const label = /^#(?!cyberdog-off# )\s*(.+)$/.exec(above.trim())?.[1]
      const labelIsCode = label && (parseLine(label, system) || /^m\s+h\s+dom\s+mon\s+dow\b/i.test(label))
      entries.push({ ...entry, id: `${source}:${file || ''}:${line}`, source, file, line, raw, disabled: off, name: label && !labelIsCode ? label.trim() : '', labelLine: label && !labelIsCode ? line - 1 : null, env: { ...env } })
    })
    return entries
  }

  // ---------- next runs, in the server's wall clock (Date used through its UTC getters) ----------
  function nextRuns(schedule, fromMs, count = 5) {
    if (schedule.reboot) return []
    const out = []
    const d = new Date(Math.floor(fromMs / 60000) * 60000 + 60000)
    const dayOk = () => {
      const dom = schedule.dom.has(d.getUTCDate()), dow = schedule.dow.has(d.getUTCDay())
      return schedule.domStar || schedule.dowStar ? dom && dow : dom || dow
    }
    for (let guard = 0; out.length < count && guard < 200000; guard++) {
      if (d.getUTCFullYear() > new Date(fromMs).getUTCFullYear() + 8) break
      if (!schedule.month.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0); continue }
      if (!dayOk()) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0); continue }
      if (!schedule.hour.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0); continue }
      if (!schedule.minute.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1); continue }
      out.push(d.getTime())
      d.setUTCMinutes(d.getUTCMinutes() + 1)
    }
    return out
  }

  // ---------- human description: tr(key, vars), lang for Intl day/month names ----------
  const pad = n => String(n).padStart(2, '0')
  const sorted = set => [...set].sort((a, b) => a - b)
  const isAll = (set, i) => set.size === (i === 4 ? 7 : FIELDS[i][1] - FIELDS[i][0] + 1)
  const stepOf = (field, i) => { const m = field.match(/^\*\/(\d+)$/) || (i < 2 && field.match(/^0\/(\d+)$/)); return m ? Number(m[1]) : 0 }
  function describe(s, tr, lang = 'en') {
    if (s.reboot) return tr('cron.d.reboot')
    const list = items => { try { return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(items) } catch { return items.join(', ') } }
    const day = n => new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + n))
    const month = n => new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, n - 1, 1))
    const allDays = s.domStar && s.dowStar && isAll(s.month, 3)
    const months = text => isAll(s.month, 3) ? text : tr('cron.d.in_months', { text, months: list(sorted(s.month).map(month)) })
    if (allDays && isAll(s.hour, 1)) {
      if (isAll(s.minute, 0)) return tr('cron.d.every_minute')
      const n = stepOf(s.fields[0], 0)
      if (n) return tr('cron.d.every_n_minutes', { n })
      if (s.minute.size === 1) return tr('cron.d.hourly', { mm: pad(sorted(s.minute)[0]) })
    }
    if (allDays && s.minute.size === 1 && stepOf(s.fields[1], 1)) return tr('cron.d.every_n_hours', { n: stepOf(s.fields[1], 1), mm: pad(sorted(s.minute)[0]) })
    if (s.minute.size * s.hour.size > 4) return tr('cron.d.custom')
    const times = list(sorted(s.hour).flatMap(h => sorted(s.minute).map(m => `${pad(h)}:${pad(m)}`)))
    if (s.domStar && s.dowStar) return months(tr('cron.d.daily', { times }))
    if (s.domStar) {
      const days = sorted(s.dow)
      if (days.join() === '1,2,3,4,5') return months(tr('cron.d.weekdays', { times }))
      return months(tr('cron.d.weekly', { days: list(days.map(day)), times }))
    }
    if (s.dowStar) return months(tr('cron.d.monthly', { days: list(sorted(s.dom).map(String)), times }))
    return tr('cron.d.custom')
  }

  // ---------- systemd timers ----------
  function timerSchedule(t) {
    const cal = [...(t.TimersCalendar || '').matchAll(/OnCalendar=([^;]+?)\s*;/g)].map(m => m[1].trim())
    const mono = [...(t.TimersMonotonic || '').matchAll(/(On\w+?)(?:USec)?=([^;]+?)\s*;/g)].map(m => `${m[1].replace(/USec$/, '')}Sec=${m[2].trim()}`)
    return [...cal, ...mono].join(' · ')
  }

  // ---------- snapshot ----------
  function parse(out) {
    const text = String(out).replace(/\r/g, '')
    const now = text.match(/^@@NOW\n(\d+) ([+-]\d{4})\n(.*)$/m)
    if (!now) throw new Error('Incomplete schedule snapshot')
    const sign = now[2][0] === '-' ? -1 : 1, offset = sign * (Number(now[2].slice(1, 3)) * 60 + Number(now[2].slice(3, 5))) * 60
    const result = { now: Number(now[1]), offset, tz: now[2], me: now[3].trim(), cron: { available: false }, entries: [], periodic: [], cronService: '', timers: [] }
    const cron = text.match(/@@CRON\n([\s\S]*?)@@CRONRC (\d+)\n/)
    if (cron) {
      const rc = Number(cron[2])
      result.cron = { available: rc !== 127, text: rc === 0 ? cron[1].replace(/\n$/, '') : '' }
      result.entries.push(...parseCrontab(result.cron.text, { source: 'user' }).map(e => ({ ...e, user: result.me })))
    }
    for (const m of text.matchAll(/^@@FILE (\S+)\n([\s\S]*?)(?=^@@(?:FILE|PERIODIC)\b)/gm)) result.entries.push(...parseCrontab(m[2], { system: true, source: 'file', file: m[1] }))
    const periodic = text.match(/@@PERIODIC\n([\s\S]*?)@@CRONSVC/)?.[1] || ''
    for (const l of periodic.split('\n')) { const m = l.match(/^(hourly|daily|weekly|monthly) (\/\S+)$/); if (m) result.periodic.push({ id: 'periodic:' + m[2], source: 'periodic', period: m[1], file: m[2], user: 'root', command: m[2] }) }
    result.cronService = text.match(/@@CRONSVC\n([\w@.-]+\.service)\n/)?.[1] || ''
    for (const block of (text.split('@@TIMERS\n')[1] || '').split(/^@@T /m).slice(1)) {
      const [name, ...lines] = block.split('\n'), t = { name: name.trim() }, svc = {}
      for (const l of lines) { const m = l.match(/^(S_)?(\w+)=(.*)$/); if (m) (m[1] ? svc : t)[m[2]] = m[3] }
      if (!/^[\w@:.\\-]+\.timer$/.test(t.name)) continue
      result.timers.push({ id: 'timer:' + t.name, source: 'timer', name: t.name, unit: t.Unit || '', description: t.Description || '', active: t.ActiveState || '', enabled: t.UnitFileState || '', schedule: timerSchedule(t), persistent: t.Persistent === 'yes', next: Number(t.NEXT) || null, last: Number(t.LAST) || null, result: svc.Result || '', status: svc.ExecMainStatus == null ? null : Number(svc.ExecMainStatus), running: svc.ActiveState === 'active' || svc.ActiveState === 'activating', fragment: svc.FragmentPath || '' })
    }
    return result
  }

  // ---------- edits to the user's crontab (pure; main re-reads the crontab and checks the line) ----------
  const clean = (s, what) => { s = String(s ?? '').trim(); if (/[\r\n]/.test(s)) throw new Error(`invalid ${what}`); return s }
  function formatEntry({ schedule, command, name = '', disabled = false }) {
    schedule = clean(schedule, 'schedule'); command = clean(command, 'command'); name = clean(name, 'name')
    parseSchedule(schedule)
    if (!command) throw new Error('command required')
    return [...(name ? ['# ' + name] : []), (disabled ? OFF : '') + schedule + ' ' + command]
  }
  function applyEdit(text, op) {
    const lines = String(text).replace(/\r/g, '').replace(/\n+$/, '').split('\n')
    if (lines.length === 1 && !lines[0]) lines.length = 0
    if (op.type === 'add') { if (lines.length && lines[lines.length - 1].trim()) lines.push(''); lines.push(...formatEntry(op.entry)); return lines.join('\n') + '\n' }
    if (!Number.isSafeInteger(op.line) || lines[op.line] !== op.raw) throw new Error('crontab changed')
    const entry = parseCrontab(lines.join('\n')).find(e => e.line === op.line)
    if (!entry) throw new Error('crontab changed')
    const start = entry.labelLine ?? op.line
    let replacement
    if (op.type === 'delete') replacement = []
    else if (op.type === 'toggle') replacement = [...(entry.labelLine != null ? [lines[entry.labelLine]] : []), entry.disabled ? op.raw.slice(OFF.length) : OFF + op.raw]
    else if (op.type === 'update') replacement = formatEntry({ ...op.entry, disabled: entry.disabled })
    else throw new Error('invalid edit')
    lines.splice(start, op.line - start + 1, ...replacement)
    return lines.join('\n').replace(/\n+$/, '') + '\n'
  }

  // cron semantics: an unescaped % ends the command, the rest (with % as newlines) is its stdin; \% is a literal %
  function cronCommand(command) {
    let cmd = '', i = 0
    for (; i < command.length; i++) {
      if (command[i] === '\\' && command[i + 1] === '%') { cmd += '%'; i++; continue }
      if (command[i] === '%') break
      cmd += command[i]
    }
    const rest = i < command.length ? command.slice(i + 1).replace(/(^|[^\\])%/g, '$1\n').replace(/\\%/g, '%') : null
    return { command: cmd, stdin: rest == null ? undefined : rest + '\n' }
  }

  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
  // Script that runs a cron command now, the way cron would: from $HOME, with the crontab's variables and SHELL.
  function runScript(entry) {
    const { command } = cronCommand(entry.command)
    const env = Object.entries(entry.env || {}).filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
    const shell = env.find(([k]) => k === 'SHELL')?.[1] || '/bin/sh'
    return ['cd "$HOME" 2>/dev/null || cd /', ...env.map(([k, v]) => `export ${k}=${q(v)}`), `exec ${q(shell)} -c ${q(command)}`].join('\n')
  }

  const api = { SNAPSHOT, OFF, CronError, parseSchedule, parseCrontab, nextRuns, describe, parse, applyEdit, formatEntry, cronCommand, runScript, timerSchedule, q }
  if (typeof module !== 'undefined') module.exports = api
  else window.scheduleModel = api
})()
