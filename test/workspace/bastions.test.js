const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream')
const {createRoutes,access,validate}=require('../../src/workspace/bastions/route')
const b={id:'b',name:'Bastion',host:'jump.test',port:22,user:'jump'},target={id:'t',name:'Target',host:'private.test',port:22,user:'deploy',networkAccess:{version:1,mode:'bastion',bastionId:'b'}}
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(x=>x^51),decryptString:b=>Buffer.from(b).map(x=>x^51).toString()}
function fixture({mfa=false,hold=false,denied=false,sftpError=false,authorize=async()=>{},permissionTTL=60000,promptTimeout=120000}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-route-unit-')),events=[],clients=[];let routes,version='ab'.repeat(32)
 class Client extends EventEmitter{
  constructor(){super();clients.push(this)}
  connect(config){this.config=config;assert.equal(config.agentForward,false);assert.equal(config.readyTimeout,0);setImmediate(()=>config.hostVerifier(version,accept=>{if(!accept){this.emit('error',Error('untrusted'));return}if(mfa&&config.host==='jump.test')this.emit('keyboard-interactive','n','OTP','en',[{prompt:'OTP',echo:false},{prompt:'Reason',echo:true}],answers=>{assert.deepEqual(answers,['123456','test']);this.emit('ready')});else this.emit('ready')}));return this}
  forwardOut(_host,_port,host,port,cb){assert.equal(host,'private.test');assert.equal(port,22);setImmediate(()=>cb(denied?Error('raw secret must not escape'):null,new PassThrough()))}
  sftp(cb){setImmediate(()=>cb(sftpError?Error('secret server error'):null,{end(){}}))}
  end(){if(!this.ended){this.ended=true;this.emit('close')}}destroy(){this.end()}
 }
 routes=createRoutes({Client,utils:{parseKey:()=>({})},authorize,resolve:async()=>({target,bastion:b}),credentials:async()=>({password:'password-never-in-event'}),send:(name,e)=>{events.push({name,...e});if(name==='bastions:challenge'&&!hold)setImmediate(()=>routes.respond(e.id,{accept:true,responses:e.type==='authentication'?['123456','test']:[]}))},storage,directory,promptTimeout,permissionTTL,networkTimeout:1000})
 return{routes,events,clients,rotate:()=>version='cd'.repeat(32),cleanup:()=>{routes.closeAll();fs.rmSync(directory,{recursive:true,force:true})}}
}
test('route validation denies malformed, self, cross-scope and multiple hops',()=>{
 for(const value of [{mode:'bastion',bastionId:'b'},{version:1,mode:'direct',bastionId:'b'},{version:1,mode:'bastion',bastionId:'b',token:'secret'}])assert.throws(()=>access(value),/invalid_route/)
 assert.equal(validate(target,[b]),b);assert.equal(validate({...target,id:undefined},[b]),b);assert.throws(()=>validate({...target,networkAccess:{version:1,mode:'bastion',bastionId:'t'}},[target]),/missing/)
 assert.throws(()=>validate({...target,teamId:'other'},[b]),/scope/)
 assert.throws(()=>validate(target,[{...b,networkAccess:{version:1,mode:'bastion',bastionId:'z'}}]),/chain/)
 assert.throws(()=>validate({...target,host:'user@host'},[b]),/invalid_server/)
})
test('two independently trusted hops, interactive MFA, SFTP test and no leaked credentials',async()=>{
 const f=fixture({mfa:true});try{assert.deepEqual(await f.routes.open(target,{test:true}),{ok:true});assert.equal(f.routes.active(),0);assert(f.clients.every(c=>c.ended));assert.equal(f.events.filter(e=>e.type==='trust').length,2);assert(!JSON.stringify(f.events).includes('password-never-in-event'));await f.routes.open(target,{test:true});assert.equal(f.events.filter(e=>e.type==='trust').length,2,'trust is remembered only for the exact route identity')}finally{f.cleanup()}
})
test('changed host keys and forwarding refusal fail closed and dispose every socket',async()=>{
 const f=fixture();try{await f.routes.open(target,{test:true});f.rotate();await assert.rejects(f.routes.open(target),/hostkey_changed/);assert.equal(f.routes.active(),0)}finally{f.cleanup()}
 const g=fixture({denied:true});try{await assert.rejects(g.routes.open(target),/channel_refused/);assert(g.clients.every(c=>c.ended));assert(!JSON.stringify(g.events).includes('raw secret'))}finally{g.cleanup()}
})
test('cancel a pending trust prompt; stale responses cannot resurrect a session',async()=>{
 const f=fixture({hold:true});try{const pending=f.routes.open(target,{attemptId:'cancel-me'});while(!f.events.some(e=>e.name==='bastions:challenge'))await new Promise(r=>setImmediate(r));const id=f.events.find(e=>e.name==='bastions:challenge').id;f.routes.cancel('cancel-me');await assert.rejects(pending,/cancelled/);assert.throws(()=>f.routes.respond(id,{accept:true}),/expired_challenge/);assert.equal(f.routes.active(),0);assert(f.clients.every(c=>c.ended))}finally{f.cleanup()}
})
test('a denied authorization opens no sockets; permission lease closes a live route and dependency lock cascades',async()=>{
 const f=fixture({authorize:async()=>{throw Error('access_denied')}});try{await assert.rejects(f.routes.open(target),/access_denied/);assert.equal(f.clients.length,0)}finally{f.cleanup()}
 const g=fixture({permissionTTL:40});try{const c=await g.routes.open(target);await new Promise(r=>setTimeout(r,70));assert(c.ended);assert.equal(g.routes.active(),0)}finally{g.cleanup()}
 const h=fixture();try{const c=await h.routes.open(target);h.routes.closeDependency('b');assert(c.ended);assert.equal(h.routes.active(),0)}finally{h.cleanup()}
})
test('cancel during asynchronous plan resolution never opens a socket',async()=>{
 let finish;const f=fixture({authorize:()=>new Promise(r=>finish=r)});try{const pending=f.routes.open(target,{attemptId:'pending'});f.routes.cancel('pending');finish();await assert.rejects(pending,/cancelled/);assert.equal(f.clients.length,0)}finally{f.cleanup()}
})

test('a tab closed before metadata resolves cannot start a late route',async()=>{const f=fixture();try{const ticket=f.routes.begin(target.id);f.routes.cancelPending(target.id);await assert.rejects(f.routes.open(target,{ticket}),/cancelled/);assert.equal(f.clients.length,0);f.routes.finish(ticket)}finally{f.cleanup()}})

test('SFTP failure and an expired prompt clean every route resource',async()=>{const f=fixture({sftpError:true});try{await assert.rejects(f.routes.open(target,{test:true}),/sftp_unavailable/);assert.equal(f.routes.active(),0);assert(f.clients.every(c=>c.ended))}finally{f.cleanup()}const g=fixture({hold:true,promptTimeout:15});try{await assert.rejects(g.routes.open(target),/prompt_expired/);assert.equal(g.routes.active(),0)}finally{g.cleanup()}})
test('reset local trust requires an authorized exact endpoint confirmation',async()=>{const f=fixture();try{await f.routes.open(target,{test:true});await assert.rejects(f.routes.forgetTrust(target,'other.test'),/invalid_response/);await f.routes.forgetTrust(target,target.host);await f.routes.open(target,{test:true});assert.equal(f.events.filter(e=>e.type==='trust').length,4)}finally{f.cleanup()}})
