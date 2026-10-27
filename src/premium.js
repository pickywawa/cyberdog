const fs=require('node:fs'),path=require('node:path')
// Only approved hosted checkout URLs live here. Cloud authorization is server-side.
function createPremiumBridge(){
 const file=path.join(__dirname,'premium-runtime','config.json')
 const available=fs.existsSync(file)
 const config=available?require(file):{portalUrl:'https://pickywawa.lemonsqueezy.com/billing'}
 const state=()=>({available,active:false})
 return{
  state,init:async()=>state(),act:async()=>{throw Error('unavailable')},
  url(kind){const value=kind==='checkout'?config.checkoutUrl:config.portalUrl;if(!value)throw Error('unconfigured');const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='pickywawa.lemonsqueezy.com'||url.username||url.password)throw Error('invalid_url');return url.href},
 }
}
module.exports={createPremiumBridge}
