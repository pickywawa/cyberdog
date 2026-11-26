let accountState={configured:false,signedIn:false,email:null,teams:[],servers:[],assets:[],invitations:[]}
const accountViews=new Set()
function paintAccountButton(){
 const button=$('#btn-account')
 if(!button)return
 button.textContent=t(accountState.signedIn?'account.button':'account.connect')
 button.classList.toggle('signed-in',!!accountState.signedIn)
 button.title=accountState.email||t('account.connect')
}
function updateAccount(state){
 accountState=state
 paintAccountButton()
 for(const view of accountViews){if(view.element.isConnected)view.paint()}
}
api.on('teams:changed',updateAccount)
api.on('servers:changed',items=>{servers=items;renderServers()})
api.on('invite:received',link=>joinFromLink(link))
const accountErrorKey=name=>({network:'account.network',secure_storage_unavailable:'account.secure',rate_limited:'account.rate',invitation_unavailable:'team.invite_unavailable',already_member:'team.already_member',invite_limit:'team.invite_limit'})[name]||(['auth_required','access_denied','admin_required','owner_required','server_write_required'].includes(name)?'account.denied':'account.error')
async function joinFromLink(link){
 if(!accountState.signedIn){toast(t('team.join_signin'),true);openSettingsModal('account');return}
 const value=link||(await modal(t('team.join'),[{name:'link',label:t('team.link_label'),placeholder:'cyberdog://invite/…'}],t('team.join_ok')))?.link
 if(!value)return
 try{const state=await api.invoke('teams:action','invite_link_accept',{token:value});updateAccount(state);toast(t('team.joined'))}catch(e){toast(t(accountErrorKey(e.message)),true)}
}
function buildTeamsPage(owner){
 const element=h('div',{className:'account-page'})
 let busy=false,message='',selected='',details=null,links=[]
 const content=h('div',{className:'account-content'}),error=h('p',{className:'err',role:'alert'})
 element.append(content,error)
 const button=(label,fn,cls='chip')=>h('button',{type:'button',className:cls,textContent:t(label),disabled:busy,onclick:fn})
 const fail=e=>{message=t(accountErrorKey(e.message))}
 const loadDetails=async team=>{
  details=await api.invoke('teams:action','details',{teamId:team.id})
  links=['owner','admin'].includes(team.role)?await api.invoke('teams:action','invite_link_list',{teamId:team.id}):[]
 }
 async function run(work){
  if(busy)return;busy=true;message='';paint()
  try{await work()}catch(e){fail(e)}finally{busy=false;paint()}
 }
 const act=(action,payload)=>run(async()=>{
  const result=await api.invoke('teams:action',action,payload)
  updateAccount(result)
  const team=result.teams.find(team=>team.id===selected)
  if(team)await loadDetails(team);else{selected='';details=null;links=[]}
 })
 const askName=async(action,team)=>{const value=await modal(t(action==='create_team'?'team.create':'team.rename'),[{name:'name',label:t('team.name'),value:team?.name}],t('btn.save'));if(value)act(action,{...value,teamId:team?.id})}
 const confirmAct=(action,payload)=>{if(confirm(t('team.confirm')))act(action,payload)}
 const createLink=team=>run(async()=>{
  const value=await modal(t('team.invite_link'),[{name:'uses',label:t('team.link_uses'),value:'1'}],t('team.invite_link'))
  if(!value)return
  const uses=Math.min(50,Math.max(1,parseInt(value.uses,10)||1))
  const created=await api.invoke('teams:action','invite_link_create',{teamId:team.id,uses})
  try{await navigator.clipboard.writeText(created.link);toast(t('team.link_copied'))}catch{}
  links=await api.invoke('teams:action','invite_link_list',{teamId:team.id})
  await modal(t('team.invite_link'),[{name:'link',label:t('team.link_ready'),value:created.link,readOnly:true}],t('dialog.close'))
 })
 function paint(){
  const a=accountState;content.replaceChildren();error.textContent=message;error.hidden=!message
  if(!a.signedIn)return
  content.append(h('div',{className:'team-heading'},h('h3',{textContent:t('team.title')}),h('div',{className:'chips'},button('team.join',()=>joinFromLink(),'chip'),button('team.create',()=>askName('create_team'),'primary'))))
  content.append(button('history.personal',()=>showServerHistory({teamId:a.personalSpaceId})))
  if(a.invitations.length){content.append(h('h4',{textContent:t('team.invitations')}));for(const i of a.invitations)content.append(h('div',{className:'team-member'},h('span',{textContent:i.name}),button('team.accept',()=>act('accept_invite',{id:i.id}))))}
  if(!a.teams.length)content.append(h('p',{className:'dim',textContent:t('team.empty')}))
  const cards=h('div',{className:'team-cards'})
  for(const team of a.teams)cards.append(h('button',{type:'button',className:'team-card'+(selected===team.id?' selected':''),disabled:busy,onclick:()=>{selected=team.id;details=null;links=[];run(()=>loadDetails(team))}},h('strong',{textContent:team.name}),h('small',{className:'dim',textContent:t('team.'+team.role)})))
  content.append(cards)
  const team=a.teams.find(t=>t.id===selected)
  if(!team)return
  const admin=['owner','admin'].includes(team.role),owner=team.role==='owner'
  const section=h('section',{className:'team-details'},h('h4',{textContent:team.name}),h('p',{className:'dim',textContent:t('team.permissions')}))
  content.append(section)
  if(!details){section.append(h('p',{textContent:t('team.loading')}));return}
  const actions=h('div',{className:'chips'},button('history.title',()=>showServerHistory({teamId:team.id})))
  if(admin){actions.append(button('team.invite_link',()=>createLink(team)),button('team.rename',()=>askName('rename_team',team)))}
  actions.append(owner?button('team.delete',()=>confirmAct('delete_team',{teamId:team.id})):button('team.leave',()=>confirmAct('leave_team',{teamId:team.id})))
  section.append(actions,h('h4',{textContent:t('team.members')}))
  for(const member of details.members||[]){
   const row=h('div',{className:'team-member'},h('div',{className:'team-member-identity'},h('span',{textContent:member.email}),h('small',{className:'dim',textContent:member.id})))
   if(owner&&member.role!=='owner'){
    const select=h('select',{className:'lsel',ariaLabel:member.email+' · '+t('team.members'),disabled:busy},...['member','admin'].map(role=>h('option',{value:role,textContent:t('team.'+role)})));select.value=member.role;select.onchange=()=>act('set_role',{teamId:team.id,userId:member.id,role:select.value});row.append(select,button('team.transfer',()=>confirmAct('transfer_owner',{teamId:team.id,userId:member.id})))
   }else row.append(h('small',{className:'dim',textContent:t('team.'+member.role)}))
   if(owner&&member.role!=='owner'){
    const permission=h('select',{className:'lsel',ariaLabel:member.email+' · '+t('team.server_permission'),disabled:busy},h('option',{value:'read',textContent:t('team.read_only')}),h('option',{value:'write',textContent:t('team.write')}));permission.value=member.canEditServers?'write':'read';permission.onchange=()=>act('set_server_permission',{teamId:team.id,userId:member.id,canEditServers:permission.value==='write'});row.append(h('label',{className:'member-server-permission'},t('team.server_permission'),permission))
   }else if(member.role!=='owner')row.append(h('small',{className:'dim',textContent:t(member.canEditServers?'team.write':'team.read_only')}))
   if(admin&&member.role!=='owner'&&(owner||member.role==='member'))row.append(button('team.remove',()=>confirmAct('remove_member',{teamId:team.id,userId:member.id})))
   section.append(row)
  }
  if(admin){
   section.append(h('p',{className:'note',textContent:t('team.invite_note')}))
   for(const link of links)section.append(h('div',{className:'team-member'},h('span',{textContent:t('team.link_pending',{n:link.usesLeft})}),h('small',{className:'dim',textContent:new Date(link.expiresAt).toLocaleDateString(lang)}),button('team.cancel',()=>run(async()=>{await api.invoke('teams:action','invite_link_revoke',{teamId:team.id,id:link.id});links=await api.invoke('teams:action','invite_link_list',{teamId:team.id})}))))
  }
 }
 accountViews.add({element,paint,owner});paint()
 api.invoke('teams:status').then(updateAccount).catch(fail).finally(paint)
 return element
}

