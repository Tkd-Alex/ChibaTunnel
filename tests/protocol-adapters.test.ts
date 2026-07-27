import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  AmneziaWG,
  V2Ray,
  Xray
} from '@sentinel-official/sentinel-js-sdk'
import {
  AmneziaWGProtocolAdapter,
  applyWireGuardSplitRoutes,
  hardenV2RayConfig,
  hardenXrayConfig,
  V2RayProtocolAdapter,
  XrayProtocolAdapter,
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

test('rolls back V2Ray and transparent mode after partial startup failure', async () => {
  const calls: string[] = []
  const adapter = new V2RayProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    async start() {
      calls.push('start')
      return { pid: 123, configFile: '/tmp/chibatunnel-v2ray-test/config.json' }
    },
    stop() {
      calls.push('stop')
    },
    async startTransparent() {
      calls.push('start-transparent')
      return { success: false, error: 'TUN setup failed' }
    },
    async stopTransparent() {
      calls.push('stop-transparent')
    }
  })

  await assert.rejects(
    adapter.connect(
      new V2Ray(1080),
      { proxy: { socksPort: 1080, transparent: true } },
      {
        nodeAddress: 'sentnode1test',
        remoteAddress: 'https://203.0.113.10:12345',
        nodeAddresses: ['203.0.113.10'],
        sessionId: '42',
        mode: 'full-tunnel'
      }
    ),
    /TUN setup failed/
  )
  assert.deepEqual(calls, ['start', 'start-transparent', 'stop-transparent', 'stop'])
})

test('disables Xray sniffing without modifying SDK-generated outbounds', () => {
  const client = new Xray(1081)
  client.config.inbounds = [{
    tag: 'proxy',
    sniffing: { enabled: true, destOverride: ['http', 'tls'] }
  }]
  client.config.outbounds = [{
    tag: 'reality',
    protocol: 'vless',
    streamSettings: { security: 'reality' }
  }]
  const outbounds = JSON.parse(JSON.stringify(client.config.outbounds))

  hardenXrayConfig(client.config)

  const proxyInbound = client.config.inbounds[0] as {
    sniffing: { enabled: boolean }
  }
  assert.equal(proxyInbound.sniffing.enabled, false)
  assert.deepEqual(client.config.outbounds, outbounds)
})

test('rolls back Xray and transparent mode after partial startup failure', async () => {
  const calls: string[] = []
  const adapter = new XrayProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    async start() {
      calls.push('start')
      return { pid: 456, configFile: '/tmp/chibatunnel-xray-test/client.json' }
    },
    stop() {
      calls.push('stop')
    },
    async startTransparent() {
      calls.push('start-transparent')
      return { success: false, error: 'Xray TUN setup failed' }
    },
    async stopTransparent() {
      calls.push('stop-transparent')
    }
  })

  await assert.rejects(
    adapter.connect(
      new Xray(1081),
      { proxy: { socksPort: 1081, transparent: true } },
      {
        nodeAddress: 'sentnode1test',
        remoteAddress: 'https://203.0.113.20:12345',
        nodeAddresses: ['203.0.113.20'],
        sessionId: '43',
        mode: 'full-tunnel'
      }
    ),
    /Xray TUN setup failed/
  )
  assert.deepEqual(calls, ['start', 'start-transparent', 'stop-transparent', 'stop'])
})

test('preserves every AmneziaWG obfuscation field in the prepared config', async () => {
  const adapter = new AmneziaWGProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    nextInterfaceName() {
      return 'chibaawg0'
    },
    async up() {
      return { success: true }
    },
    async down() {}
  }, {
    dns: ['1.1.1.1'],
    splitRoutes: '10.0.0.0/8'
  })
  const client = new AmneziaWG()
  const prepared = await adapter.parseHandshake(
    client,
    {
      addrs: ['10.8.0.2/32'],
      metadata: [{
        port: 51820,
        public_key: Buffer.alloc(32, 7).toString('base64'),
        s1: 10,
        s2: 20,
        s3: 30,
        s4: 15,
        h1: 1001,
        h2: 1002,
        h3: 1003,
        h4: 1004,
        i1: '<b 0x01>'
      }]
    },
    {
      nodeAddress: 'sentnode1test',
      remoteAddress: 'https://203.0.113.30:12345',
      nodeAddresses: ['203.0.113.30'],
      sessionId: '44',
      mode: 'full-tunnel'
    }
  )
  const config = fs.readFileSync(prepared.configPaths[0], 'utf8')

  assert.match(config, /^S1 = 10$/m)
  assert.match(config, /^S2 = 20$/m)
  assert.match(config, /^S3 = 30$/m)
  assert.match(config, /^S4 = 15$/m)
  assert.match(config, /^H4 = 1004$/m)
  assert.match(config, /^I1 = <b 0x01>$/m)
  assert.match(config, /^AllowedIPs = 10\.0\.0\.0\/8$/m)
  await adapter.cleanup(client)
  assert.equal(fs.existsSync(prepared.configPaths[0]), false)
})
