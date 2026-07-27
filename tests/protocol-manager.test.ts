import assert from 'node:assert/strict'
import test from 'node:test'
import { getProtocolDescriptor } from '../src/shared/protocols'
import { ProtocolConnectionManager } from '../src/main/protocols/manager'
import type {
  PreparedProtocolConfig,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from '../src/main/protocols/types'

interface FakeClient {
  cleaned: boolean
}

function createAdapter(overrides: {
  preflightOk?: boolean
  failPrepare?: boolean
  failConnect?: boolean
  calls?: string[]
  contexts?: ProtocolContext[]
} = {}): ProtocolAdapter<FakeClient, unknown> {
  const calls = overrides.calls ?? []
  let remainingConnectFailures = overrides.failConnect ? 1 : 0
  return {
    descriptor: getProtocolDescriptor('v2ray'),
    createClient() {
      calls.push('create')
      return { cleaned: false }
    },
    getPeerRequest() {
      calls.push('peer')
      return { uuid: [1, 2, 3] }
    },
    async preflight() {
      calls.push('preflight')
      return {
        ok: overrides.preflightOk !== false,
        errors: overrides.preflightOk === false ? ['BINARY_MISSING:v2ray'] : [],
        warnings: []
      }
    },
    async parseHandshake(_client, _data, context) {
      calls.push('prepare')
      overrides.contexts?.push(context)
      if (overrides.failPrepare) throw new Error('invalid handshake')
      return {
        configPaths: ['/tmp/chibatunnel-v2ray-test/config.json'],
        proxy: { socksPort: 1080, transparent: false }
      }
    },
    async connect(
      _client: FakeClient,
      prepared: PreparedProtocolConfig,
      _context: ProtocolContext
    ) {
      calls.push('connect')
      if (remainingConnectFailures > 0) {
        remainingConnectFailures -= 1
        throw new Error('runtime failed')
      }
      return {
        configPaths: prepared.configPaths,
        processes: [],
        proxy: { socksPort: 1080, transparent: false }
      }
    },
    async disconnect(_connection: RuntimeConnection) {
      calls.push('disconnect')
    },
    async cleanup(client: FakeClient) {
      calls.push('cleanup')
      client.cleaned = true
    }
  }
}

const beginOptions = {
  protocol: 'v2ray' as const,
  mode: 'local-proxy' as const,
  nodeAddress: 'sentnode1test',
  remoteAddress: 'https://203.0.113.10:12345',
  nodeAddresses: ['203.0.113.10'],
  sessionId: '42'
}

test('serializes prepare, runtime start and disconnect through one active connection', async () => {
  const calls: string[] = []
  const manager = new ProtocolConnectionManager()
  const pending = await manager.begin(beginOptions, createAdapter({ calls }))

  assert.deepEqual(pending.peerRequest, { uuid: [1, 2, 3] })
  assert.equal(manager.phase, 'handshaking')
  assert.equal(manager.active?.sessionId, '42')

  await manager.prepare(pending.operationId, { metadata: [] }, ['198.51.100.8'])
  assert.equal(manager.phase, 'preparing-config')
  assert.deepEqual(manager.active?.nodeAddresses, ['198.51.100.8'])

  await manager.connect(pending.operationId)
  assert.equal(manager.phase, 'connected')

  await manager.disconnect()
  assert.equal(manager.phase, 'idle')
  assert.equal(manager.active, null)
  assert.deepEqual(calls, [
    'preflight',
    'create',
    'peer',
    'prepare',
    'connect',
    'disconnect',
    'cleanup'
  ])
})

test('rejects concurrent connections before creating another SDK client', async () => {
  const manager = new ProtocolConnectionManager()
  await manager.begin(beginOptions, createAdapter())

  await assert.rejects(
    manager.begin(beginOptions, createAdapter()),
    /Cannot begin a connection/
  )
  await manager.disconnect()
})

test('keeps prepared state retryable when runtime startup fails', async () => {
  const calls: string[] = []
  const manager = new ProtocolConnectionManager()
  const pending = await manager.begin(beginOptions, createAdapter({ calls, failConnect: true }))
  await manager.prepare(pending.operationId, {})

  await assert.rejects(manager.connect(pending.operationId), /runtime failed/)
  assert.equal(manager.phase, 'failed')
  assert.ok(manager.active?.prepared)

  await manager.retry(pending.operationId)
  assert.equal(manager.phase, 'connected')
  assert.equal(calls.filter(call => call === 'preflight').length, 2)
  await manager.disconnect()
})

test('cleans the SDK client and becomes retryable after invalid handshake data', async () => {
  const calls: string[] = []
  const manager = new ProtocolConnectionManager()
  const pending = await manager.begin(beginOptions, createAdapter({ calls, failPrepare: true }))

  await assert.rejects(manager.prepare(pending.operationId, {}), /invalid handshake/)
  assert.equal(manager.phase, 'idle')
  assert.equal(manager.active, null)

  const retry = await manager.begin(beginOptions, createAdapter())
  assert.ok(retry.operationId > pending.operationId)
  await manager.disconnect()
})

test('fails preflight without leaving a half-created connection', async () => {
  const calls: string[] = []
  const manager = new ProtocolConnectionManager()

  await assert.rejects(
    manager.begin(beginOptions, createAdapter({ calls, preflightOk: false })),
    /BINARY_MISSING:v2ray/
  )
  assert.equal(manager.phase, 'idle')
  assert.equal(manager.active, null)
  assert.deepEqual(calls, ['preflight'])
})

test('preserves node addresses for SDK parsing and rejects unsupported modes before starting', async () => {
  const contexts: ProtocolContext[] = []
  const manager = new ProtocolConnectionManager()
  const pending = await manager.begin(beginOptions, createAdapter({ contexts }))
  await manager.prepare(pending.operationId, {})
  assert.deepEqual(contexts[0].nodeAddresses, ['203.0.113.10'])
  await manager.disconnect()

  await assert.rejects(
    manager.begin(
      { ...beginOptions, protocol: 'wireguard', mode: 'local-proxy' },
      { ...createAdapter(), descriptor: getProtocolDescriptor('wireguard') }
    ),
    /Unsupported mode/
  )
  assert.equal(manager.phase, 'idle')
})

test('re-runs preflight when proxy mode changes before runtime startup', async () => {
  const calls: string[] = []
  const manager = new ProtocolConnectionManager()
  const pending = await manager.begin(beginOptions, createAdapter({ calls }))
  await manager.prepare(pending.operationId, {})
  await manager.setMode(pending.operationId, 'full-tunnel')

  assert.equal(manager.active?.mode, 'full-tunnel')
  assert.equal(calls.filter(call => call === 'preflight').length, 2)
  await manager.disconnect()
})
