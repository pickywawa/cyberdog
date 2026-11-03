const VAULT_PROVIDERS={onepassword:'1Password',bitwarden:'Bitwarden / Vaultwarden',hashicorp:'HashiCorp Vault · KV v2',aws:'AWS Secrets Manager',azure:'Azure Key Vault',teampass:'TeamPass',keeper:'KeeperPAM / Secrets Manager',manageengine:'ManageEngine Password Manager Pro',devolutions:'Devolutions Server',rdm:'Remote Desktop Manager'}
const VAULT_LOGOS={onepassword:'onepassword.ico',bitwarden:'bitwarden.ico',hashicorp:'hashicorp.ico',aws:'aws.ico',azure:'azure.ico',teampass:'teampass.png',keeper:'keeper.ico',manageengine:'manageengine.ico',devolutions:'devolutions.ico',rdm:'rdm.ico'}
const vaultLogo=(provider,cls='')=>h('img',{className:'vault-logo '+cls,src:'workspace/assets/vaults/'+VAULT_LOGOS[provider],alt:'',ariaHidden:'true'})
function chooseVaultProvider(){return new Promise(resolve=>{
 let close
 const content=h('div',{className:'vault-provider-grid'})
 for(const [provider,name] of Object.entries(VAULT_PROVIDERS))content.append(h('button',{type:'button',className:'vault-provider-card',disabled:provider==='rdm'&&api.platform!=='win32',title:provider==='rdm'&&api.platform!=='win32'?t('vault.windows_only'):'',onclick:()=>{resolve({provider});close()}},vaultLogo(provider),h('strong',{textContent:name}),h('small',{className:'dim',textContent:t('vault.kind.'+provider)})))
 close=showAccountDialog(content,t('vault.provider'),'vault-picker',()=>resolve(null))
})}
let vaultConnectors=[]
function vaultError(error){return error?.message?.startsWith('vault.')?t(error.message):errText(error)}
async function vaultPinForm(connector,item,pin){
 try{
  const preview=pin||await api.invoke('vaults:preview',connector.id,item.id)
  const value=await modal(t(pin?'vault.edit_server':'vault.add_server'),[
   {name:'name',label:t('f.name'),value:pin?.name||item.name},
   {name:'host',label:t('f.host'),value:preview.host},
   {name:'port',label:t('f.port'),value:preview.port||22},
   {name:'user',label:t('f.user'),value:preview.user},
  ],t('btn.save'))
  if(!value)return
  servers=await api.invoke('vaults:pin',{...value,id:pin?.id,vaultId:connector.id,itemId:item.id});renderServers();toast(t('vault.pinned'))
 }catch(e){toast(vaultError(e),true)}
}
async function editVaultServer(server){
 try{const connectors=await api.invoke('vaults:list'),connector=connectors.find(c=>c.id===server.vaultId);if(!connector)return;await vaultPinForm(connector,{id:server.itemId,name:server.name},server)}catch(e){toast(vaultError(e),true)}
}
async function vaultConnectorForm(existing){
 try{
  const first=existing||await chooseVaultProvider()
  if(!first)return
  const provider=first.provider,fields=[{name:'name',label:t('f.name'),value:existing?.name||VAULT_PROVIDERS[provider]}]
  if(provider==='hashicorp')fields.push(
   {name:'url',label:t('vault.url'),value:existing?.url,placeholder:'https://vault.example.com'},
   {name:'mount',label:t('vault.mount'),value:existing?.mount||'secret'},
   {name:'prefix',label:t('vault.prefix'),value:existing?.prefix,placeholder:'servers/production'},
   {name:'namespace',label:t('vault.namespace'),value:existing?.namespace},
   {name:'token',label:t('vault.token'),type:'password',placeholder:existing?.hasSavedToken?t('vault.keep_token'):''},
   {name:'rememberToken',label:t('vault.remember'),type:'checkbox',value:!!existing?.hasSavedToken})
  else if(['teampass','manageengine','devolutions'].includes(provider)){
   fields.push({name:'url',label:t('vault.url'),value:existing?.url,placeholder:provider==='devolutions'?'https://server.example.com/dvls':'https://vault.example.com'})
   if(provider==='teampass')fields.push({name:'folderIds',label:t('vault.folder_ids'),value:existing?.folderIds,placeholder:'1,2'},{name:'token',label:t('vault.jwt'),type:'password'})
   if(provider==='manageengine')fields.push({name:'orgName',label:t('vault.organization'),value:existing?.orgName},{name:'token',label:t('vault.api_token'),type:'password',placeholder:existing?.hasSavedToken?t('vault.keep_token'):''},{name:'rememberToken',type:'checkbox',label:t('vault.remember'),value:!!existing?.hasSavedToken})
   if(provider==='devolutions')fields.push({name:'applicationKey',label:t('vault.application_key'),value:existing?.applicationKey},{name:'remoteVaultId',label:t('vault.remote_vault_id'),value:existing?.remoteVaultId},{name:'token',label:t('vault.application_secret'),type:'password',placeholder:existing?.hasSavedToken?t('vault.keep_token'):''},{name:'rememberToken',type:'checkbox',label:t('vault.remember'),value:!!existing?.hasSavedToken})
  }
  else if(provider==='azure')fields.push({name:'azureVault',label:t('vault.azure_vault'),value:existing?.azureVault,placeholder:'my-company-vault'},{name:'token',label:t('vault.azure_token'),type:'password'})
  else{
   fields.push({name:'cliPath',label:t('vault.cli_path'),value:existing?.cliPath,placeholder:provider==='onepassword'?'/opt/homebrew/bin/op':provider==='aws'?'/usr/local/bin/aws':provider==='keeper'?'/usr/local/bin/ksm':provider==='rdm'?'C:\\Program Files\\PowerShell\\7\\pwsh.exe':'/usr/local/bin/bw'})
   if(provider==='onepassword')fields.push({name:'account',label:t('vault.account'),value:existing?.account},{name:'vault',label:t('vault.filter'),value:existing?.vault})
   else if(provider==='aws')fields.push({name:'awsProfile',label:t('vault.aws_profile'),value:existing?.awsProfile},{name:'region',label:t('vault.aws_region'),value:existing?.region||'eu-west-1'},{name:'prefix',label:t('vault.prefix'),value:existing?.prefix})
   else if(provider==='keeper')fields.push({name:'cliProfile',label:t('vault.cli_profile'),value:existing?.cliProfile})
   else if(provider==='rdm')fields.push({name:'dataSourceId',label:t('vault.data_source_id'),value:existing?.dataSourceId},{name:'remoteVaultId',label:t('vault.remote_vault_id'),value:existing?.remoteVaultId})
   else fields.push({name:'search',label:t('vault.search_filter'),value:existing?.search},{name:'token',label:t('vault.session'),type:'password'})
  }
  const value=await modal(t(existing?'vault.edit':'vault.add'),fields,t('btn.save'))
  if(!value)return
  await api.invoke('vaults:save',{...value,provider,id:existing?.id,mapping:existing?.mapping});return true
 }catch(e){toast(vaultError(e),true)}
}
function buildVaultSettings(){
 const content=h('div',{className:'vault-manager'}),header=h('div',{className:'vault-toolbar'}),list=h('div'),items=h('div',{className:'vault-items'}),message=h('p',{className:'dim',role:'status'})
 let selected=null,busy=false
 const button=(key,action,cls='chip')=>h('button',{type:'button',className:cls,textContent:t(key),onclick:()=>run(action)})
 async function run(action){if(busy)return;busy=true;content.classList.add('busy');message.textContent=t('vault.working');try{await action();message.textContent=''}catch(e){message.textContent=vaultError(e)}finally{busy=false;content.classList.remove('busy')}}
 const disconnect=id=>{for(const tab of tabs.filter(tb=>tb.server.vaultId===id)){if(tab.connId)tab.connId=null}}
 async function refresh(){vaultConnectors=await api.invoke('vaults:list');paint()}
 async function browse(connector){
  selected=connector;items.replaceChildren();const records=await api.invoke('vaults:browse',connector.id)
  const query=h('input',{type:'search',placeholder:t('vault.search'),ariaLabel:t('vault.search')}),rows=h('div',{className:'vault-item-list'})
  const paintRows=()=>{rows.replaceChildren();const q=query.value.toLowerCase();for(const item of records.filter(item=>(item.name+' '+item.id).toLowerCase().includes(q)))rows.append(h('div',{className:'vault-item'},h('div',{},h('b',{textContent:item.name||item.id}),h('small',{className:'dim mono',textContent:item.id})),button('vault.add_server',()=>vaultPinForm(connector,item))));if(!records.length)rows.append(h('p',{className:'dim',textContent:t('vault.empty')}))}
  query.oninput=paintRows;items.append(h('h4',{textContent:connector.name}),query,rows);paintRows()
 }
 function paint(){
  list.replaceChildren()
  if(!vaultConnectors.length)list.append(h('p',{className:'dim',textContent:t('vault.none')}))
  for(const connector of vaultConnectors){
   const row=h('section',{className:'vault-connector'},h('div',{className:'vault-identity'},vaultLogo(connector.provider),h('div',{},h('strong',{textContent:connector.name}),h('small',{className:'dim',textContent:VAULT_PROVIDERS[connector.provider]}))),h('div',{className:'chips'},
    button('vault.browse',()=>browse(connector)),
    button(connector.locked?'vault.unlock':'vault.lock',async()=>{
     if(connector.locked){let token='';if(!['onepassword','aws','keeper','rdm'].includes(connector.provider)){const v=await modal(t('vault.unlock'),[{name:'token',label:t(connector.provider==='hashicorp'?'vault.token':connector.provider==='azure'?'vault.azure_token':connector.provider==='teampass'?'vault.jwt':connector.provider==='devolutions'?'vault.application_secret':connector.provider==='manageengine'?'vault.api_token':'vault.session'),type:'password',placeholder:connector.hasSavedToken?t('vault.keep_token'):''}],t('vault.unlock'));if(!v)return;token=v.token}await api.invoke('vaults:unlock',connector.id,token)}else{await api.invoke('vaults:lock',connector.id);disconnect(connector.id);if(selected?.id===connector.id)items.replaceChildren()}
     await refresh()
    }),
    button('vault.edit',async()=>{if(await vaultConnectorForm(connector)){items.replaceChildren();await refresh()}}),
    button('vault.mapping',async()=>{const value=await modal(t('vault.mapping'),['host','user','port','password','privateKey','passphrase'].map(name=>({name,label:t('vault.field.'+name),value:connector.mapping?.[name]})),t('btn.save'));if(value){await api.invoke('vaults:save',{...connector,rememberToken:connector.hasSavedToken,mapping:value});items.replaceChildren();await refresh()}}),
    button('vault.remove',async()=>{if(!confirm(t('vault.confirm_remove')))return;await api.invoke('vaults:remove',connector.id);items.replaceChildren();await refresh()})))
   list.append(row)
  }
 }
 header.append(button('vault.add',async()=>{if(await vaultConnectorForm()){items.replaceChildren();await refresh()}},'primary'))
 content.append(h('p',{className:'dim',textContent:t('vault.intro')}),h('small',{className:'dim',textContent:t('vault.immediate')}),h('details',{className:'vault-help'},h('summary',{textContent:t('vault.setup_title')}),h('p',{className:'note',textContent:t('vault.setup')}),h('p',{className:'note',textContent:t('vault.cloud_setup')}),h('p',{className:'note',textContent:t('vault.enterprise_setup')})),header,message,list,items)
 run(refresh)
 return content
}
api.on('vaults:changed',()=>{if($('#modal .vault-manager'))return;api.invoke('vaults:list').then(value=>{vaultConnectors=value}).catch(()=>{})})
