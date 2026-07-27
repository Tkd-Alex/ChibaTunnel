import assert from 'node:assert/strict'
import test from 'node:test'
import { GasPrice } from '@cosmjs/stargate'
import {
  AmneziaWG,
  Hysteria2,
  NodeVPNType,
  OpenVPN,
  V2Ray,
  Wireguard,
  Xray
} from '@sentinel-official/sentinel-js-sdk'

test('SDK 2.1 exposes every supported VPN protocol', () => {
  assert.deepEqual(Object.values(NodeVPNType).sort(), [
    'amneziawg',
    'hysteria2',
    'openvpn',
    'v2ray',
    'wireguard',
    'xray'
  ])
})

test('every SDK VPN client exposes its expected peer request', () => {
  const wireguard = new Wireguard().getPeerRequest()
  const v2ray = new V2Ray().getPeerRequest()
  const openvpn = new OpenVPN().getPeerRequest()
  const xray = new Xray().getPeerRequest()
  const amneziawg = new AmneziaWG().getPeerRequest()
  const hysteria2 = new Hysteria2().getPeerRequest()

  assert.match(wireguard.public_key, /^[A-Za-z0-9+/]{43}=$/)
  assert.equal(v2ray.uuid.length, 16)
  assert.equal(openvpn.uuid.length, 16)
  assert.equal(xray.uuid.length, 16)
  assert.match(amneziawg.public_key, /^[A-Za-z0-9+/]{43}=$/)
  assert.match(hysteria2.uuid, /^[0-9a-f-]{36}$/)
})

test('application and SDK share the same CosmJS GasPrice implementation', () => {
  assert.equal(GasPrice.fromString('0.2udvpn').toString(), '0.2udvpn')
})
