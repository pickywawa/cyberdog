// Shared metadata uses the licensed gateway; local entries remain independent.
function sharedLocationField(entry,preferred=''){
 const a=accountState,options=[['',t('space.local')],...(a.signedIn&&a.personalSpaceId?[[a.personalSpaceId,t('space.personal')]]:[]),...(a.teams||[]).filter(team=>team.role==='owner'||team.canEditServers||team.id===entry?.teamId).map(team=>[team.id,t('space.team',{name:team.name})])]
 const value=entry?.teamId||preferred
 return {name:'teamId',label:t('space.location'),type:'select',value:options.some(([id])=>id===value)?value:'',options}
}
function sharedScopeName(entry){return !entry.teamId?t('space.local'):entry.teamId===accountState.personalSpaceId?t('space.personal'):(accountState.teams||[]).find(team=>team.id===entry.teamId)?.name||t('team.title')}
function sharedVisible(entry,tab){return !entry.teamId||entry.teamId===accountState.personalSpaceId||entry.teamId===tab.server.teamId}
api.on('shared:changed',state=>{groups=state.groups;quickActions=state.actions;savedPaths=state.paths;renderServers();repaintActions();repaintPaths()})
async function showServerHistory(scope){
 const content=h('div',{className:'history-list'}),list=h('div'),status=h('p',{className:'dim',role:'status'}),more=h('button',{className:'chip',textContent:t('history.more')})
 const team=accountState.teams?.find(team=>team.id===scope.teamId),writable=scope.teamId===accountState.personalSpaceId||team?.role==='owner'||team?.canEditServers
 let before=null,busy=false
 content.append(h('p',{className:'dim',textContent:t('history.note')}),status,list,more)
 showAccountDialog(content,t('history.title'),'history-dialog')
 async function load(reset=false){
  if(busy)return;busy=true;more.disabled=true;status.textContent=t('team.loading')
  try{
   if(reset){before=null;list.replaceChildren()}
   const rows=await api.invoke('teams:action','history_list',{teamId:scope.teamId,...(scope.id?{id:scope.id}:{}),...(before?{before}: {})})
   for(const row of rows){const s=row.snapshot,card=h('article',{className:'history-entry'},h('strong',{textContent:s.name}),h('small',{className:'dim',textContent:new Date(row.at).toLocaleString()+' · '+t('history.'+row.operation)}),h('p',{textContent:row.actorEmail||t('history.unknown')}),...(row.actorId?[h('small',{className:'dim mono',textContent:row.actorId})]:[]),h('pre',{textContent:`${s.user}@${s.host}:${s.port}`}),...(s.group?[h('small',{className:'dim',textContent:t('f.group')+' : '+(groups.find(g=>g.id===s.group)?.name||s.group)})]:[]))
    if(writable)card.append(h('button',{className:'chip',textContent:t('history.restore'),onclick:async()=>{if(busy||!confirm(t('history.confirm')))return;busy=true;try{await api.invoke('teams:action','history_restore',{teamId:scope.teamId,versionId:row.id});busy=false;await load(true)}catch(e){status.textContent=errText(e)}finally{busy=false}}}))
    list.append(card)
   }
   before=rows.at(-1)?.sequence;more.hidden=rows.length<100;status.textContent=list.childElementCount?'':t('history.empty')
  }catch(e){status.textContent=errText(e)}finally{busy=false;more.disabled=false}
 }
 more.onclick=()=>load();await load()
}

async function beforeActionRun(action){return !action.teamId||!!await modal(t('shared.review'),[{name:'script',label:action.name,type:'textarea',value:action.script,readOnly:true}],t('qa.run'),{wide:true})}
function actionPayload(action){return action.teamId?{id:action.id,expectedScript:action.script}:action.script}
