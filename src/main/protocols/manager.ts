import { getProtocolDescriptor, type ProtocolId, type TunnelMode } from '../../shared/protocols'
import { ConnectionLifecycle } from './lifecycle'
import type {
  ActiveConnection,
  PreparedProtocolConfig,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface BeginConnectionOptions {
  protocol: ProtocolId
  mode: TunnelMode
  nodeAddress: string
  remoteAddress: string
  nodeAddresses: string[]
  sessionId: string
}

export interface PendingHandshake {
  operationId: number
  peerRequest: unknown
}

type ManagedAdapter = ProtocolAdapter<unknown, unknown>
type ManagedConnection = ActiveConnection<unknown>

export class ProtocolConnectionManager {
  private readonly lifecycle = new ConnectionLifecycle()
  private activeValue: ManagedConnection | null = null

  get active(): Readonly<ManagedConnection> | null {
    return this.activeValue
  }

  get phase() {
    return this.lifecycle.phase
  }

  async begin(
    options: BeginConnectionOptions,
    adapter: ManagedAdapter
  ): Promise<PendingHandshake> {
    if (adapter.descriptor.id !== options.protocol) {
      throw new Error(
        `Protocol adapter mismatch: expected ${options.protocol}, received ${adapter.descriptor.id}`
      )
    }

    const context = this.createContext(options)
    const operationId = this.lifecycle.begin()
    let client: unknown

    try {
      const preflight = await adapter.preflight(context)
      this.lifecycle.assertCurrent(operationId)
      if (!preflight.ok) {
        throw new Error(`Runtime preflight failed: ${preflight.errors.join(', ')}`)
      }

      client = adapter.createClient()
      this.lifecycle.transition('handshaking', operationId)
      this.activeValue = {
        operationId,
        protocol: options.protocol,
        mode: options.mode,
        nodeAddress: options.nodeAddress,
        remoteAddress: options.remoteAddress,
        nodeAddresses: [...options.nodeAddresses],
        sessionId: options.sessionId,
        adapter,
        sdkClient: client,
        createdAt: Date.now(),
        phase: this.lifecycle.phase
      }

      return {
        operationId,
        peerRequest: adapter.getPeerRequest(client)
      }
    } catch (error) {
      if (client !== undefined) {
        await this.safelyCleanup(adapter, client)
      }
      this.failAndReset(operationId)
      throw error
    }
  }

  async prepare(
    operationId: number,
    handshakeData: unknown,
    nodeAddresses?: string[]
  ): Promise<PreparedProtocolConfig> {
    const active = this.requireActive(operationId)
    try {
      if (nodeAddresses) active.nodeAddresses = [...nodeAddresses]
      this.lifecycle.transition('preparing-config', operationId)
      this.syncPhase()
      const prepared = await active.adapter.parseHandshake(
        active.sdkClient,
        handshakeData,
        this.contextFromActive(active)
      )
      this.lifecycle.assertCurrent(operationId)
      active.prepared = prepared
      return prepared
    } catch (error) {
      await this.rollback(operationId)
      throw error
    }
  }

  async retry(operationId: number): Promise<RuntimeConnection> {
    const active = this.requireActive(operationId)
    if (!active.prepared) throw new Error('Protocol configuration has not been prepared')
    if (this.lifecycle.phase !== 'failed') {
      throw new Error(`Cannot retry runtime while phase is "${this.lifecycle.phase}"`)
    }

    try {
      this.lifecycle.transition('recovering', operationId)
      this.syncPhase()
      const preflight = await active.adapter.preflight(this.contextFromActive(active))
      this.lifecycle.assertCurrent(operationId)
      if (!preflight.ok) {
        throw new Error(`Runtime preflight failed: ${preflight.errors.join(', ')}`)
      }
      this.lifecycle.transition('starting-runtime', operationId)
      this.syncPhase()
      const runtime = await active.adapter.connect(
        active.sdkClient,
        active.prepared,
        this.contextFromActive(active)
      )
      this.lifecycle.assertCurrent(operationId)
      active.runtime = runtime
      this.lifecycle.transition('connected', operationId)
      this.syncPhase()
      return runtime
    } catch (error) {
      this.lifecycle.fail(operationId)
      this.syncPhase()
      throw error
    }
  }

  async setMode(operationId: number, mode: TunnelMode): Promise<void> {
    const active = this.requireActive(operationId)
    if (this.lifecycle.phase !== 'preparing-config') {
      throw new Error(`Cannot change tunnel mode while phase is "${this.lifecycle.phase}"`)
    }
    if (!active.adapter.descriptor.modes.includes(mode)) {
      throw new Error(`Unsupported mode for ${active.protocol}: ${mode}`)
    }
    if (active.mode === mode) return

    const context = this.contextFromActive(active)
    context.mode = mode
    const preflight = await active.adapter.preflight(context)
    this.lifecycle.assertCurrent(operationId)
    if (!preflight.ok) {
      throw new Error(`Runtime preflight failed: ${preflight.errors.join(', ')}`)
    }
    active.mode = mode
  }

  async connect(operationId: number): Promise<RuntimeConnection> {
    const active = this.requireActive(operationId)
    if (!active.prepared) throw new Error('Protocol configuration has not been prepared')

    try {
      this.lifecycle.transition('starting-runtime', operationId)
      this.syncPhase()
      const runtime = await active.adapter.connect(
        active.sdkClient,
        active.prepared,
        this.contextFromActive(active)
      )
      this.lifecycle.assertCurrent(operationId)
      active.runtime = runtime
      this.lifecycle.transition('connected', operationId)
      this.syncPhase()
      return runtime
    } catch (error) {
      this.lifecycle.fail(operationId)
      this.syncPhase()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    const active = this.activeValue
    if (!active) {
      if (this.lifecycle.phase !== 'idle') {
        throw new Error(`Connection state is ${this.lifecycle.phase} without an active connection`)
      }
      return
    }

    const operationId = active.operationId
    let disconnectError: unknown
    try {
      this.lifecycle.transition('disconnecting', operationId)
      this.syncPhase()
      if (active.runtime) await active.adapter.disconnect(active.runtime)
    } catch (error) {
      disconnectError = error
    }

    try {
      await active.adapter.cleanup(active.sdkClient, active.runtime)
    } catch (error) {
      disconnectError ??= error
    } finally {
      this.activeValue = null
      this.lifecycle.reset(operationId)
    }

    if (disconnectError) throw disconnectError
  }

  private createContext(options: BeginConnectionOptions): ProtocolContext {
    if (!getProtocolDescriptor(options.protocol).modes.includes(options.mode)) {
      throw new Error(`Unsupported mode for ${options.protocol}: ${options.mode}`)
    }
    return {
      nodeAddress: options.nodeAddress,
      remoteAddress: options.remoteAddress,
      nodeAddresses: [...options.nodeAddresses],
      sessionId: options.sessionId,
      mode: options.mode
    }
  }

  private contextFromActive(active: ManagedConnection): ProtocolContext {
    return {
      nodeAddress: active.nodeAddress,
      remoteAddress: active.remoteAddress,
      nodeAddresses: [...active.nodeAddresses],
      sessionId: active.sessionId,
      mode: active.mode
    }
  }

  private requireActive(operationId: number): ManagedConnection {
    this.lifecycle.assertCurrent(operationId)
    if (!this.activeValue || this.activeValue.operationId !== operationId) {
      throw new Error('No active connection for this operation')
    }
    return this.activeValue
  }

  private syncPhase(): void {
    if (this.activeValue) this.activeValue.phase = this.lifecycle.phase
  }

  private async rollback(operationId: number): Promise<void> {
    const active = this.activeValue
    this.lifecycle.fail(operationId)
    if (active) {
      if (active.runtime) {
        try {
          await active.adapter.disconnect(active.runtime)
        } catch {
          // Preserve the original connection error.
        }
      }
      await this.safelyCleanup(active.adapter, active.sdkClient, active.runtime)
    }
    this.activeValue = null
    this.lifecycle.reset(operationId)
  }

  private failAndReset(operationId: number): void {
    this.lifecycle.fail(operationId)
    this.activeValue = null
    this.lifecycle.reset(operationId)
  }

  private async safelyCleanup(
    adapter: ManagedAdapter,
    client: unknown,
    runtime?: RuntimeConnection
  ): Promise<void> {
    try {
      await adapter.cleanup(client, runtime)
    } catch {
      // Cleanup is best-effort while another error is already being handled.
    }
  }
}
