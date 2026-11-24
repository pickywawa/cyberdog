const assert = require('assert')
const M = require('../src/databases')

// ---------- discovery ----------
const snap = M.parseSnapshot(`@@PS
postgres        /usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main -c config_file=/etc/postgresql/15/main/postgresql.conf
mariadbd        /usr/sbin/mariadbd --basedir=/usr --datadir=/var/lib/mysql --user=mysql --log-error=/var/log/mysql/error.log
redis-server    /usr/bin/redis-server 127.0.0.1:6380
@@SS
LISTEN 0      244     127.0.0.1:5432  0.0.0.0:*
LISTEN 0      80      127.0.0.1:3306  0.0.0.0:*
LISTEN 0      511     127.0.0.1:6380  0.0.0.0:*
@@CLUSTERS
15  main    5432 online postgres /var/lib/postgresql/15/main /var/log/postgresql/postgresql-15-main.log
14  old     5433 down   postgres /var/lib/postgresql/14/old  /var/log/postgresql/postgresql-14-old.log
@@BIN
psql
mariadb
redis-cli
docker
@@SUDO
nopass
@@UNITS
mariadb.service loaded active running MariaDB 10.11 database server
postgresql@15-main.service loaded active running PostgreSQL Cluster 15-main
redis-server.service loaded active running Advanced key-value store
@@END
`)
assert.strictEqual(snap.sudo, 'nopass')
const byId = Object.fromEntries(snap.instances.map(x => [x.id, x]))
assert.deepStrictEqual(Object.keys(byId).sort(), ['local:mysql:3306', 'local:postgres:5432', 'local:postgres:5433', 'local:redis:6380'])
assert.strictEqual(byId['local:postgres:5432'].logFile, '/var/log/postgresql/postgresql-15-main.log')
assert.strictEqual(byId['local:postgres:5432'].unit, 'postgresql@15-main.service')
assert.strictEqual(byId['local:postgres:5433'].status, 'stopped', 'a cluster that is down')
assert.strictEqual(byId['local:mysql:3306'].flavor, 'MariaDB')
assert.strictEqual(byId['local:mysql:3306'].logFile, '/var/log/mysql/error.log')
assert.strictEqual(byId['local:redis:6380'].port, 6380)
assert.strictEqual(byId['local:redis:6380'].unit, 'redis-server.service')

// processes hidden from the account: the usual ports, when the client is there; a stopped service is listed too
const hidden = M.parseSnapshot('@@PS\n@@SS\nLISTEN 0 128 0.0.0.0:5432 0.0.0.0:*\n@@CLUSTERS\n@@BIN\npsql\n@@SUDO\nno\n@@UNITS\nredis-server.service loaded inactive dead Advanced key-value store\n@@END\n')
assert.deepStrictEqual(hidden.instances.map(x => [x.id, x.status]), [['local:postgres:5432', 'running'], ['local:redis:6379', 'stopped']])
assert.strictEqual(hidden.sudo, 'no')

// containers: engine from the image, credentials from the environment / command line (kept out of the public view)
const ps = [
  { Names: 'shop-db', Image: 'postgres:16-alpine', State: 'running' },
  { Names: 'cache', Image: 'redis:7', State: 'running' },
  { Names: 'blog', Image: 'docker.io/library/mariadb:11', State: 'exited' },
  { Names: 'web', Image: 'nginx:1.27', State: 'running' },
  { Names: 'bad name;rm', Image: 'mysql:8', State: 'running' },
].map(x => JSON.stringify(x))
const inspected = [
  { Name: '/shop-db', Config: { Env: ['POSTGRES_USER=shop', 'POSTGRES_PASSWORD=s3cret', 'PATH=/bin'], Cmd: ['postgres'] } },
  { Name: '/cache', Config: { Env: [], Cmd: ['redis-server', '--requirepass', 'cache-pw'] } },
  { Name: '/blog', Config: { Env: ['MARIADB_ROOT_PASSWORD=root-pw', 'MARIADB_DATABASE=blog'] } },
]
const cont = M.parseContainers(ps, inspected)
assert.deepStrictEqual(cont.map(x => [x.id, x.engine, x.flavor, x.status]), [['docker:shop-db', 'postgres', 'PostgreSQL', 'running'], ['docker:cache', 'redis', 'Redis', 'running'], ['docker:blog', 'mysql', 'MariaDB', 'stopped']])
assert.deepStrictEqual(cont.map(x => x.secret), ['s3cret', 'cache-pw', 'root-pw'])
assert.strictEqual(cont[0].user, 'shop')
assert.strictEqual(cont[0].database, 'shop')
assert.strictEqual(cont[2].database, 'blog')
const pub = M.publicInstance(cont[0])
assert.ok(!('secret' in pub) && pub.autoSecret === true)

