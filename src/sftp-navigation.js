const posix = require('path').posix
const P = (s, method, ...args) => new Promise((resolve, reject) => s[method](...args, (e, value) => e ? reject(e) : resolve(value)))
async function resolveDirectory(s, input) {
  const home = await P(s, 'realpath', '.')
  let target = input === '~' ? home : input.startsWith('~/') ? posix.join(home, input.slice(2)) : input
  target = await P(s, 'realpath', target)
  const attrs = await P(s, 'stat', target)
  return attrs.isDirectory() ? { path: target, selected: null } : { path: posix.dirname(target), selected: posix.basename(target) }
}
module.exports = { resolveDirectory }
