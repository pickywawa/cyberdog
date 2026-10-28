// Portable, non-secret server preferences. No network or filesystem access.
function serverOptions(value={},fallback={}){
 const result={}
 for(const key of ['website','downloadDir']){
  const v=value[key]===undefined?fallback[key]??'':value[key]
  if(typeof v!=='string'||v.length>(key==='website'?2048:4096)||/[\x00-\x1f]/.test(v))throw Error('invalid_server_options')
  result[key]=v.trim()
 }
 if(result.website){let url;try{url=new URL(result.website)}catch{throw Error('invalid_server_options')};if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('invalid_server_options')}
 const tags=value.tags===undefined?fallback.tags??[]:value.tags
 if(!Array.isArray(tags)||tags.length>30||tags.some(v=>typeof v!=='string'||!v.trim()||v.length>64||/[\x00-\x1f]/.test(v)))throw Error('invalid_server_options')
 result.tags=[...new Set(tags.map(v=>v.trim()))]
 return result
}
module.exports={serverOptions}
