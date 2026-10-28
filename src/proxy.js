// Outbound proxy (HTTP CONNECT or SOCKS5) for the file protocols, plus TLS options for the HTTP-based ones.
// ProxySocket is a net.Socket that reaches its target through the proxy: callers use it like any socket
// (`connect({ host, port })`), so basic-ftp and Node's http(s) agents need no proxy support of their own.
const net = require('net')
const tls = require('tls')
const http = require('http')
const https = require('https')

const SOCKS_ERRORS = { 1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' }

// Next n bytes / bytes up to and including marker, from what the proxy has sent so far
async function take(s, n) {
  while (s._buf.length < n) { if (s.destroyed) throw new Error('Proxy connection closed'); await new Promise(r => { s._wait = r }) }
  const b = s._buf.subarray(0, n)
  s._buf = s._buf.subarray(n)
  return b
}
async function until(s, marker) {
  for (;;) {
    const i = s._buf.indexOf(marker)
    if (i >= 0) return take(s, i + marker.length)
    if (s.destroyed) throw new Error('Proxy connection closed')
    await new Promise(r => { s._wait = r })
  }
}

async function httpConnect(s, host, port) {
  const { user, pass } = s.proxy
  const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass || ''}`).toString('base64')}\r\n` : ''
  const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
  const head = (await until(s, '\r\n\r\n')).toString('latin1')
  const status = +/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]
  if (status === 407) throw new Error('Proxy authentication required')
  if (status !== 200) throw new Error('Proxy refused the connection' + (status ? ` (HTTP ${status})` : ''))
}

async function socks5(s, host, port) {
  const { user, pass } = s.proxy
  s.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]))
  const choice = await take(s, 2)
  if (choice[0] !== 5 || choice[1] === 0xff) throw new Error('SOCKS5 proxy rejected the authentication methods')
  if (choice[1] === 2) {
    const u = Buffer.from(user || ''), p = Buffer.from(pass || '')
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
    if ((await take(s, 2))[1] !== 0) throw new Error('Proxy authentication required')
  }
  const ip = net.isIPv4(host)
  const addr = ip ? Buffer.from(host.split('.').map(Number)) : Buffer.concat([Buffer.from([Buffer.byteLength(host)]), Buffer.from(host)])
  s.write(Buffer.concat([Buffer.from([5, 1, 0, ip ? 1 : 3]), addr, Buffer.from([port >> 8, port & 0xff])]))
  const reply = await take(s, 4)
  if (reply[1] !== 0) throw new Error('SOCKS5 proxy: ' + (SOCKS_ERRORS[reply[1]] || 'error ' + reply[1]))
  await take(s, reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : (await take(s, 1))[0] + 2)
}

class ProxySocket extends net.Socket {
  constructor(proxy) {
    super()
    this.proxy = proxy
    this.tunneled = false
    this._buf = Buffer.alloc(0)
    this._wait = null
  }
  // Until the tunnel is up, the proxy's own bytes and the TCP "connect" are kept away from the caller.
  emit(event, ...args) {
    if (!this.tunneled) {
      if (event === 'connect') { this._tunnel().then(() => { this.emit('connect'); this.emit('ready') }, e => this.destroy(e)); return true }
      if (event === 'ready') return true
      if (event === 'data') { this._buf = Buffer.concat([this._buf, args[0]]); this._wait?.(); return true }
      if (event === 'close') this._wait?.()
    }
    return super.emit(event, ...args)
  }
  // basic-ftp asks for text mode up front; the proxy handshake is binary, so apply it once tunnelled
  setEncoding(encoding) {
    if (this.tunneled) return super.setEncoding(encoding)
    this._encoding = encoding
    return this
  }
  connect(options, cb) {
    this.target = { host: options.host, port: options.port }
    Object.defineProperty(this, 'remoteAddress', { get: () => this.target.host, configurable: true }) // callers compare it with server-announced addresses
    if (cb) this.once('connect', cb)
    return super.connect({ host: this.proxy.host, port: this.proxy.port })
  }
  async _tunnel() {
    this.resume()
    this._read(0) // net starts reading only from its own 'connect' listener, which this class held back
    await (this.proxy.type === 'socks5' ? socks5 : httpConnect)(this, this.target.host, this.target.port)
    this.tunneled = true
    if (this._encoding) super.setEncoding(this._encoding)
    if (this._buf.length) this.unshift(this._buf)
    this._buf = Buffer.alloc(0)
  }
}

// Agent for http(s).request: through the proxy and/or accepting untrusted certificates. undefined when neither applies.
function agentFor({ proxy, insecure } = {}, protocol) {
  if (!proxy && !insecure) return undefined
  const secure = protocol === 'https:'
  const agent = new (secure ? https : http).Agent(secure && insecure ? { rejectUnauthorized: false } : {})
  if (proxy) {
    // The request starts once the tunnel is up (callback form of createConnection), so nothing is written to the proxy before then
    agent.createConnection = (options, cb) => {
      const raw = new ProxySocket(proxy)
      raw.once('error', cb)
      raw.connect({ host: options.host || options.hostname, port: +options.port || (secure ? 443 : 80) }, () => {
        raw.removeListener('error', cb)
        cb(null, secure ? tls.connect({ ...options, socket: raw, servername: net.isIP(options.servername || options.host) ? undefined : options.servername || options.host }) : raw)
      })
    }
  }
  return agent
}

module.exports = { ProxySocket, agentFor }
