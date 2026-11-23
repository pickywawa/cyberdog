// Configuration files the editor knows how to check and apply on the server: nginx, Apache, sshd, HAProxy, Caddy,
// systemd units, Docker Compose and sudoers. Pure: main builds the commands from here (never from the renderer),
// the renderer shows the buttons and turns the checker's output into markers on the edited file.
;(function () {
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
  const base = p => p.slice(p.lastIndexOf('/') + 1)
  const dir = p => p.slice(0, p.lastIndexOf('/')) || '/'
  const UNIT_EXT = /\.(service|timer|socket|path|mount|automount|target)$/
  // first service manager unit that exists among the names, for distributions that call it differently
  const firstUnit = names => `u=; for n in ${names.join(' ')}; do [ "$(systemctl show -p LoadState --value "$n" 2>/dev/null)" = loaded ] && { u=$n; break; }; done; [ -n "$u" ] || { echo 'Service not found: ${names.join(', ')}'; exit 1; }`
  const svc = (names, verb) => `${firstUnit(names)}; systemctl ${verb} "$u"`
  const status = names => `${firstUnit(names)}; echo "$u $(systemctl is-active "$u" 2>/dev/null)"`
  // the first existing binary among candidates (some are outside a non-root PATH)
  const bin = names => `b=; for n in ${names.join(' ')}; do command -v "$n" >/dev/null 2>&1 && { b=$n; break; }; [ -x "$n" ] && { b=$n; break; }; done; [ -n "$b" ] || { echo 'Not installed: ${names.map(base).join(', ')}'; exit 127; }`

  const PROFILES = [
    {
      id: 'nginx', name: 'nginx', sudo: true,
      match: p => /^\/etc\/nginx\//.test(p) || /(^|\/)nginx\.conf$/.test(p),
      units: ['nginx.service'],
      actions: { test: () => `${bin(['nginx', '/usr/sbin/nginx'])}; "$b" -t`, reload: () => svc(['nginx.service'], 'reload'), restart: () => svc(['nginx.service'], 'restart') },
      apply: 'reload',
    },
    {
      id: 'apache', name: 'Apache', sudo: true,
      match: p => /^\/etc\/(apache2|httpd)\//.test(p),
      units: ['apache2.service', 'httpd.service'],
      actions: { test: () => `${bin(['apachectl', 'apache2ctl', '/usr/sbin/apachectl', '/usr/sbin/apache2ctl'])}; "$b" configtest`, reload: () => svc(['apache2.service', 'httpd.service'], 'reload'), restart: () => svc(['apache2.service', 'httpd.service'], 'restart') },
      apply: 'reload',
    },
    {
      id: 'sshd', name: 'OpenSSH', sudo: true, careful: true,
      match: p => /^\/etc\/ssh\/sshd_config(\.d\/[^/]+)?$/.test(p),
      units: ['ssh.service', 'sshd.service'],
      // no restart: a reload keeps the open sessions, including this one
      actions: { test: () => `${bin(['sshd', '/usr/sbin/sshd'])}; "$b" -t`, reload: () => svc(['ssh.service', 'sshd.service'], 'reload') },
      apply: 'reload',
    },
    {
      id: 'haproxy', name: 'HAProxy', sudo: true,
      match: p => /^\/etc\/haproxy\/[^/]+\.cfg$/.test(p),
      units: ['haproxy.service'],
      actions: { test: p => `${bin(['haproxy', '/usr/sbin/haproxy'])}; "$b" -c -f ${q(p)}`, reload: () => svc(['haproxy.service'], 'reload'), restart: () => svc(['haproxy.service'], 'restart') },
      apply: 'reload',
    },
    {
      id: 'caddy', name: 'Caddy', sudo: true,
      match: p => /(^|\/)Caddyfile$/.test(p) || /^\/etc\/caddy\//.test(p),
      units: ['caddy.service'],
      actions: { test: p => `${bin(['caddy', '/usr/bin/caddy'])}; "$b" validate --config ${q(p)}${/Caddyfile$/.test(p) ? ' --adapter caddyfile' : ''}`, reload: () => svc(['caddy.service'], 'reload'), restart: () => svc(['caddy.service'], 'restart') },
      apply: 'reload',
    },
    {
      id: 'systemd', name: 'systemd', sudo: true,
      match: p => /^\/(etc|lib|usr\/lib)\/systemd\/system\/[^/]+$/.test(p) && UNIT_EXT.test(p),
      units: p => [base(p)],
      actions: { test: p => `systemd-analyze verify ${q(p)}`, 'daemon-reload': () => 'systemctl daemon-reload', restart: p => `systemctl daemon-reload && systemctl restart ${q(base(p))}` },
      apply: 'daemon-reload',
    },
    {
      id: 'compose', name: 'Docker Compose', sudo: false,
      match: p => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(p),
      actions: {
        test: p => `cd ${q(dir(p))} && docker compose -f ${q(base(p))} config -q`,
        up: p => `cd ${q(dir(p))} && docker compose -f ${q(base(p))} up -d --remove-orphans`,
        restart: p => `cd ${q(dir(p))} && docker compose -f ${q(base(p))} restart`,
      },
      status: p => `cd ${q(dir(p))} && docker compose -f ${q(base(p))} ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '{n++; if ($2=="running") r++} END {print "compose " (n ? r+0 "/" n : "0")}'`,
      apply: 'up',
    },
    {
      id: 'sudoers', name: 'sudo', sudo: true,
      match: p => p === '/etc/sudoers' || /^\/etc\/sudoers\.d\/[^/]+$/.test(p),
      actions: { test: p => `${bin(['visudo', '/usr/sbin/visudo'])}; "$b" -c -f ${q(p)}` },
      apply: null,
    },
  ]

  const SAFE_PATH = /^\/[^\0\n\r]*$/
  const profileFor = path => (typeof path === 'string' && SAFE_PATH.test(path) && PROFILES.find(p => p.match(path))) || null
  const actionsOf = profile => Object.keys(profile.actions)
  const unitsOf = (profile, path) => typeof profile.units === 'function' ? profile.units(path) : profile.units || []

  // shell command for an action on a file; null when the profile does not offer it
  function command(path, id, action) {
    const profile = profileFor(path)
    if (!profile || profile.id !== id) return null
    if (action === 'status') {
      if (profile.status) return { cmd: profile.status(path), sudo: false }
      const units = unitsOf(profile, path)
      return units.length ? { cmd: status(units), sudo: false } : null
    }
    const build = profile.actions[action]
    return build ? { cmd: build(path), sudo: profile.sudo } : null
  }

  // checker output -> problems in `path`: [{ line, message, severity }]
  function problems(out, path) {
    const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), name = base(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const patterns = [
      new RegExp(`${esc}:(\\d+)`), // nginx "in /etc/nginx/x:12", haproxy "[/etc/haproxy/haproxy.cfg:12]", systemd "/x.service:12:"
      new RegExp(`line (\\d+) of ${esc}`), // apache "Syntax error on line 12 of /etc/apache2/x.conf"
      new RegExp(`${esc}: line (\\d+)`), // sshd "/etc/ssh/sshd_config: line 12: Bad configuration option"
      new RegExp(`${esc}:? (?:syntax error )?near line (\\d+)`), // sudoers ">>> /etc/sudoers: syntax error near line 12 <<<"
      new RegExp(`(?:^|[\\s/])${name}:(\\d+)`), // caddy "Caddyfile:12"
      /\byaml: line (\d+)/i, // compose "yaml: line 12: did not find expected key"
    ]
    const found = [], lines = String(out).split('\n')
    lines.forEach((text, i) => {
      for (const re of patterns) {
        const m = text.match(re)
        if (!m) continue
        let message = text.replace(/^\s*(nginx: |\[ALERT\]\s*(\(\d+\)\s*)?:?\s*|>>> |AH\d+: )/, '').replace(/ <<<$/, '').trim()
        // Apache puts the reason on the next line
        if (/^Syntax error on line/.test(message) && lines[i + 1]?.trim()) message = lines[i + 1].trim()
        // the file and line are shown apart: keep the reason only
        message = message.replace(new RegExp(`\\s*(?:in )?\\[?${esc}(?::\\d+\\]?|: line \\d+)?:?`, 'g'), ' ').replace(/\s+/g, ' ').trim() || text.trim()
        const severity = /\b(warn|warning)\b/i.test(text) && !/\b(emerg|error|alert|fatal)\b/i.test(text) ? 'warning' : 'error'
        found.push({ line: Number(m[1]), message, severity })
        break
      }
    })
    return found.filter((p, i) => p.line > 0 && found.findIndex(o => o.line === p.line) === i) // one problem per line: the first, most precise
  }

  const api = { PROFILES, profileFor, actionsOf, command, problems, q }
  if (typeof module !== 'undefined') module.exports = api
  else window.configProfiles = api
})()
