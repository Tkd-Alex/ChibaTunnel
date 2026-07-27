import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROTOCOL_IDS,
  PROTOCOL_REGISTRY,
  getRequiredBinaries,
  normalizeIndexedNodeType,
  normalizeServiceType,
  protocolSupportsMode
} from '../src/shared/protocols'

test('registry contains one valid descriptor for every protocol', () => {
  assert.deepEqual(Object.keys(PROTOCOL_REGISTRY), [...PROTOCOL_IDS])

  for (const protocol of PROTOCOL_IDS) {
    const descriptor = PROTOCOL_REGISTRY[protocol]
    assert.equal(descriptor.id, protocol)
    assert.ok(descriptor.aliases.length > 0)
    assert.ok(descriptor.modes.includes(descriptor.defaultMode))
    assert.ok(getRequiredBinaries(protocol, descriptor.defaultMode).length > 0)
  }
})

test('normalizes canonical service types and documented aliases', () => {
  const cases = {
    wireguard: ['wireguard', 'Wire Guard', 'wire_guard', 'wg'],
    v2ray: ['v2ray', 'V2-Ray', 'v2_ray'],
    openvpn: ['openvpn', 'Open VPN', 'open_vpn'],
    xray: ['xray', 'X-Ray', 'x_ray'],
    amneziawg: ['amneziawg', 'Amnezia-WG', 'amnezia_wg', 'awg'],
    hysteria2: ['hysteria2', 'Hysteria-2', 'hysteria_2', 'hy2']
  } as const

  for (const [expected, aliases] of Object.entries(cases)) {
    for (const alias of aliases) {
      assert.equal(normalizeServiceType(alias), expected)
    }
  }
})

test('never falls back for an unknown or malformed service type', () => {
  assert.equal(normalizeServiceType('future-vpn'), null)
  assert.equal(normalizeServiceType(''), null)
  assert.equal(normalizeServiceType(2), null)
  assert.equal(normalizeServiceType({ service_type: 'v2ray' }), null)
})

test('keeps the legacy index mapping deliberately limited to known values', () => {
  assert.equal(normalizeIndexedNodeType(1), 'wireguard')
  assert.equal(normalizeIndexedNodeType('2'), 'v2ray')
  assert.equal(normalizeIndexedNodeType(3), null)
  assert.equal(normalizeIndexedNodeType('openvpn'), 'openvpn')
})

test('models proxy and full-tunnel modes explicitly', () => {
  assert.equal(protocolSupportsMode('wireguard', 'local-proxy'), false)
  assert.equal(protocolSupportsMode('xray', 'local-proxy'), true)
  assert.equal(protocolSupportsMode('xray', 'full-tunnel'), true)
  assert.equal(protocolSupportsMode('hysteria2', 'local-proxy'), true)
  assert.equal(protocolSupportsMode('hysteria2', 'full-tunnel'), true)
  assert.deepEqual(getRequiredBinaries('hysteria2', 'local-proxy'), ['hysteria2'])
  assert.deepEqual(getRequiredBinaries('amneziawg', 'full-tunnel', 'win32'), ['amneziawg'])
  assert.deepEqual(getRequiredBinaries('amneziawg', 'full-tunnel', 'linux'), ['awg-quick'])
  assert.deepEqual(
    getRequiredBinaries('xray', 'full-tunnel', 'win32'),
    ['xray', 'tun2socks', 'wintun']
  )
})
