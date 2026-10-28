const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{utils}=require('ssh2'),{listPrivateKeys,readPrivateKey}=require('../src/local-ssh-keys')
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-key-discovery-'))
try{
 const keys=utils.generateKeyPairSync('rsa',{bits:2048}),locked=utils.generateKeyPairSync('rsa',{bits:2048,passphrase:'test-only',cipher:'aes256-ctr'})
 fs.mkdirSync(path.join(dir,'.ssh','cyberdog'),{recursive:true});fs.mkdirSync(path.join(dir,'.config','ssh'),{recursive:true})
 fs.writeFileSync(path.join(dir,'.ssh','id_test'),keys.private);fs.writeFileSync(path.join(dir,'.ssh','id_test.pub'),keys.public);fs.writeFileSync(path.join(dir,'.ssh','config'),'Host example\n HostName test');fs.writeFileSync(path.join(dir,'.config','ssh','encrypted.pem'),locked.private)
 const found=listPrivateKeys(dir);assert.equal(found.length,2);assert.equal(found.filter(k=>k.encrypted).length,1);assert(!JSON.stringify(found).includes('BEGIN'));assert(!JSON.stringify(found).includes(keys.private));assert.equal(readPrivateKey(found.find(k=>!k.encrypted).path).text,keys.private)
 assert.throws(()=>readPrivateKey(path.join(dir,'.ssh','id_test.pub')),/invalid_ssh_key/);assert.throws(()=>readPrivateKey('../relative'),/invalid_ssh_key/)
 console.log('private key discovery: common directories, encrypted keys, bounded parsing, public/config exclusion, no key material in inventory')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
