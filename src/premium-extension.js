// Optional proprietary extension. A public checkout runs without private source files.
const fs=require('node:fs'),path=require('node:path')
function load(context){
 const file=path.join(__dirname,'premium-runtime','main.js')
 if(fs.existsSync(file))return require(file).createExtension(context)
 const state=()=>({premium:false,teams:[],servers:[],assets:[],invitations:[]})
 const unavailable=()=>{throw Error('unavailable')}
 const status=()=>({available:false,configured:false,active:false,hasLicense:false,status:'unavailable',checkoutAvailable:false})
 for(const channel of ['premium:status','premium:refresh'])context.accountIPC(channel,status)
 context.accountIPC('teams:status',state)
 context.accountIPC('premium:open',unavailable)
 return{
  available:false,hasPremium:async()=>false,init:async()=>state(),refresh:async()=>{},servers:()=>[],owns:()=>false,
  handlesServerData:d=>{if(d.teamId)unavailable();return false},
  saveServer:unavailable,removeServer:unavailable,updateServer:unavailable,resolveServer:unavailable,
  connectionAuth:async()=>null,saveCredentials:unavailable,resolveAction:unavailable,
  groups:()=>[],actions:()=>[],paths:()=>[],updateGroup:()=>false,
  routeAsset:async(_,data)=>{if(data.teamId)unavailable();return false},finishAssetMove:async()=>{},deleteAsset:async()=>false,
 }
}
module.exports={load}
