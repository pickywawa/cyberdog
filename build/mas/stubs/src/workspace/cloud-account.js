// Mac App Store edition: no Cyberdog account, teams or shared servers. Every server stays on this Mac.
function createCloudAccount() {
  const state = { configured: false, signedIn: false, email: null, teams: [], servers: [], assets: [], invitations: [] }
  const unavailable = () => Promise.reject(new Error('access_denied'))
  return {
    available: false,
    state: () => state, init: async () => state, refresh: async () => state,
    getServer: unavailable, getRoute: unavailable, getRouteForDraft: unavailable, getAsset: unavailable,
    saveServer: unavailable, saveAsset: unavailable, action: unavailable,
    saveCredentials() { throw new Error('access_denied') },
    localAuth: () => ({}), hasPassword: () => false, localKey: () => undefined, previews: () => [],
  }
}
module.exports = { createCloudAccount }
