const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{utils}=require('ssh2')
function readPrivateKey(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('invalid_ssh_key')
 const st=fs.statSync(file);if(!st.isFile()||st.size>65536)throw Error('invalid_ssh_key')
 const text=fs.readFileSync(file,'utf8'),parsed=utils.parseKey(text)
 if(parsed instanceof Error){if(!/encrypted|passphrase/i.test(parsed.message)||!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/m.test(text))throw Error('invalid_ssh_key')}
 else if(Array.isArray(parsed)||!parsed.isPrivateKey())throw Error('invalid_ssh_key')
 return {text,info:{path:file,name:path.basename(file),type:parsed instanceof Error?'SSH':parsed.type,encrypted:parsed instanceof Error}}
}
function listPrivateKeys(home=os.homedir(),extra=[]){
 const dirs=['.ssh','.ssh/cyberdog','.ssh/keys','.shh','.config/ssh','.config/ssh/keys','.putty'].map(d=>path.join(home,d)).concat(extra),items=[],seen=new Set()
 for(const dir of dirs){let names;try{names=fs.readdirSync(dir).slice(0,200)}catch{continue}
  for(const name of names){try{const file=fs.realpathSync(path.join(dir,name));if(seen.has(file))continue;seen.add(file);items.push(readPrivateKey(file).info)}catch{}}
 }
 return items.sort((a,b)=>a.path.localeCompare(b.path))
}
module.exports={readPrivateKey,listPrivateKeys}
