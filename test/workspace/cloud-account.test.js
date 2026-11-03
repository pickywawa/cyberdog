const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const{createCloudAccount,parseInvite}=require('../../src/workspace/cloud-account')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-account-'))
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('protected:'+s),decryptString:b=>b.toString().replace(/^protected:/,'')}
const config={supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-only'}
const email='member@example.test',password='correct horse battery',link='cyberdog://invite/'+'A'.repeat(43)
const server={id:'server-1',teamId:'team-1',name:'VM',host:'host-1',port:22,user:'root'}
const jump={...server,id:'jump-1',host:'jump.test',user:'jump'}
const asset={id:'action-1',teamId:'team-1',kind:'actions',name:'Health',script:'uptime'}
let requests=[],auths=[],valid=new Set(),refreshes=0,expiresIn=3600,refreshFails=false,offline=false,denied=false,confirm=false
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data})
const session=(n,id='user-1')=>{valid.add('access-'+n);return{access_token:'access-'+n,refresh_token:'refresh-'+n,expires_in:expiresIn,user:{id,email}}}
const fetch=async(url,opts)=>{
 if(offline)throw Error('offline')
 const body=JSON.parse(opts.body||'{}'),headers=opts.headers
 if(url.includes('/auth/v1/')){
  auths.push({url,body});assert.equal(headers.apikey,'public-only')
  if(url.endsWith('grant_type=password'))return body.password==='wrong-password'?reply({error_code:'invalid_credentials'},400):reply(session(++refreshes))
  if(url.endsWith('/signup'))return body.email==='taken@example.test'?reply({error_code:'user_already_exists'},422):confirm?reply({id:'user-2',email:body.email}):reply(session(++refreshes))
  if(url.endsWith('grant_type=refresh_token'))return refreshFails?reply({error_code:'refresh_token_not_found'},400):reply(session(++refreshes))
  if(url.endsWith('/logout'))return reply({})
 }
 assert(url.endsWith('/functions/v1/cyberdog-cloud'),'only the gateway is called: '+url)
 requests.push({body,authorization:headers.Authorization});assert(!('email'in body)&&!('userId'in body),'identity is never client supplied')
 if(!valid.has(headers.Authorization.replace('Bearer ',''))){return reply({error:'auth_required'},401)}
 if(denied)return reply({error:'access_denied'},403)
 const value=body.action==='list'?{teams:[{id:'team-1',name:'Team',role:'owner'}],servers:[server,jump],assets:[asset],invitations:[]}:body.action==='route_get'?{target:{...server},bastion:{...jump}}:body.action==='server_get'?{...(body.payload.id===jump.id?jump:server)}:body.action==='asset_get'?asset:body.action==='history_list'?[{id:'revision-1',snapshot:{name:'VM'}}]:body.action==='invite_link_create'?{id:'link-1',link,token:'A'.repeat(43)}:body.action==='invite_link_list'?[{id:'link-1',usesLeft:1}]:{email,userId:'user-1'}
 return reply({value})
}
;(async()=>{try{
 const cloud=createCloudAccount({config,fetch,safeStorage,directory});await cloud.init()
 assert.equal(cloud.state().signedIn,false)
 for(const bad of [{email:'invalid',password},{email,password:'short'}])await assert.rejects(()=>cloud.signIn(bad),/invalid_email|weak_password/)
 await assert.rejects(()=>cloud.signIn({email,password:'wrong-password'}),/invalid_credentials/);assert.equal(cloud.state().signedIn,false)
 await assert.rejects(()=>cloud.signUp({email:'taken@example.test',password}),/email_taken/)
 confirm=true;assert.equal((await cloud.signUp({email:'new@example.test',password})).confirmEmail,true);assert.equal(cloud.state().signedIn,false);confirm=false
 refreshes=0;await cloud.signIn({email,password})
 assert(cloud.state().signedIn);assert.equal(cloud.state().email,email);assert.equal(cloud.state().teams.length,1)
 assert(!JSON.stringify(cloud.state()).includes('access-'));assert(!JSON.stringify(requests).includes(password))
 assert(requests.every(r=>r.authorization==='Bearer access-1'),'gateway receives the access token')
 // A token that the server no longer accepts is refreshed once and the request is retried.
 valid.delete('access-1');const before=auths.length;await cloud.refresh();assert(auths.length>before&&auths.some(a=>a.url.endsWith('grant_type=refresh_token')));assert(cloud.state().signedIn)
 // Join and invitation links.
 assert.equal(parseInvite(link),'A'.repeat(43));assert.equal(parseInvite('A'.repeat(43)),'A'.repeat(43))
 for(const bad of ['','cyberdog://invite/short','https://evil.test/'+'A'.repeat(43),'A'.repeat(42)+'!'])assert.throws(()=>parseInvite(bad),/invitation_unavailable/)
 const count=requests.length;const created=await cloud.action('invite_link_create',{teamId:'team-1',uses:3});assert.equal(created.link,link);assert.equal(requests.length,count+1,'creating a link does not refresh the catalog')
 await cloud.action('invite_link_accept',{token:link});assert.equal(requests.at(-1).body.action,'list');assert.equal(requests.findLast(r=>r.body.action==='invite_link_accept').body.payload.token,'A'.repeat(43),'only the secret token is sent, never the URL')
 await assert.rejects(()=>cloud.action('invite_link_accept',{token:'nope'}),/invitation_unavailable/)
 await assert.rejects(()=>cloud.action('grant_everything',{}),/unknown_action/)
 assert.equal((await cloud.getAsset(asset.id)).script,'uptime')
 assert.equal((await cloud.action('history_list',{teamId:'team-1'}))[0].id,'revision-1')
 cloud.saveCredentials(server,{pass:'local-password',key:'/local/private-key'})
 assert.equal((await cloud.getServer(server.id)).pass,'local-password')
 cloud.saveCredentials(jump,{pass:'jump-local-password'});const plan=await cloud.getRoute(server.id);assert.equal(plan.target.pass,'local-password');assert.equal(plan.bastion.pass,'jump-local-password')
 assert(!JSON.stringify(requests).includes('local-password'));assert(!JSON.stringify(requests).includes('/local/private-key'))
 server.host='host-2';assert.equal((await cloud.getServer(server.id)).pass,undefined,'credentials never follow a changed destination')
 // A denied action keeps the session; a failure of the network keeps it too.
 denied=true;await assert.rejects(()=>cloud.refresh(),/access_denied/);assert(cloud.state().signedIn);denied=false
 offline=true;await assert.rejects(()=>cloud.refresh(),/network/);assert(cloud.state().signedIn);offline=false
 // Startup previews contain names only and grant no access before the server answers.
 let release;const gate=new Promise(resolve=>release=resolve)
 const slow=createCloudAccount({config,fetch:async(...args)=>{await gate;return fetch(...args)},safeStorage,directory})
 const initializing=slow.init();await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(slow.previews().length,2);assert.deepEqual(Object.keys(slow.previews()[0]).sort(),['id','name','teamId']);assert.equal(slow.state().servers.length,0)
 const cached=JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(directory,'cloud-server-names.bin'))))
 assert(!JSON.stringify(cached).includes('host-1'));assert(!JSON.stringify(cached).includes('local-password'))
 release();await initializing;assert.equal(slow.previews().length,0)
 // A refresh token the server rejects ends the session and clears the cache.
 valid.clear();refreshFails=true;await assert.rejects(()=>cloud.refresh(),/auth_required/)
 assert.equal(cloud.state().signedIn,false);assert.equal(cloud.state().servers.length,0);assert(!fs.existsSync(path.join(directory,'account-session.bin')));assert(!fs.existsSync(path.join(directory,'cloud-server-names.bin')))
 refreshFails=false;await cloud.signIn({email,password});const logouts=auths.length;await cloud.signOut();assert(auths.slice(logouts).some(a=>a.url.endsWith('/logout')));assert.equal(cloud.state().signedIn,false);assert(!fs.existsSync(path.join(directory,'account-session.bin')))
 await assert.rejects(()=>cloud.action('list'),/unknown_action/)
 const insecure=createCloudAccount({config,fetch,safeStorage:{isEncryptionAvailable:()=>false},directory})
 await assert.rejects(()=>insecure.signIn({email,password}),/secure_storage_unavailable/)
 const unconfigured=createCloudAccount({config:{},fetch,safeStorage,directory});await assert.rejects(()=>unconfigured.signIn({email,password}),/unconfigured/);assert.equal(unconfigured.state().configured,false)
 console.log('account session: sign-in, refresh, invitation links, fail-closed errors and local credential isolation ok')
}finally{fs.rmSync(directory,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1})
