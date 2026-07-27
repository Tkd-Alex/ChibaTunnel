import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWireGuardSplitRoutes,
  hardenV2RayConfig,
  type V2RayConfig
} from '../src/main/protocols'

test('applies only validated CIDR routes to WireGuard configurations', () => {
  const config = [
    '[Interface]',
    'Address = 10.0.0.2/32',
    '',
    '[Peer]',
    'AllowedIPs = 0.0.0.0/0,::/0'
  ].join('\n')

  const result = applyWireGuardSplitRoutes(
    config,
    '10.0.0.0/8, 2001:db8::/32'
  )
  assert.match(result, /^AllowedIPs = 10\.0\.0\.0\/8,2001:db8::\/32$/m)
  assert.throws(
    () => applyWireGuardSplitRoutes(config, '10.0.0.0/8\nPostUp = touch /tmp/pwned'),
    /Invalid split-tunnel route/
  )
  assert.throws(
    () => applyWireGuardSplitRoutes(config, '203.0.113.0/99'),
    /Invalid split-tunnel route/
  )
})

test('disables V2Ray sniffing and enables observatory health checks safely', () => {
  const config: V2RayConfig = {
    inbounds: [{
      tag: 'proxy',
      sniffing: { enabled: true }
    }],
    routing: {
      balancers: [{ selector: ['outbound-a', 'outbound-b'] }]
    }
  }

  hardenV2RayConfig(config)

  assert.equal(config.inbounds?.[0].sniffing?.enabled, false)
  assert.deepEqual(config.observatory, {
    subjectSelector: ['outbound-a', 'outbound-b'],
    probeInterval: '30s',
    probeUrl: 'https://www.google.com/generate_204'
  })
})
