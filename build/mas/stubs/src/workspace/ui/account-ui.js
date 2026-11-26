// Mac App Store edition: no Cyberdog account, teams or shared servers.
let accountState = { configured: false, signedIn: false, email: null, teams: [], servers: [], assets: [], invitations: [] }
function updateAccount() {}
api.on('servers:changed', items => { servers = items; renderServers() })
