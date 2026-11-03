// SSH routing through bastions. The caller supplies only authorized server records.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path')
const fail=code=>{throw Error(code)}
function access(value){
 if(value==null)return{version:1,mode:'direct'}
 if(typeof value!=='object'||Array.isArray(value)||value.version!==1)fail('bastion.invalid_route')
 if(value.mode==='direct'&&Object.keys(value).every(k=>['version','mode'].includes(k)))return{version:1,mode:'direct'}
 if(value.mode!=='bastion'||typeof value.bastionId!=='string'||!value.bastionId||value.bastionId.length>128||Object.keys(value).some(k=>!['version','mode','bastionId'].includes(k)))fail('bastion.invalid_route')
 return{version:1,mode:'bastion',bastionId:value.bastionId}
}
function endpoint(s){if(!s||typeof s.host!=='string'||!s.host.trim()||s.host.length>255||/[\s\x00-\x1f\x7f/@]/.test(s.host)||!Number.isInteger(+s.port)||+s.port<1||+s.port>65535||typeof s.user!=='string'||!s.user.trim()||s.user.length>128||/[\x00-\x1f\x7f]/.test(s.user))fail('bastion.invalid_server');return s}
function validate(target,servers){
 endpoint(target);const route=access(target.networkAccess)
 if(route.mode==='direct')return null
 const b=servers.find(s=>s.id===route.bastionId)
 if(!b||b.id===target.id)fail('bastion.missing')
 if((b.teamId||'')!==(target.teamId||''))fail('bastion.scope')
 if(access(b.networkAccess).mode!=='direct'||target.id&&servers.some(s=>s.id!==target.id&&access(s.networkAccess).bastionId===target.id))fail('bastion.chain')
 return endpoint(b)
}
const identity=s=>JSON.stringify([s.id||'',s.teamId||'',s.host,+s.port,s.user,access(s.networkAccess)])
function createRoutes({Client,utils,authorize,resolve,credentials,send,storage,directory,onTrust=()=>{},networkTimeout=15000,promptTimeout=120000,permissionTTL=60000}){
 const requests=new Set(),sessions=new Map(),challenges=new Map(),file=path.join(directory,'bastion-trust.bin');let trusted=null
 const secure=()=>{if(!storage.isEncryptionAvailable()||storage.getSelectedStorageBackend?.()==='basic_text')fail('secure_storage_unavailable')}
 const read=()=>{secure();if(!trusted)trusted=fs.existsSync(file)?JSON.parse(storage.decryptString(fs.readFileSync(file))):{};return trusted}
 const trust=(key,fp)=>{const next={...read(),[key]:fp};const tmp=file+'.tmp';try{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(tmp,storage.encryptString(JSON.stringify(next)),{mode:0o600});fs.renameSync(tmp,file);trusted=next}finally{fs.rmSync(tmp,{force:true})}onTrust()}
 const progress=(s,phase,role,extra={})=>send('bastions:progress',{attemptId:s.id,serverId:s.target.id,phase,role,...extra})
 function stop(s,reason='bastion.cancelled'){
  if(s.closed)return;s.closed=true;clearTimeout(s.permissionTimer)
  for(const [id,c]of challenges)if(c.session===s){clearTimeout(c.timer);challenges.delete(id);c.reject(Error(reason));send('bastions:challenge-closed',{id})}
  for(const reject of s.waiters)reject(Error(reason));s.waiters.clear()
  for(const client of [...s.clients].reverse()){try{client.end();client.destroy()}catch{}}
  for(const ch of s.channels){try{ch.destroy()}catch{}}sessions.delete(s.id);progress(s,reason==='bastion.cancelled'?'cancelled':'closed',null,{code:reason})
 }
 function ask(s,role,type,data){
  if(s.closed)return Promise.reject(Error('bastion.cancelled'))
  return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{challenges.delete(id);send('bastions:challenge-closed',{id});reject(Error('bastion.prompt_expired'))},promptTimeout);challenges.set(id,{session:s,timer,reject,resolve});send('bastions:challenge',{id,attemptId:s.id,serverId:s.target.id,role,type,endpoint:role==='bastion'?s.bastion.host:s.target.host,...data})})
 }
 function response(id,value){const c=challenges.get(id);if(!c)fail('bastion.expired_challenge');if(!value||typeof value!=='object')fail('bastion.invalid_response');if(value.accept!==true){clearTimeout(c.timer);challenges.delete(id);c.reject(Error('bastion.cancelled'));return}if(value.responses!==undefined&&(!Array.isArray(value.responses)||value.responses.length>10||value.responses.some(v=>typeof v!=='string'||v.length>4096)))fail('bastion.invalid_response');clearTimeout(c.timer);challenges.delete(id);c.resolve(value)}
 async function dial(s,record,role,sock){
  if(s.closed)fail('bastion.cancelled');s.role=role;progress(s,'connecting',role)
  const auth=await credentials(record);if(s.closed)fail('bastion.cancelled')
  try{
   if(auth.privateKey){let parsed=utils.parseKey(auth.privateKey,auth.passphrase);if(parsed instanceof Error){if(/encrypted|passphrase|decrypt/i.test(parsed.message)){const a=await ask(s,role,'authentication',{instructions:'bastion.passphrase',prompts:[{prompt:'bastion.passphrase',echo:false}]});auth.passphrase=a.responses?.[0];parsed=utils.parseKey(auth.privateKey,auth.passphrase)}if(parsed instanceof Error)fail('bastion.invalid_key')}}
   return await new Promise((resolveDial,rejectDial)=>{
    const client=new Client();s.clients.push(client);let settled=false,timer,interactive=0
    const reject=e=>{clearTimeout(timer);if(!settled){settled=true;s.waiters.delete(reject);rejectDial(e)}};s.waiters.add(reject)
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{reject(Error('bastion.timeout'));client.destroy()},networkTimeout)}
    const interact=async(type,data)=>{clearTimeout(timer);try{const result=await ask(s,role,type,data);if(s.closed)fail('bastion.cancelled');arm();return result}catch(e){reject(e);client.destroy();throw e}}
    client.on('error',e=>{if(e.level==='agent')return;if(settled)stop(s,'bastion.connection_lost');else reject(Error(e.level==='client-authentication'?'bastion.authentication_failed':'bastion.connection_failed'))})
    client.on('close',()=>{clearTimeout(timer);if(!settled)reject(Error('bastion.connection_closed'));if(!s.closed)stop(s,'bastion.connection_lost')})
    client.on('ready',()=>{clearTimeout(timer);if(s.closed){client.destroy();return}settled=true;s.waiters.delete(reject);progress(s,'authenticated',role);resolveDial(client)})
    client.on('keyboard-interactive',(_name,instructions,_lang,prompts,finish)=>{
     if(++interactive>5||prompts.length>10||prompts.some(p=>typeof p.prompt!=='string'||p.prompt.length>2000)){reject(Error('bastion.authentication_failed'));client.destroy();return}
     interact('authentication',{instructions:String(instructions||'').slice(0,4000),prompts:prompts.map(p=>({prompt:p.prompt,echo:!!p.echo}))}).then(a=>{if(!Array.isArray(a.responses)||a.responses.length!==prompts.length)throw Error('bastion.invalid_response');finish(a.responses)}).catch(()=>client.destroy())
    })
    const used=new Set()
    const authHandler=(methods,_partial,callback)=>{
     if(s.closed){callback(false);return}
     if(!used.has('none')){used.add('none');callback('none');return}
     if(!Array.isArray(methods)){callback(false);return}
     for(const [method,available,serverMethod]of [['publickey',!!auth.privateKey,'publickey'],['agent',!!auth.agent,'publickey'],['password',!!auth.password,'password'],['keyboard-interactive',true,'keyboard-interactive']]){
      if(available&&methods.includes(serverMethod)&&!used.has(method)){used.add(method);callback(method);return}
     }
     if(methods.includes('password')&&!used.has('manual-password')){used.add('manual-password');interact('authentication',{instructions:'bastion.password_note',prompts:[{prompt:'bastion.password',echo:false}]}).then(a=>{if(!s.closed&&a.responses?.length===1)callback({type:'password',username:record.user,password:a.responses[0]});else callback(false)}).catch(()=>{if(!s.closed)callback(false)});return}
     callback(false)
    }
    arm();client.connect({authHandler,host:record.host.replace(/^\[|\]$/g,''),port:+record.port,username:record.user,sock,password:auth.password,privateKey:auth.privateKey,passphrase:auth.passphrase,agent:auth.agent,agentForward:false,tryKeyboard:true,readyTimeout:0,keepaliveInterval:15000,keepaliveCountMax:3,hostHash:'sha256',hostVerifier:(fp,verify)=>{
     const key=JSON.stringify([role,identity(record),role==='target'?identity(s.bastion):''])
     let known;try{known=read()[key]}catch(e){reject(e);verify(false);return}
     if(known){if(known!==fp)reject(Error('bastion.hostkey_changed'));verify(known===fp);return}
     interact('trust',{fingerprint:'SHA256:'+Buffer.from(fp,'hex').toString('base64').replace(/=+$/,'')}).then(()=>{try{if(s.closed)fail('bastion.cancelled');trust(key,fp);verify(true)}catch(e){reject(e);verify(false)}}).catch(()=>verify(false))
    }})
   })
  }finally{auth.password='';auth.privateKey='';auth.passphrase=''}
 }
 async function freshPlan(target){await authorize();const plan=await resolve(target);if(!plan?.bastion)fail('bastion.missing');validate(plan.target,[plan.bastion]);return plan}
 async function open(target,{test=false,attemptId,ticket}={}){
  if(ticket?.cancelled)fail('bastion.cancelled')
  const id=attemptId||crypto.randomUUID();if(typeof id!=='string'||id.length>128||sessions.has(id))fail('bastion.invalid_attempt')
  // Register before asynchronous resolution: cancellation and revocation also cover pending authentication.
  const s={id,target,started:Date.now(),clients:[],channels:[],waiters:new Set(),closed:false};sessions.set(id,s);progress(s,'validating',null)
  try{
   const plan=await freshPlan(target);if(s.closed)fail('bastion.cancelled');s.target=plan.target;s.bastion=plan.bastion
   s.permissionTimer=setTimeout(()=>stop(s,'bastion.authorization_expired'),permissionTTL)
   const refresh=async()=>{if(s.closed||s.rechecking)return;s.rechecking=true;try{const fresh=await freshPlan(target);if(s.closed)return;if(identity(fresh.target)!==identity(s.target)||identity(fresh.bastion)!==identity(s.bastion))fail('bastion.route_changed');clearTimeout(s.permissionTimer);s.permissionTimer=setTimeout(()=>stop(s,'bastion.authorization_expired'),permissionTTL)}catch{stop(s,'bastion.access_denied')}finally{s.rechecking=false}}
   s.recheck=setInterval(refresh,Math.max(1000,Math.floor(permissionTTL/2)));s.recheck.unref?.()
   // The permission TTL also bounds a pending prompt. Refresh is independent of user interaction.
   const gateway=await dial(s,s.bastion,'bastion');if(s.closed)fail('bastion.cancelled');progress(s,'opening_channel','bastion')
   const channel=await new Promise((ok,no)=>{const timer=setTimeout(()=>{s.waiters.delete(reject);no(Error('bastion.timeout'))},networkTimeout);const reject=e=>{clearTimeout(timer);no(e)};s.waiters.add(reject);gateway.forwardOut('127.0.0.1',0,s.target.host.replace(/^\[|\]$/g,''),+s.target.port,(e,ch)=>{clearTimeout(timer);s.waiters.delete(reject);if(e){no(Error('bastion.channel_refused'));return}if(s.closed){ch.destroy();no(Error('bastion.cancelled'));return}s.channels.push(ch);ok(ch)})})
   const client=await dial(s,s.target,'target',channel)
   if(test){progress(s,'checking_sftp','target');await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('bastion.sftp_unavailable')),networkTimeout);const reject=e=>{clearTimeout(timer);no(e)};s.waiters.add(reject);client.sftp((e,ftp)=>{clearTimeout(timer);s.waiters.delete(reject);ftp?.end();if(s.closed)no(Error('bastion.cancelled'));else e?no(Error('bastion.sftp_unavailable')):ok()})});progress(s,'ready','target');stop(s,'bastion.test_complete');return{ok:true}}
   client.routeAttemptId=id;client.connectMs=Date.now()-s.started;client.routeDescription={bastionId:s.bastion.id,name:s.bastion.name};s.ready=true;progress(s,'ready','target',{bastionName:s.bastion.name});return client
  }catch(e){const code=e.message?.startsWith('bastion.')||['secure_storage_unavailable'].includes(e.message)?e.message:'bastion.access_denied';progress(s,'failed',s.role||null,{code});stop(s,code);throw Error(code)}
 }
 // Always clean up periodic authorization checks, including stop paths before a socket exists.
 const originalStop=stop;stop=(s,reason)=>{clearInterval(s.recheck);originalStop(s,reason)}
 return{open,begin:serverId=>{const ticket={serverId,cancelled:false};requests.add(ticket);return ticket},finish:ticket=>requests.delete(ticket),async forgetTrust(target,confirmation){const plan=await freshPlan(target);if(confirmation!==plan.target.host)fail('bastion.invalid_response');const next={...read()};delete next[JSON.stringify(['bastion',identity(plan.bastion),''])];delete next[JSON.stringify(['target',identity(plan.target),identity(plan.bastion)])];const tmp=file+'.tmp';try{fs.writeFileSync(tmp,storage.encryptString(JSON.stringify(next)),{mode:0o600});fs.renameSync(tmp,file);trusted=next}finally{fs.rmSync(tmp,{force:true})}for(const session of sessions.values())if(session.target.id===target.id)stop(session,'bastion.route_changed')},cancelPending:serverId=>{for(const ticket of requests)if(ticket.serverId===serverId)ticket.cancelled=true;for(const s of sessions.values())if(s.target.id===serverId&&!s.ready)stop(s)},respond:response,cancel:id=>{const s=sessions.get(id);if(s)stop(s)},closeAll:()=>{for(const ticket of requests)ticket.cancelled=true;for(const s of sessions.values())stop(s,'bastion.access_denied')},closeDependency:(id,vaultId)=>{for(const s of sessions.values())if([s.target,s.bastion].some(r=>r&&(r.id===id||vaultId&&r.vaultId===vaultId)))stop(s,'bastion.access_denied')},active:()=>sessions.size}
}
module.exports={access,endpoint,validate,identity,createRoutes}
