// Secrets only cross the renderer boundary when explicitly entered; saved secrets stay in main.
function createServerAuth({storage,readPrivateKey,keyPassphrase}){
 const seal=value=>{if(!storage.isEncryptionAvailable()||storage.getSelectedStorageBackend?.()==='basic_text')throw Error('secure_storage_unavailable');return storage.encryptString(value).toString('base64')}
 const open=value=>value?storage.decryptString(Buffer.from(value,'base64')):undefined
 function prepare(d,source={}){
  const mode=d.authMode||source.authMode||(source.key||source.keyData?'key':'password');if(!['password','key'].includes(mode))throw Error('invalid_credential')
  let credential,path
  if(mode==='password'){
   const password=d.pass||source.syncedCredential?.password||open(source.pass)
   if(password)credential={kind:'password',password}
  }else{
   path=d.key||source.key
   const privateKey=path?readPrivateKey(path).text:source.syncedCredential?.privateKey||open(source.keyData)
   if(privateKey)credential={kind:'key',privateKey}
  }
  const local={authMode:mode,pass:null,key:null,keyData:null}
  if(credential?.kind==='password')local.pass=seal(credential.password)
  if(credential?.kind==='key'){if(path)local.key=path;else local.keyData=seal(credential.privateKey)}
  return{mode,credential,local}
 }
 function connection(s){
  if(s.syncedCredential?.kind==='password'&&s.authMode!=='key')return{password:s.syncedCredential.password}
  const privateKey=s.syncedCredential?.kind==='key'?s.syncedCredential.privateKey:open(s.keyData)
  if(privateKey&&s.authMode!=='password')return{privateKey:Buffer.from(privateKey),passphrase:keyPassphrase?.(s.key||'cloud:'+s.id)}
  return null
 }
 return{prepare,connection}
}
module.exports={createServerAuth}
