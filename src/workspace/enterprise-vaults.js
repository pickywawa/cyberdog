// Proprietary adapters. Read-only secret access; no automatic approval or checkout.
const fs=require('node:fs'),path=require('node:path')
const PROVIDERS=['teampass','keeper','manageengine','devolutions','rdm']
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail=code=>{throw Error('vault.'+code)}
function baseURL(value){
 let url;try{url=new URL(value)}catch{fail('url_error')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/[\x00-\x1f]/.test(value))fail('url_error')
 return url.href.replace(/\/+$/,'')
}
function validate(input,c,platform){
 if(['teampass','manageengine','devolutions'].includes(c.provider))c.url=baseURL(input.url)
 if(c.provider==='teampass'){
  c.folderIds=String(input.folderIds||'').trim()
  if(!/^\d+(?:,\d+){0,49}$/.test(c.folderIds))fail('invalid')
 }
 if(c.provider==='devolutions'&&(!c.applicationKey||c.applicationKey.length>512||!GUID.test(c.remoteVaultId||'')))fail('invalid')
 if(c.provider==='rdm'){
  if(platform!=='win32')fail('windows_only')
  if(!GUID.test(c.dataSourceId||'')||!GUID.test(c.remoteVaultId||''))fail('invalid')
 }
}
function list(value){
 if(!Array.isArray(value))fail('response')
 if(value.length>1000)fail('limit')
 return value
}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))fail('response');return value}
function targetFromURL(value){
 try{const u=new URL(value);if(['ssh:','sftp:'].includes(u.protocol))return{host:u.hostname.replace(/^\[|\]$/g,''),port:u.port||'22',user:decodeURIComponent(u.username)}}catch{}
 return{}
}
function keeperFields(item){
 const result=Object.create(null)
 for(const field of [...(item.fields||[]),...(item.custom||[])]){
  const v=Array.isArray(field.value)?field.value[0]:field.value
  if(field.label&&typeof v==='string')result[field.label]=v
  if(field.type==='host'&&v&&typeof v==='object'){result.host=v.hostName;result.port=v.port}
  else if(field.type==='keyPair'&&v&&typeof v==='object'){result.private_key=v.privateKey}
  else if(typeof v==='string'&&field.type)result[field.type]=v
 }
 return{...targetFromURL(result.url),...result,username:result.username||result.login}
}
function createEnterpriseAdapters({httpJSON,command,normalize,credential,platform=process.platform}){
 const tokenHeaders=(c,name)=>{const token=credential(c);if(!token)fail('locked');if(/[\r\n]/.test(token))fail('invalid');return{[name]:token}}
 const request=(c,route,options={})=>httpJSON(c.url+route,options)
 const pmp=async(c,route)=>{
  const raw=await request(c,'/restapi/json/v1'+route,{headers:{...tokenHeaders(c,'AUTHTOKEN'),...(c.orgName?{orgName:c.orgName}:{})}})
  const operation=object(raw.operation),status=operation.result||operation['result ']
  if(!status||String(status.status||'').toLowerCase()!=='success')fail('denied')
  return operation.Details
 }
 const pmpAccounts=async(c,rid)=>object(await pmp(c,'/resources/'+rid+'/accounts'))
 async function devolutions(c,operation){
  const auth=object(await request(c,'/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appKey:c.applicationKey,appSecret:credential(c)||fail('locked')})}))
  if(typeof auth.tokenId!=='string'||!auth.tokenId||/[\r\n]/.test(auth.tokenId))fail('denied')
  const headers={tokenId:auth.tokenId}
  try{return await operation(route=>request(c,route,{headers}))}
  finally{try{await request(c,'/api/v1/logout',{method:'POST',headers})}catch{/* Do not replace the original access error. Token is never retained. */}}
 }
 const unwrap=value=>Array.isArray(value)?value:value?.data??value?.items??value?.entries??value
 const api={
  teampass:{
   async browse(c){
    const result=[];const headers=tokenHeaders(c,'Authorization');headers.Authorization='Bearer '+headers.Authorization
    for(let offset=0;offset<=1000;offset+=100){const page=list(await request(c,'/api/v1/item/inFolders?'+new URLSearchParams({folders:c.folderIds,limit:'100',offset:String(offset)}),{headers}));for(const item of page){if(!/^\d+$/.test(String(item.id))||!c.folderIds.split(',').includes(String(item.id_tree)))fail('response');if(!Number(item.inactif))result.push({id:String(item.id),name:String(item.label||item.id).slice(0,200)})}if(result.length>1000)fail('limit');if(page.length<100)return result}fail('limit')
   },
   async read(c,id){
    if(!/^\d+$/.test(id))fail('invalid')
    const bearer=tokenHeaders(c,'Authorization');bearer.Authorization='Bearer '+bearer.Authorization
    const items=list(await request(c,'/api/v1/item/get?id='+id,{headers:bearer})),item=items.find(item=>String(item.id)===id)
    if(!item||Number(item.inactif)||!c.folderIds.split(',').includes(String(item.id_tree)))fail('denied')
    const fields=Object.create(null);for(const f of item.fields||[])if((f.title||f.label)&&typeof f.value==='string')fields[f.title||f.label]=f.value
    return normalize({...fields,...targetFromURL(item.url),username:item.login,password:item.pwd},c.mapping)
   },
  },
  keeper:{
   async browse(c){const records=list(await command(c,['secret','list','--json']));return records.map(record=>{if(!/^[A-Za-z0-9_-]{20,80}$/.test(record.uid||''))fail('response');return{id:record.uid,name:String(record.title||record.uid).slice(0,200)}})},
   async read(c,id){
    if(!/^[A-Za-z0-9_-]{20,80}$/.test(id))fail('invalid')
    const data=await command(c,['secret','get','--json','--force-array','--uid',id]),item=list(data).find(record=>record.uid===id)
    if(!item)fail('missing');return normalize(keeperFields(item),c.mapping)
   },
  },
  manageengine:{
   async browse(c){
    const resources=list(await pmp(c,'/resources')),result=[]
    if(resources.length>100)fail('limit')
    for(const resource of resources){const rid=String(resource['RESOURCE ID']);if(!/^\d+$/.test(rid))fail('response');const details=await pmpAccounts(c,rid)
     for(const account of list(details['ACCOUNT LIST'])){const aid=String(account['ACCOUNT ID']);if(!/^\d+$/.test(aid))fail('response');result.push({id:rid+':'+aid,name:String(resource['RESOURCE NAME']||rid)+' · '+String(account['ACCOUNT NAME']||aid)})}
     if(result.length>1000)fail('limit')
    }return result
   },
   async read(c,id){
    if(!/^\d+:\d+$/.test(id))fail('invalid');const[rid,aid]=id.split(':'),details=await pmpAccounts(c,rid),account=list(details['ACCOUNT LIST']).find(a=>String(a['ACCOUNT ID'])===aid)
    if(!account)fail('denied')
    const value=object(await pmp(c,'/resources/'+rid+'/accounts/'+aid+'/password'))
    return normalize({host:details['DNS NAME'],username:account['ACCOUNT NAME'],password:value.PASSWORD},c.mapping)
   },
  },
  devolutions:{
   async browse(c){return devolutions(c,async get=>{
    const result=[]
    for(let page=0;page<=10;page++){const records=list(unwrap(await get('/api/v1/vault/'+c.remoteVaultId+'/entry?pageSize=100&pageNumber='+page)));for(const entry of records){const id=entry.id||entry.ID;if(!GUID.test(id||''))fail('response');result.push({id,name:String(entry.name||entry.Name||id).slice(0,200)})}if(result.length>1000)fail('limit');if(records.length<100)return result}fail('limit')
   })},
   async read(c,id){if(!GUID.test(id))fail('invalid');return devolutions(c,async get=>{
    const entry=object(unwrap(await get('/api/v1/vault/'+c.remoteVaultId+'/entry/'+id)))
    if((entry.id||entry.ID)&&String(entry.id||entry.ID).toLowerCase()!==id.toLowerCase())fail('response')
    const values=entry.credential||entry.credentials||entry
    return normalize({...values,host:values.host||entry.host,username:values.username||values.userName||entry.username,password:values.password},c.mapping)
   })},
  },
  rdm:{
   async browse(c){if(platform!=='win32')fail('windows_only');return list(await command(c,['list'])).map(item=>{if(!GUID.test(item.id||''))fail('response');return{id:item.id,name:String(item.name||item.id).slice(0,200)}})},
   async read(c,id){if(platform!=='win32')fail('windows_only');if(!GUID.test(id))fail('invalid');const value=object(await command(c,['get',id]));if(String(value.id||'').toLowerCase()!==id.toLowerCase())fail('response');return normalize(value,c.mapping)},
  },
 }
 return{has:provider=>PROVIDERS.includes(provider),browse:(c)=>api[c.provider].browse(c),read:(c,id)=>api[c.provider].read(c,id)}
}
module.exports={PROVIDERS,validate,baseURL,keeperFields,createEnterpriseAdapters}
