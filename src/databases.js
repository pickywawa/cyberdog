// Databases over SSH with the server's own clients: psql, mysql / mariadb, redis-cli, run on the server or inside the
// database's Docker container. Pure: discovery parsing, client command lines, SQL scripts and result parsing. main.js
// runs the commands, the renderer uses the same splitting / read-only checks.
// Secrets never go in a command line: the password (sudo, then database) is written on the client's stdin, read by a
// small `sh` wrapper that exports it (PGPASSWORD, MYSQL_PWD, REDISCLI_AUTH) before starting the client.
;(function () {
  const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
  const NULL = '\u2400' // psql prints NULL as this (an empty string stays empty)
  const MARK = '@@CYBERDOG-END@@'
  const ENGINES = { postgres: 'PostgreSQL', mysql: 'MySQL', redis: 'Redis' }
  const DEFAULT_PORT = { postgres: 5432, mysql: 3306, redis: 6379 }
  const SYSTEM_DBS = { postgres: ['postgres'], mysql: ['mysql', 'information_schema', 'performance_schema', 'sys'], redis: [] }
  const NAME = /^[^\0\r\n]{1,128}$/ // database / schema / table / user names: any text, always quoted
  const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  const check = (re, v, what) => { if (typeof v !== 'string' || !re.test(v)) throw new Error('invalid ' + what); return v }

  // ---------- discovery ----------
  const SNAPSHOT = `echo @@PS; ps -eo comm=,args= 2>/dev/null | grep -E '^(postgres|postmaster|mysqld|mariadbd|redis-server|valkey-server)[[:space:]]' | grep -v '^postgres[[:space:]]*postgres:'
echo @@SS; ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null
echo @@CLUSTERS; command -v pg_lsclusters >/dev/null 2>&1 && pg_lsclusters -h 2>/dev/null
echo @@BIN; for b in psql pg_dump mysql mariadb mysqldump mariadb-dump redis-cli docker gzip; do command -v $b >/dev/null 2>&1 && echo $b; done
echo @@SUDO; sudo -n true >/dev/null 2>&1 && echo nopass || echo no
echo @@UNITS; systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | grep -Ei 'postgres|mysql|maria|redis|valkey'
echo @@END
`
  const sections = out => {
    const r = {}
    let cur = null
    for (const l of out.split('\n')) {
      const m = /^@@([A-Z]+)$/.exec(l.trim())
      if (m) { cur = r[m[1]] = []; continue }
      if (cur && l.trim()) cur.push(l.replace(/\r$/, ''))
    }
    return r
  }
  const portArg = (args, re) => { const m = re.exec(args); return m ? +m[1] : null }
  function parseSnapshot(out) {
    const S = sections(out), list = []
    const bins = new Set((S.BIN || []).map(s => s.trim()))
    const ports = new Set((S.SS || []).map(l => (/[:.](\d+)\s+\S+[:.](?:\*|\d+)\s*$/.exec(l.trim().replace(/\s+users:.*$/, '')) || /:(\d+)\s/.exec(l))?.[1]).filter(Boolean).map(Number))
    const units = (S.UNITS || []).map(l => l.trim().split(/\s+/)).map(([unit, load, active, sub]) => ({ unit, active, sub }))
    const unitFor = re => units.find(u => re.test(u.unit))
    const add = x => { if (!list.some(y => y.id === x.id)) list.push(x) }
    // PostgreSQL: Debian / Ubuntu clusters (version, port, status, log file), else the postmaster processes
    for (const l of S.CLUSTERS || []) {
      const [ver, cluster, port, status, owner, data, log] = l.trim().split(/\s+/)
      if (!/^\d+(\.\d+)?$/.test(ver) || !/^\d+$/.test(port)) continue
      const u = unitFor(new RegExp(`^postgresql@${ver}-${cluster}\\.service$`)) || unitFor(/^postgresql(@.*)?\.service$/)
      add({ id: `local:postgres:${port}`, engine: 'postgres', flavor: 'PostgreSQL', source: 'local', port: +port, version: ver, cluster: `${ver}/${cluster}`, status: /online/.test(status) ? 'running' : 'stopped', logFile: log && log.startsWith('/') ? log : null, unit: u?.unit || null })
    }
    for (const l of S.PS || []) {
      const [comm] = l.trim().split(/\s+/), args = l.trim().slice(comm.length).trim()
      if (/^(postgres|postmaster)$/.test(comm)) {
        const port = portArg(args, /\s-p\s*(\d+)/) || (args.includes('config_file=') && list.find(x => x.engine === 'postgres')?.port) || 5432
        add({ id: `local:postgres:${port}`, engine: 'postgres', flavor: 'PostgreSQL', source: 'local', port, version: (/postgresql\/(\d+)/.exec(args) || [])[1] || null, status: 'running', logFile: null, unit: unitFor(/^postgresql(@.*)?\.service$/)?.unit || null })
      } else if (/^(mysqld|mariadbd)$/.test(comm)) {
        const port = portArg(args, /--port[= ](\d+)/) || 3306, maria = comm === 'mariadbd' || /maria/i.test(args)
        add({ id: `local:mysql:${port}`, engine: 'mysql', flavor: maria ? 'MariaDB' : 'MySQL', source: 'local', port, version: null, status: 'running', logFile: (/--log-error=(\/\S+)/.exec(args) || [])[1] || null, unit: unitFor(/^(mariadb|mysql|mysqld)\.service$/)?.unit || null })
      } else if (/^(redis-server|valkey-server)$/.test(comm)) {
        const port = portArg(args, /:(\d+)/) || 6379
        add({ id: `local:redis:${port}`, engine: 'redis', flavor: comm.startsWith('valkey') ? 'Valkey' : 'Redis', source: 'local', port, version: null, status: 'running', logFile: null, unit: unitFor(/^(redis|redis-server|valkey|valkey-server)(@.*)?\.service$/)?.unit || null })
      }
    }
    // a process list hidden from this account (hidepid): the usual ports, when the client is installed
    for (const [engine, port, bin] of [['postgres', 5432, 'psql'], ['mysql', 3306, null], ['redis', 6379, 'redis-cli']]) {
      if (!ports.has(port) || list.some(x => x.engine === engine && x.port === port)) continue
      if (bin ? !bins.has(bin) : !bins.has('mysql') && !bins.has('mariadb')) continue
      add({ id: `local:${engine}:${port}`, engine, flavor: ENGINES[engine], source: 'local', port, version: null, status: 'running', logFile: null, unit: null })
    }
    // installed services that are stopped
    for (const [engine, re] of [['postgres', /^postgresql(@.*)?\.service$/], ['mysql', /^(mariadb|mysql|mysqld)\.service$/], ['redis', /^(redis|redis-server|valkey|valkey-server)\.service$/]]) {
      const u = unitFor(re)
      if (!u || u.unit === 'postgresql.service' || list.some(x => x.engine === engine)) continue
      if (u.active === 'active') continue
      add({ id: `local:${engine}:${DEFAULT_PORT[engine]}`, engine, flavor: /maria/.test(u.unit) ? 'MariaDB' : /valkey/.test(u.unit) ? 'Valkey' : ENGINES[engine], source: 'local', port: DEFAULT_PORT[engine], version: null, status: 'stopped', logFile: null, unit: u.unit })
    }
    return { instances: list, bins: [...bins], sudo: (S.SUDO || [])[0] === 'nopass' ? 'nopass' : 'no' }
  }

  // Docker: database images among the running (and stopped) containers. `inspect` gives the environment the image
  // was started with (user, database, root password) and its command line (redis --requirepass).
  const IMAGE = [
    ['postgres', /(^|\/)(postgres|postgis|timescaledb[\w-]*|postgresql|pgvector)(:|@|$)/i, 'PostgreSQL'],
    ['mysql', /(^|\/)(mariadb)(:|@|$)/i, 'MariaDB'],
    ['mysql', /(^|\/)(mysql|mysql-server|percona[\w-]*)(:|@|$)/i, 'MySQL'],
    ['redis', /(^|\/)(valkey)(:|@|$)/i, 'Valkey'],
    ['redis', /(^|\/)(redis|redis-stack[\w-]*)(:|@|$)/i, 'Redis'],
  ]
  const imageEngine = image => IMAGE.find(([, re]) => re.test(image || ''))
  function parseContainers(psLines, inspected) {
    const out = []
    for (const l of psLines) {
      let c
      try { c = JSON.parse(l) } catch { continue }
      const kind = imageEngine(c.Image)
      if (!kind || !CONTAINER.test(c.Names || '')) continue
      const info = (inspected || []).find(x => (x.Name || '').replace(/^\//, '') === c.Names) || {}
      const env = Object.fromEntries((info.Config?.Env || []).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
      const cmd = [...(info.Config?.Entrypoint || []), ...(info.Config?.Cmd || [])]
      const pass = kind[0] === 'redis' ? cmd[cmd.indexOf('--requirepass') + 1] && cmd.includes('--requirepass') ? cmd[cmd.indexOf('--requirepass') + 1] : env.REDIS_PASSWORD || null
        : kind[0] === 'mysql' ? env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || null : env.POSTGRES_PASSWORD || null
      out.push({
        id: `docker:${c.Names}`, engine: kind[0], flavor: kind[2], source: 'docker', container: c.Names, image: c.Image,
        version: (/:([\w.-]+)$/.exec(c.Image) || [])[1] || null, status: c.State === 'running' ? 'running' : 'stopped', port: null,
        user: kind[0] === 'postgres' ? env.POSTGRES_USER || 'postgres' : kind[0] === 'mysql' ? 'root' : null,
        database: kind[0] === 'postgres' ? env.POSTGRES_DB || env.POSTGRES_USER || 'postgres' : env.MYSQL_DATABASE || env.MARIADB_DATABASE || null,
        secret: pass || null, // stays in main
      })
    }
    return out
  }
  // what the renderer may see of an instance
  const publicInstance = x => { const { secret, ...rest } = x; return { ...rest, autoSecret: !!secret } }

  // ---------- client command lines ----------
  // conn: { inst, creds: { user, database }?, sudo: 'nopass' | 'pass' | 'no', dockerSudo }
  // Returns { cmd, needsSudoPassword }: the caller writes [sudo password line] [database password line] then the data.
  const ENV = { postgres: 'PGPASSWORD', mysql: 'MYSQL_PWD', redis: 'REDISCLI_AUTH' }
  function wrap(engine, client, { mysqlDocker = false } = {}) {
    const fallback = mysqlDocker ? '[ -z "$P" ] && P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; ' : ''
    return `IFS= read -r P; ${fallback}[ -n "$P" ] && export ${ENV[engine]}="$P"; unset P; export PGCONNECT_TIMEOUT=10; ${client}`
  }
  const MYSQL_BIN = 'M=$(command -v mariadb || command -v mysql) || { echo "mysql client not found" >&2; exit 127; }; exec "$M"'
  const DUMP_BIN = { mysql: 'M=$(command -v mariadb-dump || command -v mysqldump) || { echo "mysqldump not found" >&2; exit 127; }; exec "$M"' }

  function clientArgs(conn, tool, db) {
    const { inst, creds } = conn, e = inst.engine, local = inst.source === 'local'
    const tcp = local && creds?.user // with a login: TCP on 127.0.0.1, as the SSH account
    if (e === 'postgres') {
      const bin = tool === 'dump' ? 'pg_dump' : 'psql'
      const target = tcp ? ['-h', '127.0.0.1', '-p', String(inst.port), '-U', creds.user] : local ? ['-p', String(inst.port)] : creds?.user ? ['-U', creds.user] : []
      const dbName = db || creds?.database || 'postgres'
      if (tool === 'dump') return `exec ${bin} ${[...target, '-d', check(NAME, dbName, 'database')].map(q).join(' ')}${local || creds?.user ? '' : ' -U "${POSTGRES_USER:-postgres}"'}`
      const base = ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-P', 'null=' + NULL, '-P', 'pager=off', ...target, '-d', check(NAME, dbName, 'database'), '-f', '-']
      return `exec psql ${base.map(q).join(' ')}${local || creds?.user ? '' : ' -U "${POSTGRES_USER:-postgres}"'}`
    }
    if (e === 'mysql') {
      const target = tcp ? ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(inst.port), '-u', creds.user] : creds?.user ? ['-u', creds.user] : inst.source === 'docker' ? ['-uroot'] : []
      if (tool === 'dump') return `${DUMP_BIN.mysql} ${[...target, '--single-transaction', '--routines', '--triggers', '--events', '--no-tablespaces', check(NAME, db, 'database')].map(q).join(' ')}`
      return `${MYSQL_BIN} ${['--batch', '--binary-mode', '--connect-timeout=10', ...target, ...(db ? [check(NAME, db, 'database')] : [])].map(q).join(' ')}`
    }
    const target = local ? ['-p', String(inst.port)] : []
    if (creds?.user) target.push('--user', creds.user)
    if (tool === 'dump') return `exec redis-cli ${[...target, '--rdb', '-'].map(q).join(' ')}`
    return `exec redis-cli ${['--no-raw', ...target, ...(db != null && db !== '' ? ['-n', String(Number(db) || 0)] : [])].map(q).join(' ')}`
  }

  function command(conn, { tool = 'client', db } = {}) {
    const { inst, creds } = conn
    const script = wrap(inst.engine, clientArgs(conn, tool, db), { mysqlDocker: inst.source === 'docker' && inst.engine === 'mysql' && !creds?.user })
    let cmd = `sh -c ${q(script)}`, sudoUser = null
    if (inst.source === 'docker') {
      cmd = `docker exec -i ${q(check(CONTAINER, inst.container, 'container'))} ${cmd}`
      if (conn.dockerSudo) sudoUser = 'root'
    } else if (!creds?.user && inst.engine !== 'redis' && conn.sudo !== 'no') {
      // no login given: the administrator account of the server (peer / unix_socket authentication)
      sudoUser = inst.engine === 'postgres' ? 'postgres' : 'root'
    }
    if (!sudoUser) return { cmd, needsSudoPassword: false }
    const pass = conn.sudo === 'pass'
    // -k: always ask, so that the password line is read even when sudo remembers a recent one
    return { cmd: `${pass ? "sudo -k -S -p ''" : 'sudo -n'}${sudoUser === 'root' ? '' : ' -u ' + sudoUser} ${cmd}`, needsSudoPassword: pass }
  }

  // ---------- SQL splitting ----------
  // Statements separated by `;` outside strings, quoted identifiers, comments and (PostgreSQL) dollar quotes.
  // psql runs backslash commands (\! runs a shell): a backslash outside a string is refused in PostgreSQL.
  function splitSql(text, dialect) {
    const out = [], my = dialect === 'mysql'
    let start = 0, i = 0
    const n = text.length
    const push = end => { const s = text.slice(start, end).trim(); if (s && stripComments(s, dialect).trim()) out.push(s); start = end + 1 }
    while (i < n) {
      const c = text[i], d = text[i + 1]
      if (c === '-' && d === '-' && (!my || /\s/.test(text[i + 2] || ' '))) { while (i < n && text[i] !== '\n') i++; continue }
      if (my && c === '#') { while (i < n && text[i] !== '\n') i++; continue }
      if (c === '/' && d === '*') {
        let depth = 1; i += 2
        while (i < n && depth) { if (!my && text[i] === '/' && text[i + 1] === '*') { depth++; i += 2 } else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2 } else i++ }
        continue
      }
      if (c === "'" || c === '"' || (my && c === '`')) {
        const escapes = my ? c !== '`' : c === "'" && /[eE]/.test(text[i - 1] || '') && !/\w/.test(text[i - 2] || '')
        i++
        while (i < n) {
          if (escapes && text[i] === '\\') { i += 2; continue }
          if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue } break }
          i++
        }
        i++
        continue
      }
      if (!my && c === '$') {
        const m = /^\$([A-Za-z_][\w]*)?\$/.exec(text.slice(i))
        if (m && !/[\w$]/.test(text[i - 1] || '')) {
          const end = text.indexOf(m[0], i + m[0].length)
          i = end < 0 ? n : end + m[0].length
          continue
        }
      }
      if (c === '\\') {
        if (!my) throw new Error('psql-meta')
        // mysql client commands (\! \. \u…): run with --binary-mode they are not interpreted, refused here anyway
        throw new Error('mysql-meta')
      }
      if (c === ';') push(i)
      i++
    }
    push(n)
    for (const s of out) if (my && /^(delimiter|source|system)\b/i.test(stripComments(s, dialect).trim())) throw new Error('mysql-meta')
    return out
  }
  function stripComments(s, dialect) {
    return s.replace(dialect === 'mysql' ? /(--\s[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g : /(--[^\n]*|\/\*[\s\S]*?\*\/)/g, ' ')
  }
  const firstWord = (s, dialect) => (/^[\s(]*([A-Za-z]+)/.exec(stripComments(s, dialect)) || [])[1]?.toLowerCase() || ''
  const READ_SQL = new Set(['select', 'show', 'explain', 'describe', 'desc', 'values', 'table', 'with'])
  const isReadSql = (s, dialect) => READ_SQL.has(firstWord(s, dialect))

  // ---------- scripts ----------
  // After each statement a marker tells where its output ends, with the number of rows it changed or returned.
  function sqlScript(engine, statements, { readOnly = true } = {}) {
    const body = statements.map(s => s.replace(/;\s*$/, ''))
    if (engine === 'postgres') return (readOnly ? 'SET default_transaction_read_only = on;\n' : '') + body.map(s => `${s}\n;\n\\echo ${MARK} :ROW_COUNT\n`).join('')
    return (readOnly ? 'SET SESSION TRANSACTION READ ONLY;\n' : '') + body.map(s => `${s}\n;\nSELECT ROW_COUNT() AS \`${MARK}\`;\n`).join('')
  }

  // ---------- result parsing ----------
  function parseCsv(text) {
    const rows = []
    let row = [], f = '', i = 0, quoted = false, wasQuoted = false
    const n = text.length
    const end = () => { row.push(wasQuoted ? f : f === NULL ? null : f); f = ''; wasQuoted = false }
    while (i < n) {
      const c = text[i]
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue } quoted = false; i++; continue }
        f += c; i++; continue
      }
      if (c === '"') { quoted = wasQuoted = true; i++; continue }
      if (c === ',') { end(); i++; continue }
      if (c === '\n' || c === '\r') { end(); rows.push(row); row = []; i += c === '\r' && text[i + 1] === '\n' ? 2 : 1; continue }
      f += c; i++
    }
    if (f || wasQuoted || row.length) { end(); rows.push(row) }
    return rows
  }
  const unTsv = v => (v === 'NULL' ? null : v.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\' }[c] ?? c)))
  // results of a script: one entry per statement that ran; `error` is the statement that stopped it
  function parseSql(engine, stdout, stderr, statements, { maxRows = 2000 } = {}) {
    const results = []
    const table = rows => {
      const [columns = [], ...data] = rows
      return { columns, rows: data.slice(0, maxRows), total: data.length, truncated: data.length > maxRows }
    }
    if (engine === 'postgres') {
      const re = new RegExp(`^${MARK} (\\d*)$\\n?`, 'gm')
      let last = 0, m
      while ((m = re.exec(stdout))) {
        const chunk = stdout.slice(last, m.index).replace(/^\n/, '')
        last = m.index + m[0].length
        const count = m[1] === '' ? null : +m[1]
        results.push(chunk.trim() ? { ...table(parseCsv(chunk)), count } : { columns: null, rows: [], affected: count })
      }
    } else {
      const lines = stdout.split('\n')
      let buf = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === MARK) {
          const count = +lines[i + 1]
          i++
          const rows = buf.map(l => l.split('\t').map(unTsv))
          results.push(rows.length ? { ...table(rows), count: rows.length - 1 } : { columns: null, rows: [], affected: count >= 0 ? count : 0 })
          buf = []
          continue
        }
        if (lines[i] !== '' || buf.length) buf.push(lines[i])
      }
    }
    results.forEach((r, i) => { r.statement = statements[i] })
    const err = cleanError(engine, stderr)
    return { results, error: err && results.length < statements.length ? { index: results.length, statement: statements[results.length], message: err } : err ? { index: null, message: err } : null }
  }
  function cleanError(engine, stderr) {
    const lines = String(stderr || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()
      && !/^Warning: Using a password/i.test(l) && !/^mysql: Deprecated program name/i.test(l) && !/^@@RC /.test(l) && !/^sending REPLCONF|^SYNC sent|^Transfer finished/i.test(l))
    if (!lines.length) return null
    return lines.map(l => l.replace(/^psql:<stdin>:\d+: /, '').replace(/^ERROR (\d+) \(\w+\) at line \d+: /, 'ERROR $1: ')).join('\n').slice(0, 2000)
  }

  // ---------- queries ----------
  const pgId = s => '"' + check(NAME, s, 'name').replace(/"/g, '""') + '"'
  const pgLit = s => "'" + String(s).replace(/'/g, "''") + "'"
  const myId = s => '`' + check(NAME, s, 'name').replace(/`/g, '``') + '`'
  const myLit = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
  const int = (v, max) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error('invalid number'); return n }

  const PG = {
    overview: () => [`SELECT current_setting('server_version') AS version, pg_postmaster_start_time() AS started, current_setting('max_connections')::int AS max_connections,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
  (SELECT sum(pg_database_size(datname)) FROM pg_database WHERE has_database_privilege(datname, 'CONNECT')) AS size,
  (SELECT round(100 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 1) FROM pg_stat_database) AS cache_hit,
  current_user AS login, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser, current_setting('port') AS port`],
    databases: () => [`SELECT d.datname AS name, CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size,
  pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation,
  (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1`],
    tables: () => [`SELECT n.nspname AS schema, c.relname AS name, CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'f' THEN 'foreign' END AS kind,
  CASE WHEN c.relkind IN ('r', 'p', 'm') THEN coalesce(s.n_live_tup, greatest(c.reltuples, 0))::bigint END AS rows, pg_total_relation_size(c.oid) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT c.relispartition
ORDER BY n.nspname = 'public' DESC, 1, 2`],
    columns: (db, schema, table) => {
      const rel = pgLit(pgId(schema) + '.' + pgId(table))
      return [`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default",
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = ${rel}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = ${pgLit(schema)} AND tablename = ${pgLit(table)} ORDER BY 1`]
    },
    preview: (db, schema, table, { limit = 100, offset = 0 } = {}) => [`SELECT * FROM ${pgId(schema)}.${pgId(table)} LIMIT ${int(limit, 1000)} OFFSET ${int(offset, 1e12)}`],
    activity: () => [`SELECT pid, usename AS "user", datname AS database, coalesce(host(client_addr), 'local') AS client, state, application_name AS application,
  extract(epoch FROM now() - coalesce(query_start, backend_start))::int AS seconds, wait_event_type AS waiting, left(query, 2000) AS query
FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY state = 'active' DESC, seconds DESC`],
    kill: (id, hard) => [`SELECT ${hard ? 'pg_terminate_backend' : 'pg_cancel_backend'}(${int(id, 2 ** 31)}) AS ok`],
    users: () => [`SELECT r.rolname AS name, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolreplication AS replication,
  r.rolconnlimit AS connlimit, r.rolvaliduntil AS valid_until, array_to_string(ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid ORDER BY 1), ', ') AS member_of
FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolcanlogin DESC, 1`],
    grants: (db, user) => [`SELECT d.datname AS database, concat_ws(', ', CASE WHEN has_database_privilege(${pgLit(user)}, d.datname, 'CONNECT') THEN 'CONNECT' END,
  CASE WHEN has_database_privilege(${pgLit(user)}, d.datname, 'CREATE') THEN 'CREATE' END, CASE WHEN has_database_privilege(${pgLit(user)}, d.datname, 'TEMP') THEN 'TEMP' END) AS privileges,
  pg_get_userbyid(d.datdba) = ${pgLit(user)} AS owner FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1`,
    `SELECT n.nspname AS schema, c.relname AS "table", CASE WHEN pg_get_userbyid(c.relowner) = ${pgLit(user)} THEN 'OWNER' ELSE string_agg(DISTINCT a.privilege_type, ', ') END AS privileges
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (pg_get_userbyid(c.relowner) = ${pgLit(user)} OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${pgLit(user)}))
GROUP BY 1, 2, c.relowner ORDER BY 1, 2`],
    logInfo: () => [`SELECT current_setting('logging_collector') AS collector, current_setting('log_directory') AS dir, current_setting('data_directory', true) AS data`],
  }
  const MY = {
    overview: () => ['SELECT VERSION() AS version, @@port AS port, @@max_connections AS max_connections, CURRENT_USER() AS login, @@datadir AS datadir',
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Questions', 'Slow_queries')",
      'SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS size FROM information_schema.TABLES'],
    databases: () => [`SELECT s.SCHEMA_NAME AS name, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size, COUNT(t.TABLE_NAME) AS tables,
  s.DEFAULT_CHARACTER_SET_NAME AS encoding, s.DEFAULT_COLLATION_NAME AS collation
FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME ORDER BY 1`],
    tables: db => [`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS kind, TABLE_ROWS AS \`rows\`, DATA_LENGTH + INDEX_LENGTH AS size, ENGINE AS engine
FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${myLit(db)} ORDER BY 2`],
    columns: (db, schema, table) => [`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`, COLUMN_KEY = 'PRI' AS pk, EXTRA AS extra
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${myLit(schema || db)} AND TABLE_NAME = ${myLit(table)} ORDER BY ORDINAL_POSITION`,
    `SELECT INDEX_NAME AS name, CONCAT(IF(NON_UNIQUE = 0, 'UNIQUE ', ''), 'INDEX (', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), ')') AS definition
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${myLit(schema || db)} AND TABLE_NAME = ${myLit(table)} GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME = 'PRIMARY' DESC, 1`],
    preview: (db, schema, table, { limit = 100, offset = 0 } = {}) => [`SELECT * FROM ${myId(schema || db)}.${myId(table)} LIMIT ${int(offset, 1e12)}, ${int(limit, 1000)}`],
    activity: () => [`SELECT ID AS pid, USER AS user, DB AS \`database\`, HOST AS client, COMMAND AS state, TIME AS seconds, STATE AS waiting, LEFT(INFO, 2000) AS query
FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY COMMAND <> 'Sleep' DESC, TIME DESC`],
    kill: (id, hard) => [`KILL ${hard ? '' : 'QUERY '}${int(id, 2 ** 53)}`],
    users: () => ["SELECT User AS name, Host AS host, plugin AS plugin, IF(authentication_string = '' AND plugin IN ('mysql_native_password', ''), 'yes', 'no') AS no_password FROM mysql.user ORDER BY User = '', User, Host"],
    grants: (db, user, host = '%') => [`SHOW GRANTS FOR ${myLit(user)}@${myLit(host)}`],
    logInfo: () => ['SELECT @@log_error AS log_error, @@datadir AS datadir'],
  }
  const queries = engine => (engine === 'postgres' ? PG : MY)

  // ---------- Redis ----------
  // Commands one per line, as redis-cli reads them; ECHO separates the replies.
  const redisArg = a => (/^[\w:.\-*@/+?[\]{}^$|]+$/.test(String(a)) && String(a) ? String(a) : '"' + String(a).replace(/[\\"]/g, m => '\\' + m).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"')
  const redisLine = args => args.map(redisArg).join(' ')
  const redisScript = commands => commands.map(c => (Array.isArray(c) ? redisLine(c) : c) + '\nECHO ' + MARK + '\n').join('')
  function splitRedis(stdout) {
    const out = [], marker = `"${MARK}"`
    let buf = []
    for (const l of stdout.split('\n')) {
      if (l.replace(/\r$/, '') === marker) { out.push(buf.join('\n')); buf = []; continue }
      buf.push(l.replace(/\r$/, ''))
    }
    return out
  }
  const unquote = s => s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, c) => (c[0] === 'x' && c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b' }[c] ?? c))
  function redisValue(s) {
    s = s.trim()
    if (s === '(nil)') return null
    if (s === '(empty array)' || s === '(empty list or set)') return []
    let m
    if ((m = /^\(integer\) (-?\d+)$/.exec(s))) return Number(m[1])
    if ((m = /^\(double\) (.+)$/.exec(s))) return Number(m[1])
    if ((m = /^\(error\) ([\s\S]*)$/.exec(s))) return { error: m[1] }
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return unquote(s.slice(1, -1))
    return s
  }
  // a --no-raw reply: scalar or (nested) array, items numbered "1) …" and indented by level
  function parseRedis(text) {
    const lines = text.split('\n').filter(l => l.trim())
    if (!lines.length) return null
    if (!/^\s*\d+\) /.test(lines[0])) return redisValue(lines.join('\n'))
    const root = [], stack = [{ col: 0, arr: root }]
    for (const line of lines) {
      let pos = line.length - line.trimStart().length, first = true
      for (;;) {
        const m = /^(\d+)\) /.exec(line.slice(pos))
        if (!m) { if (first) { const top = stack.at(-1).arr; if (top.length && typeof top[top.length - 1] === 'string') top[top.length - 1] += '\n' + line.trim() } break }
        if (first) { while (stack.length > 1 && stack.at(-1).col > pos) stack.pop(); first = false }
        const after = pos + m[0].length
        if (/^\d+\) /.test(line.slice(after))) { const arr = []; stack.at(-1).arr.push(arr); stack.push({ col: after, arr }); pos = after; continue }
        stack.at(-1).arr.push(redisValue(line.slice(after)))
        break
      }
    }
    return root
  }
  const parseInfo = text => {
    const v = typeof text === 'string' ? text : ''
    const out = {}
    for (const l of v.split(/\r?\n/)) { const i = l.indexOf(':'); if (i > 0 && !l.startsWith('#')) out[l.slice(0, i)] = l.slice(i + 1) }
    return out
  }
  const keyspace = info => Object.entries(info).filter(([k]) => /^db\d+$/.test(k)).map(([k, v]) => ({ name: k.slice(2), ...Object.fromEntries(v.split(',').map(p => p.split('=')).map(([a, b]) => [a, Number(b)])) }))
  const parseClients = text => String(text || '').split(/\r?\n/).filter(Boolean).map(l => Object.fromEntries(l.trim().split(' ').map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])))
  const REDIS = {
    overview: () => [['INFO']],
    keys: (pattern = '*', cursor = '0', count = 200) => [['SCAN', String(int(cursor, 2 ** 64)), 'MATCH', String(pattern || '*').slice(0, 500), 'COUNT', String(int(count, 5000))]],
    meta: keys => keys.flatMap(k => [['TYPE', k], ['TTL', k]]),
    key: key => [['TYPE', key], ['TTL', key], ['MEMORY', 'USAGE', key], ['GET', key], ['HGETALL', key], ['LRANGE', key, '0', '199'], ['SSCAN', key, '0', 'COUNT', '200'], ['ZRANGE', key, '0', '199', 'WITHSCORES'], ['XREVRANGE', key, '+', '-', 'COUNT', '50'],
      ['STRLEN', key], ['HLEN', key], ['LLEN', key], ['SCARD', key], ['ZCARD', key], ['XLEN', key]],
    activity: () => [['CLIENT', 'LIST']],
    kill: id => [['CLIENT', 'KILL', 'ID', String(int(id, 2 ** 53))]],
    users: () => [['ACL', 'LIST']],
    logInfo: () => [['CONFIG', 'GET', 'logfile'], ['CONFIG', 'GET', 'dir']],
  }
  const REDIS_READ = new Set(['get', 'mget', 'strlen', 'getrange', 'exists', 'type', 'ttl', 'pttl', 'expiretime', 'keys', 'scan', 'randomkey', 'hget', 'hgetall', 'hmget', 'hkeys', 'hvals', 'hlen', 'hscan', 'hexists', 'hstrlen', 'hrandfield',
    'lrange', 'llen', 'lindex', 'lpos', 'smembers', 'scard', 'sismember', 'smismember', 'sscan', 'srandmember', 'sinter', 'sunion', 'sdiff', 'zrange', 'zrangebyscore', 'zrevrange', 'zrevrangebyscore', 'zrangebylex', 'zcard', 'zscore', 'zmscore', 'zrank', 'zrevrank', 'zscan', 'zcount', 'zlexcount',
    'xrange', 'xrevrange', 'xlen', 'xinfo', 'xpending', 'info', 'dbsize', 'ping', 'echo', 'time', 'lastsave', 'role', 'select', 'dump', 'object', 'bitcount', 'getbit', 'bitpos', 'pfcount', 'geopos', 'geodist', 'geohash', 'georadius_ro', 'geosearch', 'json.get', 'json.type'])
  const REDIS_READ_SUB = { memory: ['usage', 'stats', 'doctor'], client: ['list', 'info', 'getname', 'id'], config: ['get'], acl: ['list', 'whoami', 'users', 'cat'], slowlog: ['get', 'len'], command: ['count', 'info', 'docs'], cluster: ['info', 'nodes'], module: ['list'], latency: ['latest', 'history'] }
  const redisWords = line => (String(line).trim().match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) || [])
  function isReadRedis(line) {
    const [cmd = '', sub = ''] = redisWords(line).map(w => w.toLowerCase())
    if (REDIS_READ.has(cmd)) return true
    return !!REDIS_READ_SUB[cmd]?.includes(sub)
  }
  // the editor: one command per line, blank lines and # comments skipped
  const redisLines = text => String(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

  // ---------- misc ----------
  const backupName = (inst, db, now = new Date()) => {
    const pad = n => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const slug = s => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60)
    const who = inst.source === 'docker' ? inst.container : `${inst.engine}-${inst.port}`
    return inst.engine === 'redis' ? `${slug(who)}-${stamp}.rdb.gz` : `${slug(who)}-${slug(db)}-${stamp}.sql.gz`
  }

  const api = { SNAPSHOT, MARK, NULL, ENGINES, SYSTEM_DBS, parseSnapshot, parseContainers, imageEngine, publicInstance, command, splitSql, firstWord, isReadSql, sqlScript, parseCsv, parseSql, cleanError, queries,
    redisScript, redisLine, splitRedis, parseRedis, parseInfo, keyspace, parseClients, REDIS, isReadRedis, redisLines, backupName, q, pgId, myId }
  if (typeof module !== 'undefined') module.exports = api
  else window.dbModel = api
})()
