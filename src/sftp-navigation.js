const posix = require('path').posix
const P = (s, method, ...args) => new Promise((resolve, reject) => s[method](...args, (e, value) => e ? reject(e) : resolve(value)))
// `known` : the caller already listed this folder (row, '..', back, refresh) — skip the realpath + stat round trips.
async function resolveDirectory(s, input, known = false) {
  if (known && typeof input === 'string' && input.startsWith('/')) return { path: posix.normalize(input), selected: null }
  // the home folder is only looked up when the path uses it
  let target = input
  if (input === '~' || input.startsWith('~/')) {
    const home = await P(s, 'realpath', '.')
    target = input === '~' ? home : posix.join(home, input.slice(2))
  }
  target = await P(s, 'realpath', target)
  const attrs = await P(s, 'stat', target)
  return attrs.isDirectory() ? { path: target, selected: null } : { path: posix.dirname(target), selected: posix.basename(target) }
}
module.exports = { resolveDirectory }
