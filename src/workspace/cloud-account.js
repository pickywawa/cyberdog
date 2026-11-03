// Cloud access uses a Supabase Auth session. The server derives the acting identity from the access token,
// never from anything the client claims about itself.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const INVITE_RE=/^[A-Za-z0-9_-]{43}$/
function parseInvite(value){
 const text=String(value||'').trim(),token=text.startsWith('cyberdog://')?text.replace(/^cyberdog:\/\/invite\//,'').replace(/[/?#].*$/,''):text
 if(!INVITE_RE.test(token))throw Error('invitation_unavailable')
 return token
}
function createCloudAccount({config,fetch,safeStorage,directory,onChange=()=>{}}){
 const file=path.join(directory,'account-session.bin'),credentialsFile=path.join(directory,'team-credentials.bin'),previewFile=path.join(directory,'cloud-server-names.bin')
 let session=null,profile=null,initialized=null,queue=Promise.resolve(),lastError=null,preview=[]
 const previewOwner=()=>session?crypto.createHash('sha256').update(session.userId).digest('hex'):null
 const clearPreview=()=>{preview=[];write(previewFile,null)}
 let catalog={teams:[],servers:[],invitations:[]}
 const configured=!!(config?.supabaseUrl&&config?.supabaseAnonKey)
 const secure=()=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('secure_storage_unavailable')}
 const read=p=>{if(!fs.existsSync(p))return null;secure();return JSON.parse(safeStorage.decryptString(fs.readFileSync(p)))}
 const write=(p,value)=>{if(value===null){fs.rmSync(p,{force:true});return}secure();fs.mkdirSync(directory,{recursive:true});const temp=p+'.tmp';try{fs.writeFileSync(temp,safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});fs.renameSync(temp,p)}finally{fs.rmSync(temp,{force:true})}}
 const state=()=>({configured,signedIn:!!session,email:session?.email||null,userId:session?.userId||null,error:lastError,...catalog})
 const emit=()=>{onChange(state());return state()}
 const empty=()=>{profile=null;catalog={teams:[],servers:[],invitations:[]}}
 const drop=()=>{session=null;empty();clearPreview();write(file,null)}
 async function auth(endpoint,body,token){
  let r;try{r=await fetch(config.supabaseUrl+'/auth/v1/'+endpoint,{method:'POST',headers:{apikey:config.supabaseAnonKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body||{}),signal:AbortSignal.timeout(30000)})}catch{throw Error('network')}
  const data=await r.json().catch(()=>({}))
  if(!r.ok)throw Error(authError(r.status,data))
  return data
 }
 const storeSession=data=>{
  if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||typeof data.user?.id!=='string')throw Error('network')
  session={accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+(Number(data.expires_in)||3600)*1000,userId:data.user.id,email:String(data.user.email||'').toLowerCase()}
  write(file,session)
 }
 async function token(force=false){
  if(!session)throw Error('auth_required')
  if(!force&&session.expiresAt-60000>Date.now())return session.accessToken
  try{storeSession(await auth('token?grant_type=refresh_token',{refresh_token:session.refreshToken}))}
  catch(e){if(e.message==='auth_required'){drop();emit()}throw e}
  return session.accessToken
 }
 async function request(action,payload={}){
  if(!configured)throw Error('unconfigured')
  for(let attempt=0;attempt<2;attempt++){
   let bearer;try{bearer=await token(attempt>0)}catch(e){lastError=['network','rate_limited'].includes(e.message)?e.message:'auth_required';throw e}
   let r;try{r=await fetch(config.supabaseUrl+'/functions/v1/cyberdog-cloud',{method:'POST',headers:{apikey:config.supabaseAnonKey,Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify({action,payload}),signal:AbortSignal.timeout(30000)})}catch{lastError='network';throw Error('network')}
   const data=await r.json().catch(()=>({}))
   if(r.status===401&&attempt===0)continue
   if(!r.ok){lastError=ERRORS.has(data.error)?data.error:'network';if(lastError==='auth_required'){drop();emit()}throw Error(lastError)}
   lastError=null;return data
  }
 }
 async function refresh(){
  if(!session)return emit()
  try{
   profile=(await request('status')).value
   catalog=(await request('list')).value;preview=[]
   write(previewFile,{owner:previewOwner(),servers:catalog.servers.map(({id,name,teamId})=>({id,name,teamId}))})
   return emit()
  }catch(e){emit();throw e}
 }
 const exclusive=work=>{const next=queue.then(work);queue=next.catch(()=>{});return next}
 const mergeSecrets=fresh=>{const local=(read(credentialsFile)||{})[credentialId(fresh)]||{},merged={...fresh,...local,authMode:local.authMode||(local.key?'key':fresh.authMode),syncedCredential:fresh.syncedCredential};if(fresh.syncedCredential){merged.authMode=fresh.authMode;delete merged.pass;delete merged.key;delete merged.keyData}return merged}
 const credentialId=s=>JSON.stringify([session?.userId,s.id,s.host,s.port,s.user])
 const credentials=value=>{
  const email=String(value?.email||'').trim().toLowerCase(),password=String(value?.password||'')
  if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)throw Error('invalid_email')
  if(password.length<8||password.length>256)throw Error('weak_password')
  return{email,password}
 }
 return{
  state,
  previews:()=>preview.map(s=>({...s})),
  localAuth(s){try{const local=(read(credentialsFile)||{})[credentialId(s)]||{};return s.hasSyncedCredential?{}:{authMode:local.authMode||(local.key?'key':s.authMode),hasStoredKey:!!local.keyData}}catch{return {}}},
  localKey(s){try{return (read(credentialsFile)||{})[credentialId(s)]?.key||undefined}catch{return undefined}},
  hasPassword(s){try{return !!(read(credentialsFile)||{})[credentialId(s)]?.pass}catch{return false}},
  async init(){if(!initialized)initialized=(async()=>{try{session=read(file);if(session&&(typeof session.userId!=='string'||typeof session.refreshToken!=='string'))session=null;try{const cached=read(previewFile);if(session&&cached?.owner===previewOwner()&&Array.isArray(cached.servers))preview=cached.servers.filter(s=>typeof s.id==='string'&&typeof s.name==='string'&&typeof s.teamId==='string').map(({id,name,teamId})=>({id,name,teamId}))}catch{}await refresh()}catch{emit()}})();await initialized;return state()},
  signIn(value){return exclusive(async()=>{
   if(!configured)throw Error('unconfigured');secure();const input=credentials(value);lastError=null
   storeSession(await auth('token?grant_type=password',input));empty()
   try{await refresh()}catch{}
   return state()
  })},
  signUp(value){return exclusive(async()=>{
   if(!configured)throw Error('unconfigured');secure();const input=credentials(value);lastError=null
   const data=await auth('signup',input)
   // With e-mail confirmation enabled Supabase returns no session yet.
   if(!data.access_token)return{...state(),confirmEmail:true}
   storeSession(data);empty()
   try{await refresh()}catch{}
   return state()
  })},
  signOut(){return exclusive(async()=>{
   if(session){try{await auth('logout',{},session.accessToken)}catch{}}
   drop();lastError=null;return emit()
  })},
  refresh:()=>exclusive(refresh),
  async action(action,payload){return exclusive(async()=>{
   if(!ACTIONS.has(action))throw Error('unknown_action')
   const body=action==='invite_link_accept'?{token:parseInvite(payload?.token)}:payload
   const value=(await request(action,body)).value
   if(VALUE_ACTIONS.has(action))return value
   await refresh();return state()
  })},
  async getServer(id){return exclusive(async()=>{const s=catalog.servers.find(s=>s.id===id);if(!s)throw Error('access_denied');const fresh=(await request('server_get',{id,teamId:s.teamId,routeVersion:1})).value;return mergeSecrets(fresh)})},
  async getRoute(id){return exclusive(async()=>{const s=catalog.servers.find(s=>s.id===id);if(!s)throw Error('access_denied');const plan=(await request('route_get',{id,teamId:s.teamId})).value;return{target:mergeSecrets(plan.target),bastion:mergeSecrets(plan.bastion)}})},
  async getRouteForDraft(draft){const b=await this.getServer(draft.networkAccess.bastionId);if(b.teamId!==draft.teamId)throw Error('bastion.scope');let target=draft;if(catalog.servers.some(s=>s.id===draft.id)){const source=await this.getServer(draft.id);if(['host','port','user'].every(k=>String(source[k])===String(draft[k])))target={...source,...draft}}return{target,bastion:b}},
  saveCredentials(s,patch){if(!session)throw Error('auth_required');const records=read(credentialsFile)||{};records[credentialId(s)]={...records[credentialId(s)],...patch};write(credentialsFile,records)},
  async saveAsset(data){return exclusive(async()=>{const result=(await request('asset_save',data)).value;await refresh();return result})},
  async getAsset(id){return exclusive(async()=>{const a=catalog.assets?.find(a=>a.id===id);if(!a)throw Error('access_denied');return(await request('asset_get',{id,teamId:a.teamId})).value})},
  async saveServer(data){return exclusive(async()=>{const result=(await request('server_save',data)).value;await refresh();return result})},
 }
}
function authError(status,data){
 const code=String(data.error_code||data.code||data.error||'')
 if(status===429||/rate_limit/.test(code))return 'rate_limited'
 if(status>=500)return 'network'
 if(code==='invalid_credentials'||code==='invalid_grant')return 'invalid_credentials'
 if(code==='user_already_exists'||code==='email_exists')return 'email_taken'
 if(code==='weak_password')return 'weak_password'
 if(code==='email_not_confirmed')return 'email_not_confirmed'
 if(code==='signup_disabled'||code==='email_provider_disabled')return 'signup_disabled'
 if(/email_address_invalid|validation_failed/.test(code))return 'invalid_email'
 if(['refresh_token_not_found','refresh_token_already_used','session_not_found','session_expired','bad_jwt'].includes(code)||status===401)return 'auth_required'
 return 'unknown'
}
const ACTIONS=new Set(['create_team','accept_invite','details','leave_team','invite','revoke_invite','remove_member','set_role','set_server_permission','transfer_owner','rename_team','delete_team','server_delete','asset_get','asset_delete','history_list','history_restore','invite_link_create','invite_link_list','invite_link_revoke','invite_link_accept'])
const VALUE_ACTIONS=new Set(['details','asset_get','history_list','invite_link_create','invite_link_list'])
const ERRORS=new Set(['bastion.invalid_route','bastion.missing','bastion.scope','bastion.chain','bastion.in_use','bastion.route_unsupported','unconfigured','access_denied','auth_required','admin_required','owner_required','server_write_required','invalid_permission','invalid_name','invalid_recipient','already_member','invalid_role','invalid_server','invalid_server_options','invalid_credential','credential_sync_unavailable','invalid_asset','invalid_group','group_in_use','secrets_forbidden','invitation_unavailable','invalid_invite_link','transfer_ownership_first','team_limit','invite_limit','network','rate_limited'])
module.exports={createCloudAccount,parseInvite}
