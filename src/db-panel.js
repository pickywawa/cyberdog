// Databases panel: PostgreSQL, MySQL / MariaDB and Redis found on the server (services, processes, Docker containers).
// Overview, read-only data browser, SQL / command editor, sessions, users and rights, backups, server log.
// Model: databases.js (window.dbModel); reuses h, t, icon, toast, ensure, hib, modal, errText, sizeOf, fmtUptime, createLogView, loadMonaco.
const newDbs = () => ({ loaded: false, loading: false, error: null, list: [], sudo: 'no', inst: null, view: 'overview', per: {} })
const dt = (key, vars) => t('db.' + key, vars)
const DB_VIEWS = { sql: [['overview', 'activity'], ['data', 'grid'], ['sql', 'code'], ['activity', 'processes'], ['users', 'user'], ['logs', 'scroll']],
  redis: [['overview', 'activity'], ['data', 'key'], ['sql', 'terminal'], ['activity', 'processes'], ['users', 'user'], ['logs', 'scroll']] }
const dbKind = inst => (inst.engine === 'redis' ? 'redis' : 'sql')
const dbState = (tab, id) => (tab.dbs.per[id] ||= { sql: { text: '', db: '', readOnly: true, results: null, error: null, running: false }, data: { db: null, table: null, tableTab: 'data', page: 0 }, redis: { db: '0', pattern: '*', keys: [], cursor: '0' } })
const curInst = tab => tab.dbs.list.find(x => x.id === tab.dbs.inst)
const dbOp = (tab, op, a) => api.invoke('db:op', tab.connId, tab.dbs.inst, op, a)
const fmtDur = s => (s < 60 ? `${Math.round(s)} s` : fmtUptime(s))
const fmtNum = n => (n == null || n === '' ? '—' : Number(n).toLocaleString())
const rowObj = r => (r?.columns ? Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0]?.[i]])) : {})

async function dbDiscover(tab) {
  const D = tab.dbs
  if (D.loading) return
  D.loading = true
  try {
    await ensure(tab)
    const r = await api.invoke('db:discover', tab.connId)
    Object.assign(D, { list: r.instances, sudo: r.sudo, bins: r.bins, error: null })
    if (D.inst && !D.list.some(x => x.id === D.inst)) D.inst = null
  } catch (e) { D.error = errText(e) }
  D.loaded = true
  D.loading = false
  paintDbs(tab)
}
function renderDatabases(tab) {
  tab.rpanelActions.append(hib('refresh', 'tb.refresh', () => { dropDbStates(tab); tab.dbs.loaded = false; paintDbs(tab); dbDiscover(tab) }))
  tab.dbsBody = h('div', { className: 'docker-view db-view' })
  tab.rpanelBody.append(tab.dbsBody)
  paintDbs(tab)
  if (!tab.dbs.loaded) dbDiscover(tab)
}
function dropDbStates(tab) { for (const S of Object.values(tab.dbs.per)) { S?.log?.stop(); S?.sql?.editor?.dispose() } tab.dbs.per = {} }
function leaveDatabases(tab) {
  for (const S of Object.values(tab.dbs.per)) if (S) { S.log?.stop(); S.log = null }
  tab.dbsBody = null
}
// the panel's poll: the sessions list, while it is shown
async function dbPoll(tab) {
  if (tab.panel !== 'databases' || tab.dbs.view !== 'activity' || !curInst(tab)) return
  await loadActivity(tab, true)
}

// ---------- painting ----------
function paintDbs(tab) {
  const D = tab.dbs, body = tab.dbsBody
  if (!body || tab.panel !== 'databases') return
  body.replaceChildren()
  tab.rpanelBody.classList.toggle('flush', !!D.inst && D.view === 'logs')
  const inst = curInst(tab)
  if (!inst) return paintDbList(tab, body)
  paintDbInstance(tab, body, inst)
}

const DB_ICON = { postgres: 'database', mysql: 'database', redis: 'zap' }
function authText(D, inst) {
  if (inst.login) return dt('auth.login', { user: inst.login.user })
  if (inst.source === 'docker') return dt('auth.container')
  if (inst.engine === 'redis') return dt('auth.none')
  if (D.sudo === 'no') return dt('auth.account')
  return inst.engine === 'postgres' ? dt('auth.peer') : dt('auth.socket')
}
function paintDbList(tab, body) {
  const D = tab.dbs
  body.append(h('p', { className: 'security-note dim', textContent: dt('intro') }))
  if (D.error) return body.append(h('div', { className: 'msg small err', textContent: D.error }))
  if (!D.loaded) return body.append(h('div', { className: 'msg small', textContent: dt('discovering') }))
  if (!D.list.length) return body.append(h('div', { className: 'msg small', textContent: dt('none') }))
  const list = h('div', { className: 'svc-list db-list' })
  const order = x => (x.status === 'running' ? 0 : 1)
  for (const x of [...D.list].sort((a, b) => order(a) - order(b) || a.source.localeCompare(b.source) || a.flavor.localeCompare(b.flavor))) {
    const chip = (text, lv = 'idle') => h('span', { className: 'mchip lv-' + lv, textContent: text })
    const where = x.source === 'docker' ? dt('in_container', { name: x.container }) : dt('on_port', { port: x.port }) + (x.cluster ? ' · ' + x.cluster : '')
    list.append(h('div', { className: 'dk click', onclick: () => { D.inst = x.id; D.view = 'overview'; paintDbs(tab); loadDbView(tab) } },
      h('span', { className: 'dk-ic', innerHTML: icon(DB_ICON[x.engine]) }),
      h('div', { className: 'svc-main' }, h('b', { textContent: `${x.flavor}${x.version ? ' ' + x.version : ''}` }), h('small', { className: 'dim', textContent: where + (x.image ? ' · ' + x.image : '') }),
        h('span', { className: 'dk-res' }, chip(dt(x.status === 'running' ? 'running' : 'stopped'), x.status === 'running' ? 'ok' : 'idle'), chip(x.source === 'docker' ? 'Docker' : dt('service')), chip(authText(D, x), x.login ? 'ok' : 'idle'))),
      h('span', { className: 'dim', innerHTML: icon('chevron-right') })))
  }
  body.append(list)
  if (D.sudo === 'no') body.append(h('p', { className: 'security-note dim', textContent: dt('no_sudo') }))
}

