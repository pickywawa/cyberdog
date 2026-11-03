const {access,validate}=require('./route')
function createConfigHooks(localServers,pins=()=>[]){return{
 prepareExport(data){const servers=[...data.servers];for(const s of data.servers){const r=access(s.networkAccess);if(r.mode!=='bastion')continue;const b=localServers().find(v=>v.id===r.bastionId);if(!b)throw Error('bastion.export_dependency');if(!servers.some(v=>v.id===b.id))servers.push(b)}for(const s of servers)validate(s,servers);return{...data,servers}},
 bundleOptions(data){const routed=data.servers.some(s=>access(s.networkAccess).mode==='bastion');return{version:routed?2:1,features:routed?['ssh-bastion']:[],transformItem:(kind,item,raw)=>kind==='servers'&&raw.networkAccess?{...item,networkAccess:access(raw.networkAccess)}:item}},
 readBundleOptions:()=>({versions:[1,2],features:['ssh-bastion']}),
 finalizeImport(out,incoming,ids,current){for(const source of incoming.servers){const route=access(source.networkAccess);if(route.mode==='direct')continue;const destination=out.servers.find(s=>s.id===ids.get(source.id)),bastionId=ids.get(route.bastionId);if(!destination||!bastionId)throw Error('bastion.export_dependency');const networkAccess={version:1,mode:'bastion',bastionId};const old=current.servers.find(s=>s.id===destination.id);if(old&&JSON.stringify(access(old.networkAccess))!==JSON.stringify(networkAccess))throw Error('bastion.import_conflict');destination.networkAccess=networkAccess}for(const s of out.servers)validate(s,[...out.servers,...pins()])},
}}
module.exports={createConfigHooks}
