const test=require('node:test'),assert=require('node:assert/strict'),{createConfigHooks}=require('../../src/workspace/bastions/config')
test('route bundle hooks include dependencies, refuse missing dependencies and remap references',()=>{
 const b={id:'jump',name:'Jump',host:'jump.test',port:22,user:'j',pass:'DO_NOT_EXPORT'},t={id:'target',name:'Target',host:'private.test',port:22,user:'t',networkAccess:{version:1,mode:'bastion',bastionId:'jump'}},hooks=createConfigHooks(()=>[b,t]),input={groups:[],servers:[t],actions:[],paths:[]};const data=hooks.prepareExport(input);assert.equal(data.servers.length,2);const opts=hooks.bundleOptions(data);assert.equal(opts.version,2);assert(!JSON.stringify(opts.transformItem('servers',{id:b.id},b)).includes('DO_NOT_EXPORT'))
 const out={servers:[{...t,id:'new-target',networkAccess:undefined},{...b,id:'new-jump'}]},ids=new Map([['target','new-target'],['jump','new-jump']]);hooks.finalizeImport(out,{servers:[t,b]},ids,{servers:[]});assert.equal(out.servers[0].networkAccess.bastionId,'new-jump')
 assert.throws(()=>hooks.prepareExport({...input,servers:[{...t,networkAccess:{version:1,mode:'bastion',bastionId:'absent'}}]}),/export_dependency/)
})
