const {app,safeStorage,net}=require('electron')
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
function createExtension(ctx){
 require('./i18n').apply(require('../i18n').D)
 const {accountIPC,send,conns,pendingVaultClients,list,t,saveGroups,persistActions,writePaths,allGroups,allActions,allPaths}=ctx
// Team permissions are enforced server-side from the verified Supabase session.
const serverAuth=require('./server-auth').createServerAuth({storage:safeStorage,readPrivateKey:file=>ctx.readPrivateKey(file),keyPassphrase:id=>ctx.keyPassphrase?.(id)})
const cloudConfig = fs.existsSync(path.join(__dirname,'config.json')) ? require('./config.json') : {}
let cloudServers = []
let sharedAssets = []
const sharedGroupPreferences=new Map()
const cloud = require('./cloud-account').createCloudAccount({config:cloudConfig,fetch:(...args)=>net.fetch(...args),safeStorage,directory:app.getPath('userData'),onChange:state=>{
  const previous = cloudServers
  sharedAssets=state.assets||[]
  cloudServers = state.servers.map(s=>({...s,teamRole:state.teams.find(t=>t.id===s.teamId)?.role}))
  for (const [id,c] of conns) if(c.server?.teamId && !cloudServers.some(s=>s.id===c.server.id&&s.host===c.server.host&&s.port===c.server.port&&s.user===c.server.user)) c.client.end()
  send('teams:changed',state)
  send('servers:changed',list())
  send('shared:changed',{groups:allGroups(),actions:allActions(),paths:allPaths()})
}})
accountIPC('account:sign-in',value=>cloud.signIn(value))
accountIPC('account:sign-up',value=>cloud.signUp(value))
accountIPC('account:verify-code',value=>cloud.verifyCode(value))
accountIPC('account:resend-code',()=>cloud.resendCode())
accountIPC('account:cancel-pending',()=>cloud.cancelPending())
accountIPC('account:sign-out',()=>cloud.signOut())
accountIPC('account:delete',()=>cloud.deleteAccount())
accountIPC('teams:status',()=>cloud.init())
accountIPC('teams:refresh',()=>cloud.refresh())
accountIPC('teams:action',(action,payload)=>cloud.action(action,payload))
// Vault credentials never enter cloud payloads or the ordinary server store.
const vaults=require('./secret-vaults').createVaults({directory:app.getPath('userData'),safeStorage,fetch:(...args)=>net.fetch(...args),authorize:async()=>{}})
const vaultPins=()=>{try{return vaults.pins()}catch{return[]}}
const vaultChanged=()=>{send('servers:changed',list());send('vaults:changed')}
const closeVaultConnections=id=>{if(typeof routes!=='undefined'){if(id)routes.closeDependency(null,id);else routes.closeAll()}for(const c of [...conns.values(),...pendingVaultClients])if(c.server?.vaultId&&(!id||c.server.vaultId===id))c.client.end()}
accountIPC('vaults:list',()=>vaults.list())
accountIPC('vaults:save',async value=>{const result=await vaults.saveConnector(value);closeVaultConnections(result.id);vaultChanged();return result})
accountIPC('vaults:browse',id=>vaults.browse(id))
accountIPC('vaults:preview',(id,itemId)=>vaults.preview(id,itemId))
accountIPC('vaults:pin',async value=>{const id=await vaults.pin(value);routes.closeDependency(id);for(const c of conns.values())if(c.server?.id===id)c.client.end();vaultChanged();return list()})
accountIPC('vaults:unpin',id=>{beforeDeleteServer(id);vaults.unpin(id);for(const c of conns.values())if(c.server?.id===id)c.client.end();vaultChanged();return list()})
accountIPC('vaults:remove',async id=>{for(const pin of vaultPins().filter(s=>s.vaultId===id))beforeDeleteServer(pin.id);await vaults.remove(id);closeVaultConnections(id);vaultChanged()})
accountIPC('vaults:unlock',async (id,token)=>{const result=await vaults.unlock(id,token);vaultChanged();return result})
accountIPC('vaults:lock',id=>{vaults.lock(id);closeVaultConnections(id);vaultChanged()})

// SSH routes own their sockets, trust decisions and authorization leases.
const routeTools=require('./bastions/route')
const DRAFT=Symbol('route-draft')
const authorizeRoutes=async()=>{}
const resolveRoute=async target=>{
 if(target.teamId&&!target[DRAFT])return cloud.getRoute(target.id)
 const source=target[DRAFT]?target:ctx.servers.find(s=>s.id===target.id)
 if(!source)throw Error('bastion.missing')
 if(source.teamId){const fresh=await cloud.getRouteForDraft(source);return fresh}
 const all=[...ctx.servers,...vaultPins()];const b=routeTools.validate(source,all)
 if(!b)throw Error('bastion.missing');return{target:source,bastion:b}
}
const routes=routeTools.createRoutes({Client:ctx.ssh?.Client,utils:ctx.ssh?.utils,authorize:authorizeRoutes,resolve:resolveRoute,credentials:async s=>{const auth=await ctx.credentials(s);if(s.testPassword)auth.password=s.testPassword;return auth},send,storage:safeStorage,directory:app.getPath('userData')})
async function validateServer(d){
 const existing=ctx.servers.find(s=>s.id===(d.id||d.copyFrom))
 const networkAccess=routeTools.access(d.networkAccess===undefined?existing?.networkAccess:d.networkAccess)
 const candidate={...existing,...d,id:d.id,port:d.port==null||d.port===''?22:+d.port,networkAccess}
 if(networkAccess.mode==='bastion'){await authorizeRoutes();routeTools.validate(candidate,[...ctx.servers,...cloudServers,...vaultPins()])}
 if(d.id&&ctx.servers.some(s=>s.id!==d.id&&routeTools.access(s.networkAccess).bastionId===d.id)&&networkAccess.mode!=='direct')throw Error('bastion.chain')
 return networkAccess
}
function beforeDeleteServer(id){if(ctx.servers.some(s=>routeTools.access(s.networkAccess).bastionId===id))throw Error('bastion.in_use');routes.closeDependency(id)}
app.on?.('before-quit',()=>routes.closeAll())
accountIPC('bastions:forget-trust',async(id,confirmation)=>{const target=ctx.servers.find(s=>s.id===id)||cloudServers.find(s=>s.id===id);if(!target)throw Error('access_denied');await routes.forgetTrust(target,confirmation)})
accountIPC('bastions:respond',(id,value)=>routes.respond(id,value))
accountIPC('bastions:cancel-server',serverId=>routes.cancelPending(serverId))
accountIPC('bastions:cancel',id=>routes.cancel(id))
accountIPC('bastions:test',async(d,attemptId)=>{
 const existing=d.id&&(ctx.servers.find(s=>s.id===d.id)||cloudServers.find(s=>s.id===d.id))
 const same=existing&&['host','port','user'].every(k=>String(existing[k])===String(d[k]))
 if(d.key)ctx.readPrivateKey(d.key)
 const draft={...(same?existing:{}),authMode:d.authMode,key:d.key,id:d.id||crypto.randomUUID(),name:String(d.name||d.host||'').slice(0,120),host:d.host,port:+d.port,user:d.user,teamId:d.teamId||undefined,networkAccess:routeTools.access(d.networkAccess),testPassword:typeof d.pass==='string'?d.pass:undefined,[DRAFT]:true}
 return routes.open(draft,{test:true,attemptId})
})

// Recheck open shared connections; a revoked membership cannot keep using this app's session indefinitely.
let checkingSharedConnections=false
setInterval(async()=>{
  if(checkingSharedConnections)return
  checkingSharedConnections=true
  try{for(const c of conns.values())if(c.server?.teamId){try{await cloud.getServer(c.server.id)}catch{c.client.end()}}}
  finally{checkingSharedConnections=false}
},60000).unref()


const sharedOf=kind=>sharedAssets.filter(a=>a.kind===kind)



function removeLocalAsset(kind,id){
 if(kind==='groups'){if(ctx.servers.some(s=>s.group===id))throw new Error('group_in_use');ctx.groups=ctx.groups.filter(g=>g.id!==id);saveGroups()}
 if(kind==='actions'){ctx.actions=ctx.actions.filter(a=>a.id!==id);persistActions()}
 if(kind==='paths'){ctx.savedPaths=ctx.savedPaths.filter(a=>a.id!==id);writePaths()}
}
async function routeCloudAsset(kind,d){
 const existing=sharedAssets.find(a=>a.id===d.id&&a.kind===kind)
 const destination=d.teamId===undefined?existing?.teamId:d.teamId
 if(destination){
  if(kind==='groups'&&!existing&&d.id&&ctx.servers.some(s=>s.group===d.id))throw new Error('group_in_use')
  const result=await cloud.saveAsset({kind,teamId:destination,id:existing?.id,name:String(d.name||d.path||'').trim().slice(0,120),...(kind==='actions'?{script:d.script}:{}),...(kind==='paths'?{path:d.path,serverId:d.serverId||null}:{})})
  if(!existing&&d.id)removeLocalAsset(kind,d.id)
  return true
 }
 if(existing){
  if(kind==='groups'&&cloudServers.some(s=>s.group===existing.id))throw new Error('group_in_use')
  d._cloudSource=existing;d.id=undefined
 }
 return false
}
async function finishAssetMove(d){if(d._cloudSource){try{await cloud.action('asset_delete',{id:d._cloudSource.id,teamId:d._cloudSource.teamId})}catch{throw new Error(t('space.local_copy_kept'))}}}
async function deleteCloudAsset(kind,id){const asset=sharedAssets.find(a=>a.kind===kind&&a.id===id);if(!asset)return false;await cloud.action('asset_delete',{id,teamId:asset.teamId});return true}


 async function saveServer(d){
  if(vaultPins().some(s=>s.id===d.id||s.id===d.copyFrom))throw Error('vault.managed')
  const existing=cloudServers.find(s=>s.id===d.id),localSource=ctx.servers.find(s=>s.id===(d.id||d.copyFrom)),remoteSource=existing||cloudServers.find(s=>s.id===d.copyFrom)
  const source=remoteSource?await cloud.getServer(remoteSource.id):localSource||{}
  const sameEndpoint=!source.id||['host','port','user'].every(k=>String(source[k])===String(d[k]))
  const options=ctx.serverOptions(d,source),auth=serverAuth.prepare(d,sameEndpoint?source:{authMode:source.authMode})
  const networkAccess=routeTools.access(d.networkAccess===undefined?source.networkAccess:d.networkAccess)
  const base={...options,authMode:auth.mode,networkAccess,name:d.name?.trim()||d.host?.trim(),host:d.host?.trim(),port:+d.port||22,user:d.user?.trim(),group:d.group||null}
  if(!d.teamId&&(existing||remoteSource)){
   if(networkAccess.mode!=='direct')throw Error('bastion.scope')
   const local={...base,...auth.local,id:crypto.randomUUID(),group:ctx.groups.some(g=>g.id===d.group)?d.group:undefined}
   ctx.servers=[...ctx.servers,local];ctx.persist()
   if(existing){try{await cloud.action('server_delete',{id:existing.id,teamId:existing.teamId})}catch{send('servers:changed',list());throw Error(t('space.local_copy_kept'))}}
   return list()
  }
  const teamId=d.teamId||existing?.teamId
  if(!existing&&d.id&&ctx.servers.some(s=>routeTools.access(s.networkAccess).bastionId===d.id))throw Error('bastion.in_use')
  if(networkAccess.mode==='bastion')routeTools.endpoint({...base,port:+d.port})
  const sync=(d.syncCredentials===undefined?!!existing?.hasSyncedCredential:d.syncCredentials===true)&&!!auth.credential
  const data={...base,teamId,id:existing?.id,syncCredentials:sync,...(sync&&auth.credential?{credentials:auth.credential}:{})}
  const metadataChanged=!existing||teamId!==existing.teamId||Object.keys(base).some(k=>JSON.stringify(base[k]||null)!==JSON.stringify(existing[k]||null))
  // Preserve a local encrypted copy before removing a synchronized credential.
  if(!sync&&existing)cloud.saveCredentials({...source,...base,id:existing.id,teamId},auth.local)
  let target=existing
  if(metadataChanged||sync||existing?.hasSyncedCredential){const result=await cloud.saveServer(data);target=cloudServers.find(s=>s.id===(existing?.id||result.serverId))}
  if(!target)throw Error('server_not_found')
  if(sync||!existing)cloud.saveCredentials(target,sync?{authMode:null,pass:null,key:null,keyData:null}:auth.local)
  if(!existing&&d.id){ctx.servers=ctx.servers.filter(s=>s.id!==d.id);ctx.persist()}
  return list()
 }
 return {
  ...require('./bastions/config').createConfigHooks(()=>ctx.servers,()=>vaultPins()),
  validateServer,beforeDeleteServer,beginConnection:routes.begin,endConnection:routes.finish,openConnection:(s,options)=>routes.open(s,options),
  available:true,init:()=>cloud.init(),refresh:()=>cloud.state().signedIn?cloud.refresh():Promise.resolve(),
  servers:()=>[...cloudServers.map(s=>({...s,...cloud.localAuth?.(s),hasPass:s.authMode!=='key'&&(s.hasSyncedCredential||cloud.hasPassword?.(s)||false),key:s.hasSyncedCredential?undefined:cloud.localKey?.(s)})),...(cloud.previews?.()||[]).map(s=>({...s,loading:true})),...vaultPins()],owns:id=>[...cloudServers,...vaultPins()].some(s=>s.id===id),
  handlesServerData:d=>!!d.teamId||[d.id,d.copyFrom].some(id=>id&&[...cloudServers,...vaultPins()].some(s=>s.id===id)),saveServer,
  async removeServer(id){beforeDeleteServer(id);const p=vaultPins().find(s=>s.id===id);if(p){vaults.unpin(id);for(const c of conns.values())if(c.server?.id===id)c.client.end();vaultChanged()}else{const remote=cloudServers.find(s=>s.id===id);if(!remote)throw Error('access_denied');await cloud.action('server_delete',{id,teamId:remote.teamId})}return list()},
  async updateServer(s,patch){if(s.vaultId)throw Error('vault.managed');if(!('group' in patch))throw Error('team_metadata_managed_remotely');await cloud.saveServer({id:s.id,teamId:s.teamId,name:s.name,host:s.host,port:s.port,user:s.user,networkAccess:s.networkAccess,...ctx.serverOptions(s),group:patch.group||null});return list()},
  resolveServer:id=>cloudServers.some(s=>s.id===id)?cloud.getServer(id):Promise.resolve(vaultPins().find(s=>s.id===id)),
  async connectionAuth(s){if(!s.vaultId)return serverAuth.connection(s);const resolved=await vaults.resolve(s.id);return{password:resolved.vaultPassword,privateKey:resolved.vaultPrivateKey,passphrase:resolved.vaultPassphrase,error:'vault.ssh_failed',keyError:'vault.key_invalid'}},
  saveCredentials(s,patch){if(s.vaultId){if(Object.keys(patch).some(k=>k!=='fp'))throw Error('vault.managed');if(patch.fp)vaults.fingerprint(s.id,patch.fp)}else cloud.saveCredentials(s,patch)},
  groups:()=>sharedOf('groups').map(g=>({...g,...sharedGroupPreferences.get(g.id)})),actions:()=>sharedOf('actions'),paths:()=>sharedOf('paths'),
  updateGroup(id,patch){if(!sharedAssets.some(a=>a.kind==='groups'&&a.id===id))return false;const prefs=sharedGroupPreferences.get(id)||{};for(const k of ['collapsed','favorite'])if(k in patch)prefs[k]=!!patch[k];sharedGroupPreferences.set(id,prefs);return true},
  routeAsset:routeCloudAsset,finishAssetMove,deleteAsset:deleteCloudAsset,
  async resolveAction(script,server){const asset=await cloud.getAsset(script.id);if(asset.kind!=='actions'||(asset.teamId!==cloud.state().personalSpaceId&&asset.teamId!==server?.teamId))throw Error('access_denied');if(asset.script!==script.expectedScript)throw Error('script_changed');return asset.script},
 }
}
module.exports={createExtension}
