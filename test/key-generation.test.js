const assert = require('assert')
const { utils } = require('ssh2')
const { generateValidatedKeyPair } = require('../src/ssh-keys')
;(async () => {
  const good = await generateValidatedKeyPair('ed25519', { comment:'regression' })
  const blob = Buffer.from(good.public.split(' ')[1], 'base64')
  const truncated = Buffer.concat([blob.subarray(0, 19), blob.subarray(20)])
  truncated.writeUInt32BE(31, 15)
  const invalid = { ...good, public: 'ssh-ed25519 ' + truncated.toString('base64') }
  assert(utils.parseKey(invalid.public) instanceof Error, '31-byte Ed25519 public keys are invalid')
  let calls = 0
  const recovered = await generateValidatedKeyPair('ed25519', {}, (_, options, callback) => callback(null, ++calls === 1 ? invalid : good))
  assert.equal(calls, 2)
  assert.equal(recovered.public, good.public)
  assert(!(utils.parseKey(recovered.private) instanceof Error))
  await assert.rejects(generateValidatedKeyPair('ed25519', {}, (_, options, callback) => callback(null, invalid)), /Unable to generate/)
  await assert.rejects(generateValidatedKeyPair('ed25519', {}, (_, options, callback) => callback(new Error('generation failed'))), /generation failed/)
  console.log('invalid SSH key generation retries and errors ok')
})().catch(e => { console.error(e); process.exitCode = 1 })
