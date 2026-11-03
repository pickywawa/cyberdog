const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-private-bridge-'))
const D={en:{},fr:{},de:{},it:{}},handlers=new Map(),events=[]
let extension,cloudHooks,cloudServers=[],assets=[],saved=0,saveDenied=false
const cloudSecrets=new Map(),localCredentials=new Map()
const state=()=>({signedIn:true,userId:'owner',personalSpaceId:'personal',teams:[{id:'team',role:'owner'}],servers:cloudServers,assets,invitations:[]})
const cloud={state,init:async()=>state(),refresh:async()=>state(),
 getServer:async id=>({...cloudServers.find(s=>s.id===id),...localCredentials.get(id),syncedCredential:cloudSecrets.get(id)}),saveCredentials:(s,patch)=>localCredentials.set(s.id,{...localCredentials.get(s.id),...patch}),getAsset:async id=>assets.find(a=>a.id===id),
 async saveServer(data){if(saveDenied)throw Error('server_write_required');const id=data.id||'shared-server';if(data.syncCredentials===false)cloudSecrets.delete(id);if(data.credentials)cloudSecrets.set(id,data.credentials);const {credentials,...metadata}=data;cloudServers=[...cloudServers.filter(s=>s.id!==id),{...metadata,id,hasSyncedCredential:cloudSecrets.has(id)}];cloudHooks.onChange(state());return{serverId:id}},
 async saveAsset(data){assets=[{...data,id:'shared-group'}];cloudHooks.onChange(state());return{serverId:'shared-group'}},
 async action(action,payload){if(action==='server_delete')cloudServers=cloudServers.filter(s=>s.id!==payload.id);if(action==='asset_delete')assets=assets.filter(a=>a.id!==payload.id);cloudHooks.onChange(state());return state()},
}
const mainFile=path.join(__dirname,'../../src/workspace/main.js'),stub={exports:{}}
vm.runInNewContext(fs.readFileSync(mainFile,'utf8'),{module:stub,__dirname:path.dirname(mainFile),setInterval,Error,Buffer,require:name=>{
 if(name==='electron')return{app:{getPath:()=>directory},safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},shell:{openExternal:async()=>{}},net:{fetch:async()=>{throw Error('unexpected request')}}}
 if(name==='./cloud-account')return{createCloudAccount:options=>{cloudHooks=options;return cloud}}
 if(name==='./config.json')return require('../../src/workspace/config.json')
 if(name==='../i18n')return{D}
 if(name==='./i18n')return require('../../src/workspace/i18n')
 if(name==='./server-auth')return require('../../src/workspace/server-auth')
 if(name==='./bastions/config')return require('../../src/workspace/bastions/config')
 if(name==='./bastions/route')return require('../../src/workspace/bastions/route')
 if(name==='./secret-vaults')return require('../../src/workspace/secret-vaults')
 return require(name)
}})
const ctx={readPrivateKey:()=>({text:'-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----'}),serverOptions:(v,f={})=>({website:v.website??f.website??'',tags:v.tags??f.tags??[],downloadDir:v.downloadDir??f.downloadDir??''}),servers:[{id:'local',name:'Local',host:'host',port:22,user:'user'}],groups:[],actions:[],savedPaths:[],conns:new Map(),pendingVaultClients:new Set(),accountIPC:(name,fn)=>handlers.set(name,fn),send:(...event)=>events.push(event),t:key=>key,persist:()=>saved++,saveGroups:()=>{},persistActions:()=>{},writePaths:()=>{},list:()=>[...ctx.servers,...(extension?.servers()||[])],allGroups:()=>[...ctx.groups,...(extension?.groups()||[])],allActions:()=>ctx.actions,allPaths:()=>ctx.savedPaths}
;(async()=>{try{
 extension=stub.exports.createExtension(ctx);assert(extension.available)
 assert(handlers.has('vaults:save'));assert(handlers.has('teams:action'))
 await extension.saveServer({id:'local',teamId:'team',name:'Moved',host:'host',port:22,user:'user'})
 assert.equal(ctx.servers.length,0);assert(saved);assert.equal(extension.servers().length,1)
 await extension.updateServer(extension.servers()[0],{group:null});assert.equal(extension.servers()[0].group,null)
 await extension.saveServer({id:'shared-server',teamId:'',name:'Local again',host:'host',port:22,user:'user'})
 assert.equal(ctx.servers.length,1);assert.equal(extension.servers().length,0)
 await extension.saveServer({teamId:'team',name:'Shared secret',host:'host',port:22,user:'user',authMode:'password',pass:'sync-password',syncCredentials:true})
 assert.equal(cloudSecrets.get('shared-server').password,'sync-password');assert.equal(localCredentials.get('shared-server').pass,null)
 assert.equal((await extension.connectionAuth(await cloud.getServer('shared-server'))).password,'sync-password')
 saveDenied=true
 await assert.rejects(()=>extension.saveServer({id:'shared-server',teamId:'team',name:'Shared secret',host:'host',port:22,user:'user',authMode:'password',syncCredentials:false}),/server_write_required/)
 assert.equal(cloudSecrets.get('shared-server').password,'sync-password');assert.equal(Buffer.from(localCredentials.get('shared-server').pass,'base64').toString(),'sync-password','a local encrypted copy exists before deleting the cloud secret')
 saveDenied=false
 await extension.saveServer({id:'shared-server',teamId:'team',name:'Shared secret',host:'host',port:22,user:'user',authMode:'password',syncCredentials:false})
 assert(!cloudSecrets.has('shared-server'));assert(localCredentials.get('shared-server').pass)
 await extension.saveServer({id:'shared-server',teamId:'team',name:'Shared secret',host:'host',port:22,user:'user',authMode:'key',key:'/fixture-key',syncCredentials:true})
 assert.equal(cloudSecrets.get('shared-server').kind,'key');assert.equal(localCredentials.get('shared-server').key,null)
 assert((await extension.connectionAuth(await cloud.getServer('shared-server'))).privateKey.toString().includes('fixture-key'))
 assert(!JSON.stringify(extension.servers()).includes('fixture-key'),'secret key material is not exposed in the list')
 await extension.saveServer({id:'shared-server',teamId:'team',name:'New endpoint',host:'different-host',port:22,user:'user',authMode:'password',syncCredentials:true})
 assert(!cloudSecrets.has('shared-server'),'changing the destination cannot silently forward a saved secret')
 assert.equal(localCredentials.get('shared-server').pass,null)
 await extension.removeServer('shared-server')
 await extension.routeAsset('groups',{name:'Shared group',teamId:'team'});assert.equal(extension.groups()[0].name,'Shared group')
 assert(extension.updateGroup('shared-group',{collapsed:true}));assert.equal(extension.groups()[0].collapsed,true)
 await extension.deleteAsset('groups','shared-group');assert.equal(extension.groups().length,0)
 const keys=Object.keys(D.en).sort();for(const lang of ['fr','de','it'])assert.deepEqual(Object.keys(D[lang]).sort(),keys)
 console.log('workspace bridge: secure handlers, server transfers, local persistence, shared groups and translation parity ok')
}finally{fs.rmSync(directory,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1})
