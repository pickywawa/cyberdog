const assert = require('assert')
const { spawnSync } = require('child_process')
const c = require('../src/config-profiles')

// ---------- detection ----------
const id = p => c.profileFor(p)?.id || null
assert.strictEqual(id('/etc/nginx/nginx.conf'), 'nginx')
assert.strictEqual(id('/etc/nginx/sites-available/example.com'), 'nginx')
assert.strictEqual(id('/opt/openresty/nginx/conf/nginx.conf'), 'nginx')
assert.strictEqual(id('/etc/apache2/sites-enabled/000-default.conf'), 'apache')
assert.strictEqual(id('/etc/httpd/conf/httpd.conf'), 'apache')
assert.strictEqual(id('/etc/ssh/sshd_config'), 'sshd')
assert.strictEqual(id('/etc/ssh/sshd_config.d/50-cloud-init.conf'), 'sshd')
assert.strictEqual(id('/etc/ssh/ssh_config'), null, 'the client configuration is not the server')
assert.strictEqual(id('/etc/haproxy/haproxy.cfg'), 'haproxy')
assert.strictEqual(id('/etc/caddy/Caddyfile'), 'caddy')
assert.strictEqual(id('/srv/site/Caddyfile'), 'caddy')
assert.strictEqual(id('/etc/systemd/system/api.service'), 'systemd')
assert.strictEqual(id('/lib/systemd/system/backup.timer'), 'systemd')
assert.strictEqual(id('/etc/systemd/system/api.service.d/override.conf'), null)
assert.strictEqual(id('/srv/app/docker-compose.yml'), 'compose')
assert.strictEqual(id('/srv/app/compose.yaml'), 'compose')
assert.strictEqual(id('/srv/app/docker-compose.prod.yml'), 'compose')
assert.strictEqual(id('/srv/app/config.yml'), null)
assert.strictEqual(id('/etc/sudoers'), 'sudoers')
assert.strictEqual(id('/etc/sudoers.d/deploy'), 'sudoers')
assert.strictEqual(id('/etc/hosts'), null)
assert.strictEqual(id('relative/nginx.conf'), null)
assert.strictEqual(id('/etc/nginx/x\nrm -rf /'), null, 'no newline in paths')

// ---------- commands ----------
assert.strictEqual(c.command('/etc/nginx/nginx.conf', 'apache', 'test'), null, 'the profile must be the file’s own')
assert.strictEqual(c.command('/etc/nginx/nginx.conf', 'nginx', 'rm'), null)
assert.strictEqual(c.command('/etc/ssh/sshd_config', 'sshd', 'restart'), null, 'sshd is only reloaded')
assert.strictEqual(c.command('/etc/sudoers', 'sudoers', 'reload'), null)
assert.deepStrictEqual(c.actionsOf(c.profileFor('/etc/nginx/nginx.conf')), ['test', 'reload', 'restart'])
assert.strictEqual(c.profileFor('/etc/nginx/nginx.conf').apply, 'reload')
assert.strictEqual(c.profileFor('/srv/app/compose.yaml').apply, 'up')
assert.strictEqual(c.profileFor('/etc/sudoers').apply, null)
const tricky = "/srv/it's here/docker-compose.yml"
const up = c.command(tricky, 'compose', 'up')
assert.strictEqual(up.sudo, false)
assert.ok(up.cmd.includes(`cd '/srv/it'\\''s here' && docker compose -f 'docker-compose.yml' up -d`))
assert.ok(c.command('/etc/systemd/system/api.service', 'systemd', 'restart').cmd.endsWith("systemctl daemon-reload && systemctl restart 'api.service'"))
assert.ok(c.command('/etc/haproxy/haproxy.cfg', 'haproxy', 'test').cmd.endsWith(`"$b" -c -f '/etc/haproxy/haproxy.cfg'`))
assert.ok(c.command('/etc/caddy/Caddyfile', 'caddy', 'test').cmd.includes('--adapter caddyfile'))
assert.ok(c.command('/etc/caddy/caddy.json', 'caddy', 'test').cmd.endsWith(`validate --config '/etc/caddy/caddy.json'`))

