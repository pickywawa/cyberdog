// Host-independent tests. POSIX remote-script integration is exercised on Linux/macOS CI.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process')
const posix=new Set(['health.test.js','archive.test.js','processes.test.js','security.test.js'])
for(const name of fs.readdirSync(__dirname).filter(n=>n.endsWith('.test.js')&&!posix.has(n)).sort()){
 const result=spawnSync(process.execPath,[path.join(__dirname,name)],{stdio:'inherit'})
 if(result.error)throw result.error
 if(result.status!==0)process.exit(result.status||1)
}
const workspace=spawnSync(process.execPath,['--test',...fs.readdirSync(path.join(__dirname,'workspace')).filter(n=>n.endsWith('.test.js')).sort().map(n=>path.join(__dirname,'workspace',n))],{stdio:'inherit'})
if(workspace.error)throw workspace.error
if(workspace.status!==0)process.exit(workspace.status||1)
console.log('Portable suite passed; POSIX script integration runs on Linux/macOS.')
