// Run: npx electron test/smoke/account-ui.cjs — real window, stubbed cloud service.
const {app}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cyberdog-account-ui-'))
app.setPath('appData',path.join(temp,'profile'));fs.mkdirSync(app.getPath('appData'),{recursive:true})
app.on('quit',()=>fs.rmSync(temp,{recursive:true,force:true}))
let hook,signedIn=false,calls=[]
const team={id:'team-1',name:'Production',role:'owner',canEditServers:true}
const state=()=>({configured:true,signedIn,email:signedIn?'me@example.test':null,userId:signedIn?'u1':null,personalSpaceId:'personal-1',teams:signedIn?[team]:[],servers:[],assets:[],invitations:[]})
require(path.join(root,'src/workspace/cloud-account')).createCloudAccount=options=>{hook=options;return{
 state,init:async()=>state(),refresh:async()=>state(),previews:()=>[],localAuth:()=>({}),localKey:()=>undefined,hasPassword:()=>false,
 signIn:async v=>{calls.push(['signIn',v]);if(v.password==='wrong-password')throw Error('invalid_credentials');signedIn=true;hook.onChange(state());return state()},
 signUp:async v=>{calls.push(['signUp',v]);return{...state(),confirmEmail:true}},
 signOut:async()=>{signedIn=false;hook.onChange(state());return state()},
 action:async(action,payload)=>{calls.push([action,payload]);if(action==='details')return{members:[{id:'u1',email:'me@example.test',role:'owner',canEditServers:true}],invitations:[]};if(action==='invite_link_list')return[{id:'l1',usesLeft:2,expiresAt:new Date(Date.now()+6e8).toISOString()}];if(action==='invite_link_create')return{id:'l2',link:'cyberdog://invite/'+'B'.repeat(43)};return state()},
}}
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{
 try{
  const js=code=>win.webContents.executeJavaScript(code),pause=(ms=250)=>new Promise(r=>setTimeout(r,ms))
  const wait=async(code,label)=>{for(let i=0;i<40;i++){if(await js(code))return;await pause(100)}throw Error('timeout: '+(label||code))}
  await wait(`document.querySelector('#btn-account')?.textContent.length>0`,'button')
  const label=await js(`document.querySelector('#btn-account').textContent`)
  assert(/Connexion|Sign in/.test(label),'top bar shows the sign-in button: '+label)
  assert.equal(await js(`document.querySelector('#btn-premium')`),null)
  await js(`document.querySelector('#btn-account').click()`);await wait(`!!document.querySelector('.account-settings input[type=email]')`,'login form')
  assert.equal(await js(`document.querySelector('.settings-nav-item.active').id`),'settings-tab-account','the button opens Settings on the sign-in tab')
  assert.equal(await js(`document.querySelectorAll('.settings-nav-item').length`),5)
  const text=await js(`document.body.innerText`);assert(!/premium|lemon|licen[cs]e|licence/i.test(text),'no commercial wording in the UI: '+text.match(/.{20}(premium|lemon|licen[cs]e).{20}/i))
  // wrong password shows a readable error and stays signed out
  await js(`(()=>{const f=document.querySelector('.account-settings');f.querySelector('input[type=email]').value='me@example.test';f.querySelector('input[type=password]').value='wrong-password';[...f.querySelectorAll('button')].find(b=>b.classList.contains('primary')).click()})()`)
  await wait(`document.querySelector('.account-settings .err')?.textContent.length>0`,'error');assert.equal(signedIn,false)
  await js(`(()=>{const f=document.querySelector('.account-settings');f.querySelector('input[type=password]').value='correct horse battery';[...f.querySelectorAll('button')].find(b=>b.classList.contains('primary')).click()})()`)
  await wait(`!!document.querySelector('.account-identity')`,'signed in view');assert.equal(signedIn,true)
  assert(await js(`document.querySelector('.account-identity').textContent.includes('me@example.test')`))
  assert(/Compte|Account/.test(await js(`document.querySelector('#btn-account').textContent`)),'button reflects the signed-in state')
  // team with invitation links
  await wait(`!!document.querySelector('.team-card')`,'team card');await js(`document.querySelector('.team-card').click()`)
  await wait(`document.body.innerText.includes('${'me@example.test'}')&&[...document.querySelectorAll('.team-details button')].some(b=>/lien d’invitation|invitation link/i.test(b.textContent))`,'invite link button')
  assert(await js(`[...document.querySelectorAll('.team-details .team-member')].some(r=>/2/.test(r.textContent))`),'pending link with remaining uses is listed')
  assert(await js(`!document.body.innerText.match(/identifiant de membre|member id/i)`),'member-ID invitations are gone')
  fs.writeFileSync(path.join(os.tmpdir(),'cyberdog-account-ui.png'),(await win.webContents.capturePage()).toPNG())
  // join with a link: the invite event opens the join flow
  await js(`joinFromLink('cyberdog://invite/${'C'.repeat(43)}')`);await pause(400);assert(calls.some(c=>c[0]==='invite_link_accept'&&c[1].token.endsWith('C'.repeat(43))))
  await js(`[...document.querySelectorAll('.account-identity button')][0].click()`);await wait(`!document.querySelector('.account-identity')`,'signed out');assert.equal(signedIn,false)
  console.log('Account UI passed: sign-in button, Connexion tab, errors, sign-in, teams with invitation links, join by link, sign-out, no commercial wording.');app.exit(0)
 }catch(e){console.error(e);app.exit(1)}
}))
setTimeout(()=>{console.error('timeout');app.exit(1)},45000).unref()
require(path.join(root,'src/main.js'))
