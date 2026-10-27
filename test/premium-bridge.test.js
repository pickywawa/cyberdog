const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const filename = path.join(__dirname, '../src/premium.js')
const moduleStub = {exports:{}}
vm.runInNewContext(fs.readFileSync(filename,'utf8'), {module:moduleStub, __dirname:path.dirname(filename), URL, require:name=>name==='node:fs'?{...fs,existsSync:()=>false}:require(name)})
const {createPremiumBridge} = moduleStub.exports
;(async()=>{
 const bridge=createPremiumBridge({directory:'/unused',safeStorage:{isEncryptionAvailable:()=>false},fetch:()=>{throw new Error('No request expected')},onChange:()=>{}})
 assert.equal((await bridge.init()).available,false)
 assert.equal(bridge.state().active,false)
 assert.equal(bridge.url('portal'),'https://pickywawa.lemonsqueezy.com/billing')
 assert.throws(()=>bridge.url('checkout'),/unconfigured/)
 await assert.rejects(bridge.act('activate','test'),/unavailable/)
 console.log('community build and Premium URL boundary ok')
})().catch(e=>{console.error(e);process.exitCode=1})