// Settings → Connexion: sign in / create an account, then manage teams.
function buildAccountSettings(){
 const element=h('div',{className:'account-settings'})
 let busy=false,message='',mode='signin',notice=''
 const email=h('input',{type:'email',autocomplete:'email',placeholder:t('account.email'),ariaLabel:t('account.email')})
 const password=h('input',{type:'password',autocomplete:'current-password',placeholder:t('account.password'),ariaLabel:t('account.password')})
 const confirm=h('input',{type:'password',autocomplete:'new-password',placeholder:t('account.password_confirm'),ariaLabel:t('account.password_confirm')})
 const code=h('input',{type:'text',inputMode:'numeric',autocomplete:'one-time-code',maxLength:6,pattern:'[0-9]{6}',placeholder:'000000',ariaLabel:t('account.code')})
 const content=h('div',{className:'account-content'}),error=h('p',{className:'err',role:'alert'}),info=h('p',{className:'dim',role:'status'})
 element.append(content,info,error)
 const button=(label,fn,cls='chip',disabled=false)=>h('button',{type:'button',className:cls,textContent:t(label),disabled:busy||disabled,onclick:fn})
 // Password field with a show/hide eye. Always starts hidden again after any repaint of the form.
 const secret=(input,label)=>{
  const eye=h('button',{type:'button',className:'ib password-eye',tabIndex:0,disabled:busy})
  const show=visible=>{input.type=visible?'text':'password';eye.innerHTML=icon(visible?'eye-off':'eye');eye.ariaPressed=String(visible);eye.ariaLabel=t(visible?'account.hide_password':'account.show_password');eye.title=eye.ariaLabel}
  eye.onclick=()=>show(input.type==='password');show(false)
  return h('label',{className:'account-field'},label,h('span',{className:'password-wrap'},input,eye))
 }
 const hide=()=>{for(const i of [password,confirm])i.type='password'}
 const known=['invalid_credentials','email_taken','weak_password','invalid_email','email_not_confirmed','signup_disabled','network','rate_limited','secure_storage_unavailable','unconfigured','otp_invalid','otp_expired','mfa_required','password_mismatch']
 const fail=e=>{message=t(known.includes(e.message)?'account.err.'+e.message:'account.err.unknown')}
 async function run(work){
  if(busy)return;busy=true;message='';notice='';paint()
  try{await work()}catch(e){fail(e)}finally{busy=false;paint()}
 }
 const submit=()=>run(async()=>{
  if(mode==='signup'&&password.value!==confirm.value)throw Error('password_mismatch')
  const result=await api.invoke(mode==='signup'?'account:sign-up':'account:sign-in',{email:email.value,password:password.value})
  password.value='';confirm.value='';hide();code.value='';updateAccount(result)
 })
 const verify=()=>run(async()=>{const result=await api.invoke('account:verify-code',{code:code.value});code.value='';updateAccount(result)})
 const resend=()=>run(async()=>{updateAccount(await api.invoke('account:resend-code'));notice=t('account.code_resent')})
 const cancel=()=>run(async()=>{code.value='';updateAccount(await api.invoke('account:cancel-pending'))})
 async function deleteAccount(){if(busy||!confirm(t('account.delete_confirm',{email:accountState.email||''})))return;busy=true;message='';paint()
  try{updateAccount(await api.invoke('account:delete'));notice=t('account.deleted')}catch(e){message=t(e.message==='transfer_ownership_first'?'account.err.delete_owner':accountErrorKey(e.message))}finally{busy=false;paint()}}
 async function signOut(){if(busy)return;busy=true;paint();try{updateAccount(await api.invoke('account:sign-out'))}catch{message=t('account.err.unknown')}finally{busy=false;paint()}}
 const enter=event=>{if(event.key==='Enter'){event.preventDefault();accountState.pending?verify():submit()}}
 email.onkeydown=enter;password.onkeydown=enter;confirm.onkeydown=enter;code.onkeydown=enter
 code.oninput=()=>{code.value=code.value.replace(/\D/g,'').slice(0,6)}
 let teams=null
 function paint(){
  const a=accountState;content.replaceChildren();error.textContent=message;error.hidden=!message;info.textContent=notice;info.hidden=!notice
  if(a.signedIn){
   content.append(h('div',{className:'account-identity',role:'status'},h('strong',{textContent:t('account.signed_in')}),h('span',{textContent:a.email||''}),button('account.sign_out',signOut),button('account.delete',deleteAccount,'chip danger')))
   teams||=buildTeamsPage(element);content.append(teams)
   return
  }
  if(a.pending){
   // Second step: a 6-digit code e-mailed by Supabase. The server decides whether it is right.
   const signup=a.pending.kind==='signup';code.disabled=busy
   content.append(h('p',{className:'dim',textContent:t(signup?'account.code_signup':'account.code_login')}),h('strong',{textContent:a.pending.email||''}),h('label',{className:'account-field'},t('account.code'),code))
   content.append(h('div',{className:'chips'},button('account.verify',verify,'primary'),button('account.resend',resend),button('btn.cancel',cancel)))
   return
  }
  email.disabled=busy;password.disabled=busy;confirm.disabled=busy;hide();password.autocomplete=mode==='signup'?'new-password':'current-password'
  content.append(h('p',{className:'dim',textContent:t('account.intro')}),h('label',{className:'account-field'},t('account.email'),email),secret(password,t(mode==='signup'?'account.password_new':'account.password')))
  if(mode==='signup')content.append(secret(confirm,t('account.password_confirm')))
  content.append(h('div',{className:'chips'},button(mode==='signup'?'account.sign_up':'account.sign_in',submit,'primary',a.configured===false),button(mode==='signup'?'account.have_account':'account.no_account',()=>{mode=mode==='signup'?'signin':'signup';message='';notice='';password.value='';confirm.value='';paint()},'chip')))
  content.append(h('small',{className:'dim',textContent:t('account.privacy')}))
 }
 accountViews.add({element,paint});paint()
 api.invoke('teams:status').then(updateAccount).catch(()=>{message=t('account.err.unknown');paint()})
 return element
}