function paintDbInstance(tab, body, inst) {
  const D = tab.dbs, S = dbState(tab, inst.id)
  const head = h('div', { className: 'dback' },
    h('button', { className: 'ib', innerHTML: icon('arrow-left'), title: t('docker.back'), onclick: () => { S.log?.stop(); S.log = null; D.inst = null; paintDbs(tab) } }),
    h('span', { className: 'dk-ic', innerHTML: icon(DB_ICON[inst.engine]) }),
    h('b', { textContent: `${inst.flavor}${inst.version ? ' ' + inst.version : ''} · ${inst.source === 'docker' ? inst.container : ':' + inst.port}` }),
    h('span', { className: 'mchip lv-' + (inst.login ? 'ok' : 'idle'), textContent: authText(D, inst) }),
    h('span', { className: 'dk-acts' },
      h('button', { className: 'ib', innerHTML: icon('lock'), title: dt('login.title'), onclick: () => editDbLogin(tab, inst) }),
      ...(inst.login ? [h('button', { className: 'ib', innerHTML: icon('x'), title: dt('login.forget'), onclick: () => forgetDbLogin(tab, inst) })] : [])))
  const views = h('div', { className: 'seg db-views' }, ...DB_VIEWS[dbKind(inst)].map(([v, ic]) => h('button', { className: D.view === v ? 'on' : '', title: dt('view.' + v + (inst.engine === 'redis' ? '_redis' : '')),
    innerHTML: icon(ic) + `<span>${dt('view.' + v + (inst.engine === 'redis' ? '_redis' : ''))}</span>`, onclick: () => { if (D.view === v) return; S.log?.stop(); S.log = null; D.view = v; paintDbs(tab); loadDbView(tab) } })))
  body.append(head, views)
  if (inst.status !== 'running') body.append(h('div', { className: 'alert lv-warn', innerHTML: icon('alert') }, h('span', { textContent: dt('stopped_note') })))
  const view = h('div', { className: 'db-pane' })
  body.append(view)
  ;({ overview: paintOverview, data: inst.engine === 'redis' ? paintRedisData : paintSqlData, sql: paintEditor, activity: paintActivity, users: paintUsers, logs: paintDbLogs })[D.view](tab, view, inst, S)
}

async function editDbLogin(tab, inst) {
  const l = inst.login
  const v = await modal(dt('login.title'), [
    { name: 'user', label: dt('login.user'), value: l?.user || (inst.engine === 'postgres' ? '' : inst.engine === 'mysql' ? '' : 'default') },
    { name: 'pass', label: dt('login.pass'), type: 'password', placeholder: l?.hasPass ? dt('login.unchanged') : '' },
    ...(inst.engine === 'postgres' ? [{ name: 'database', label: dt('login.database'), value: l?.database || '', placeholder: 'postgres' }] : []),
  ], t('btn.save'))
  if (!v) return
  try { await api.invoke('db:login', tab.connId, inst.id, { user: v.user, pass: v.pass, database: v.database, keepPass: !v.pass }) } catch (e) { return toast(errText(e), true) }
  tab.dbs.per[inst.id]?.sql?.editor?.dispose(); tab.dbs.per[inst.id]?.log?.stop(); delete tab.dbs.per[inst.id]
  await dbDiscover(tab)
  loadDbView(tab)
}
async function forgetDbLogin(tab, inst) {
  try { await api.invoke('db:login', tab.connId, inst.id, null) } catch (e) { return toast(errText(e), true) }
  tab.dbs.per[inst.id]?.sql?.editor?.dispose(); tab.dbs.per[inst.id]?.log?.stop(); delete tab.dbs.per[inst.id]
  await dbDiscover(tab)
  loadDbView(tab)
}

// load what the current view needs, then repaint
async function loadDbView(tab) {
  const D = tab.dbs, inst = curInst(tab)
  if (!inst || inst.status !== 'running') return
  const S = dbState(tab, inst.id)
  const run = async (key, fn) => {
    S[key + 'Busy'] = true
    try { S[key] = await fn(); S[key + 'Error'] = null } catch (e) { S[key + 'Error'] = errText(e) }
    S[key + 'Busy'] = false
    if (D.inst === inst.id) paintDbs(tab)
  }
  if (D.view === 'overview' && !S.overview) await run('overview', () => dbOp(tab, 'overview'))
  if (D.view === 'data' && inst.engine !== 'redis') {
    if (!S.databases) await run('databases', () => dbOp(tab, 'databases'))
    if (S.data.db && !S.tables) await run('tables', () => dbOp(tab, 'tables', { db: S.data.db }))
    if (S.data.table && !S.preview) await loadTable(tab)
  }
  if (D.view === 'data' && inst.engine === 'redis') {
    if (!S.overview) await run('overview', () => dbOp(tab, 'overview'))
    if (!S.redis.loaded) await loadKeys(tab, true)
  }
  if (D.view === 'sql' && inst.engine !== 'redis' && !S.databases) await run('databases', () => dbOp(tab, 'databases'))
  if (D.view === 'sql' && inst.engine === 'redis' && !S.overview) await run('overview', () => dbOp(tab, 'overview'))
  if (D.view === 'activity') await loadActivity(tab)
  if (D.view === 'users' && !S.users) await run('users', () => dbOp(tab, 'users'))
}
const busyMsg = (el, S, key) => {
  if (S[key + 'Error']) { el.append(h('div', { className: 'msg small err db-err', textContent: S[key + 'Error'] })); return true }
  if (!S[key]) { el.append(h('div', { className: 'msg small', textContent: t('dash.checking') })); return true }
  return false
}

