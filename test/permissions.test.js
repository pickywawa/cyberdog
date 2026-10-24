const assert = require('node:assert/strict')
const { parseUsers, applyAttributes } = require('../src/permissions')
const users = parseUsers('root:x:0:0::/root:/bin/bash\napp:x:1000:1000::/srv:/bin/bash\nalias:x:1000:1000::::\nbad:x:no:0::::\n')
assert.deepEqual(users,[{name:'app',uid:1000},{name:'root',uid:0}])
;(async () => {
  const calls=[]
  const sftp={
    stat: (file,cb)=>{ calls.push('stat');cb(null,{uid:1000,gid:50,mode:0o100644}) },
    chown: (file,uid,gid,cb)=>{ calls.push(['chown',uid,gid]);cb() },
    chmod: (file,mode,cb)=>{ calls.push(['chmod',mode]);cb() },
  }
  await applyAttributes(sftp,'/srv/file',{uid:0,mode:'4755'})
  assert.deepEqual(calls.splice(0),['stat',['chown',0,50],['chmod',0o4755]],'chown precedes chmod and retains original group and requested special bits')
  await applyAttributes(sftp,'/srv/file',{uid:1000,mode:'0644'})
  assert.deepEqual(calls.splice(0),['stat'],'unchanged metadata requires no write')
  for(const attrs of [{uid:-1,mode:'644'},{uid:0xffffffff,mode:'644'},{uid:1.5,mode:'644'},{uid:0,mode:'0888'},{uid:0,mode:'chmod 777'}]) await assert.rejects(applyAttributes(sftp,'/srv/file',attrs))
  assert.deepEqual(calls,[],'invalid input must not touch the remote file')
  const denied={...sftp,chown:(...args)=>args.at(-1)(new Error('Permission denied'))}
  await assert.rejects(applyAttributes(denied,'/srv/file',{uid:0,mode:'0755'}),/Permission denied/)
  assert.deepEqual(calls.splice(0),['stat'],'failed owner change must not change permissions')
  const partial={...sftp,chmod:(...args)=>args.at(-1)(new Error('Permission denied'))}
  await assert.rejects(applyAttributes(partial,'/srv/file',{uid:0,mode:'0755'}),e=>e.ownerChanged===true)
  console.log('permissions ok')
})().catch(e=>{console.error(e);process.exitCode=1})
