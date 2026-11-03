const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const load=()=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../../backend/functions/cloud-handler.js'),'utf8')).toString('base64'))
const env=k=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-only'})[k]
const token='aaaa.bbbb.cccc',authId='11111111-1111-4111-8111-111111111111',email='member@example.test',identity='22222222-2222-4222-8222-222222222222'
function fixture(options={}){
 const calls=[]
 const fetcher=async(url,opts={})=>{
  const body=opts.body?JSON.parse(opts.body):undefined;calls.push({url,body,headers:opts.headers})
  if(url.endsWith('/auth/v1/user'))return opts.headers.Authorization==='Bearer '+token?Response.json({id:authId,email}):Response.json({error:'bad_jwt'},{status:401})
  if(url.endsWith('/rpc/cyberdog_bind_auth'))return Response.json(identity)
  if(url.endsWith('/rpc/cyberdog_member_action'))return options.deny?Response.json({message:'access_denied'},{status:400}):Response.json({teams:[],servers:[]})
  if(url.includes('/rpc/cyberdog_invite_link_'))return options.deny?Response.json({message:options.deny},{status:400}):Response.json(url.endsWith('_create')?{id:'link-1',expiresAt:'2030-01-01T00:00:00Z',usesLeft:body.uses}:url.endsWith('_list')?[]:null)
  throw Error('unexpected URL '+url)
 }
 return{calls,fetcher,rpc:name=>calls.filter(c=>c.url.endsWith('/rpc/'+name))}
}
const request=(body,bearer='Bearer '+token)=>new Request('https://test.test',{method:'POST',headers:bearer?{authorization:bearer}:{},body:JSON.stringify(body)})
const sha=text=>crypto.createHash('sha256').update(text).digest('hex')
test('requires a verified Supabase session; forged tokens, emails and user ids are useless',async()=>{
 const{createCloudHandler}=await load()
 for(const [bearer,body] of [[null,{action:'list'}],['Bearer not-a-jwt',{action:'list'}],['Bearer aaaa.bbbb.wrong',{action:'list',userId:authId,email}]]){
  const f=fixture(),r=await createCloudHandler({env,fetcher:f.fetcher})(request(body,bearer));assert.equal(r.status,401);assert.equal(f.calls.filter(c=>c.url.includes('/rpc/')).length,0)
 }
 assert.equal((await createCloudHandler({env,fetcher:fixture().fetcher})(new Request('https://t.test'))).status,405)
})
test('derives the acting identity solely from the verified token',async()=>{
 const{createCloudHandler}=await load(),f=fixture(),r=await createCloudHandler({env,fetcher:f.fetcher})(request({action:'list',userId:'victim',email:'victim@example.test',premium:true,identity_id:'victim',payload:{userId:'victim'}}))
 assert.equal(r.status,200)
 assert.deepEqual(f.rpc('cyberdog_bind_auth')[0].body,{auth_id:authId,email})
 const operation=f.rpc('cyberdog_member_action')[0].body;assert.equal(operation.identity_id,identity);assert.equal(operation.action,'list')
 assert(!JSON.stringify(f.calls.filter(c=>c.url.includes('/rpc/'))).includes('victim@example.test'))
})
test('rejects unknown and privileged actions before any database call',async()=>{
 const{createCloudHandler}=await load()
 for(const action of ['bind','grant','cyberdog_bind_auth','delete_user',undefined]){const f=fixture(),r=await createCloudHandler({env,fetcher:f.fetcher})(request({action}));assert.equal(r.status,400);assert.equal(f.calls.filter(c=>c.url.includes('/rpc/')).length,0)}
 const f=fixture(),r=await createCloudHandler({env,fetcher:f.fetcher})(request({action:'list',payload:{_credentialEnvelope:{data:'forged'}}}));assert.equal(r.status,400)
})
test('database denials are returned as access_denied without internals',async()=>{
 const{createCloudHandler}=await load(),f=fixture({deny:true}),r=await createCloudHandler({env,fetcher:f.fetcher})(request({action:'details',payload:{teamId:'x'}}));assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'access_denied'})
})
test('invitation links: 256-bit secret, only its hash is stored, shown once',async()=>{
 const{createCloudHandler}=await load(),handle=f=>createCloudHandler({env,fetcher:f.fetcher}),team='33333333-3333-4333-8333-333333333333'
 const f=fixture(),r=await handle(f)(request({action:'invite_link_create',payload:{teamId:team,uses:3}}));assert.equal(r.status,200)
 const data=(await r.json()).value;assert.match(data.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(data.link,'cyberdog://invite/'+data.token)
 const stored=f.rpc('cyberdog_invite_link_create')[0].body;assert.equal(stored.hash,sha(data.token));assert.equal(stored.uid,identity);assert.equal(stored.uses,3);assert(!JSON.stringify(stored).includes(data.token))
 const a=fixture(),accepted=await handle(a)(request({action:'invite_link_accept',payload:{token:data.token}}));assert.equal(accepted.status,200);assert.equal(a.rpc('cyberdog_invite_link_accept')[0].body.hash,sha(data.token))
 for(const bad of ['short','A'.repeat(44),'A'.repeat(42)+'!',undefined,123]){const b=fixture(),res=await handle(b)(request({action:'invite_link_accept',payload:{token:bad}}));assert.equal(res.status,403);assert.equal(b.rpc('cyberdog_invite_link_accept').length,0)}
 const bad=await handle(fixture())(request({action:'invite_link_create',payload:{teamId:'not-a-uuid'}}));assert.equal(bad.status,400)
 const gone=await handle(fixture({deny:'invitation_unavailable'}))(request({action:'invite_link_accept',payload:{token:data.token}}));assert.equal(gone.status,403);assert.deepEqual(await gone.json(),{error:'invitation_unavailable'})
 const plain=await handle(fixture({deny:'admin_required'}))(request({action:'invite_link_create',payload:{teamId:team}}));assert.deepEqual(await plain.json(),{error:'admin_required'})
})
test('credential encryption binds ciphertext to a server and rejects tampering, wrong keys and unsafe payloads',async()=>{
 const{encryptCredential,decryptCredential,validateCredential}=await load(),keyEnv=k=>k==='CYBERDOG_CREDENTIALS_KEY'?'ab'.repeat(32):env(k),id='00000000-0000-4000-8000-000000000001'
 const secretValue={kind:'password',password:'database-secret'},cipher=await encryptCredential(secretValue,id,keyEnv)
 assert(!JSON.stringify(cipher).includes(secretValue.password));assert.deepEqual(await decryptCredential(cipher,id,keyEnv),secretValue)
 await assert.rejects(()=>decryptCredential(cipher,'other-server',keyEnv),/credential_sync_unavailable/)
 await assert.rejects(()=>decryptCredential({...cipher,data:(cipher.data[0]==='A'?'B':'A')+cipher.data.slice(1)},id,keyEnv),/credential_sync_unavailable/)
 await assert.rejects(()=>decryptCredential(cipher,id,k=>k==='CYBERDOG_CREDENTIALS_KEY'?'cd'.repeat(32):env(k)),/credential_sync_unavailable/)
 await assert.rejects(()=>encryptCredential(secretValue,id,env),/credential_sync_unavailable/)
 for(const value of [{kind:'password',password:''},{kind:'password',password:'x',other:'hidden'},{kind:'key',privateKey:'not a key'},{kind:'password',password:'x'.repeat(5000)}])assert.throws(()=>validateCredential(value),/invalid_credential/)
})
test('gateway stores only ciphertext, reveals only after authorization and rejects injected envelopes',async()=>{
 const{createCloudHandler,encryptCredential}=await load(),keyEnv=k=>k==='CYBERDOG_CREDENTIALS_KEY'?'ab'.repeat(32):env(k),id='00000000-0000-4000-8000-000000000001',f=fixture();let saved
 const handle=createCloudHandler({env:keyEnv,randomUUID:()=>id,fetcher:async(url,opts)=>{
  if(url.endsWith('/rpc/cyberdog_member_action')){const b=JSON.parse(opts.body);if(b.action==='server_save'){saved=b;return Response.json({serverId:id})}if(b.action==='server_get')return Response.json({id,authMode:'password',credentialEnvelope:await encryptCredential({kind:'password',password:'shared-password'},id,keyEnv)})}
  return f.fetcher(url,opts)
 }})
 let r=await handle(request({action:'server_save',payload:{teamId:'team',name:'Server',authMode:'password',syncCredentials:true,credentials:{kind:'password',password:'shared-password'}}}));assert.equal(r.status,200);assert(saved.payload._credentialEnvelope);assert.equal(saved.payload._newServerId,id);assert(!JSON.stringify(saved).includes('shared-password'));assert(!('credentials'in saved.payload))
 r=await handle(request({action:'server_get',payload:{id,teamId:'team'}}));const result=await r.json();assert.equal(result.value.syncedCredential.password,'shared-password');assert(!('credentialEnvelope'in result.value))
 const denied=fixture({deny:true});r=await createCloudHandler({env:keyEnv,fetcher:denied.fetcher})(request({action:'server_get',payload:{id,teamId:'other'}}));assert.equal(r.status,403);assert(!JSON.stringify(await r.json()).includes('shared-password'))
})
