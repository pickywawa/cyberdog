// Linux /proc + procps, no agent. Shared pure analysis in main and renderer.
;(function () {
  const SNAPSHOT = `
[ -r /proc/stat ] || { echo 'Process Explorer requires Linux /proc and procps.'; exit 1; }
export LC_ALL=C
printf '@@META\\n'
getconf CLK_TCK
cat /proc/uptime /proc/stat /proc/meminfo
printf '@@PS\\n'
ps -ww -eo pid=,ppid=,user:64=,stat=,rss=,etimes=,comm=,args= || exit 1
printf '@@TICKS\\n'
awk '{p=$1; sub(/^.*\\) /, ""); split($0,a," "); print p,a[12]+a[13],a[20]}' /proc/[0-9]*/stat 2>/dev/null
printf '@@GROUPS\\n'
awk '{print FILENAME " " $0}' /proc/[0-9]*/cgroup 2>/dev/null
exit 0
`
  function parse(out) {
    const parts = out.split(/^@@(?:META|PS|TICKS|GROUPS)\n/m)
    if (parts.length !== 5) throw new Error('Incomplete process snapshot')
    const meta = parts[1].trim().split('\n'), hz = Number(meta[0])
    const uptime = parseFloat(meta[1])
    if (!(hz > 0) || !Number.isFinite(uptime)) throw new Error('Invalid process clock')
    const ticks = new Map(parts[3].trim().split('\n').map(l => { const a = l.split(/\s+/); return [Number(a[0]), { ticks: Number(a[1]), start: a[2] }] }))
    const groups = new Map()
    for (const line of parts[4].split('\n')) {
      const m = line.match(/^\/proc\/(\d+)\/cgroup \d+:[^:]*:(.*)$/)
      if (!m) continue
      const g = groups.get(+m[1]) || {}
      g.service ||= m[2].match(/(?:^|\/)([^/]+\.service)(?:\/|$)/)?.[1] || ''
      g.container ||= m[2].match(/(?:docker[-/]|cri-containerd-)([a-f0-9]{64})/)?.[1] || ''
      groups.set(+m[1], g)
    }
    const list = []
    for (const l of parts[2].split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      if (!m || !ticks.has(+m[1])) continue // exited between ps and /proc
      list.push({ pid: +m[1], ppid: +m[2], user: m[3], state: m[4], rss: +m[5] * 1024, age: +m[6], name: m[7], command: m[8], ...ticks.get(+m[1]), ...groups.get(+m[1]) })
    }
    const cpu = (parts[1].match(/^cpu\s+(.+)$/m)?.[1] || '').trim().split(/\s+/).map(Number).slice(0, 8)
    const total = cpu.reduce((a, b) => a + b, 0), idle = (cpu[3] || 0) + (cpu[4] || 0)
    const mem = k => Number(parts[1].match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))?.[1] || 0) * 1024
    return { list, hz, uptime, total, idle, memTotal: mem('MemTotal'), memUsed: mem('MemTotal') - mem('MemAvailable') }
  }
  const identity = p => `${p.pid}:${p.start}`
  function observe(snapshot, previous, histories = new Map()) {
    const dt = previous ? snapshot.uptime - previous.uptime : 0
    const old = new Map((previous?.list || []).map(p => [identity(p), p]))
    const live = new Set()
    for (const p of snapshot.list) {
      const key = identity(p), before = old.get(key)
      live.add(key)
      p.cpu = before && dt > 0 ? Math.max(0, (p.ticks - before.ticks) / snapshot.hz / dt * 100) : null
      const history = (histories.get(key) || []).filter(x => snapshot.uptime - x.ts <= 300)
      p.alerts = []
      if (p.state.startsWith('Z')) p.alerts.push({ key: 'zombie' })
      if (p.state.startsWith('D')) p.alerts.push({ key: 'blocked' })
      const baseline = history.filter(x => x.cpu != null)
      const avg = baseline.reduce((s, x) => s + x.cpu, 0) / baseline.length
      if (baseline.length >= 5 && p.cpu >= 20 && p.cpu >= Math.max(1, avg) * 3) p.alerts.push({ key: 'spike', ratio: (p.cpu / Math.max(1, avg)).toFixed(1), seconds: Math.round(snapshot.uptime - baseline[0].ts) })
      else if (p.cpu >= 80) p.alerts.push({ key: 'high' })
      if (history.length >= 5 && p.rss - history[0].rss >= 32 * 1024 * 1024 && p.rss >= history[0].rss * 1.25) p.alerts.push({ key: 'growth', size: p.rss - history[0].rss })
      history.push({ ts: snapshot.uptime, cpu: p.cpu, rss: p.rss })
      histories.set(key, history.slice(-61))
    }
    for (const key of histories.keys()) if (!live.has(key)) histories.delete(key)
    snapshot.cpu = previous && snapshot.total > previous.total ? Math.max(0, Math.min(100, 100 * (1 - (snapshot.idle - previous.idle) / (snapshot.total - previous.total)))) : null
    return snapshot
  }
  function group(list, mode) {
    const byPid = new Map(list.map(p => [p.pid, p]))
    const root = p => { const seen = new Set([p.pid]); while (p.ppid > 1 && byPid.has(p.ppid) && !seen.has(p.ppid)) { p = byPid.get(p.ppid); seen.add(p.pid) } return `${p.name} · ${p.pid}` }
    const groups = new Map()
    for (const p of list) {
      const key = mode === 'user' ? p.user : mode === 'service' ? p.service || '—' : mode === 'container' ? p.container?.slice(0, 12) || '—' : mode === 'tree' ? root(p) : p.name
      if (!groups.has(key)) groups.set(key, { name: key, list: [], cpu: 0, rss: 0, alerts: 0 })
      const g = groups.get(key); g.list.push(p); g.cpu += p.cpu || 0; g.rss += p.rss; g.alerts += p.alerts.length
    }
    return [...groups.values()].sort((a, b) => b.alerts - a.alerts || b.cpu - a.cpu || b.rss - a.rss)
  }
  function target(p) {
    if (!p || !Number.isSafeInteger(p.pid) || p.pid <= 0 || typeof p.start !== 'string' || !/^\d+$/.test(p.start)) throw new Error('Invalid process identity')
    return p.pid
  }
  function guard(p) {
    const pid = target(p)
    return `s=$(cat /proc/${pid}/stat) || exit 1\ns=\${s##*) }\nset -- $s\nshift 19\n[ "$1" = '${p.start}' ] || { echo 'Process exited or PID reused'; exit 1; }\n`
  }
  function signal(p, sig) {
    if (p?.pid === 1) throw new Error('PID 1 is protected')
    if (!['TERM', 'KILL'].includes(sig)) throw new Error('Invalid signal')
    return guard(p) + `kill -${sig} ${p.pid}\n`
  }
  function details(p) {
    return guard(p) + `
export LC_ALL=C
printf '@@CWD\\n'
readlink /proc/${p.pid}/cwd 2>/dev/null || true
printf '@@COMMAND\\n'
tr '\\000' ' ' < /proc/${p.pid}/cmdline 2>/dev/null
printf '\\n@@PORTS\\n'
if command -v ss >/dev/null; then
 ss -lntup 2>&1 | awk 'NR==1 || /pid=${p.pid},/'
else echo 'ss unavailable'; fi
printf '@@CGROUP\\n'
cat /proc/${p.pid}/cgroup 2>/dev/null || true
printf '@@RESTARTS\\n'
unit=$(sed -n 's|.*[/]\\([^/]*\\.service\\).*|\\1|p' /proc/${p.pid}/cgroup 2>/dev/null | head -n 1)
if [ -n "$unit" ] && command -v systemctl >/dev/null; then systemctl show "$unit" -p NRestarts --value 2>/dev/null; fi
exit 0
`
  }
  const api = { SNAPSHOT, parse, observe, identity, group, target, guard, signal, details }
  if (typeof module !== 'undefined') module.exports = api
  else window.processModel = api
})()
