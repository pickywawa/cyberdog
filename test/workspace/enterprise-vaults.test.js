const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {createVaults}=require('../../src/workspace/secret-vaults')
const {keeperFields,baseURL}=require('../../src/workspace/enterprise-vaults')
const GUID='11111111-1111-4111-8111-111111111111',ENTRY='22222222-2222-4222-8222-222222222222'
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(x=>x^89),decryptString:b=>Buffer.from(b).map(x=>x^89).toString()}
function fixture(provider){
 let password='fixture-secret',paid=true;const calls=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-enterprise-unit-'))
 const config={provider,name:provider,url:'https://fixture.test/'+provider,token:'fixture-token',folderIds:'1,2',applicationKey:GUID,remoteVaultId:GUID,dataSourceId:GUID,cliProfile:'test',cliPath:path.join(directory,provider==='keeper'?'ksm':'pwsh')}
 const itemId=provider==='teampass'?'1':provider==='manageengine'?'1:2':provider==='keeper'?'-2345678901234567890123':ENTRY
 const item=()=>({id:1,id_tree:1,label:'Production',login:'deploy',url:'ssh://server.test:2222',pwd:password,inactif:0,fields:[{title:'private_key',value:''}]})
 const fetch=async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit')
  const u=new URL(url),p=u.pathname
  if(provider==='teampass'){
   assert.equal(options.headers.Authorization,'Bearer fixture-token')
   if(p.endsWith('/item/inFolders')){assert.equal(u.searchParams.get('folders'),'1,2');return Response.json([item()])}
   if(p.endsWith('/item/get')){assert.equal(u.searchParams.get('id'),'1');return Response.json([item()])}
  }
  if(provider==='manageengine'){
   assert.equal(options.headers.AUTHTOKEN,'fixture-token')
   const data=p.endsWith('/resources')?[{'RESOURCE ID':'1','RESOURCE NAME':'Production'}]:p.endsWith('/password')?{PASSWORD:password}:{'DNS NAME':'server.test','ACCOUNT LIST':[{'ACCOUNT ID':'2','ACCOUNT NAME':'deploy'}]}
   return Response.json({operation:{result:{status:'Success'},Details:data}})
  }
  if(provider==='devolutions'){
   if(p.endsWith('/login')){assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).appSecret,'fixture-token');return Response.json({tokenId:'devo-session'})}
   assert.equal(options.headers.tokenId,'devo-session')
   if(p.endsWith('/logout')){assert.equal(options.method,'POST');return Response.json({ok:true})}
   if(p.endsWith('/entry'))return Response.json({data:[{id:ENTRY,name:'Production',password:'do-not-expose-in-list'}]})
   if(p.endsWith('/entry/'+ENTRY))return Response.json({id:ENTRY,host:'server.test',username:'deploy',password})
  }
  throw Error('unexpected fixture route '+p)
 }
 const run=async(file,args,env)=>{
  calls.push({file,args,env});assert(!args.includes('fixture-token'));assert(!args.includes(password))
  if(provider==='keeper'){
   assert(args.includes('--no-cache'));assert(args.includes('--profile-name'));assert(!env.KSM_TOKEN)
   if(args.includes('list'))return JSON.stringify([{uid:itemId,title:'Production'}])
   assert(args.includes('--force-array'));assert.equal(args[args.indexOf('--uid')+1],itemId)
   return JSON.stringify([{uid:itemId,fields:[{type:'host',value:[{hostName:'server.test',port:'2222'}]},{type:'login',value:['deploy']},{type:'password',value:[password]}]}])
  }
  assert.equal(provider,'rdm');assert(args.includes('-NonInteractive'));assert(args.includes('-File'));assert(!args.includes('-Command'))
  const data=JSON.parse(env.CYBERDOG_RDM_REQUEST);assert.equal(data.dataSourceId,GUID)
  if(data.operation==='list')return JSON.stringify([{id:ENTRY,name:'Production'}])
  return JSON.stringify({id:ENTRY,host:'server.test',user:'deploy',password})
 }
 const store=createVaults({directory,safeStorage,fetch,authorize:async()=>{if(!paid)throw Error('access_denied')},run,platform:provider==='rdm'?'win32':process.platform})
 return{store,config,itemId,directory,calls,setPassword:value=>password=value,revoke:()=>paid=false,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})}
}
for(const provider of ['teampass','keeper','manageengine','devolutions','rdm'])test(provider+': inventory, credential rotation, locks, authorization and secret boundaries',async()=>{
 const f=fixture(provider)
 try{
  const connector=await f.store.saveConnector(f.config),items=await f.store.browse(connector.id)
  assert.equal(items.length,1);assert.equal(items[0].id,f.itemId);assert(!JSON.stringify(items).includes('secret'));assert(!JSON.stringify(items).includes('do-not-expose'))
  const preview=await f.store.preview(connector.id,f.itemId);assert.equal(preview.host,'server.test');assert.equal(preview.user,'deploy');assert(!JSON.stringify(preview).includes('fixture-secret'))
  const id=await f.store.pin({vaultId:connector.id,itemId:f.itemId,name:'Production',host:preview.host,user:preview.user,port:preview.port})
  assert.equal((await f.store.resolve(id)).vaultPassword,'fixture-secret');f.setPassword('rotated-secret');assert.equal((await f.store.resolve(id)).vaultPassword,'rotated-secret')
  const persisted=safeStorage.decryptString(fs.readFileSync(path.join(f.directory,'secret-vaults.bin')))
  for(const secret of ['fixture-token','fixture-secret','rotated-secret','devo-session'])assert(!persisted.includes(secret))
  assert(!JSON.stringify(f.store.list()).includes('fixture-token'))
  f.store.lock(connector.id);await assert.rejects(()=>f.store.resolve(id),/vault.locked/)
  await f.store.unlock(connector.id,['keeper','rdm'].includes(provider)?'':'fixture-token');assert((await f.store.resolve(id)).vaultPassword)
  f.revoke();await assert.rejects(()=>f.store.resolve(id),/access_denied/)
  if(provider==='devolutions')assert.equal(f.calls.filter(c=>c.url?.endsWith('/login')).length,f.calls.filter(c=>c.url?.endsWith('/logout')).length,'log out every temporary API session')
 }finally{f.cleanup()}
})
test('scopes, malformed responses, denied approvals, TLS configuration and platform checks',async()=>{
 for(const url of ['http://fixture.test','https://user:secret@fixture.test','https://fixture.test?token=secret'])assert.throws(()=>baseURL(url),/vault.url_error/)
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-vault-denials-'))
 try{
  const store=createVaults({directory:dir,safeStorage,authorize:async()=>{},fetch:async()=>Response.json([{id:1,id_tree:3,label:'Outside',pwd:'sensitive'}])})
  const connector=await store.saveConnector({provider:'teampass',name:'TeamPass',url:'https://fixture.test',folderIds:'1',token:'token'})
  await assert.rejects(()=>store.browse(connector.id),{message:'vault.response'})
  await assert.rejects(()=>store.preview(connector.id,'1'),{message:'vault.denied'})
  await assert.rejects(()=>store.preview(connector.id,'../1'),{message:'vault.invalid'})
  const pmp=createVaults({directory:path.join(dir,'pmp'),safeStorage,authorize:async()=>{},fetch:async()=>Response.json({operation:{result:{status:'Failed',message:'PASSWORD SECRET approval required'}}})})
  const p=await pmp.saveConnector({provider:'manageengine',name:'PMP',url:'https://fixture.test',token:'token'})
  await assert.rejects(()=>pmp.browse(p.id),{message:'vault.denied'})
  const unsupported=createVaults({directory:path.join(dir,'rdm'),safeStorage,authorize:async()=>{},platform:'darwin'})
  await assert.rejects(()=>unsupported.saveConnector({provider:'rdm',name:'RDM',dataSourceId:GUID,remoteVaultId:GUID}),{message:'vault.windows_only'})
  assert.equal(keeperFields({fields:[{type:'keyPair',value:[{privateKey:'private-key'}]}]}).private_key,'private-key')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('Devolutions logout on access failure and no response-body leakage',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-devo-fail-'));let logout=false
 try{
  const store=createVaults({directory:dir,safeStorage,authorize:async()=>{},fetch:async(url,options)=>{
   if(url.endsWith('/login'))return Response.json({tokenId:'temporary'})
   if(url.endsWith('/logout')){logout=true;return Response.json({})}
   return new Response('sensitive backend detail',{status:403})
  }})
  const connector=await store.saveConnector({provider:'devolutions',name:'Devo',url:'https://fixture.test/dvls',applicationKey:GUID,remoteVaultId:GUID,token:'secret'})
  await assert.rejects(()=>store.browse(connector.id),{message:'vault.denied'});assert(logout)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('changing the destination never reuses a remembered or runtime API secret',async()=>{
 const f=fixture('manageengine')
 try{
  const c=await f.store.saveConnector({...f.config,rememberToken:true})
  assert.equal(c.hasSavedToken,true)
  const moved=await f.store.saveConnector({...c,url:'https://another.test/pmp',rememberToken:true})
  assert.equal(moved.hasSavedToken,false);assert.equal(moved.locked,true)
  await assert.rejects(()=>f.store.browse(c.id),{message:'vault.locked'})
 }finally{f.cleanup()}
})
