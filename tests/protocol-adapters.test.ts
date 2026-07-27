import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  AmneziaWG,
  Hysteria2,
  OpenVPN,
  V2Ray,
  Xray
} from '@sentinel-official/sentinel-js-sdk'
import {
  AmneziaWGProtocolAdapter,
  Hysteria2ProtocolAdapter,
  OpenVPNProtocolAdapter,
  applyWireGuardSplitRoutes,
  hardenV2RayConfig,
  hardenXrayConfig,
  stripWireGuardDns,
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

const hysteriaHandshake = {
  metadata: [{
    port: 443,
    tls_pin: 'ab'.repeat(32),
    obfs_password: 'do-not-log-this-secret'
  }]
}

test('builds Hysteria2 local proxy config without a privileged TUN section', async () => {
  const calls: string[] = []
  const adapter = new Hysteria2ProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    async allocateSocksPort() {
      return 1082
    },
    nextInterfaceName() {
      return 'chibahy0'
    },
    async startLocal() {
      calls.push('start-local')
      return { pid: 789 }
    },
    async stopLocal() {
      calls.push('stop-local')
    },
    async startFull() {
      throw new Error('unexpected full-tunnel start')
    },
    async stopFull() {
      throw new Error('unexpected full-tunnel stop')
    }
  })
  const client = new Hysteria2()
  const context = {
    nodeAddress: 'sentnode1test',
    remoteAddress: 'https://203.0.113.40:12345',
    nodeAddresses: ['203.0.113.40'],
    sessionId: '45',
    mode: 'local-proxy' as const
  }
  const prepared = await adapter.parseHandshake(client, hysteriaHandshake, context)
  const config = fs.readFileSync(prepared.localConfigFile, 'utf8')

  assert.doesNotMatch(config, /^tun:$/m)
  assert.match(config, /^socks5:$/m)
  assert.match(config, /^  listen: "127\.0\.0\.1:1082"$/m)
  const runtime = await adapter.connect(client, prepared, context)
  assert.deepEqual(runtime.proxy, { socksPort: 1082, transparent: false })
  await adapter.disconnect(runtime)
  assert.deepEqual(calls, ['start-local', 'stop-local'])
  await adapter.cleanup(client, runtime)
  assert.equal(fs.existsSync(prepared.localConfigFile), false)
})

test('keeps Hysteria2 endpoint excluded from native full-tunnel routes', async () => {
  const calls: string[] = []
  const adapter = new Hysteria2ProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    async allocateSocksPort() {
      return 1083
    },
    nextInterfaceName() {
      return 'chibahy1'
    },
    async startLocal() {
      throw new Error('unexpected local start')
    },
    async stopLocal() {
      throw new Error('unexpected local stop')
    },
    async startFull() {
      calls.push('start-full')
      return { pid: 790, interfaceName: 'chibahy1' }
    },
    async stopFull() {
      calls.push('stop-full')
    }
  })
  const client = new Hysteria2()
  const context = {
    nodeAddress: 'sentnode1test',
    remoteAddress: 'https://203.0.113.40:12345',
    nodeAddresses: ['203.0.113.40'],
    sessionId: '46',
    mode: 'full-tunnel' as const
  }
  const prepared = await adapter.parseHandshake(client, hysteriaHandshake, context)
  const config = fs.readFileSync(prepared.fullConfigFile, 'utf8')

  assert.match(config, /^tun:$/m)
  assert.match(config, /^  name: "chibahy1"$/m)
  assert.match(config, /^      - "203\.0\.113\.40\/32"$/m)
  const runtime = await adapter.connect(client, prepared, context)
  assert.equal(runtime.interfaceName, 'chibahy1')
  await adapter.disconnect(runtime)
  assert.deepEqual(calls, ['start-full', 'stop-full'])
  await adapter.cleanup(client, runtime)
})

test('keeps OpenVPN PKI private and removes it after disconnect', async () => {
  const calls: string[] = []
  const adapter = new OpenVPNProtocolAdapter({
    async preflight() {
      return { ok: true, errors: [], warnings: [] }
    },
    async start() {
      calls.push('start')
      return { pid: 791, interfaceName: 'ovpn0' }
    },
    async stop() {
      calls.push('stop')
    }
  })
  const client = new OpenVPN()
  const context = {
    nodeAddress: 'sentnode1test',
    remoteAddress: 'https://203.0.113.50:12345',
    nodeAddresses: ['203.0.113.50'],
    sessionId: '47',
    mode: 'full-tunnel' as const
  }
  const bytes = (value: string) => Buffer.from(value).toString('base64')
  const prepared = await adapter.parseHandshake(client, {
    metadata: [{
      port: 1194,
      protocol: 'udp',
      ca: bytes('test-ca'),
      tls: bytes('test-tls')
    }],
    cert: bytes('test-cert'),
    key: bytes('test-private-key')
  }, context)
  const configFile = prepared.configPaths[0]
  const pkiDirectory = path.join(path.dirname(configFile), 'pki')

  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(pkiDirectory, 'client.key')).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(configFile, 'utf8'), /^remote 203\.0\.113\.50 1194$/m)
  const runtime = await adapter.connect(client, prepared, context)
  assert.equal(runtime.interfaceName, 'ovpn0')
  await adapter.disconnect(runtime)
  await adapter.cleanup(client, runtime)
  assert.deepEqual(calls, ['start', 'stop'])
  assert.equal(fs.existsSync(pkiDirectory), false)
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

test('strips DNS without changing AmneziaWG obfuscation fields', () => {
  const config = [
    '[Interface]',
    'DNS = 1.1.1.1, 1.0.0.1',
    'Jc = 7',
    'S1 = 10',
    'H1 = 1001',
    '',
    '[Peer]',
    'AllowedIPs = 0.0.0.0/0'
  ].join('\n')

  const stripped = stripWireGuardDns(config)
  assert.doesNotMatch(stripped, /^DNS\s*=/m)
  assert.match(stripped, /^Jc = 7$/m)
  assert.match(stripped, /^S1 = 10$/m)
  assert.match(stripped, /^H1 = 1001$/m)
  assert.match(stripped, /^AllowedIPs = 0\.0\.0\.0\/0$/m)
})
