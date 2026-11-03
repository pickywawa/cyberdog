// The Supabase Auth access token is the bearer credential. The gateway verifies it with Supabase Auth,
// derives the acting identity from it and never trusts a client-supplied user id, email or role.
export function createCloudHandler({env,fetcher=fetch,randomUUID=()=>crypto.randomUUID()}){
 const allowed=new Set(['status','list','create_team','accept_invite','details','leave_team','invite','revoke_invite','remove_member','set_role','set_server_permission','transfer_owner','rename_team','delete_team','route_get','server_get','server_save','server_delete','asset_get','asset_save','asset_delete','history_list','history_restore'])
 const linkActions=new Set(['invite_link_create','invite_link_list','invite_link_revoke','invite_link_accept'])
 const fail=(code,status=403)=>Object.assign(new Error(code),{status})
 return async req=>{
  const reply=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}})
  if(req.method!=='POST')return reply(405,{error:'method_not_allowed'})
  const service=env('SUPABASE_SERVICE_ROLE_KEY'),base=env('SUPABASE_URL')
  if(!service||!base)return reply(503,{error:'unconfigured'})
  const json=async(url,options)=>{let r;try{r=await fetcher(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error'})}catch{throw fail('network',503)}let data;try{data=r.status===204?null:await r.json()}catch{throw fail('network',503)}if(r.status===429)throw fail('rate_limited',429);if(r.status>=500)throw fail('network',503);return{ok:r.ok,data}}
  const rpc=async(name,body)=>{const r=await json(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw fail(SAFE_ERRORS.has(r.data?.message)?r.data.message:'access_denied');return r.data}
  const sha256=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('')
  try{
   const token=/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.get('authorization')||'')?.[1]
   if(!token)throw fail('auth_required',401)
   // Bound the streamed body before allocating it in memory.
   const reader=req.body?.getReader();if(!reader)throw fail('invalid_request',400)
   const chunks=[];let length=0
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>262144){await reader.cancel();throw fail('invalid_request',413)}chunks.push(value)}
   const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
   let body;try{body=JSON.parse(new TextDecoder().decode(bytes))}catch{throw fail('invalid_request',400)}
   const {action,payload:inputPayload={}}=body
   if(!inputPayload||typeof inputPayload!=='object'||Array.isArray(inputPayload)||Object.keys(inputPayload).some(k=>k.startsWith('_')||['credentialEnvelope','newServerId'].includes(k)))throw fail('invalid_request',400)
   let payload={...inputPayload}
   if(!allowed.has(action)&&!linkActions.has(action))throw fail('invalid_request',400)
   const user=await json(base+'/auth/v1/user',{headers:{apikey:service,Authorization:'Bearer '+token}})
   const authId=user.data?.id,email=user.data?.email
   if(!user.ok||typeof authId!=='string'||!/^[0-9a-f-]{36}$/i.test(authId)||typeof email!=='string'||!email)throw fail('auth_required',401)
   const identityId=await rpc('cyberdog_bind_auth',{auth_id:authId,email})
   if(linkActions.has(action)){
    const team=()=>{if(typeof payload.teamId!=='string'||!/^[0-9a-f-]{36}$/i.test(payload.teamId))throw fail('invalid_request',400);return payload.teamId}
    if(action==='invite_link_create'){
     const bytes=crypto.getRandomValues(new Uint8Array(32)),secret=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
     const value=await rpc('cyberdog_invite_link_create',{uid:identityId,tid:team(),hash:await sha256(secret),uses:Number.isInteger(payload.uses)?payload.uses:1})
     return reply(200,{value:{...value,token:secret,link:'cyberdog://invite/'+secret}})
    }
    if(action==='invite_link_list')return reply(200,{value:await rpc('cyberdog_invite_link_list',{uid:identityId,tid:team()})})
    if(action==='invite_link_revoke'){if(typeof payload.id!=='string'||!/^[0-9a-f-]{36}$/i.test(payload.id))throw fail('invalid_request',400);await rpc('cyberdog_invite_link_revoke',{uid:identityId,tid:team(),link_id:payload.id});return reply(200,{value:{ok:true}})}
    const secret=typeof payload.token==='string'?payload.token.trim():''
    if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw fail('invitation_unavailable')
    return reply(200,{value:await rpc('cyberdog_invite_link_accept',{uid:identityId,hash:await sha256(secret)})})
   }
   if(action==='server_save'){
    if(payload.authMode!==undefined&&!['password','key'].includes(payload.authMode))throw fail('invalid_credential',400)
    if(payload.syncCredentials!==undefined&&typeof payload.syncCredentials!=='boolean')throw fail('invalid_credential',400)
    if(payload.credentials!==undefined){
     if(payload.syncCredentials!==true||payload.credentials?.kind!==payload.authMode)throw fail('invalid_credential',400)
     const serverId=payload.id||randomUUID();if(!payload.id)payload._newServerId=serverId
     payload._credentialEnvelope=await encryptCredential(payload.credentials,serverId,env)
    }else if(payload.syncCredentials===false)payload._credentialEnvelope=null
    delete payload.credentials
   }else if('credentials' in payload)throw fail('invalid_request',400)
   const value=await rpc('cyberdog_member_action',{identity_id:identityId,action,payload})
   const reveal=async server=>{if(!server||typeof server!=='object')return;const envelope=server.credentialEnvelope;delete server.credentialEnvelope;if(envelope)server.syncedCredential=await decryptCredential(envelope,server.id,env)}
   if(action==='server_get')await reveal(value)
   if(action==='route_get'){await reveal(value.target);await reveal(value.bastion)}
   return reply(200,{value})
  }catch(e){
   return reply(e.status||503,{error:SAFE_ERRORS.has(e.message)?e.message:'network'})
  }
 }
}
const SAFE_ERRORS=new Set(['access_denied', 'admin_required', 'already_member', 'auth_required', 'bastion.chain', 'bastion.in_use', 'bastion.invalid_route', 'bastion.missing', 'bastion.route_unsupported', 'bastion.scope', 'credential_sync_unavailable', 'group_in_use', 'invalid_asset', 'invalid_credential', 'invalid_group', 'invalid_invite_link', 'invalid_name', 'invalid_permission', 'invalid_recipient', 'invalid_request', 'invalid_role', 'invalid_server', 'invalid_server_options', 'invitation_unavailable', 'invite_limit', 'network', 'owner_required', 'rate_limited', 'secrets_forbidden', 'server_write_required', 'team_limit', 'transfer_ownership_first'])

