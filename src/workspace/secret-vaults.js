const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const enterprise=require('./enterprise-vaults')
const PROVIDERS = ['onepassword', 'bitwarden', 'hashicorp','aws','azure',...enterprise.PROVIDERS]
const fail = code => { throw Error('vault.' + code) }
const text = (v, max = 4096) => typeof v === 'string' ? v.slice(0, max) : ''
const ref = value => { if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f]/.test(value) || value.startsWith('-')) fail('invalid'); return value }
function segments(value, allowEmpty = false) {
  if (value === '' && allowEmpty) return ''
  ref(value)
  if (value.split('/').some(s => !s || s === '.' || s === '..')) fail('invalid')
  return value.split('/').map(encodeURIComponent).join('/')
}
function endpoint(value) {
  let u; try { u = new URL(value) } catch { fail('url_error') }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) fail('url_error')
  return u.origin
}
function fieldsOf(item, provider) {
  if (provider === 'hashicorp') return item
  const values = Object.create(null)
  for (const f of item.fields || []) for (const key of [f.id, f.label, f.name]) if (key) values[key] = f.value
  if (provider === 'bitwarden') {
    if (item.login?.username !== undefined) values.username = item.login.username
    if (item.login?.password !== undefined) values.password = item.login.password
    if (item.sshKey?.privateKey) values.private_key = item.sshKey.privateKey
  }
  const uri = item.login?.uris?.find(u => /^s(?:sh|ftp):\/\//i.test(u.uri || ''))?.uri || item.urls?.find(u => /^s(?:sh|ftp):\/\//i.test(u.href || ''))?.href
  if (uri) try { const u = new URL(uri); values.host ||= u.hostname.replace(/^\[|\]$/g,''); values.port ||= u.port || '22'; values.username ||= decodeURIComponent(u.username) } catch {}
  return values
}
function normalize(values, mapping = {}) {
  const pick = (key, names) => {
    if (mapping[key]) return text(values[mapping[key]], 262144)
    for (const name of names) if (typeof values[name] === 'string' || typeof values[name] === 'number') return String(values[name])
    return ''
  }
  return {
    host: pick('host', ['host', 'hostname', 'server', 'address']),
    user: pick('user', ['username', 'user', 'login']),
    port: pick('port', ['port']) || '22',
    password: pick('password', ['password', 'pass']),
    privateKey: pick('privateKey', ['private_key', 'privateKey']),
    passphrase: pick('passphrase', ['passphrase']),
  }
}
function cliExecutable(provider, configured) {
  const name = provider === 'onepassword' ? 'op' : provider==='aws'?'aws':provider==='keeper'?'ksm':provider==='rdm'?'pwsh':'bw'
  if (configured) {
    if (!path.isAbsolute(configured) || ![name, name + '.exe', name + '.cmd'].includes(path.basename(configured).toLowerCase())) fail('cli')
    // .cmd would require a command shell; use a native executable instead.
    if (configured.toLowerCase().endsWith('.cmd')) fail('cli')
    return configured
  }
  const dirs = process.platform === 'win32' ? (process.env.PATH || '').split(path.delimiter) : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...((process.env.PATH || '').split(path.delimiter))]
  const file = dirs.filter(Boolean).map(dir => path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''))).find(file => { try { return fs.statSync(file).isFile() } catch { return false } })
  if (!file) fail('cli')
  return file
}
function runCLI(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: 90000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
      // stderr and command errors may contain secrets. Never propagate them.
      if (error) return reject(Error('vault.cli_failed'))
      resolve(stdout)
    })
    child.stdin?.end()
  })
}
function createVaults({ directory, safeStorage, fetch, authorize, run = runCLI, platform = process.platform }) {
  const file = path.join(directory, 'secret-vaults.bin')
  let state, credentials = new Map(), locked = new Set(), generations = new Map()
  const invalidate = id => generations.set(id,(generations.get(id)||0)+1)
  const secure = () => { if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') fail('storage') }
  const load = () => {
    if (state) return state
    if (!fs.existsSync(file)) return state = { connectors: [], pins: [] }
    secure()
    try { const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); if (!Array.isArray(data.connectors) || !Array.isArray(data.pins)) fail('storage'); return state = data } catch { fail('storage') }
  }
  const save = () => {
    secure(); fs.mkdirSync(directory, { recursive: true }); const temp = file + '.tmp'
    try { fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 }); fs.renameSync(temp, file) } finally { fs.rmSync(temp, { force: true }) }
  }
  const commit = next => {const previous=state;state=next;try{save()}catch(e){state=previous;throw e}}
  const connector = id => load().connectors.find(c => c.id === id) || fail('missing')
  const credential = c => { if (locked.has(c.id)) fail('locked'); return credentials.get(c.id) || c.savedToken || '' }
  const safeConnector = c => ({ id: c.id, name: c.name, provider: c.provider, url: c.url, mount: c.mount, prefix: c.prefix, namespace: c.namespace, vault: c.vault, account: c.account, search: c.search, cliPath: c.cliPath, mapping: c.mapping, awsProfile:c.awsProfile,region:c.region,azureVault:c.azureVault, folderIds:c.folderIds,orgName:c.orgName,applicationKey:c.applicationKey,remoteVaultId:c.remoteVaultId,cliProfile:c.cliProfile,dataSourceId:c.dataSourceId, hasSavedToken: !!c.savedToken, locked: locked.has(c.id) || (!['onepassword','aws','keeper','rdm'].includes(c.provider) && !credential(c)) })
  const pins = () => load().pins.map(p => ({ ...p, vaultName: connector(p.vaultId).name,vaultProvider:connector(p.vaultId).provider, canEditServers: false }))
  async function command(c, args) {
    const env = { ...process.env }
    delete env.OP_SERVICE_ACCOUNT_TOKEN; delete env.OP_CONNECT_TOKEN; delete env.OP_CONNECT_HOST; delete env.BW_SESSION; delete env.BW_PASSWORD; delete env.BW_CLIENTSECRET; delete env.BW_CLIENTID
    for (const k of Object.keys(env)) if (/^OP_SESSION/.test(k)) delete env[k]
    if(c.provider==='keeper'){credential(c);delete env.KSM_TOKEN;delete env.KSM_CONFIG;args=['--no-cache','--no-color',...(c.cliProfile?['--profile-name',c.cliProfile]:[]),...args]}
    else if(c.provider==='rdm'){credential(c);if(platform!=='win32')fail('windows_only');env.CYBERDOG_RDM_REQUEST=JSON.stringify({operation:args[0],itemId:args[1],dataSourceId:c.dataSourceId,vaultId:c.remoteVaultId});let script=path.join(__dirname,'rdm-reader.ps1').replace(/app\.asar([\\/])/,'app.asar.unpacked$1');args=['-NoLogo','-NoProfile','-NonInteractive','-File',script]}
    else if (c.provider === 'bitwarden') { env.BW_SESSION = credential(c); if (!env.BW_SESSION) fail('locked'); args.push('--nointeraction') }
    else if(c.provider==='aws'){credential(c);env.AWS_PAGER='';env.AWS_CLI_AUTO_PROMPT='off';delete env.AWS_ENDPOINT_URL;delete env.AWS_ENDPOINT_URL_SECRETS_MANAGER;args.push('--output','json','--no-cli-pager','--region',c.region);if(c.awsProfile)args.push('--profile',c.awsProfile)}
    else { credential(c); env.OP_BIOMETRIC_UNLOCK_ENABLED = 'true'; env.OP_CACHE = 'false'; if (c.account) args.push('--account', c.account) }
    return run(cliExecutable(c.provider, c.cliPath), args, env)
  }
  async function jsonCLI(c, args) { try { return JSON.parse(await command(c, args)) } catch (e) { if (e.message.startsWith('vault.')) throw e; fail('response') } }
  async function vaultRequest(c, route) {
    const token = credential(c); if (!token) fail('locked')
    if (/[\r\n]/.test(token + (c.namespace || ''))) fail('invalid')
    let r
    try { r = await fetch(endpoint(c.url) + '/v1/' + route, { headers: { 'X-Vault-Token': token, ...(c.namespace ? { 'X-Vault-Namespace': c.namespace } : {}) }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) }) } catch { fail('network') }
    if (r.status === 404 && route.includes('/metadata/')) return {data:{keys:[]}}
    if (!r.ok) fail([401,403].includes(r.status) ? 'denied' : 'network')
    if (Number(r.headers?.get('content-length')) > 2 * 1024 * 1024) fail('limit')
    try {
      let raw = ''
      if (r.body?.getReader) {
        const reader = r.body.getReader(), decoder = new TextDecoder(); let count = 0
        try { for (;;) { const {done,value} = await reader.read(); if (done) break; count += value.byteLength; if (count > 2 * 1024 * 1024) { await reader.cancel(); fail('limit') } raw += decoder.decode(value, { stream: true }) } raw += decoder.decode() } finally { reader.releaseLock() }
      } else { raw = await r.text(); if (Buffer.byteLength(raw) > 2 * 1024 * 1024) fail('limit') }
      return JSON.parse(raw)
    } catch (e) { if (e.message.startsWith('vault.')) throw e; fail('response') }
  }
  function secretObject(value){
    if(typeof value!=='string')fail('response')
    try{const data=JSON.parse(value);if(data&&typeof data==='object'&&!Array.isArray(data))return data}catch{}
    return {password:value}
  }
  async function azureRequest(c,url){
    const origin='https://'+c.azureVault+'.vault.azure.net';let parsed;try{parsed=new URL(url)}catch{fail('response')}
    if(parsed.origin!==origin||!/^\/secrets(?:\/|$)/.test(parsed.pathname)||parsed.username||parsed.password)fail('invalid')
    const token=credential(c);if(!token)fail('locked')
    let response;try{response=await fetch(url,{headers:{Authorization:'Bearer '+token},redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)})}catch{fail('network')}
    if(!response.ok)fail([401,403].includes(response.status)?'denied':'network')
    try{if(Number(response.headers?.get('content-length'))>2*1024*1024)fail('limit');let raw='';if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();fail('limit')}raw+=decoder.decode(value,{stream:true})}raw+=decoder.decode()}finally{reader.releaseLock()}}else{raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)fail('limit')}return JSON.parse(raw)}catch(e){if(e.message.startsWith('vault.'))throw e;fail('response')}
  }
  async function httpJSON(url,options={}){
    let parsed;try{parsed=new URL(url)}catch{fail('invalid')}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password)fail('url_error')
    let response;try{response=await fetch(url,{...options,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)})}catch{fail('network')}
    if(!response.ok)fail([401,403].includes(response.status)?'denied':response.status===429?'rate_limited':'network')
    if(Number(response.headers?.get('content-length'))>2*1024*1024)fail('limit')
    try{let raw='';if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();fail('limit')}raw+=decoder.decode(value,{stream:true})}raw+=decoder.decode()}finally{reader.releaseLock()}}else{raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)fail('limit')}return JSON.parse(raw)}catch(e){if(e.message.startsWith('vault.'))throw e;fail('response')}
  }
  const adapters=enterprise.createEnterpriseAdapters({httpJSON,command:jsonCLI,normalize,credential,platform})
  const itemReference=(c,value)=>c.provider==='keeper'&&/^[A-Za-z0-9_-]{20,80}$/.test(value)?value:ref(value)
  async function readUnchecked(c, itemId) {
    itemReference(c,itemId)
    if(adapters.has(c.provider))return adapters.read(c,itemId)
    if(c.provider==='aws'){if(c.prefix&&!itemId.startsWith(c.prefix))fail('invalid');const item=await jsonCLI(c,['secretsmanager','get-secret-value','--secret-id',itemId,'--version-stage','AWSCURRENT']);return normalize(secretObject(item.SecretString),c.mapping)}
    if(c.provider==='azure'){if(!/^[a-zA-Z0-9-]{1,127}$/.test(itemId))fail('invalid');const item=await azureRequest(c,'https://'+c.azureVault+'.vault.azure.net/secrets/'+encodeURIComponent(itemId)+'?api-version=7.4');return normalize(secretObject(item.value),c.mapping)}
    if (c.provider === 'hashicorp') {
      if (c.prefix && !itemId.startsWith(c.prefix + '/')) fail('invalid')
      const value = await vaultRequest(c, segments(c.mount) + '/data/' + segments(itemId))
      if (!value.data?.data || typeof value.data.data !== 'object') fail('response')
      return normalize(value.data.data, c.mapping)
    }
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(itemId)) fail('invalid')
    const args = c.provider === 'onepassword' ? ['item', 'get', itemId, '--format=json', '--reveal', ...(c.vault ? ['--vault', c.vault] : [])] : ['get', 'item', itemId]
    if (c.provider === 'bitwarden') await command(c,['sync'])
    const item = await jsonCLI(c, args)
    if (item.id !== itemId || item.deletedDate) fail('missing')
    const values = fieldsOf(item, c.provider)
    const normalized = normalize(values, c.mapping)
    if (c.provider === 'onepassword' && normalized.privateKey && (item.category === 'SSH_KEY' || (item.fields || []).some(f=>f.type === 'SSHKEY'))) {
      const key = (item.fields || []).find(f => f.id === (c.mapping?.privateKey || 'private_key') || f.label === c.mapping?.privateKey)
      const vaultId = item.vault?.id
      if (!key?.id || !/^[a-zA-Z0-9_]{1,80}$/.test(key.id) || !/^[a-zA-Z0-9]{8,80}$/.test(vaultId || '')) fail('response')
      normalized.privateKey = await command(c, ['read', `op://${vaultId}/${itemId}/${key.id}?ssh-format=openssh`])
    }
    return normalized
  }
  async function read(c,itemId){
    const generation=generations.get(c.id)||0
    const result=await readUnchecked(c,itemId)
    if((generations.get(c.id)||0)!==generation)fail('locked')
    credential(c)
    return result
  }
  return {
    pins,
    list: () => load().connectors.map(safeConnector),
    async saveConnector(input) {
      await authorize(); load()
      if (!PROVIDERS.includes(input.provider)) fail('invalid')
      const old = input.id ? connector(input.id) : null
      if (old && old.provider !== input.provider) fail('invalid')
      const c = { id: old?.id || crypto.randomUUID(), provider: input.provider, name: text(input.name,120).trim() }
      if (!c.name || state.connectors.length >= 30 && !old) fail('invalid')
      for (const key of ['namespace','vault','account','search','cliPath','awsProfile','region','azureVault','folderIds','orgName','applicationKey','remoteVaultId','cliProfile','dataSourceId']) if (input[key]) c[key] = ref(text(input[key]))
      c.mapping = {}
      for (const key of ['host','user','port','password','privateKey','passphrase']) if (input.mapping?.[key]) c.mapping[key] = ref(text(input.mapping[key],120))
      if(adapters.has(c.provider)){enterprise.validate(input,c,platform);if(['keeper','rdm'].includes(c.provider))cliExecutable(c.provider,c.cliPath)}
      else if (c.provider === 'hashicorp') { c.url = endpoint(input.url); c.mount = input.mount || 'secret'; c.prefix = text(input.prefix).replace(/^\/+|\/+$/g,''); segments(c.mount); segments(c.prefix,true) }
      else if(c.provider==='azure'){c.azureVault=c.azureVault?.toLowerCase();if(!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(c.azureVault||''))fail('invalid')}
      else{if(c.provider==='aws'){if(!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(c.region||''))fail('invalid');c.prefix=text(input.prefix,256)}cliExecutable(c.provider,c.cliPath)}
      const scope=value=>JSON.stringify(['provider','url','namespace','applicationKey','orgName','azureVault','account','awsProfile','cliProfile','dataSourceId'].map(key=>value?.[key]||''))
      const sameCredentialScope=!!old&&scope(old)===scope(c)
      const token = text(input.token,16384).trim()
      if (['hashicorp','manageengine','devolutions'].includes(c.provider) && input.rememberToken) c.savedToken = token || (sameCredentialScope?old?.savedToken:undefined)
      const next = old ? state.connectors.map(x => x.id === c.id ? c : x) : [...state.connectors,c]
      const previous = state.connectors; state.connectors = next
      try { save() } catch (e) { state.connectors = previous; throw e }
      invalidate(c.id)
      if(!sameCredentialScope)credentials.delete(c.id)
      if (token) { credentials.set(c.id,token); locked.delete(c.id) }
      return safeConnector(c)
    },
    async unlock(id, token) { await authorize(); const c = connector(id); invalidate(id); if (token) credentials.set(id,ref(text(token,16384).trim())); locked.delete(id); return safeConnector(c) },
    lock(id) { connector(id); invalidate(id); credentials.delete(id); locked.add(id) },
    lockAll() { credentials.clear(); for (const c of load().connectors) { invalidate(c.id); locked.add(c.id) } },
    async remove(id) { await authorize(); connector(id); commit({...state,connectors:state.connectors.filter(c=>c.id!==id),pins:state.pins.filter(p=>p.vaultId!==id)});invalidate(id);credentials.delete(id);locked.delete(id) },
    async browse(id) {
      await authorize(); const c = connector(id)
      if(adapters.has(c.provider))return adapters.browse(c)
      if(c.provider==='aws'){
        const result=[];let next,steps=0
        do{if(++steps>100)fail('limit');const page=await jsonCLI(c,['secretsmanager','list-secrets','--no-paginate','--max-results','100',...(next?['--next-token',ref(next)]:[]),...(c.prefix?['--filters',JSON.stringify([{Key:'name',Values:[c.prefix]}])]:[])]);if(!Array.isArray(page.SecretList))fail('response');for(const item of page.SecretList)if(typeof item.Name==='string'&&(!c.prefix||item.Name.startsWith(c.prefix)))result.push({id:item.Name,name:item.Name});if(result.length>1000)fail('limit');next=page.NextToken}while(next)
        return result
      }
      if(c.provider==='azure'){
        const result=[];let next='https://'+c.azureVault+'.vault.azure.net/secrets?api-version=7.4&maxresults=25',steps=0
        do{if(++steps>100)fail('limit');const page=await azureRequest(c,next);if(!Array.isArray(page.value))fail('response');for(const item of page.value){let id;try{id=new URL(item.id)}catch{fail('response')}if(id.origin!=='https://'+c.azureVault+'.vault.azure.net')fail('response');const name=id.pathname.split('/')[2];if(!/^[a-zA-Z0-9-]{1,127}$/.test(name||''))fail('response');if(item.attributes?.enabled!==false)result.push({id:name,name})}if(result.length>1000)fail('limit');next=page.nextLink}while(next)
        return result
      }
      if (c.provider === 'hashicorp') {
        const result = [], queue = [c.prefix || '']; let count = 0
        while (queue.length) {
          if (++count > 100 || result.length > 1000) fail('limit')
          const prefix = queue.shift(), data = await vaultRequest(c, segments(c.mount) + '/metadata/' + segments(prefix,true) + '?list=true')
          if (!Array.isArray(data.data?.keys)) fail('response')
          for (const key of data.data.keys) {
            if (typeof key !== 'string' || key.includes('/') && !key.endsWith('/') || key.slice(0,-1).includes('/')) fail('response')
            const folder = key.endsWith('/'), itemId = (prefix ? prefix + '/' : '') + (folder ? key.slice(0,-1) : key)
            segments(itemId)
            if (folder) queue.push(itemId); else result.push({ id:itemId,name:itemId })
          }
          if (queue.length + result.length > 1000) fail('limit')
        }
        return result
      }
      const args = c.provider === 'onepassword' ? ['item','list','--format=json',...(c.vault?['--vault',c.vault]:[])] : ['list','items',...(c.search?['--search',c.search]:[])]
      if (c.provider === 'bitwarden') await command(c,['sync'])
      const items = await jsonCLI(c,args)
      if (!Array.isArray(items) || items.length > 10000) fail('limit')
      return items.filter(item=>!item.deletedDate && /^[a-zA-Z0-9-]{8,80}$/.test(item.id||'')).map(item=>({id:item.id,name:text(item.title||item.name,200)}))
    },
    async preview(id,itemId) { await authorize(); const value = await read(connector(id),itemId); return { host:value.host,user:value.user,port:value.port,hasPassword:!!value.password,hasPrivateKey:!!value.privateKey } },
    async pin(input) {
      await authorize(); const c = connector(input.vaultId); itemReference(c,input.itemId)
      // Validate existence/access, but only persist metadata and a stable secret reference.
      await read(c,input.itemId)
      const host=text(input.host,255).trim(),user=text(input.user,128).trim(),port=Number(input.port||22),name=text(input.name,120).trim()
      if (!name || !host || /[\s\x00-\x1f]/.test(host) || !user || /[\x00-\x1f]/.test(user) || !Number.isInteger(port) || port<1 || port>65535) fail('invalid')
      const existing=input.id?state.pins.find(p=>p.id===input.id&&p.vaultId===c.id):state.pins.find(p=>p.vaultId===c.id&&p.itemId===input.itemId)
      if (input.id&&!existing) fail('missing')
      const p={id:existing?.id||'vault-'+crypto.randomUUID(),vaultId:c.id,itemId:input.itemId,name,host,user,port}
      if (existing?.host===host&&existing.port===port&&existing.user===user&&existing.itemId===input.itemId) p.fp=existing.fp
      invalidate(c.id)
      commit({...state,pins:existing?state.pins.map(x=>x.id===existing.id?p:x):[...state.pins,p]});return p.id
    },
    unpin(id) { load(); const pin=state.pins.find(p=>p.id===id);if(pin)invalidate(pin.vaultId);commit({...state,pins:state.pins.filter(p=>p.id!==id)}) },
    fingerprint(id,fp) { const p=load().pins.find(p=>p.id===id); if(!p)fail('missing');commit({...state,pins:state.pins.map(p=>p.id===id?{...p,fp}:p)}) },
    async resolve(id) {
      await authorize(); const p=load().pins.find(p=>p.id===id); if(!p)fail('missing')
      const value=await read(connector(p.vaultId),p.itemId)
      if (!value.password && !value.privateKey) fail('no_secret')
      return {...p,vaultPassword:value.password,vaultPrivateKey:value.privateKey,vaultPassphrase:value.passphrase}
    },
  }
}
module.exports={createVaults,normalize,fieldsOf,endpoint,segments,cliExecutable}
