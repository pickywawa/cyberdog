// Store references to configured servers, never credentials or terminal contents.
function normalizeSession(items, servers) {
  if (!Array.isArray(items)) return []
  const allowed = new Set(servers.map(s => s.id))
  return items.slice(0, 50).filter(x => x && allowed.has(x.serverId)).map(x => ({ serverId: x.serverId, terminal: x.terminal === true }))
}
module.exports = { normalizeSession }
