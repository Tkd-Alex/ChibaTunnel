import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidNodeAddress, parseDeepLink } from '../src/main/deep-link'

const NODE = 'sentnode1d6qqywlc47cnxt4gh7pjqvjw057s7qdf64zw0u'

test('parses a complete deep link', () => {
  assert.deepEqual(
    parseDeepLink(`chibatun://connect?node=${NODE}&type=hours&amount=24`),
    { nodeAddress: NODE, subscriptionType: 'hours', amount: 24 }
  )
})

test('applies documented defaults', () => {
  assert.deepEqual(
    parseDeepLink(`chibatun://connect?node=${NODE}`),
    { nodeAddress: NODE, subscriptionType: 'gigabytes', amount: 1 }
  )
})

test('accepts the optional root path', () => {
  assert.ok(parseDeepLink(`chibatun://connect/?node=${NODE}`))
})

test('rejects an unexpected scheme, host, or path', () => {
  assert.equal(parseDeepLink(`https://connect?node=${NODE}`), null)
  assert.equal(parseDeepLink(`chibatun://other?node=${NODE}`), null)
  assert.equal(parseDeepLink(`chibatun://connect/other?node=${NODE}`), null)
})

test('rejects malformed node addresses', () => {
  assert.equal(isValidNodeAddress(NODE), true)
  assert.equal(parseDeepLink('chibatun://connect?node=sentnode123'), null)
  assert.equal(parseDeepLink(`chibatun://connect?node=${NODE}%2Fother`), null)
})

test('rejects invalid subscription types', () => {
  assert.equal(parseDeepLink(`chibatun://connect?node=${NODE}&type=minutes`), null)
})

test('rejects invalid or excessive amounts', () => {
  assert.equal(parseDeepLink(`chibatun://connect?node=${NODE}&amount=0`), null)
  assert.equal(parseDeepLink(`chibatun://connect?node=${NODE}&amount=2gb`), null)
  assert.equal(parseDeepLink(`chibatun://connect?node=${NODE}&amount=1000001`), null)
})
