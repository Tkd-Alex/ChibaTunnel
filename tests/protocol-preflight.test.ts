import assert from 'node:assert/strict'
import test from 'node:test'
import type { BinaryCheckResult } from '../src/shared/binaries'
import { preflightProtocol } from '../src/main/protocols'

const available = (id: BinaryCheckResult['id']): BinaryCheckResult => ({
  id,
  status: 'ok',
  source: 'bundled',
  path: `/runtime/${id}`,
  executable: true
})

test('passes a proxy preflight without requiring the privileged helper', async () => {
  let helperChecks = 0
  const result = await preflightProtocol({
    protocol: 'hysteria2',
    mode: 'local-proxy',
    platform: 'linux',
    resolveBinary: available,
    checkHelper: async () => { helperChecks += 1; return false }
  })

  assert.equal(result.ok, true)
  assert.equal(helperChecks, 0)
  assert.deepEqual(result.binaries?.map(binary => binary.id), ['hysteria2'])
})

test('requires the helper for full-tunnel mode', async () => {
  const result = await preflightProtocol({
    protocol: 'hysteria2',
    mode: 'full-tunnel',
    platform: 'linux',
    resolveBinary: available,
    checkHelper: async () => false
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, ['HELPER_UNAVAILABLE'])
})

test('reports every missing runtime before a paid session', async () => {
  const result = await preflightProtocol({
    protocol: 'xray',
    mode: 'full-tunnel',
    platform: 'win32',
    resolveBinary: id => ({ id, status: 'missing', errorCode: 'BINARY_NOT_FOUND' }),
    checkHelper: async () => true
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    'BINARY_MISSING:xray:BINARY_NOT_FOUND',
    'BINARY_MISSING:tun2socks:BINARY_NOT_FOUND',
    'BINARY_MISSING:wintun:BINARY_NOT_FOUND'
  ])
})

test('rejects a mode the protocol does not implement', async () => {
  const result = await preflightProtocol({
    protocol: 'openvpn',
    mode: 'local-proxy',
    platform: 'linux',
    resolveBinary: available,
    checkHelper: async () => true
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, ['UNSUPPORTED_MODE:openvpn:local-proxy'])
})

test('rejects AmneziaWG on Linux when kernel and userspace support are unavailable', async () => {
  let supportChecks = 0
  const result = await preflightProtocol({
    protocol: 'amneziawg',
    mode: 'full-tunnel',
    platform: 'linux',
    resolveBinary: available,
    checkHelper: async () => true,
    checkAmneziaWgSupport: async () => {
      supportChecks += 1
      return false
    }
  })

  assert.equal(result.ok, false)
  assert.equal(supportChecks, 1)
  assert.deepEqual(result.errors, ['SYSTEM_SUPPORT_MISSING:amneziawg'])
})
