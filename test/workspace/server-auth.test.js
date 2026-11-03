const{test}=require('node:test'),assert=require('node:assert/strict'),{createServerAuth}=require('../../src/workspace/server-auth')
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('sealed:'+s),decryptString:b=>b.toString().replace(/^sealed:/,'')}
const auth=createServerAuth({storage,readPrivateKey:file=>({text:'private:'+file}),keyPassphrase:id=>id==='cloud:s'?'passphrase':undefined})
test('credentials switch methods, preserve saved secrets, and localize synced secrets securely',()=>{
 const pw=auth.prepare({authMode:'password',pass:'secret'});assert.equal(pw.credential.password,'secret');assert.equal(pw.local.key,null);assert(!pw.local.pass.includes('secret'))
 const key=auth.prepare({authMode:'key',key:'/key'});assert.equal(key.credential.privateKey,'private:/key');assert.equal(key.local.pass,null);assert.equal(key.local.key,'/key')
 const localized=auth.prepare({authMode:'key'},{syncedCredential:{kind:'key',privateKey:'remote-key'}});assert.equal(localized.local.key,null);assert(localized.local.keyData);assert.equal(auth.connection({id:'s',authMode:'key',...localized.local}).privateKey.toString(),'remote-key')
 assert.equal(auth.connection({id:'s',authMode:'key',syncedCredential:{kind:'key',privateKey:'remote-key'}}).passphrase,'passphrase')
 assert.equal(auth.connection({authMode:'password',syncedCredential:{kind:'password',password:'shared'}}).password,'shared')
 assert.equal(auth.connection({authMode:'password',keyData:localized.local.keyData}),null)
})
test('insecure local secret persistence fails closed',()=>assert.throws(()=>createServerAuth({storage:{isEncryptionAvailable:()=>false},readPrivateKey:()=>{}}).prepare({pass:'secret'}),/secure_storage_unavailable/))
