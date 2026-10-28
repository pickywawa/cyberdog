// Assembly is explicit: proprietary modules are never copied into tracked public paths.
const fs=require('node:fs'),path=require('node:path')
const root=path.resolve(__dirname,'..')
const source=path.resolve(process.argv[2]||path.join(root,'..','cyberdog-premium'))
const destination=path.join(root,'src','premium-runtime')
const config=JSON.parse(fs.readFileSync(path.join(source,'runtime','config.json'),'utf8'))
const allowed=new Set(['storeId','productId','variantIds','mode','checkoutUrl','portalUrl','graceDays','supabaseUrl','supabaseAnonKey'])
if(Object.keys(config).some(key=>!allowed.has(key)))throw Error('Unexpected configuration field; refusing to bundle potential secrets')
if(config.supabaseAnonKey?.startsWith('ey')){let claims;try{claims=JSON.parse(Buffer.from(config.supabaseAnonKey.split('.')[1],'base64url').toString())}catch{throw Error('Invalid public Supabase key')}if(claims.role!=='anon')throw Error('Only an anonymous public Supabase key may be bundled')}
if(!['test','live'].includes(config.mode))throw Error('Invalid Premium environment')
const modules=['server-auth.js','main.js','cloud-account.js','secret-vaults.js','enterprise-vaults.js','rdm-reader.ps1','i18n.js','style.css']
for(const file of [...modules,'premium-ui.js','shared-ui.js','vault-ui.js','server-list.js'])if(!fs.existsSync(path.join(source,'desktop',file)))throw Error('Missing private module: '+file)
fs.rmSync(destination,{recursive:true,force:true});fs.mkdirSync(destination,{recursive:true})
for(const file of modules)fs.copyFileSync(path.join(source,'desktop',file),path.join(destination,file))
fs.cpSync(path.join(source,'desktop','bastions'),path.join(destination,'bastions'),{recursive:true})
fs.cpSync(path.join(source,'desktop','assets'),path.join(destination,'assets'),{recursive:true})
fs.copyFileSync(path.join(source,'runtime','config.json'),path.join(destination,'config.json'))
const ui=['i18n.js','premium-ui.js','shared-ui.js','vault-ui.js','server-list.js','bastions/ui.js'].map(file=>fs.readFileSync(path.join(source,'desktop',file),'utf8')).join('\n')
fs.writeFileSync(path.join(destination,'renderer.js'),ui+`
applyPremiumTranslations(i18n.D)
const premiumStyles=document.createElement('link');premiumStyles.rel='stylesheet';premiumStyles.href='premium-runtime/style.css';document.head.append(premiumStyles)
`)
console.log('Private Premium modules assembled locally ('+config.mode+'); no administrative credentials are bundled.')
