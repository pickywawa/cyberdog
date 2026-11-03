// Real system OpenSSH daemons, dedicated loopback ports and temporary keys/configuration only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'../..'),{Client,utils}=require(path.join(root,'node_modules/ssh2')),{createRoutes}=require('../../src/workspace/bastions/route')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-bastion-openssh-')),daemons=[]
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(x=>x^93),decryptString:b=>Buffer.from(b).map(x=>x^93).toString()}
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
const pause=ms=>new Promise(r=>setTimeout(r,ms))
let routes
;(async()=>{try{
 if(process.platform==='win32')throw Error('This lab requires Unix OpenSSH sshd; use a separate lab for native Windows application acceptance.')
 const sshd=fs.existsSync('/usr/sbin/sshd')?'/usr/sbin/sshd':process.env.CYBERDOG_TEST_SSHD;if(!sshd)throw Error('Install system OpenSSH server to run this real integration test')
 const p1=await port(),p2=await port(),user=os.userInfo().username
 for(const name of ['jump-host','target-host','jump-user','target-user'])cp.execFileSync('ssh-keygen',['-q','-t','ed25519','-N',name==='target-user'?'fixture-passphrase':'','-f',path.join(temp,name)])
 const sftp=['/usr/libexec/sftp-server','/usr/lib/openssh/sftp-server','/usr/lib/ssh/sftp-server'].find(fs.existsSync);if(!sftp)throw Error('OpenSSH sftp-server not found')
 for(const [name,p,auth,host,extra]of [['jump',p1,'jump-user','jump-host',`MaxSessions 0\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:${p2}`],['target',p2,'target-user','target-host','AllowTcpForwarding no']]){
  const config=path.join(temp,name+'.conf');fs.writeFileSync(config,`Port ${p}\nListenAddress 127.0.0.1\nHostKey ${temp}/${host}\nAuthorizedKeysFile ${temp}/${auth}.pub\nPidFile ${temp}/${name}.pid\nStrictModes no\nUsePAM no\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${user}\nSubsystem sftp ${sftp}\nLogLevel ERROR\n${extra}\n`)
  const child=cp.spawn(sshd,['-D','-e','-f',config],{stdio:['ignore','ignore','pipe']});let log='';child.stderr.on('data',d=>log+=d);child.on('error',()=>{});daemons.push(child)
  let ready=false;for(let tries=0;tries<40;tries++){if(child.exitCode!==null)throw Error('OpenSSH daemon failed: '+log);ready=await new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false))});if(ready)break;await pause(50)}if(!ready)throw Error('OpenSSH did not start')
 }
 const bastion={id:'jump',name:'Real OpenSSH jump',host:'127.0.0.1',port:p1,user},target={id:'target',name:'Real OpenSSH target',host:'127.0.0.1',port:p2,user,networkAccess:{version:1,mode:'bastion',bastionId:'jump'}}
 let wrongKey=false,denyPort=false,paid=true;const events=[]
 routes=createRoutes({Client,utils,storage,directory:temp,authorize:async()=>{if(!paid)throw Error('access_denied')},resolve:async()=>({target:{...target,port:denyPort?p1:p2},bastion}),credentials:async s=>({privateKey:fs.readFileSync(path.join(temp,s.id==='jump'?'jump-user':wrongKey?'jump-user':'target-user'))}),send:(name,e)=>{events.push({name,...e});if(name==='bastions:challenge')setImmediate(()=>routes.respond(e.id,{accept:true,responses:e.type==='authentication'?['fixture-passphrase']:[]}))}})
 const client=await routes.open(target)
 const out=await new Promise((ok,no)=>client.exec('printf cyberdog-real-target',(e,stream)=>{if(e)return no(e);let out='';stream.on('data',d=>out+=d);stream.on('close',()=>ok(out));stream.on('error',no)}));assert.equal(out,'cyberdog-real-target')
 const ftp=await new Promise((ok,no)=>client.sftp((e,s)=>e?no(e):ok(s))),data=crypto.randomBytes(65536),remote=path.join(temp,'remote-fixture.bin'),local=path.join(temp,'local-fixture.bin');fs.writeFileSync(local,data)
 await new Promise((ok,no)=>ftp.fastPut(local,remote,e=>e?no(e):ok()));const read=await new Promise((ok,no)=>ftp.readFile(remote,(e,b)=>e?no(e):ok(b)));assert.equal(crypto.createHash('sha256').update(read).digest('hex'),crypto.createHash('sha256').update(data).digest('hex'));ftp.end();client.end();await pause(80)
 assert.equal(events.filter(e=>e.type==='trust').length,2,'independent trust decisions');assert.equal(routes.active(),0)
 await routes.open(target,{test:true});wrongKey=true;await assert.rejects(routes.open(target),/authentication_failed/);wrongKey=false;denyPort=true;await assert.rejects(routes.open(target),/channel_refused/);denyPort=false
 // Replace target host key, keeping its endpoint; the existing trust must reject the new identity.
 daemons[1].kill();await new Promise(r=>daemons[1].once('exit',r));fs.rmSync(path.join(temp,'target-host'));fs.rmSync(path.join(temp,'target-host.pub'));cp.execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(temp,'target-host')]);const replacement=cp.spawn(sshd,['-D','-e','-f',path.join(temp,'target.conf')],{stdio:'ignore'});daemons.push(replacement);await pause(150);await assert.rejects(routes.open(target),/hostkey_changed/)
 paid=false;await assert.rejects(routes.open(target),/access_denied/)
 assert.equal(routes.active(),0)
 console.log(JSON.stringify({realOpenSSH:true,platform:process.platform,forwardingOnlyBastion:true,distinctKeys:true,encryptedPrivateKey:true,targetCommand:true,sftpUploadDownloadSha256:true,wrongTargetKey:'denied',permitOpenRestriction:'denied',changedTargetHostKey:'denied',unlicensed:'denied',mfa:'unit simulation only',networkIsolation:'loopback; direct target not firewalled'}))
 }finally{routes?.closeAll();for(const d of daemons){d.kill();}await pause(100);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
