// Store references to configured servers, never credentials or terminal contents.
// paths: the folder of each explorer of the tab (two when split), absolute paths only.
const folder = p => typeof p === 'string' && p.startsWith('/') && p.length <= 4096 && !p.includes('\0')
function normalizeSession(items, servers) {
  if (!Array.isArray(items)) return []
  const allowed = new Set(servers.map(s => s.id))
  return items.slice(0, 50).filter(x => x && allowed.has(x.serverId))
    .map(x => ({ serverId: x.serverId, terminal: x.terminal === true, paths: Array.isArray(x.paths) ? x.paths.filter(folder).slice(0, 2) : [] }))
}
module.exports = { normalizeSession }
