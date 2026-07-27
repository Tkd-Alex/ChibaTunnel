import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionLifecycle } from '../src/main/protocols/lifecycle'

test('accepts the complete connection and disconnect lifecycle', () => {
  const lifecycle = new ConnectionLifecycle()
  const operationId = lifecycle.begin()

  lifecycle.transition('creating-session', operationId)
  lifecycle.transition('handshaking', operationId)
  lifecycle.transition('preparing-config', operationId)
  lifecycle.transition('starting-runtime', operationId)
  lifecycle.transition('connected', operationId)
  lifecycle.transition('disconnecting', operationId)
  lifecycle.reset(operationId)

  assert.equal(lifecycle.phase, 'idle')
})

test('supports an existing on-chain session without creating another one', () => {
  const lifecycle = new ConnectionLifecycle()
  const operationId = lifecycle.begin()

  lifecycle.transition('handshaking', operationId)
  assert.equal(lifecycle.phase, 'handshaking')
})

test('rejects invalid transitions and concurrent starts', () => {
  const lifecycle = new ConnectionLifecycle()
  lifecycle.begin()

  assert.throws(() => lifecycle.begin(), /Cannot begin/)
  assert.throws(() => lifecycle.transition('connected'), /Invalid connection transition/)
})

test('rejects stale asynchronous operations', () => {
  const lifecycle = new ConnectionLifecycle()
  const firstOperation = lifecycle.begin()
  lifecycle.fail(firstOperation)
  lifecycle.reset(firstOperation)
  const secondOperation = lifecycle.begin()

  assert.notEqual(firstOperation, secondOperation)
  assert.throws(
    () => lifecycle.transition('creating-session', firstOperation),
    /Stale connection operation/
  )
})

test('allows failure cleanup to be idempotent', () => {
  const lifecycle = new ConnectionLifecycle()
  const operationId = lifecycle.begin()
  lifecycle.transition('handshaking', operationId)
  lifecycle.fail(operationId)
  lifecycle.fail(operationId)
  lifecycle.transition('disconnecting', operationId)
  lifecycle.reset(operationId)

  assert.equal(lifecycle.phase, 'idle')
})
