import assert from 'node:assert/strict'
import test from 'node:test'
import { Hysteria2 } from '@sentinel-official/sentinel-js-sdk'
import { PROTOCOL_IDS } from '../src/shared/protocols'
import {
  buildHysteria2Config,
  createSdkVpnClient,
  decodeHandshakeData,
  getSdkPeerRequest
} from '../src/main/protocols'

test('creates an SDK client and peer request for every registered protocol', () => {
  for (const protocol of PROTOCOL_IDS) {
    const client = createSdkVpnClient(protocol)
    assert.equal(typeof client, 'object')
    assert.equal(typeof getSdkPeerRequest(client), 'object')
  }
})

test('decodes only canonical bounded Base64 JSON handshake data', () => {
  const valid = Buffer.from(JSON.stringify({ metadata: [] }), 'utf8').toString('base64')
  assert.deepEqual(decodeHandshakeData(valid), { metadata: [] })
  assert.throws(() => decodeHandshakeData('%%%'), /canonical Base64/)
  assert.throws(() => decodeHandshakeData(Buffer.from('no json').toString('base64')), /valid JSON/)
  assert.throws(() => decodeHandshakeData('A'.repeat(2_000_001)), /maximum accepted size/)
})

test('builds Hysteria2 SOCKS and TUN configurations from SDK-validated data', () => {
  const client = new Hysteria2()
  client.parseConfig(
    {
      metadata: [{
        port: 443,
        tls_pin: 'ab'.repeat(32),
        obfs_password: 'test-obfuscation'
      }]
    },
    ['203.0.113.10']
  )

  const proxy = buildHysteria2Config(client, 'local-proxy', 1080)
  assert.match(proxy, /socks5:\n  listen: "127\.0\.0\.1:1080"/)
  assert.doesNotMatch(proxy, /^tun:/m)
  assert.match(proxy, /obfs:\n  type: salamander/)
  assert.match(proxy, /203\.0\.113\.10:443/)

  const tunnel = buildHysteria2Config(client, 'full-tunnel')
  assert.match(tunnel, /^tun:/m)
  assert.doesNotMatch(tunnel, /^socks5:/m)
})

test('rejects invalid Hysteria2 SOCKS ports', () => {
  const client = new Hysteria2()
  client.parseConfig(
    {
      metadata: [{
        port: 443,
        tls_pin: 'cd'.repeat(32),
        obfs_password: ''
      }]
    },
    ['203.0.113.11']
  )

  assert.throws(() => buildHysteria2Config(client, 'local-proxy', 0), /SOCKS port/)
  assert.throws(() => buildHysteria2Config(client, 'local-proxy', 65536), /SOCKS port/)
})