// ---------- command lines: no secret in them, sudo as asked ----------
const pg = byId['local:postgres:5432'], my = byId['local:mysql:3306'], rd = byId['local:redis:6380']
let c = M.command({ inst: pg, sudo: 'nopass' }, { db: 'shop' })
assert.ok(c.cmd.startsWith("sudo -n -u postgres sh -c "), c.cmd)
assert.ok(c.cmd.includes("'\\''shop'\\''"), 'database quoted inside the wrapper')
assert.strictEqual(c.needsSudoPassword, false)
c = M.command({ inst: pg, sudo: 'pass' })
assert.ok(c.cmd.startsWith("sudo -k -S -p '' -u postgres "), 'always asks, so that the password line is read')
assert.strictEqual(c.needsSudoPassword, true)
c = M.command({ inst: pg, sudo: 'nopass', creds: { user: 'app', pass: 'pw-should-not-appear' } })
assert.ok(!c.cmd.startsWith('sudo') && c.cmd.includes('127.0.0.1') && !c.cmd.includes('pw-should-not-appear'))
assert.ok(c.cmd.includes('PGPASSWORD="$P"'))
c = M.command({ inst: my, sudo: 'nopass' })
assert.ok(c.cmd.startsWith('sudo -n sh -c ') && c.cmd.includes('--binary-mode'), 'root through the socket, client commands off')
c = M.command({ inst: my, sudo: 'no' })
assert.ok(c.cmd.startsWith('sh -c '), 'no sudo: the SSH account itself (~/.my.cnf)')
c = M.command({ inst: rd, sudo: 'nopass' }, { db: '2' })
assert.ok(c.cmd.startsWith('sh -c ') && c.cmd.includes("'\\''6380'\\''") && c.cmd.includes("'\\''-n'\\'' '\\''2'\\''"))
c = M.command({ inst: cont[2], sudo: 'no', dockerSudo: false })
assert.ok(c.cmd.startsWith("docker exec -i 'blog' sh -c ") && c.cmd.includes('MARIADB_ROOT_PASSWORD') && !c.cmd.includes('root-pw'))
c = M.command({ inst: cont[0], sudo: 'nopass', dockerSudo: true }, { tool: 'dump', db: 'shop' })
assert.ok(c.cmd.startsWith('sudo -n docker exec -i ') && c.cmd.includes('pg_dump') && c.cmd.includes('POSTGRES_USER'))
assert.throws(() => M.command({ inst: { ...cont[0], container: 'x;rm -rf /' } }), /invalid container/)
assert.throws(() => M.command({ inst: pg, sudo: 'no' }, { db: 'bad\nname' }), /invalid database/)

// ---------- SQL splitting ----------
assert.deepStrictEqual(M.splitSql("select 1; select ';' as a; -- c;\nselect \"x;y\" from t;", 'postgres'), ['select 1', "select ';' as a", '-- c;\nselect "x;y" from t'])
assert.deepStrictEqual(M.splitSql("create function f() returns int as $$ begin return 1; end $$ language plpgsql; select $tag$ ; $tag$", 'postgres').length, 2)
assert.deepStrictEqual(M.splitSql("select 'it''s'; select E'a\\'b;c'; /* x; /* nested; */ y; */ select 2", 'postgres'), ["select 'it''s'", "select E'a\\'b;c'", '/* x; /* nested; */ y; */ select 2'])
assert.throws(() => M.splitSql('select 1 \\! rm -rf ~', 'postgres'), /psql-meta/)
assert.throws(() => M.splitSql('\\d customers', 'postgres'), /psql-meta/)
assert.deepStrictEqual(M.splitSql("select 'a\\';b'; select `c;d` # x;\n; select 3", 'mysql'), ["select 'a\\';b'", 'select `c;d` # x;', 'select 3'])
assert.throws(() => M.splitSql('DELIMITER //\nselect 1', 'mysql'), /mysql-meta/)
assert.throws(() => M.splitSql('system ls', 'mysql'), /mysql-meta/)
assert.deepStrictEqual(M.splitSql('  ;; -- only a comment\n', 'postgres'), [])
assert.ok(M.isReadSql('  (SELECT 1)', 'postgres') && M.isReadSql('-- c\nWITH x AS (SELECT 1) SELECT * FROM x', 'postgres') && M.isReadSql('show tables', 'mysql'))
assert.ok(!M.isReadSql('/* select */ DELETE FROM t', 'postgres') && !M.isReadSql('SET default_transaction_read_only = off', 'postgres'))