// ---------- overview ----------
function paintOverview(tab, el, inst, S) {
  if (busyMsg(el, S, 'overview')) return
  const tiles = []
  const tile = (label, value, sub) => tiles.push(h('div', { className: 'db-tile' }, h('small', { className: 'dim', textContent: label }), h('b', { textContent: value ?? '—', title: value ?? '' }), ...(sub ? [h('small', { className: 'dim', textContent: sub })] : [])))
  if (inst.engine === 'redis') {
    const I = S.overview.info, keys = dbModel.keyspace(I).reduce((n, d) => n + (d.keys || 0), 0)
    tile(dt('ov.version'), I.redis_version || I.valkey_version, I.redis_mode)
    tile(dt('ov.uptime'), I.uptime_in_seconds ? fmtUptime(+I.uptime_in_seconds) : null)
    tile(dt('ov.clients'), fmtNum(I.connected_clients), I.maxclients ? dt('ov.max', { n: fmtNum(I.maxclients) }) : '')
    tile(dt('ov.memory'), I.used_memory_human, I.maxmemory_human && I.maxmemory !== '0' ? dt('ov.max', { n: I.maxmemory_human }) : dt('ov.nolimit'))
    tile(dt('ov.keys'), fmtNum(keys), dbModel.keyspace(I).map(d => `db${d.name}: ${fmtNum(d.keys)}`).join(' · '))
    tile(dt('ov.role'), I.role, I.connected_slaves && I.connected_slaves !== '0' ? dt('ov.replicas', { n: I.connected_slaves }) : '')
    tile(dt('ov.saved'), I.rdb_last_save_time ? new Date(I.rdb_last_save_time * 1000).toLocaleString() : null, I.aof_enabled === '1' ? 'AOF' : 'RDB')
    tile(dt('ov.ops'), fmtNum(I.instantaneous_ops_per_sec), dt('ov.per_sec'))
  } else {
    const r = S.overview.results || []
    if (inst.engine === 'postgres') {
      const o = rowObj(r[0])
      tile(dt('ov.version'), o.version)
      tile(dt('ov.uptime'), o.started ? fmtUptime((Date.now() - Date.parse(o.started)) / 1000) : null, o.started ? new Date(o.started).toLocaleString() : '')
      tile(dt('ov.connections'), fmtNum(o.connections), dt('ov.max', { n: fmtNum(o.max_connections) }))
      tile(dt('ov.size'), o.size ? sizeOf(+o.size) : null)
      tile(dt('ov.cache'), o.cache_hit ? o.cache_hit + ' %' : null)
      tile(dt('ov.login'), o.login, o.superuser === 't' ? dt('ov.superuser') : '')
    } else {
      const o = rowObj(r[0]), st = Object.fromEntries((r[1]?.rows || []).map(([k, v]) => [k, v])), size = rowObj(r[2]).size
      tile(dt('ov.version'), o.version)
      tile(dt('ov.uptime'), st.Uptime ? fmtUptime(+st.Uptime) : null)
      tile(dt('ov.connections'), fmtNum(st.Threads_connected), dt('ov.max', { n: fmtNum(o.max_connections) }))
      tile(dt('ov.size'), size != null ? sizeOf(+size) : null)
      tile(dt('ov.queries'), fmtNum(st.Questions), st.Slow_queries ? dt('ov.slow', { n: fmtNum(st.Slow_queries) }) : '')
      tile(dt('ov.login'), o.login)
    }
  }
  tile(dt('ov.source'), inst.source === 'docker' ? 'Docker · ' + inst.container : dt('service') + ' · :' + inst.port, inst.image || inst.cluster || inst.unit || '')
  el.append(h('div', { className: 'db-tiles' }, ...tiles))
  if (S.overview.error) el.append(h('div', { className: 'msg small err db-err', textContent: S.overview.error.message }))
  const acts = [h('button', { className: 'chip', innerHTML: icon('code') + `<span>${dt(inst.engine === 'redis' ? 'open_cli' : 'open_sql')}</span>`, onclick: () => switchDbView(tab, 'sql') })]
  if (inst.engine === 'redis') acts.unshift(h('button', { className: 'primary', textContent: dt('backup.instance'), onclick: () => dbBackup(tab, inst, null) }))
  else acts.unshift(h('button', { className: 'chip', innerHTML: icon('grid') + `<span>${dt('view.data')}</span>`, onclick: () => switchDbView(tab, 'data') }))
  el.append(h('div', { className: 'chips' }, ...acts), backupLine(tab, inst, S))
}
const switchDbView = (tab, v) => { tab.dbs.view = v; paintDbs(tab); loadDbView(tab) }

// ---------- backups ----------
function backupLine(tab, inst, S) {
  if (!S.backup) return h('span')
  const b = S.backup
  return h('div', { className: 'db-backup' }, h('span', { innerHTML: icon('archive') }),
    h('div', { className: 'svc-main' }, h('b', { textContent: dt('backup.done', { size: sizeOf(b.size) }) }), h('small', { className: 'dim', textContent: b.path, title: b.path })),
    h('button', { className: 'chip', innerHTML: icon('download') + `<span>${dt('backup.download')}</span>`, onclick: () => downloadBackup(tab, b) }))
}
async function downloadBackup(tab, b) {
  try { const r = await api.invoke('sftp:download', tab.connId, [b.path]); if (r) downloadedToast(r) } catch (e) { toast(errText(e), true) }
}
async function dbBackup(tab, inst, db) {
  const S = dbState(tab, inst.id)
  if (S.backingUp) return
  S.backingUp = db || '*'
  paintDbs(tab)
  toast(dt('backup.running', { name: db || inst.flavor }), false, 60000)
  try {
    S.backup = await api.invoke('db:backup', tab.connId, inst.id, db)
    toast(dt('backup.done', { size: sizeOf(S.backup.size) }), false, 10000, { label: dt('backup.download'), fn: () => downloadBackup(tab, S.backup) })
  } catch (e) { toast(dt('backup.failed', { error: errText(e) }), true, 8000) }
  S.backingUp = null
  paintDbs(tab)
}

