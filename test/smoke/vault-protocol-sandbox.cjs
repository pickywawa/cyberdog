// Protocol sandbox, not vendor servers: real TLS and child processes with vendor-shaped fixtures.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),assert=require('node:assert/strict')
const {execFile,execFileSync}=require('node:child_process'),{Readable}=require('node:stream')
const {createVaults}=require('../../src/workspace/secret-vaults')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-protocol-sandbox-'))
const GUID='11111111-1111-4111-8111-111111111111',ENTRY='22222222-2222-4222-8222-222222222222'
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(x=>x^77),decryptString:b=>Buffer.from(b).map(x=>x^77).toString()}
let password='sandbox-password',denied=false,logins=0,logouts=0,requests=0
const server=https.createServer
;(async()=>{
 let service
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:company.vault.azure.net,IP:127.0.0.1','-days','1'],{stdio:'ignore'})
  const cert=fs.readFileSync(path.join(directory,'cert.pem'))
  service=server({key:fs.readFileSync(path.join(directory,'key.pem')),cert},async(req,res)=>{
   requests++;const url=new URL(req.url,'https://localhost'),p=url.pathname
   const reply=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))}
   if(denied)return reply({error:'do not leak private details'},403)
   if(req.headers.host?.startsWith('company.vault.azure.net')){if(req.headers.authorization!=='Bearer sandbox-token')return reply({},401);return reply(p==='/secrets'?{value:[{id:'https://company.vault.azure.net/secrets/server'}]}:{value:JSON.stringify({host:'server.test',user:'deploy',password})})}
   if(p.startsWith('/tp/')){
    if(req.headers.authorization!=='Bearer sandbox-token')return reply({},401)
    return reply([{id:1,id_tree:1,label:'Server',login:'deploy',url:'ssh://server.test',pwd:password,inactif:0}])
   }
   if(p.startsWith('/pmp/')){
    if(req.headers.authtoken!=='sandbox-token')return reply({},401)
    const details=p.endsWith('/resources')?[{'RESOURCE ID':'1','RESOURCE NAME':'Server'}]:p.endsWith('/password')?{PASSWORD:password}:{'DNS NAME':'server.test','ACCOUNT LIST':[{'ACCOUNT ID':'2','ACCOUNT NAME':'deploy'}]}
    return reply({operation:{result:{status:'Success'},Details:details}})
   }
   if(p.startsWith('/dvls/')){
    if(p.endsWith('/login')){let body='';for await(const chunk of req)body+=chunk;if(JSON.parse(body).appSecret!=='sandbox-token')return reply({},401);assert.equal(req.method,'POST');logins++;return reply({tokenId:'sandbox-session'})}
    if(req.headers.tokenid!=='sandbox-session')return reply({},401)
    if(p.endsWith('/logout')){logouts++;return reply({ok:true})}
    return reply(p.endsWith('/entry')?{data:[{id:ENTRY,name:'Server'}]}:{id:ENTRY,host:'server.test',username:'deploy',password})
   }
   if(p.startsWith('/v1/')){
    if(req.headers['x-vault-token']!=='sandbox-token')return reply({},401)
    return reply(p.includes('/metadata/')?{data:{keys:['server']}}:{data:{data:{host:'server.test',user:'deploy',password}}})
   }
   return reply({},404)
  })
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve))
  const origin='https://localhost:'+service.address().port
  // Explicit test CA, never NODE_TLS_REJECT_UNAUTHORIZED=0. Requests keep TLS validation enabled.
  const fetchTLS=(url,options={},trust=true)=>new Promise((resolve,reject)=>{
   const target=new URL(url)
   if(target.origin!==origin&&target.origin!=='https://company.vault.azure.net')return reject(Error('Sandbox blocks external network'))
   const req=https.request(url,{port:service.address().port,servername:target.hostname,method:options.method||'GET',headers:options.headers,signal:options.signal,ca:trust?cert:undefined,rejectUnauthorized:true,lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)},response=>resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers:response.headers})))
   req.on('error',reject);if(options.body)req.write(options.body);req.end()
  })
  const store=createVaults({directory:path.join(directory,'store'),safeStorage,fetch:fetchTLS,authorize:async()=>{}})
  const configs=[{provider:'teampass',url:origin+'/tp',folderIds:'1',item:'1'},{provider:'manageengine',url:origin+'/pmp',item:'1:2'},{provider:'devolutions',url:origin+'/dvls',applicationKey:GUID,remoteVaultId:GUID,item:ENTRY},{provider:'hashicorp',url:origin,mount:'kv',prefix:'servers',item:'servers/server'},{provider:'azure',azureVault:'company',item:'server'}]
  for(const config of configs){
   password='sandbox-password';const connector=await store.saveConnector({...config,name:config.provider,token:'sandbox-token'})
   assert.equal((await store.browse(connector.id))[0].id,config.item)
   const preview=await store.preview(connector.id,config.item);assert(!JSON.stringify(preview).includes(password))
   const pin=await store.pin({vaultId:connector.id,itemId:config.item,name:'Server',host:'server.test',user:'deploy',port:22})
   assert.equal((await store.resolve(pin)).vaultPassword,password);password='sandbox-rotated';assert.equal((await store.resolve(pin)).vaultPassword,password)
   denied=true;await assert.rejects(()=>store.resolve(pin),{message:'vault.denied'});denied=false
   store.lock(connector.id);await assert.rejects(()=>store.resolve(pin),{message:'vault.locked'})
  }
  assert.equal(logins,logouts)
  const untrusted=createVaults({directory:path.join(directory,'untrusted'),safeStorage,fetch:(url,opts)=>fetchTLS(url,opts,false),authorize:async()=>{}})
  const u=await untrusted.saveConnector({provider:'teampass',name:'Untrusted',url:origin+'/tp',folderIds:'1',token:'sandbox-token'})
  await assert.rejects(()=>untrusted.browse(u.id),{message:'vault.network'})
  // CLI fixtures execute in separate Node processes; vendor CLIs/SDKs are not installed here.
  const fixture=path.join(directory,'cli-fixture.cjs')
  fs.writeFileSync(fixture,`const p=process.argv[2],args=process.argv.slice(3),password=process.env.SANDBOX_PASSWORD,entry=${JSON.stringify(ENTRY)};
let result;
if(p==='op')result=args.includes('list')?[{id:'abcdefghijklmnopqrstuvwxyz',title:'Server'}]:{id:'abcdefghijklmnopqrstuvwxyz',fields:[{id:'host',value:'server.test'},{id:'username',value:'deploy'},{id:'password',value:password}]};
if(p==='bw')result=args.includes('list')?[{id:entry,name:'Server'}]:args.includes('sync')?{}:{id:entry,login:{username:'deploy',password,uris:[{uri:'ssh://server.test'}]}};
if(p==='aws')result=args.includes('list-secrets')?{SecretList:[{Name:'server'}]}:{SecretString:JSON.stringify({host:'server.test',user:'deploy',password})};
if(p==='ksm')result=args.includes('list')?[{uid:'abcdefghijklmnopqrstuvwxyz',title:'Server'}]:[{uid:'abcdefghijklmnopqrstuvwxyz',fields:[{type:'host',value:[{hostName:'server.test'}]},{type:'login',value:['deploy']},{type:'password',value:[password]}]}];
process.stdout.write(JSON.stringify(result));`)
  const run=(file,args,env)=>new Promise((resolve,reject)=>{const name=path.basename(file).replace(/\.exe$/,'');const child=execFile(process.execPath,[fixture,name,...args],{env:{...env,SANDBOX_PASSWORD:password},timeout:10000,maxBuffer:1024*1024,shell:false},(error,out)=>error?reject(error):resolve(out));child.stdin.end()})
  const cli=createVaults({directory:path.join(directory,'cli'),safeStorage,fetch:fetchTLS,authorize:async()=>{},run})
  for(const [provider,binary,item] of [['onepassword','op','abcdefghijklmnopqrstuvwxyz'],['bitwarden','bw',ENTRY],['aws','aws','server'],['keeper','ksm','abcdefghijklmnopqrstuvwxyz']]){
   const connector=await cli.saveConnector({provider,name:provider,cliPath:path.join(directory,binary+(process.platform==='win32'?'.exe':'')),region:'eu-west-1',token:provider==='bitwarden'?'sandbox-session':''})
   assert.equal((await cli.browse(connector.id))[0].id,item)
   const id=await cli.pin({vaultId:connector.id,itemId:item,name:'Server',host:'server.test',user:'deploy',port:22});assert.equal((await cli.resolve(id)).vaultPassword,password)
  }
  console.log(JSON.stringify({sandbox:'passed',httpsAdapters:configs.map(c=>c.provider),cliProcessFixtures:['onepassword','bitwarden','aws','keeper'],tlsRequests:requests,devolutionsSessionsClosed:logouts,tlsTrustFailure:'denied',vendorServers:false,nativeRDM:'not available on this Mac'}))
 }finally{if(service)await new Promise(resolve=>service.close(resolve));fs.rmSync(directory,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1})
