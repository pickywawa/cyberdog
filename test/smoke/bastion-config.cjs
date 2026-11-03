const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createConfigHooks}=require('../../src/workspace/bastions/config')
const core=require('../../src/config-transfer')
test('configuration bundles preserve routes, include dependencies, remap IDs and refuse unsafe downgrades',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'route-bundle-'))
 try{const b={id:'jump',name:'Jump',host:'jump.test',port:22,user:'j',pass:'DO_NOT_EXPORT'},t={id:'target',name:'Target',host:'private.test',port:22,user:'t',networkAccess:{version:1,mode:'bastion',bastionId:'jump'}},hooks=createConfigHooks(()=>[b,t]);const input={groups:[],servers:[t],actions:[],paths:[]},data=hooks.prepareExport(input),file=path.join(dir,'routes.zip');assert.equal(data.servers.length,2);core.writeBundle(data,file,hooks.bundleOptions(data));assert.throws(()=>core.readBundle(file),/Unsupported/);const incoming=core.readBundle(file,hooks.readBundleOptions());assert(!JSON.stringify(incoming).includes('DO_NOT_EXPORT'));const result=core.merge({groups:[],servers:[],actions:[],paths:[]},incoming,hooks.finalizeImport);const target=result.data.servers.find(s=>s.host===t.host),jump=result.data.servers.find(s=>s.host===b.host);assert.equal(target.networkAccess.bastionId,jump.id);assert.notEqual(jump.id,b.id)
 assert.throws(()=>hooks.prepareExport({...input,servers:[{...t,networkAccess:{version:1,mode:'bastion',bastionId:'missing'}}]}),/export_dependency/)
 assert.throws(()=>core.merge({groups:[],servers:[{...t,id:'existing',networkAccess:undefined}],actions:[],paths:[]},incoming,hooks.finalizeImport),/import_conflict/)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