// ---------- scripts and results ----------
const pgScript = M.sqlScript('postgres', ['select 1', 'update t set a = 1'])
assert.ok(pgScript.startsWith('SET default_transaction_read_only = on;\n') && pgScript.includes(`\\echo ${M.MARK} :ROW_COUNT`))
assert.ok(!M.sqlScript('postgres', ['select 1'], { readOnly: false }).includes('read_only'))
assert.ok(M.sqlScript('mysql', ['select 1']).startsWith('SET SESSION TRANSACTION READ ONLY;\n'))
const N = M.NULL
const pgOut = `a,b,c\n1,${N},""\n2,"line\nnext, ""q""",x\n${M.MARK} 2\n${M.MARK} 3\n`
const pgRes = M.parseSql('postgres', pgOut, 'psql:<stdin>:7: ERROR:  column "bogus" does not exist\nLINE 1: select bogus\n', ['select', 'update', 'select bogus'])
assert.deepStrictEqual(pgRes.results[0].columns, ['a', 'b', 'c'])
assert.deepStrictEqual(pgRes.results[0].rows, [['1', null, ''], ['2', 'line\nnext, "q"', 'x']], 'NULL and empty string apart, quotes and newlines kept')
assert.strictEqual(pgRes.results[1].affected, 3)
assert.strictEqual(pgRes.error.index, 2)
assert.ok(pgRes.error.message.startsWith('ERROR:  column "bogus"'))
const myOut = `id\tbio\n3\tBio with\\ttab and\\nnewline\n4\tNULL\n${M.MARK}\n-1\n${M.MARK}\n5\n`
const myRes = M.parseSql('mysql', myOut, 'ERROR 1792 (25006) at line 4: Cannot execute statement in a READ ONLY transaction\n', ['select', 'update', 'delete'])
assert.deepStrictEqual(myRes.results[0].rows, [['3', 'Bio with\ttab and\nnewline'], ['4', null]])
assert.strictEqual(myRes.results[1].affected, 5)
assert.deepStrictEqual(myRes.error, { index: 2, statement: 'delete', message: 'ERROR 1792: Cannot execute statement in a READ ONLY transaction' })
assert.strictEqual(M.parseSql('postgres', `a\n${'1\n'.repeat(5)}${M.MARK} 5\n`, '', ['s'], { maxRows: 3 }).results[0].truncated, true)

// ---------- queries quote names ----------
assert.ok(M.queries('postgres').preview('shop', 'pub"lic', 'cus"tomers', { limit: 100, offset: 200 })[0].includes('"pub""lic"."cus""tomers" LIMIT 100 OFFSET 200'))
assert.ok(M.queries('mysql').preview('blog', 'blog', 'po`sts', { limit: 50, offset: 0 })[0].includes('`blog`.`po``sts` LIMIT 0, 50'))
assert.ok(M.queries('mysql').tables("it's")[0].includes("'it\\'s'"))
assert.throws(() => M.queries('postgres').kill('1; drop table x'), /invalid number/)
assert.throws(() => M.queries('postgres').preview('d', 's', 't', { limit: 5000 }), /invalid number/)

// ---------- Redis ----------
assert.strictEqual(M.redisLine(['SET', 'a b', 'x"y\n']), 'SET "a b" "x\\"y\\n"')
const parts = M.splitRedis(`1) "0"\n2) 1) "user:42"\n   2) "a \\"quoted\\" key"\n"${M.MARK}"\n(integer) 7\n"${M.MARK}"\n(error) WRONGTYPE Operation\n"${M.MARK}"\n`)
assert.strictEqual(parts.length, 3)
assert.deepStrictEqual(M.parseRedis(parts[0]), ['0', ['user:42', 'a "quoted" key']])
assert.strictEqual(M.parseRedis(parts[1]), 7)
assert.deepStrictEqual(M.parseRedis(parts[2]), { error: 'WRONGTYPE Operation' })
assert.deepStrictEqual(M.parseRedis('(empty array)'), [])
assert.strictEqual(M.parseRedis('(nil)'), null)
assert.strictEqual(M.parseRedis('"caf\\xc3\\xa9\\n"'), 'caf\xc3\xa9\n')
const info = M.parseInfo('# Server\r\nredis_version:7.0.15\r\n# Keyspace\r\ndb0:keys=7,expires=1,avg_ttl=3\r\ndb2:keys=1,expires=0,avg_ttl=0\r\n')
assert.strictEqual(info.redis_version, '7.0.15')
assert.deepStrictEqual(M.keyspace(info), [{ name: '0', keys: 7, expires: 1, avg_ttl: 3 }, { name: '2', keys: 1, expires: 0, avg_ttl: 0 }])
assert.deepStrictEqual(M.parseClients('id=3 addr=127.0.0.1:5 name= db=0 cmd=client|list\n')[0], { id: '3', addr: '127.0.0.1:5', name: '', db: '0', cmd: 'client|list' })
assert.ok(M.isReadRedis('GET a') && M.isReadRedis('config get maxmemory') && M.isReadRedis('  scan 0 match "a b"'))
assert.ok(!M.isReadRedis('SET a 1') && !M.isReadRedis('CONFIG SET x y') && !M.isReadRedis('FLUSHALL') && !M.isReadRedis('client kill id 3'))
assert.deepStrictEqual(M.redisLines('# comment\nGET a\n\n  TTL a  \n'), ['GET a', 'TTL a'])

// ---------- backups ----------
const when = new Date(2026, 10, 24, 9, 5, 7)
assert.strictEqual(M.backupName(pg, 'shop', when), 'postgres-5432-shop-20261124-090507.sql.gz')
assert.strictEqual(M.backupName(cont[1], null, when), 'cache-20261124-090507.rdb.gz')
assert.strictEqual(M.backupName(pg, '../../etc/x y', when), 'postgres-5432-.._.._etc_x_y-20261124-090507.sql.gz')
console.log('ok')
