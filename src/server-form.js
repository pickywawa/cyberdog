// Connection fields of the server types other than SSH. One definition feeds both the community server form
// and the Premium editor, so every type is available (and looks the same) with or without Premium.
const SERVER_TYPES = [['ssh', 'type.ssh'], ['ftp', 'type.ftp'], ['smb', 'type.smb'], ['s3', 'type.s3'], ['azure', 'type.azure'], ['azurefiles', 'type.azurefiles'], ['webdav', 'type.webdav'], ['dropbox', 'type.dropbox'], ['onedrive', 'type.onedrive'], ['gdrive', 'type.gdrive']]
const PROXIED = ['ftp', 's3', 'azure', 'azurefiles', 'webdav', 'dropbox', 'onedrive', 'gdrive']
const DRIVES = ['dropbox', 'onedrive', 'gdrive']
const serverTypeOptions = () => SERVER_TYPES.map(([value, key]) => [value, t(key)])

// s: server being edited (or the template of a duplicate); keepPass: placeholder of the secret fields.
// name is unique across types; map is the key sent to servers:save (default: name); when: [controlling field, value].
function storageFieldDefs(s, keepPass) {
  const secret = s?.hasPass ? keepPass : ''
  const presets = [['', t('preset.aws')], ['gcs', 'Google Cloud Storage'], ['b2', 'Backblaze B2'], ['wasabi', 'Wasabi'], ['do', 'DigitalOcean Spaces'], ['scaleway', 'Scaleway']]
  const security = [['explicit', t('ftp.explicit')], ['implicit', t('ftp.implicit')], ['none', t('ftp.none')]]
  const azureAuth = [['key', t('azure.auth_key')], ['entra', t('azure.auth_entra')]]
  const authMethods = [['auto', t('webdav.auth_auto')], ['basic', 'Basic'], ['digest', 'Digest'], ['bearer', t('webdav.auth_bearer')]]
  const proxies = [['none', t('proxy.none')], ['http', 'HTTP (CONNECT)'], ['socks5', 'SOCKS5']]
  const viaProxy = ['proxyType', ['http', 'socks5']]
  return [
    { name: 'ftphost', map: 'host', label: t('f.host'), value: s?.host, placeholder: 'ftp.example.com', types: ['ftp'] },
    { name: 'ftpport', map: 'port', label: t('f.port'), value: s?.port ?? '', placeholder: '21', types: ['ftp'] },
    { name: 'ftpsecurity', map: 'security', label: t('f.security'), type: 'select', value: s?.security || 'explicit', options: security, types: ['ftp'] },
    { name: 'ftpinsecure', map: 'insecureTls', label: t('f.tls_insecure'), type: 'checkbox', value: !!s?.insecureTls, types: ['ftp'] },
    { name: 'ftpuser', map: 'user', label: t('f.user'), value: s?.user, placeholder: 'anonymous', types: ['ftp'] },
    { name: 'ftppass', map: 'pass', label: t('f.pass'), type: 'password', placeholder: secret, types: ['ftp'] },
    { name: 'smbhost', map: 'host', label: t('f.host'), value: s?.host, placeholder: 'nas.local', types: ['smb'] },
    { name: 'smbport', map: 'port', label: t('f.port'), value: s?.port ?? '', placeholder: '445', types: ['smb'] },
    { name: 'smbshare', map: 'bucket', label: t('f.share'), value: s?.bucket, placeholder: 'documents', types: ['smb'] },
    { name: 'smbdomain', map: 'domain', label: t('f.domain'), value: s?.domain, placeholder: t('f.optional'), types: ['smb'] },
    { name: 'smbuser', map: 'user', label: t('f.user'), value: s?.user, types: ['smb'] },
    { name: 'smbpass', map: 'pass', label: t('f.pass'), type: 'password', placeholder: secret, types: ['smb'] },
    { name: 'preset', label: t('f.preset'), type: 'select', value: s?.preset || '', options: presets, types: ['s3'] },
    { name: 's3url', map: 'url', label: t('f.url_s3'), value: s?.url, placeholder: 'https://s3.eu-west-1.amazonaws.com', types: ['s3'] },
    { name: 'region', label: t('f.region'), value: s?.region || '', placeholder: 'us-east-1', types: ['s3'] },
    { name: 's3bucket', map: 'bucket', label: t('f.bucket'), value: s?.bucket, types: ['s3'] },
    { name: 'virtualHost', label: t('f.virtual_host'), type: 'checkbox', value: !!s?.virtualHost, types: ['s3'] },
    { name: 's3user', map: 'user', label: t('f.access_key'), value: s?.user, types: ['s3'] },
    { name: 's3pass', map: 'pass', label: t('f.secret_key'), type: 'password', placeholder: secret, types: ['s3'] },
    { name: 'token', label: t('f.session_token'), type: 'password', placeholder: s?.hasToken ? keepPass : t('f.optional'), types: ['s3'] },
    { name: 'profile', label: t('f.aws_profile'), value: s?.profile, placeholder: 'default', types: ['s3'] },
    { name: 'azurl', map: 'url', label: t('f.url_azure'), value: s?.url, placeholder: 'https://account.blob.core.windows.net', types: ['azure', 'azurefiles'] },
    { name: 'azbucket', map: 'bucket', label: t('f.container'), value: s?.bucket, types: ['azure'] },
    { name: 'afbucket', map: 'bucket', label: t('f.share'), value: s?.bucket, types: ['azurefiles'] },
    { name: 'azauth', map: 'azureAuth', label: t('f.azure_auth'), type: 'select', value: s?.azureAuth || 'key', options: azureAuth, types: ['azure', 'azurefiles'] },
    { name: 'azuser', map: 'user', label: t('f.account'), value: s?.user, types: ['azure', 'azurefiles'] },
    { name: 'azpass', map: 'pass', label: t('f.account_key'), type: 'password', placeholder: secret, types: ['azure', 'azurefiles'], when: ['azauth', 'key'] },
    { name: 'tenant', label: t('f.tenant'), value: s?.tenant, placeholder: t('f.tenant_ph'), types: ['azure', 'azurefiles'], when: ['azauth', 'entra'] },
    { name: 'clientId', label: t('f.client_id'), value: s?.clientId, placeholder: t('f.client_id_ph'), types: ['azure', 'azurefiles'], when: ['azauth', 'entra'] },
    { name: 'azsecret', map: 'pass', label: t('f.client_secret'), type: 'password', placeholder: s?.hasPass ? keepPass : t('f.optional'), types: ['azure', 'azurefiles'], when: ['azauth', 'entra'] },
    { name: 'davurl', map: 'url', label: t('f.url_dav'), value: s?.url, placeholder: 'https://cloud.example.com/remote.php/dav/files/me', types: ['webdav'] },
    { name: 'davauth', map: 'authMethod', label: t('f.dav_auth'), type: 'select', value: s?.authMethod || 'auto', options: authMethods, types: ['webdav'] },
    { name: 'davuser', map: 'user', label: t('f.user'), value: s?.user, types: ['webdav'], when: ['davauth', ['auto', 'basic', 'digest']] },
    { name: 'davpass', map: 'pass', label: t('f.pass_or_token'), type: 'password', placeholder: secret, types: ['webdav'] },
    { name: 'davinsecure', map: 'insecureTls', label: t('f.tls_insecure'), type: 'checkbox', value: !!s?.insecureTls, types: ['webdav'] },
    { name: 'drvclient', map: 'clientId', label: t('f.app_id'), value: s?.clientId, placeholder: t('f.app_id_ph'), types: DRIVES },
    { name: 'drvtenant', map: 'tenant', label: t('f.tenant'), value: s?.tenant, placeholder: 'common', types: ['onedrive'] },
    { name: 'gsecret', map: 'token', label: t('f.client_secret'), type: 'password', placeholder: s?.hasToken ? keepPass : t('f.optional'), types: ['gdrive'] },
    { name: 'drvreset', map: 'resetAuth', label: t('f.reset_auth'), type: 'checkbox', value: false, types: DRIVES },
    // network: reached through an HTTP (CONNECT) or SOCKS5 proxy
    { name: 'proxyType', label: t('f.proxy'), type: 'select', value: s?.proxyType || 'none', options: proxies, types: PROXIED, tab: 'options' },
    { name: 'proxyHost', label: t('f.proxy_host'), value: s?.proxyHost, placeholder: 'proxy.example.com', types: PROXIED, when: viaProxy, tab: 'options' },
    { name: 'proxyPort', label: t('f.proxy_port'), value: s?.proxyPort ?? '', placeholder: '8080', types: PROXIED, when: viaProxy, tab: 'options' },
    { name: 'proxyUser', label: t('f.proxy_user'), value: s?.proxyUser, placeholder: t('f.optional'), types: PROXIED, when: viaProxy, tab: 'options' },
    { name: 'proxyPass', label: t('f.proxy_pass'), type: 'password', placeholder: s?.hasProxyPass ? keepPass : t('f.optional'), types: PROXIED, when: viaProxy, tab: 'options' },
  ]
}
// Is this field shown given the raw form values (type and controlling field)?
const whenMatches = (when, value) => Array.isArray(when[1]) ? when[1].includes(value) : value === when[1]
const storageFieldShown = (d, raw) => d.types.includes(raw.type) && (!d.when || whenMatches(d.when, raw[d.when[0]]))

// raw: values by field name (including the SSH ones) -> payload for servers:save
function storagePayload(raw, defs) {
  const out = { ...raw }
  for (const d of defs) delete out[d.name]
  if (raw.type !== 'ssh') for (const k of ['host', 'port', 'user', 'pass']) delete out[k]
  for (const d of defs) if (storageFieldShown(d, raw)) out[d.map || d.name] = raw[d.name]
  return out
}