// AES-GCM key lives only in Edge Function secrets, never in the database or desktop.
function credentialKey(env){const hex=env('CYBERDOG_CREDENTIALS_KEY');if(!/^[a-f0-9]{64}$/i.test(hex||''))throw Error('credential_sync_unavailable');return crypto.subtle.importKey('raw',Uint8Array.from(hex.match(/../g),s=>parseInt(s,16)),'AES-GCM',false,['encrypt','decrypt'])}
const base64=bytes=>btoa(Array.from(new Uint8Array(bytes),n=>String.fromCharCode(n)).join(''))
const unbase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0))
export function validateCredential(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['password','key'].includes(value.kind))throw Error('invalid_credential')
 const field=value.kind==='password'?'password':'privateKey',text=value[field]
 if(Object.keys(value).some(k=>!['kind',field].includes(k))||typeof text!=='string'||!text.length||text.length>(value.kind==='password'?4096:65536)||text.includes('\0'))throw Error('invalid_credential')
 if(value.kind==='key'&&!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/m.test(text))throw Error('invalid_credential')
 return{kind:value.kind,[field]:text}
}
export async function encryptCredential(value,id,env){const plain=validateCredential(value),key=await credentialKey(env),iv=crypto.getRandomValues(new Uint8Array(12));return{v:1,iv:base64(iv),data:base64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('cyberdog-server:'+id)},key,new TextEncoder().encode(JSON.stringify(plain))))}}
export async function decryptCredential(envelope,id,env){try{if(envelope.v!==1||typeof envelope.iv!=='string'||typeof envelope.data!=='string'||envelope.data.length>100000)throw Error();const key=await credentialKey(env),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(envelope.iv),additionalData:new TextEncoder().encode('cyberdog-server:'+id)},key,unbase64(envelope.data));return validateCredential(JSON.parse(new TextDecoder().decode(plain)))}catch{throw Error('credential_sync_unavailable')}}
