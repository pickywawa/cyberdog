// Connection type of a server: 'ssh' (default, SFTP + terminal), 's3', 'webdav', 'azure' or 'ftp' (files only).
const isShell = s => !s.type || s.type === 'ssh'

// S3 presets: endpoint template and default region. '' = AWS (or any endpoint typed by hand, e.g. MinIO).
const S3_PRESETS = {
  '': {},
  gcs: { url: () => 'https://storage.googleapis.com', region: 'auto' },
  b2: { url: r => `https://s3.${r}.backblazeb2.com`, region: 'us-west-004' },
  wasabi: { url: r => `https://s3.${r}.wasabisys.com`, region: 'us-east-1' },
  do: { url: r => `https://${r}.digitaloceanspaces.com`, region: 'nyc3' },
  scaleway: { url: r => `https://s3.${r}.scw.cloud`, region: 'fr-par' },
}
const FTP_SECURITY = ['none', 'explicit', 'implicit']

// Validated storage fields (type, url, host, port...) or null for SSH.
function storageFields(d) {
  const type = d.type || 'ssh'
  if (type === 'ssh') return null
  if (!['s3', 'webdav', 'ftp', 'azure'].includes(type)) throw Error('invalid_server')
  const str = (v, max) => { const x = v == null ? '' : v; if (typeof x !== 'string' || x.length > max || /[\x00-\x1f]/.test(x)) throw Error('invalid_server'); return x.trim() }

  if (type === 'ftp') {
    const host = str(d.host, 255), security = d.security || 'explicit'
    if (!host || /[\s/@]/.test(host) || !FTP_SECURITY.includes(security)) throw Error('invalid_server')
    const port = d.port === undefined || d.port === '' ? (security === 'implicit' ? 990 : 21) : Number(d.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid_server')
    return { type, host, port, security, insecureTls: security !== 'none' && !!d.insecureTls }
  }

  const preset = type === 's3' ? str(d.preset, 20) : ''
  if (!Object.hasOwn(S3_PRESETS, preset)) throw Error('invalid_server')
  const region = type === 's3' ? str(d.region, 40) || S3_PRESETS[preset].region || 'us-east-1' : ''
  const bucket = str(d.bucket, 63)
  if (type === 's3' && (!/^[a-z0-9-]+$/i.test(region) || bucket && !/^[a-z0-9][a-z0-9._-]*$/i.test(bucket))) throw Error('invalid_server')
  if (type === 'azure' && bucket && !/^[a-z0-9][a-z0-9-]*$/.test(bucket)) throw Error('invalid_server')
  const account = type === 'azure' ? str(d.user, 64) : ''
  if (type === 'azure' && account && !/^[a-z0-9]+$/i.test(account)) throw Error('invalid_server')
  let url = str(d.url, 2048)
  if (!url && type === 's3') url = (S3_PRESETS[preset].url || (r => `https://s3.${r}.amazonaws.com`))(region)
  if (!url && type === 'azure' && account) url = `https://${account.toLowerCase()}.blob.core.windows.net`
  let u
  try { u = new URL(url) } catch { throw Error('invalid_server') }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('invalid_server')
  url = u.origin + u.pathname.replace(/\/+$/, '')
  return {
    type, url, host: u.host, port: +u.port || (u.protocol === 'https:' ? 443 : 80),
    ...(type === 's3' ? { region, bucket, preset, virtualHost: !!d.virtualHost } : {}),
    ...(type === 'azure' ? { bucket } : {}),
  }
}

module.exports = { isShell, storageFields, S3_PRESETS }
