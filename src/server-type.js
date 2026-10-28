// Connection type of a server: 'ssh' (default, SFTP + terminal) or a files-only type: ftp, s3, azure, azurefiles, webdav,
// smb, dropbox, onedrive, gdrive.
const isShell = s => !s.type || s.type === 'ssh'
const DRIVES = { dropbox: 'www.dropbox.com', onedrive: 'graph.microsoft.com', gdrive: 'www.googleapis.com' }
const TYPES = ['ftp', 's3', 'azure', 'azurefiles', 'webdav', 'smb', ...Object.keys(DRIVES)]

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
const WEBDAV_AUTH = ['auto', 'basic', 'digest', 'bearer']
const PROXY_TYPES = ['none', 'http', 'socks5']

// Validated storage fields (type, url, host, port...) or null for SSH.
function storageFields(d) {
  const type = d.type || 'ssh'
  if (type === 'ssh') return null
  if (!TYPES.includes(type)) throw Error('invalid_server')
  const str = (v, max) => { const x = v == null ? '' : v; if (typeof x !== 'string' || x.length > max || /[\x00-\x1f]/.test(x)) throw Error('invalid_server'); return x.trim() }
  const portOf = (v, fallback) => { const port = v === undefined || v === '' ? fallback : Number(v); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid_server'); return port }

  // outbound proxy (every type that speaks TCP itself; SMB goes through the operating system)
  let proxy = {}
  if (type !== 'smb') {
    const proxyType = d.proxyType || 'none'
    if (!PROXY_TYPES.includes(proxyType)) throw Error('invalid_server')
    const proxyHost = proxyType === 'none' ? '' : str(d.proxyHost, 255)
    if (proxyType !== 'none' && (!proxyHost || /[\s/@]/.test(proxyHost))) throw Error('invalid_server')
    proxy = { proxyType, proxyHost, proxyPort: proxyType === 'none' ? '' : portOf(d.proxyPort, proxyType === 'http' ? 8080 : 1080), proxyUser: proxyType === 'none' ? '' : str(d.proxyUser, 128) }
  }

  if (type === 'ftp') {
    const host = str(d.host, 255), security = d.security || 'explicit'
    if (!host || /[\s/@]/.test(host) || !FTP_SECURITY.includes(security)) throw Error('invalid_server')
    return { type, host, port: portOf(d.port, security === 'implicit' ? 990 : 21), security, insecureTls: security !== 'none' && !!d.insecureTls, ...proxy }
  }

  if (type === 'smb') {
    const host = str(d.host, 255), share = str(d.bucket, 80), domain = str(d.domain, 64)
    if (!host || /[\s/@\\]/.test(host) || !share || /[\\/:*?"<>|]/.test(share) || !/^[\w.-]*$/.test(domain)) throw Error('invalid_server')
    return { type, host, port: portOf(d.port, 445), bucket: share, domain }
  }

  if (DRIVES[type]) {
    const clientId = str(d.clientId, 200), tenant = type === 'onedrive' ? str(d.tenant, 128) : ''
    if (clientId && !/^[\w.@-]+$/.test(clientId) || tenant && !/^[\w.-]+$/.test(tenant)) throw Error('invalid_server')
    return { type, host: DRIVES[type], port: 443, clientId, ...(type === 'onedrive' ? { tenant } : {}), ...proxy }
  }

  const preset = type === 's3' ? str(d.preset, 20) : ''
  if (!Object.hasOwn(S3_PRESETS, preset)) throw Error('invalid_server')
  const region = type === 's3' ? str(d.region, 40) || S3_PRESETS[preset].region || 'us-east-1' : ''
  const bucket = str(d.bucket, 63)
  const profile = type === 's3' ? str(d.profile, 64) : ''
  if (profile && !/^[\w.@ -]+$/.test(profile)) throw Error('invalid_server')
  if (type === 's3' && (!/^[a-z0-9-]+$/i.test(region) || bucket && !/^[a-z0-9][a-z0-9._-]*$/i.test(bucket))) throw Error('invalid_server')
  const azure = type === 'azure' || type === 'azurefiles'
  if (azure && bucket && !/^[a-z0-9][a-z0-9-]*$/.test(bucket)) throw Error('invalid_server')
  const account = azure ? str(d.user, 64) : ''
  if (azure && account && !/^[a-z0-9]+$/i.test(account)) throw Error('invalid_server')
  const azureAuth = azure && d.azureAuth === 'entra' ? 'entra' : 'key'
  const tenant = azure ? str(d.tenant, 128) : '', clientId = azure ? str(d.clientId, 36) : ''
  if (tenant && !/^[\w.-]+$/.test(tenant) || clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) throw Error('invalid_server')
  const authMethod = type === 'webdav' ? d.authMethod || 'auto' : ''
  if (type === 'webdav' && !WEBDAV_AUTH.includes(authMethod)) throw Error('invalid_server')
  let url = str(d.url, 2048)
  if (!url && type === 's3') url = (S3_PRESETS[preset].url || (r => `https://s3.${r}.amazonaws.com`))(region)
  if (!url && azure && account) url = `https://${account.toLowerCase()}.${type === 'azure' ? 'blob' : 'file'}.core.windows.net`
  let u
  try { u = new URL(url) } catch { throw Error('invalid_server') }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('invalid_server')
  url = u.origin + u.pathname.replace(/\/+$/, '')
  return {
    type, url, host: u.host, port: +u.port || (u.protocol === 'https:' ? 443 : 80),
    ...(type === 's3' ? { region, bucket, preset, virtualHost: !!d.virtualHost, profile } : {}),
    ...(azure ? { bucket, azureAuth, tenant, clientId } : {}),
    ...(type === 'webdav' ? { authMethod, insecureTls: u.protocol === 'https:' && !!d.insecureTls } : {}),
    ...proxy,
  }
}

module.exports = { isShell, storageFields, S3_PRESETS, TYPES }
