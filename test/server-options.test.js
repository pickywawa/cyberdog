const assert=require('node:assert/strict'),{serverOptions}=require('../src/server-options')
const saved={website:'https://example.com/status',tags:['production','linux'],downloadDir:'/Users/test/Downloads'}
assert.deepEqual(serverOptions(saved),saved)
assert.deepEqual(serverOptions({tags:['linux','linux',' production ']}),{website:'',downloadDir:'',tags:['linux','production']})
assert.deepEqual(serverOptions({},saved),saved,'partial saves preserve synchronized preferences')
for(const v of [{website:'javascript:alert(1)'},{website:'https://user:password@example.com'},{tags:'bad'},{tags:['']},{tags:Array(31).fill('x')},{downloadDir:'bad\0path'},{website:null}])assert.throws(()=>serverOptions(v),/invalid_server_options/)
console.log('server preferences: bounded non-secret metadata, partial updates, unsafe URLs and malformed data rejected')