// every command is valid sh, and a missing tool / unit says so instead of failing silently
const paths = ['/etc/nginx/nginx.conf', '/etc/apache2/apache2.conf', '/etc/ssh/sshd_config', '/etc/haproxy/haproxy.cfg', '/etc/caddy/Caddyfile', '/etc/systemd/system/api.service', tricky, '/etc/sudoers']
for (const p of paths) {
  const prof = c.profileFor(p)
  for (const a of [...c.actionsOf(prof), 'status']) {
    const spec = c.command(p, prof.id, a)
    if (!spec) continue
    const r = spawnSync('sh', ['-n', '-c', spec.cmd], { encoding: 'utf8' })
    assert.strictEqual(r.status, 0, `${prof.id} ${a}: ${r.stderr}`)
  }
}
const env = { PATH: '/nonexistent' }
// the absolute fallback is pointed elsewhere: CI images (GitHub's Ubuntu) do have /usr/sbin/nginx
const missing = spawnSync('/bin/sh', ['-c', c.command('/etc/nginx/nginx.conf', 'nginx', 'test').cmd.replace('/usr/sbin/nginx', '/nonexistent/nginx')], { encoding: 'utf8', env })
assert.strictEqual(missing.status, 127)
assert.ok(missing.stdout.includes('Not installed: nginx'))
const noUnit = spawnSync('/bin/sh', ['-c', c.command('/etc/nginx/nginx.conf', 'nginx', 'status').cmd], { encoding: 'utf8', env })
assert.strictEqual(noUnit.status, 1)
assert.ok(noUnit.stdout.includes('Service not found: nginx.service'))

// ---------- checker output → problems in the edited file ----------
const P = (out, p) => c.problems(out, p).map(x => [x.line, x.message, x.severity])
assert.deepStrictEqual(P(`nginx: [emerg] unknown directive "server_nme" in /etc/nginx/sites-enabled/app:12
nginx: configuration file /etc/nginx/nginx.conf test failed`, '/etc/nginx/sites-enabled/app'), [[12, '[emerg] unknown directive "server_nme"', 'error']])
assert.deepStrictEqual(P(`nginx: [warn] conflicting server name "a.com" on 0.0.0.0:80, ignored in /etc/nginx/sites-enabled/app:3
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok`, '/etc/nginx/sites-enabled/app'), [[3, '[warn] conflicting server name "a.com" on 0.0.0.0:80, ignored', 'warning']])
assert.deepStrictEqual(P('nginx: [emerg] unknown directive "x" in /etc/nginx/other.conf:4', '/etc/nginx/nginx.conf'), [], 'errors in other files are not put on this one')
assert.deepStrictEqual(P(`AH00526: Syntax error on line 7 of /etc/apache2/sites-enabled/site.conf:
Invalid command 'ServerNme', perhaps misspelled or defined by a module not included in the server configuration
Action 'configtest' failed.`, '/etc/apache2/sites-enabled/site.conf'), [[7, "Invalid command 'ServerNme', perhaps misspelled or defined by a module not included in the server configuration", 'error']])
assert.deepStrictEqual(P('/etc/ssh/sshd_config: line 33: Bad configuration option: PermitRootLogn\n/etc/ssh/sshd_config: terminating, 1 bad configuration options', '/etc/ssh/sshd_config'), [[33, 'Bad configuration option: PermitRootLogn', 'error']])
assert.deepStrictEqual(P(`[NOTICE]   (1234) : haproxy version is 2.8.5
[ALERT]    (1234) : config : parsing [/etc/haproxy/haproxy.cfg:41] : unknown keyword 'bnd' in 'frontend' section`, '/etc/haproxy/haproxy.cfg').map(x => x[0]), [41])
assert.deepStrictEqual(P('Error: adapting config using caddyfile: /etc/caddy/Caddyfile:5: unrecognized directive: reverse_proxi', '/etc/caddy/Caddyfile').map(x => x[0]), [5])
assert.deepStrictEqual(P("/etc/systemd/system/api.service:9: Unknown key name 'ExecStar' in section 'Service', ignoring.", '/etc/systemd/system/api.service').map(x => x[0]), [9])
assert.deepStrictEqual(P('>>> /etc/sudoers.d/deploy: syntax error near line 2 <<<\nparse error in /etc/sudoers.d/deploy near line 2', '/etc/sudoers.d/deploy').map(x => x.slice(0, 2)), [[2, 'syntax error near line 2']])
assert.deepStrictEqual(P('yaml: line 8: did not find expected key', '/srv/app/docker-compose.yml').map(x => x[0]), [8])
assert.deepStrictEqual(P('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful', '/etc/nginx/nginx.conf'), [])

console.log('ok')
