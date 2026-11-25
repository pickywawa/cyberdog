// Mac App Store edition: no secret-manager integration (they rely on command-line tools the sandbox cannot run).
function createVaults() {
  const unavailable = () => Promise.reject(new Error('access_denied'))
  return {
    available: false,
    pins: () => [], list: () => [],
    resolve: unavailable, browse: unavailable, preview: unavailable, pin: unavailable, saveConnector: unavailable, unlock: unavailable, remove: unavailable,
    unpin() {}, lock() {}, fingerprint() {},
  }
}
module.exports = { createVaults }
