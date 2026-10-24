const AdmZip = require('adm-zip')
const fs = require('fs')
const crypto = require('crypto')
const TYPES = ['groups', 'servers', 'actions', 'paths']
const pick = (o, fields) => Object.fromEntries(fields.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
const endpoint = s => JSON.stringify([s.host?.trim().toLowerCase(), Number(s.port) || 22, s.user || ''])
const empty = () => Object.fromEntries(TYPES.map(k => [k, []]))
function select(data, selected) {
  const out = empty()
  for (const k of TYPES) {
    if (!Array.isArray(selected?.[k])) throw new Error('Invalid configuration selection')
    const ids = new Set(selected[k])
    out[k] = data[k].filter(x => ids.has(x.id))
  }
  return out
}
function writeBundle(data, file) {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'cyberdog-config', version: 1, created: new Date().toISOString(), counts: Object.fromEntries(TYPES.map(k => [k, data[k].length])) }, null, 2)))
  for (const k of TYPES) for (const [i, value] of data[k].entries()) {
    const fields = { groups: ['id', 'name', 'favorite', 'collapsed'], servers: ['id', 'name', 'host', 'port', 'user', 'key', 'group', 'favorite'], actions: ['id', 'name', 'script'], paths: ['id', 'name', 'path', 'serverId', 'server'] }[k]
    const item = pick(value, fields)
    if (k === 'paths' && item.server) item.server = pick(item.server, ['host', 'port', 'user'])
    const name = String(value.name || 'item').replace(/[^\w.-]+/g, '_').slice(0, 80)
    zip.addFile(`${k}/${String(i + 1).padStart(3, '0')}-${name}.json`, Buffer.from(JSON.stringify(item, null, 2)))
  }
  fs.writeFileSync(file, zip.toBuffer())
}
function linkPaths(paths, servers) {
  return paths.map(p => {
    if (!p.serverId) return p
    const server = servers.find(s => s.id === p.serverId) || (p.server && servers.find(s => endpoint(s) === endpoint(p.server)))
    return server ? { ...p, serverId: server.id, server: pick(server, ['host', 'port', 'user']) } : p
  })
}
function portable(data) {
  return { ...data, paths: data.paths.map(p => ({ ...p, ...(p.serverId && data.servers.find(s => s.id === p.serverId) ? { server: pick(data.servers.find(s => s.id === p.serverId), ['host', 'port', 'user']) } : {}) })) }
}
function readBundle(file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Configuration ZIP exceeds 32 MB')
  const entries = new AdmZip(file).getEntries().filter(e => !e.isDirectory && !e.entryName.includes('__MACOSX') && !e.entryName.split('/').at(-1).startsWith('._'))
  if (entries.length > 10000 || entries.reduce((n, e) => n + e.header.size, 0) > 32 * 1024 * 1024) throw new Error('Configuration ZIP exceeds size limits')
  const manifest = entries.find(e => e.entryName === 'manifest.json')
  const data = empty()
  if (manifest) {
    if (manifest.header.size > 10000) throw new Error('Invalid configuration manifest')
    const m = JSON.parse(manifest.getData().toString('utf8'))
    if (m.format !== 'cyberdog-config' || m.version !== 1) throw new Error('Unsupported configuration ZIP version')
  }
  for (const e of entries) {
    if (!e.entryName.endsWith('.json') || e === manifest) continue
    if (e.header.size > 1024 * 1024) throw new Error('Configuration item exceeds 1 MB')
    const type = e.entryName.match(/^(groups|servers|actions|paths)\/[^/]+\.json$/)?.[1]
    if (manifest && !type) continue
    const value = JSON.parse(e.getData().toString('utf8'))
    if (type) data[type].push(value)
    else if (value?.host) data.servers.push(value) // legacy server ZIP
    else if (value?.script) data.actions.push(value) // legacy action ZIP
  }
  return data
}
function merge(current, incoming) {
  const out = Object.fromEntries(TYPES.map(k => [k, current[k].map(x => ({ ...x }))]))
  const added = Object.fromEntries(TYPES.map(k => [k, 0]))
  let skipped = 0
  const groupIds = new Map(), serverIds = new Map()
  const text = x => typeof x === 'string' && x.trim().length > 0
  const ensureGroup = g => {
    if (!text(g?.name)) throw new Error('Invalid group')
    let existing = out.groups.find(x => x.name.toLowerCase() === g.name.trim().toLowerCase())
    if (!existing) { existing = { id: crypto.randomUUID(), name: g.name.trim(), favorite: !!g.favorite, collapsed: !!g.collapsed }; out.groups.push(existing); added.groups++ }
    if (g.id) groupIds.set(g.id, existing.id)
    return existing.id
  }
  for (const g of incoming.groups) ensureGroup(g)
  for (const s of incoming.servers) {
    if (!text(s?.host) || s.port != null && (!Number.isInteger(Number(s.port)) || Number(s.port) < 1 || Number(s.port) > 65535)) throw new Error('Invalid server')
    let existing = out.servers.find(x => endpoint(x) === endpoint(s))
    let group = groupIds.get(s.group)
    // Legacy ZIPs stored the group name instead of its ID.
    if (!group && text(s.group) && !incoming.groups.some(g => g.id === s.group) && !s.id) group = ensureGroup({ name: s.group })
    if (!existing) { existing = { id: crypto.randomUUID(), name: String(s.name || s.host), host: s.host.trim(), port: Number(s.port) || 22, user: String(s.user || ''), favorite: !!s.favorite, ...(typeof s.key === 'string' ? { key: s.key } : {}), ...(group ? { group } : {}) }; out.servers.push(existing); added.servers++ }
    if (group && !existing.group) existing.group = group
    if (s.id) serverIds.set(s.id, existing.id)
  }
  for (const a of incoming.actions) {
    if (!text(a?.name) || !text(a.script) || a.script.length > 60000) throw new Error('Invalid action')
    if (out.actions.some(x => x.name === a.name.trim() && x.script === a.script)) continue
    out.actions.push({ id: crypto.randomUUID(), name: a.name.trim(), script: a.script }); added.actions++
  }
  for (const p of incoming.paths) {
    if (typeof p?.path !== 'string' || !(p.path.startsWith('/') || p.path === '~' || p.path.startsWith('~/'))) throw new Error('Invalid saved path')
    let serverId
    if (p.serverId) {
      serverId = serverIds.get(p.serverId) || (p.server ? out.servers.find(s => endpoint(s) === endpoint(p.server))?.id : undefined)
      if (!serverId) { skipped++; continue }
    }
    if (out.paths.some(x => x.path === p.path && (x.serverId || '') === (serverId || '') && x.name === String(p.name || ''))) continue
    out.paths.push({ id: crypto.randomUUID(), name: String(p.name || ''), path: p.path, ...(serverId ? { serverId } : {}) }); added.paths++
  }
  return { data: out, added, skipped }
}
module.exports = { TYPES, select, writeBundle, portable, readBundle, merge, linkPaths }
