// Normalisation des lignes de logs (journalctl -o json, fichiers, docker) et niveau de sévérité.
// Double usage : require() côté main, <script> côté renderer (window.logfmt).
;(function () {
  // PRIORITY syslog : 0-3 erreur, 4 avertissement, 5-6 info, 7 debug
  const LEVEL_OF_PRIORITY = ['error', 'error', 'error', 'error', 'warn', 'info', 'info', 'debug']

  // Sévérité d'une ligne sans niveau explicite (nginx, applis, docker…)
  function levelOf(text) {
    if (/\b(fatal|panic|crit(ical)?|alert|emerg|error|exception|traceback|segfault|failed|failure)\b/i.test(text) || /" 5\d\d /.test(text)) return 'error'
    if (/\b(warn(ing)?|deprecated|timed? ?out|denied|refused|retry)\b/i.test(text) || /" 4\d\d /.test(text)) return 'warn'
    if (/\bdebug\b/i.test(text)) return 'debug'
    return 'info'
  }

  const text = m => (Array.isArray(m) ? Buffer.from(m).toString('utf8') : String(m ?? ''))

  // ligne brute -> { ts?, src?, lv?, m, err? }
  function normalize(kind, line, isErr) {
    if (isErr) return { m: line, err: true }
    if (kind === 'journal') {
      try {
        const j = JSON.parse(line)
        return {
          ts: Math.round(+j.__REALTIME_TIMESTAMP / 1000) || undefined,
          src: j.SYSLOG_IDENTIFIER || j._COMM || j._SYSTEMD_UNIT,
          lv: LEVEL_OF_PRIORITY[+j.PRIORITY] ?? undefined,
          m: text(j.MESSAGE),
        }
      } catch {} // ligne non JSON (« -- No entries -- »)
    }
    return { m: line }
  }

  const api = { levelOf, normalize }
  if (typeof module !== 'undefined') module.exports = api
  else window.logfmt = api
})()