// ---------- data grid ----------
const cellText = v => (v == null ? '' : String(v))
function dbGrid(columns, rows, { onRow } = {}) {
  const table = h('table', { className: 'db-grid' },
    h('thead', {}, h('tr', {}, ...columns.map(c => h('th', { textContent: c, title: c })))),
    h('tbody', {}, ...rows.map(r => {
      const tr = h('tr', {}, ...r.map(v => v == null ? h('td', { className: 'null', textContent: 'NULL' })
        : h('td', { textContent: String(v).length > 300 ? String(v).slice(0, 300) + '…' : String(v), title: String(v).slice(0, 4000) })))
      if (onRow) { tr.className = 'click'; tr.onclick = () => onRow(r) }
      return tr
    })))
  // double-click copies the cell
  table.ondblclick = e => { const td = e.target.closest('td'); if (!td) return; const i = [...td.parentNode.children].indexOf(td), r = rows[[...td.parentNode.parentNode.children].indexOf(td.parentNode)]; navigator.clipboard.writeText(cellText(r?.[i])); toast(dt('copied')) }
  return h('div', { className: 'db-grid-wrap' }, table)
}
const csvOf = (columns, rows) => [columns, ...rows].map(r => r.map(v => (v == null ? '' : /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')).join('\n')

// ---------- SQL data browser ----------
function paintSqlData(tab, el, inst, S) {
  const A = S.data
  if (busyMsg(el, S, 'databases')) return
  const dbs = S.databases.results[0]
  const col = name => dbs.columns.indexOf(name)
  const sys = new Set(dbModel.SYSTEM_DBS[inst.engine])
  const crumbs = h('div', { className: 'db-crumbs' },
    h('button', { className: 'linkish' + (A.db ? '' : ' on'), textContent: dt('databases'), onclick: () => { Object.assign(A, { db: null, table: null }); S.tables = null; paintDbs(tab) } }),
    ...(A.db ? [h('span', { className: 'dim', textContent: '›' }), h('button', { className: 'linkish' + (A.table ? '' : ' on'), textContent: A.db, onclick: () => { A.table = null; paintDbs(tab) } })] : []),
    ...(A.table ? [h('span', { className: 'dim', textContent: '›' }), h('b', { textContent: (A.table.schema && A.table.schema !== 'public' && A.table.schema !== A.db ? A.table.schema + '.' : '') + A.table.name })] : []))
  el.append(crumbs)
  if (!A.db) {
    const list = h('div', { className: 'svc-list' })
    const rows = [...dbs.rows].sort((a, b) => sys.has(a[0]) - sys.has(b[0]) || a[0].localeCompare(b[0]))
    for (const r of rows) {
      const name = r[0], size = r[col('size')]
      const meta = [size ? sizeOf(+size) : null, col('tables') >= 0 ? dt('n_tables', { n: fmtNum(r[col('tables')]) }) : null, col('owner') >= 0 ? dt('owner', { name: r[col('owner')] }) : null,
        col('connections') >= 0 && +r[col('connections')] ? dt('n_conn', { n: r[col('connections')] }) : null, r[col('encoding')]].filter(Boolean).join(' · ')
      list.append(h('div', { className: 'dk click' + (sys.has(name) ? ' db-sys' : ''), onclick: () => { A.db = name; A.table = null; S.tables = null; paintDbs(tab); loadDbView(tab) } },
        h('span', { className: 'dk-ic', innerHTML: icon('database') }),
        h('div', { className: 'svc-main' }, h('b', { textContent: name + (sys.has(name) ? ' · ' + dt('system') : '') }), h('small', { className: 'dim', textContent: meta })),
        h('span', { className: 'svc-btns' }, h('button', { className: 'ib', innerHTML: icon('archive'), title: dt('backup.db', { name }), disabled: !!S.backingUp, onclick: e => { e.stopPropagation(); dbBackup(tab, inst, name) } }))))
    }
    return el.append(list, backupLine(tab, inst, S))
  }
  if (!A.table) {
    el.append(h('div', { className: 'chips' },
      h('button', { className: 'chip', innerHTML: icon('archive') + `<span>${S.backingUp === A.db ? dt('backup.busy') : dt('backup.db', { name: A.db })}</span>`, disabled: !!S.backingUp, onclick: () => dbBackup(tab, inst, A.db) }),
      h('button', { className: 'chip', innerHTML: icon('code') + `<span>${dt('open_sql')}</span>`, onclick: () => { S.sql.db = A.db; switchDbView(tab, 'sql') } })), backupLine(tab, inst, S))
    if (busyMsg(el, S, 'tables')) return
    const T = S.tables.results[0], ci = n => T.columns.indexOf(n)
    const search = h('input', { className: 's-filter', spellcheck: false, placeholder: dt('search_tables'), value: A.query || '', oninput: () => { A.query = search.value; fill() } })
    const list = h('div', { className: 'svc-list' })
    const fill = () => {
      list.replaceChildren()
      const qy = (A.query || '').toLowerCase()
      const rows = T.rows.filter(r => !qy || (r[ci('schema')] + '.' + r[ci('name')]).toLowerCase().includes(qy))
      if (!rows.length) return list.append(h('div', { className: 'msg small', textContent: dt(T.rows.length ? 'no_match' : 'no_tables') }))
      for (const r of rows) {
        const schema = r[ci('schema')], name = r[ci('name')], kind = r[ci('kind')]
        list.append(h('div', { className: 'dk click', onclick: () => { A.table = { schema, name }; A.page = 0; A.tableTab = 'data'; S.preview = S.columns = null; paintDbs(tab); loadTable(tab) } },
          h('span', { className: 'dk-ic', innerHTML: icon(kind === 'table' ? 'grid' : 'eye') }),
          h('div', { className: 'svc-main' }, h('b', { textContent: (schema && schema !== 'public' && schema !== A.db ? schema + '.' : '') + name }),
            h('small', { className: 'dim', textContent: [kind !== 'table' ? dt('kind.' + kind) : null, r[ci('rows')] != null ? dt('n_rows', { n: +r[ci('rows')] }) : null, r[ci('size')] ? sizeOf(+r[ci('size')]) : null, r[ci('engine')]].filter(Boolean).join(' · ') }))))
      }
    }
    fill()
    return el.append(search, list)
  }
  // a table: its rows (100 per page) or its structure
  const seg = h('div', { className: 'seg' }, ...[['data', 'grid'], ['structure', 'info']].map(([k, ic]) => h('button', { className: A.tableTab === k ? 'on' : '', innerHTML: icon(ic) + `<span>${dt('table.' + k)}</span>`, onclick: () => { A.tableTab = k; paintDbs(tab); loadTable(tab) } })))
  const ident = inst.engine === 'postgres' ? `${dbModel.pgId(A.table.schema)}.${dbModel.pgId(A.table.name)}` : dbModel.myId(A.table.name)
  el.append(h('div', { className: 'db-row' }, seg, h('button', { className: 'chip', innerHTML: icon('code') + `<span>${dt('open_sql')}</span>`, onclick: () => { S.sql.db = A.db; S.sql.text = `SELECT * FROM ${ident}\nLIMIT 100;`; S.sql.editor?.setValue(S.sql.text); switchDbView(tab, 'sql') } })))
  if (A.tableTab === 'structure') {
    if (busyMsg(el, S, 'columns')) return
    const [cols, idx] = S.columns.results
    el.append(h('h4', { className: 'db-h', textContent: dt('columns') }), dbGrid(cols.columns, cols.rows.map(r => r.map(v => (v === 't' || v === '1' ? '✓' : v === 'f' || v === '0' ? '' : v)))))
    if (idx?.rows.length) el.append(h('h4', { className: 'db-h', textContent: dt('indexes') }), dbGrid(idx.columns, idx.rows))
    return
  }
  if (busyMsg(el, S, 'preview')) return
  const P = S.preview.results[0], from = A.page * 100
  el.append(h('div', { className: 'db-row' },
    h('span', { className: 'dim', textContent: P.rows.length ? dt('range', { from: fmtNum(from + 1), to: fmtNum(from + P.rows.length) }) : dt('no_rows') }),
    h('span', { className: 'mchip lv-idle', textContent: dt('read_only') }),
    h('span', { className: 'dk-acts' },
      h('button', { className: 'ib', innerHTML: icon('chevron-up'), title: dt('prev'), disabled: !A.page, onclick: () => { A.page--; S.preview = null; paintDbs(tab); loadTable(tab) } }),
      h('button', { className: 'ib', innerHTML: icon('chevron-down'), title: dt('next'), disabled: P.rows.length < 100, onclick: () => { A.page++; S.preview = null; paintDbs(tab); loadTable(tab) } }),
      h('button', { className: 'ib', innerHTML: icon('copy'), title: dt('copy_csv'), onclick: () => { navigator.clipboard.writeText(csvOf(P.columns || [], P.rows)); toast(dt('copied')) } }))))
  if (P.columns) el.append(dbGrid(P.columns, P.rows))
}
async function loadTable(tab) {
  const inst = curInst(tab), S = dbState(tab, inst.id), A = S.data
  if (!A.table) return
  const key = A.tableTab === 'structure' ? 'columns' : 'preview'
  if (S[key]) return paintDbs(tab)
  const a = { db: A.db, schema: A.table.schema, table: A.table.name, limit: 100, offset: A.page * 100 }
  try { S[key] = await dbOp(tab, key, a); S[key + 'Error'] = null } catch (e) { S[key + 'Error'] = errText(e) }
  paintDbs(tab)
}

// ---------- Redis keys ----------
async function loadKeys(tab, reset) {
  const inst = curInst(tab), S = dbState(tab, inst.id), R = S.redis
  if (reset) { R.keys = []; R.cursor = '0' }
  R.busy = true
  try {
    // SCAN may return few keys per call: a few rounds, until 200 keys or the end
    let cursor = R.cursor, rounds = 0
    do {
      const r = await dbOp(tab, 'keys', { db: R.db, pattern: R.pattern, cursor, count: 500 })
      R.keys.push(...r.keys); cursor = r.cursor
    } while (cursor !== '0' && R.keys.length < 200 && ++rounds < 20)
    R.cursor = cursor; R.error = null
  } catch (e) { R.error = errText(e) }
  R.busy = false; R.loaded = true
  paintDbs(tab)
}
function paintRedisData(tab, el, inst, S) {
  const R = S.redis
  if (R.key) return paintRedisKey(tab, el, inst, S)
  const spaces = S.overview ? dbModel.keyspace(S.overview.info) : []
  const dbs = [...new Set(['0', ...spaces.map(d => d.name)])]
  const sel = h('select', { className: 'lsel', title: dt('redis_db'), onchange: () => { R.db = sel.value; loadKeys(tab, true) } }, ...dbs.map(d => h('option', { value: d, textContent: `db${d}` + (spaces.find(x => x.name === d) ? ` (${fmtNum(spaces.find(x => x.name === d).keys)})` : '') })))
  sel.value = R.db
  const pat = h('input', { className: 's-filter', spellcheck: false, value: R.pattern === '*' ? '' : R.pattern, placeholder: dt('redis_pattern'), onkeydown: e => { if (e.key === 'Enter') { R.pattern = pat.value.trim() || '*'; loadKeys(tab, true) } } })
  el.append(h('div', { className: 'kube-tools' }, sel, pat))
  if (R.error) return el.append(h('div', { className: 'msg small err db-err', textContent: R.error }))
  if (!R.loaded) return el.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
  const list = h('div', { className: 'svc-list' })
  if (!R.keys.length) list.append(h('div', { className: 'msg small', textContent: dt('no_keys') }))
  for (const k of R.keys) list.append(h('div', { className: 'dk click', onclick: () => openRedisKey(tab, k.key) },
    h('span', { className: 'mchip lv-idle db-type', textContent: k.type }),
    h('div', { className: 'svc-main' }, h('b', { textContent: k.key, title: k.key })),
    h('small', { className: 'dim', textContent: k.ttl >= 0 ? dt('ttl', { time: fmtDur(k.ttl) }) : '' })))
  el.append(list)
  if (R.cursor !== '0') el.append(h('button', { className: 'chip', textContent: R.busy ? t('dash.checking') : dt('more'), disabled: R.busy, onclick: () => loadKeys(tab, false) }))
}
async function openRedisKey(tab, key) {
  const inst = curInst(tab), R = dbState(tab, inst.id).redis
  R.key = { key, data: null, error: null }
  paintDbs(tab)
  try { R.key.data = await dbOp(tab, 'key', { db: R.db, key }) } catch (e) { R.key.error = errText(e) }
  paintDbs(tab)
}
function paintRedisKey(tab, el, inst, S) {
  const R = S.redis, K = R.key
  el.append(h('div', { className: 'db-crumbs' }, h('button', { className: 'linkish', textContent: `db${R.db}`, onclick: () => { R.key = null; paintDbs(tab) } }), h('span', { className: 'dim', textContent: '›' }), h('b', { textContent: K.key })))
  if (K.error) return el.append(h('div', { className: 'msg small err db-err', textContent: K.error }))
  if (!K.data) return el.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
  const d = K.data
  if (d.type === 'none') return el.append(h('div', { className: 'msg small', textContent: dt('key_gone') }))
  el.append(h('div', { className: 'chips' }, h('span', { className: 'mchip lv-ok', textContent: d.type }), h('span', { className: 'mchip lv-idle', textContent: d.ttl >= 0 ? dt('ttl', { time: fmtDur(d.ttl) }) : dt('no_ttl') }),
    ...(typeof d.memory === 'number' ? [h('span', { className: 'mchip lv-idle', textContent: sizeOf(d.memory) })] : []), ...(d.length != null ? [h('span', { className: 'mchip lv-idle', textContent: dt('length', { n: +d.length }) })] : []),
    h('span', { className: 'mchip lv-idle', textContent: dt('read_only') })))
  const v = d.value, pairs = a => { const out = []; for (let i = 0; i + 1 < (a || []).length; i += 2) out.push([a[i], a[i + 1]]); return out }
  if (d.type === 'string') el.append(h('pre', { className: 'kube-text', textContent: v ?? '' }))
  else if (d.type === 'hash') el.append(dbGrid([dt('field'), dt('value')], pairs(v)))
  else if (d.type === 'zset') el.append(dbGrid([dt('member'), dt('score')], pairs(v)))
  else if (d.type === 'list') el.append(dbGrid(['#', dt('value')], (v || []).map((x, i) => [String(i), x])))
  else if (d.type === 'set') el.append(dbGrid([dt('member')], (v || []).map(x => [x])))
  else el.append(h('pre', { className: 'kube-text', textContent: JSON.stringify(v, null, 2) }))
  if (d.length != null && Array.isArray(v) && d.length > (d.type === 'hash' || d.type === 'zset' ? v.length / 2 : v.length)) el.append(h('small', { className: 'dim', textContent: dt('partial') }))
}

// ---------- editor ----------
function paintEditor(tab, el, inst, S) {
  const Q = S.sql, redis = inst.engine === 'redis'
  el.classList.add('db-editor')
  let dbSel
  if (redis) {
    const spaces = S.overview ? dbModel.keyspace(S.overview.info).map(d => d.name) : []
    dbSel = h('select', { className: 'lsel', title: dt('redis_db'), onchange: () => { Q.db = dbSel.value } }, ...[...new Set(['0', ...spaces])].map(d => h('option', { value: d, textContent: 'db' + d })))
    Q.db ||= '0'
  } else {
    const names = S.databases?.results[0]?.rows.map(r => r[0]) || []
    if (!Q.db) Q.db = inst.login?.database || (inst.engine === 'postgres' ? (inst.source === 'docker' && names.includes(inst.database) ? inst.database : names.find(n => n !== 'postgres') || 'postgres') : inst.database && names.includes(inst.database) ? inst.database : names.find(n => !dbModel.SYSTEM_DBS.mysql.includes(n)) || '')
    dbSel = h('select', { className: 'lsel', title: dt('database'), onchange: () => { Q.db = dbSel.value } }, ...(inst.engine === 'mysql' ? [h('option', { value: '', textContent: dt('no_database') })] : []), ...names.map(n => h('option', { value: n, textContent: n })))
  }
  dbSel.value = Q.db
  const ro = h('input', { type: 'checkbox', checked: Q.readOnly, onchange: () => { Q.readOnly = ro.checked; paintDbs(tab) } })
  const runBtn = h('button', { className: 'primary', innerHTML: icon('play') + `<span>${dt('run')}</span>`, disabled: Q.running, title: dt('run_hint'), onclick: () => runDbScript(tab) })
  el.append(h('div', { className: 'db-ed-tools' }, dbSel, h('label', { className: 'check db-ro' + (Q.readOnly ? '' : ' off') }, ro, h('span', { textContent: dt('read_only') })), h('span', { className: 'grow' }), runBtn))
  // the editor (Monaco) is created once per instance and moved back in at each repaint
  if (!Q.host) {
    Q.host = h('div', { className: 'db-ed-host' })
    loadMonaco().then(monaco => {
      refreshEditorTheme()
      Q.editor = monaco.editor.create(Q.host, { value: Q.text || (redis ? '# ' + dt('redis_hint') + '\nINFO keyspace\nSCAN 0 MATCH * COUNT 20\n' : dt('sql_hint')), language: redis ? 'plaintext' : inst.engine === 'mysql' ? 'mysql' : 'pgsql',
        theme: 'cyberdog', automaticLayout: true, minimap: { enabled: false }, fontSize: settings.editorFontSize || 13, scrollBeyondLastLine: false, fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', lineNumbersMinChars: 3, fixedOverflowWidgets: true })
      Q.editor.onDidChangeModelContent(() => { Q.text = Q.editor.getValue() })
      Q.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runDbScript(tab))
      Q.text = Q.editor.getValue()
    }).catch(() => {
      const ta = h('textarea', { className: 'db-ed-text', spellcheck: false, value: Q.text, oninput: () => { Q.text = ta.value }, onkeydown: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runDbScript(tab) } })
      Q.host.append(ta)
    })
  }
  el.append(Q.host)
  const out = h('div', { className: 'db-results' })
  if (Q.running) out.append(h('div', { className: 'msg small', textContent: dt('executing') }))
  else if (Q.error) out.append(h('div', { className: 'msg small err db-err', textContent: Q.error }))
  else if (Q.results) paintResults(out, Q.results, redis)
  else out.append(h('div', { className: 'msg small dim', textContent: dt(Q.readOnly ? 'ro_note' : 'rw_note') }))
  el.append(out)
}
function paintResults(out, R, redis) {
  if (R.ms != null) out.append(h('small', { className: 'dim', textContent: dt('took', { ms: fmtNum(R.ms), n: R.results.length }) }))
  for (const [i, r] of R.results.entries()) {
    const label = h('code', { className: 'db-stmt', textContent: r.statement.split('\n')[0].slice(0, 120), title: r.statement })
    if (redis) { out.append(h('div', { className: 'db-res' }, label, h('pre', { className: 'kube-text', textContent: r.text || '(empty)' }))); continue }
    const info = r.columns ? dt(r.truncated ? 'rows_cut' : 'rows', { n: +(r.total ?? r.rows.length), shown: fmtNum(r.rows.length) }) : dt('affected', { n: +r.affected })
    const box = h('div', { className: 'db-res' }, h('div', { className: 'db-row' }, label, h('small', { className: 'dim', textContent: info }),
      ...(r.columns ? [h('button', { className: 'ib', innerHTML: icon('copy'), title: dt('copy_csv'), onclick: () => { navigator.clipboard.writeText(csvOf(r.columns, r.rows)); toast(dt('copied')) } })] : [])))
    if (r.columns) box.append(dbGrid(r.columns, r.rows))
    out.append(box)
  }
  if (R.error) out.append(h('div', { className: 'db-res' }, ...(R.error.statement ? [h('code', { className: 'db-stmt', textContent: R.error.statement.split('\n')[0].slice(0, 120), title: R.error.statement })] : []), h('div', { className: 'msg small err db-err', textContent: R.error.message })))
  if (R.cut) out.append(h('small', { className: 'dim', textContent: dt('cut') }))
}
async function runDbScript(tab) {
  const inst = curInst(tab), S = dbState(tab, inst.id), Q = S.sql
  if (Q.running) return
  Q.text = Q.editor?.getValue() ?? Q.text
  // a selection runs alone
  const sel = Q.editor?.getSelection(), part = sel && !sel.isEmpty() ? Q.editor.getModel().getValueInRange(sel) : Q.text
  if (!part.trim()) return
  if (!Q.readOnly) {
    let writes = 0
    try { writes = inst.engine === 'redis' ? dbModel.redisLines(part).filter(l => !dbModel.isReadRedis(l)).length : dbModel.splitSql(part, inst.engine).filter(s => !dbModel.isReadSql(s, inst.engine)).length } catch {}
    if (writes && !confirm(dt('confirm_write', { n: writes }))) return
  }
  Object.assign(Q, { running: true, error: null })
  paintDbs(tab)
  try { Q.results = await api.invoke('db:run', tab.connId, inst.id, part, { db: Q.db, readOnly: Q.readOnly }) } catch (e) { Q.results = null; Q.error = errText(e) }
  Q.running = false
  // what was changed may show in the other views
  if (!Q.readOnly) Object.assign(S, { databases: null, tables: null, preview: null, columns: null, overview: null })
  paintDbs(tab)
}

// ---------- activity ----------
async function loadActivity(tab, quiet) {
  const inst = curInst(tab), S = dbState(tab, inst.id)
  if (S.activityBusy) return
  S.activityBusy = true
  try { S.activity = await dbOp(tab, 'activity'); S.activityError = null } catch (e) { S.activityError = errText(e) }
  S.activityBusy = false
  if (tab.dbs.view === 'activity' && tab.dbs.inst === inst.id) paintDbs(tab)
}
function paintActivity(tab, el, inst, S) {
  if (busyMsg(el, S, 'activity')) return
  const list = h('div', { className: 'svc-list' })
  const kill = async (pid, hard, label) => {
    if (!confirm(dt(hard ? 'confirm_kill' : 'confirm_cancel', { name: label }))) return
    try { await dbOp(tab, 'kill', { pid, hard }); toast(dt('killed', { name: label })) } catch (e) { toast(errText(e), true) }
    loadActivity(tab)
  }
  const btn = (ic, key, fn) => h('button', { className: 'ib', innerHTML: icon(ic), title: dt(key), onclick: e => { e.stopPropagation(); fn() } })
  if (inst.engine === 'redis') {
    const clients = S.activity.clients || []
    el.append(h('small', { className: 'dim', textContent: dt('n_clients', { n: clients.length }) }))
    for (const c of clients) list.append(h('div', { className: 'dk' }, h('span', { className: 'dot lv-' + (c.cmd && !/^(client|ping|null)/.test(c.cmd) ? 'ok' : 'idle') }),
      h('div', { className: 'svc-main' }, h('b', { textContent: `${c.addr}${c.name ? ' · ' + c.name : ''}` }), h('small', { className: 'dim', textContent: `db${c.db} · ${c.cmd || '—'} · ${dt('age', { time: fmtDur(+c.age || 0) })} · ${dt('idle', { time: fmtDur(+c.idle || 0) })}` })),
      h('span', { className: 'svc-btns' }, btn('x', 'kill', () => kill(c.id, true, c.addr)))))
    return el.append(list)
  }
  const R = S.activity.results[0], ci = n => R.columns.indexOf(n)
  el.append(h('small', { className: 'dim', textContent: dt('n_sessions', { n: R.rows.length }) }))
  for (const r of R.rows) {
    const pid = r[ci('pid')], state = r[ci('state')] || '', secs = +r[ci('seconds')] || 0, query = r[ci('query')] || ''
    const active = inst.engine === 'postgres' ? state === 'active' : state !== 'Sleep' && state !== 'Daemon'
    const lv = active ? (secs > 60 ? 'warn' : 'ok') : /idle in transaction/.test(state) ? 'warn' : 'idle'
    list.append(h('div', { className: 'dk db-session' }, h('span', { className: 'dot lv-' + lv, title: state }),
      h('div', { className: 'svc-main' },
        h('b', { textContent: `${r[ci('user')] || '—'}${r[ci('database')] ? ' @ ' + r[ci('database')] : ''}` }),
        h('small', { className: 'dim', textContent: [`#${pid}`, r[ci('client')], state, secs ? fmtDur(secs) : '', r[ci('application')], r[ci('waiting')]].filter(Boolean).join(' · ') }),
        ...(query && active ? [h('code', { className: 'db-query', textContent: query, title: query })] : [])),
      h('span', { className: 'svc-btns' }, ...(active ? [btn('stop', 'cancel', () => kill(pid, false, '#' + pid))] : []), btn('x', 'kill', () => kill(pid, true, '#' + pid)))))
  }
  if (!R.rows.length) list.append(h('div', { className: 'msg small', textContent: dt('no_sessions') }))
  el.append(list, h('small', { className: 'dim', textContent: dt('auto_refresh') }))
}

// ---------- users and rights ----------
function paintUsers(tab, el, inst, S) {
  if (S.user) return paintGrants(tab, el, inst, S)
  if (busyMsg(el, S, 'users')) return
  const list = h('div', { className: 'svc-list' })
  if (inst.engine === 'redis') {
    for (const line of S.users.users || []) {
      const [, name, ...rules] = String(line).split(' ')
      list.append(h('div', { className: 'dk' }, h('span', { className: 'dot lv-' + (rules.includes('on') ? 'ok' : 'idle') }),
        h('div', { className: 'svc-main' }, h('b', { textContent: name }), h('code', { className: 'db-query', textContent: rules.join(' ') }))))
    }
    return el.append(h('p', { className: 'security-note dim', textContent: dt('acl_note') }), list)
  }
  const R = S.users.results[0], ci = n => R.columns.indexOf(n)
  for (const r of R.rows) {
    const name = r[ci('name')], host = r[ci('host')]
    const chips = inst.engine === 'postgres'
      ? [['login', 'login'], ['superuser', 'superuser'], ['createdb', 'createdb'], ['createrole', 'createrole'], ['replication', 'replication']].filter(([c]) => r[ci(c)] === 't').map(([, k]) => dt('flag.' + k))
      : [r[ci('plugin')], r[ci('no_password')] === 'yes' ? dt('flag.no_password') : null].filter(Boolean)
    const sub = inst.engine === 'postgres' ? [r[ci('member_of')] ? dt('member_of', { names: r[ci('member_of')] }) : '', r[ci('connlimit')] !== '-1' ? dt('connlimit', { n: r[ci('connlimit')] }) : '', r[ci('valid_until')] ? dt('valid_until', { date: r[ci('valid_until')] }) : ''].filter(Boolean).join(' · ') : ''
    list.append(h('div', { className: 'dk click', onclick: () => { S.user = { name, host, data: null }; paintDbs(tab); loadGrants(tab) } },
      h('span', { className: 'dk-ic', innerHTML: icon(r[ci('superuser')] === 't' ? 'shield' : 'user') }),
      h('div', { className: 'svc-main' }, h('b', { textContent: name + (host ? '@' + host : '') }), ...(sub ? [h('small', { className: 'dim', textContent: sub })] : []),
        h('span', { className: 'dk-res' }, ...chips.map(c => h('span', { className: 'mchip lv-' + (/super|root/.test(c) ? 'warn' : 'idle'), textContent: c })))),
      h('span', { className: 'dim', innerHTML: icon('chevron-right') })))
  }
  el.append(list)
}
async function loadGrants(tab) {
  const inst = curInst(tab), S = dbState(tab, inst.id), U = S.user
  const db = inst.engine === 'postgres' ? S.data.db || S.sql.db || undefined : undefined
  try { U.data = await dbOp(tab, 'grants', { user: U.name, host: U.host, db }); U.error = null } catch (e) { U.error = errText(e) }
  paintDbs(tab)
}
function paintGrants(tab, el, inst, S) {
  const U = S.user
  el.append(h('div', { className: 'db-crumbs' }, h('button', { className: 'linkish', textContent: dt('view.users'), onclick: () => { S.user = null; paintDbs(tab) } }), h('span', { className: 'dim', textContent: '›' }), h('b', { textContent: U.name + (U.host ? '@' + U.host : '') })))
  if (U.error) return el.append(h('div', { className: 'msg small err db-err', textContent: U.error }))
  if (!U.data) return el.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
  const [a, b] = U.data.results
  if (inst.engine === 'mysql') return el.append(...a.rows.map(r => h('pre', { className: 'kube-text db-grant', textContent: r[0] })))
  el.append(h('h4', { className: 'db-h', textContent: dt('grants_db') }), dbGrid(a.columns, a.rows.map(r => r.map(v => (v === 't' ? '✓' : v === 'f' ? '' : v)))))
  el.append(h('h4', { className: 'db-h', textContent: dt('grants_tables', { db: S.data.db || S.sql.db || 'postgres' }) }), b.rows.length ? dbGrid(b.columns, b.rows) : h('div', { className: 'msg small', textContent: dt('no_grants') }))
}

// ---------- server log ----------
function paintDbLogs(tab, el, inst, S) {
  if (S.log) { el.append(S.log.el); return S.log.render() }
  if (S.logError) return el.append(h('div', { className: 'msg small err db-err', textContent: S.logError }))
  el.append(h('div', { className: 'msg small', textContent: t('dash.checking') }))
  api.invoke('db:log', tab.connId, inst.id).then(spec => {
    if (tab.dbs.view !== 'logs' || tab.dbs.inst !== inst.id) return
    S.log = createLogView(tab)
    S.logError = null
    paintDbs(tab)
    S.log.start(spec)
  }, e => { S.logError = errText(e); paintDbs(tab) })
}
