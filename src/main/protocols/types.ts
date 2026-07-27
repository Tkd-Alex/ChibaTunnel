import type { ChildProcess } from 'node:child_process'
import type { ProtocolDescriptor, ProtocolId, TunnelMode } from '../../shared/protocols'

export type ConnectionPhase =
  | 'idle'
  | 'preflight'
  | 'creating-session'
  | 'handshaking'
  | 'preparing-config'
  | 'starting-runtime'
  | 'connected'
  | 'disconnecting'
  | 'failed'
  | 'recovering'

export interface ManagedProcess {
  id: string
  binary: string
  child: ChildProcess
}

export interface PreparedProtocolConfig {
  configPaths: string[]
  publicConfig?: string
  proxy?: {
    socksPort: number
    transparent: boolean
  }
  interfaceName?: string
}

export interface RuntimeConnection {
  configPaths: string[]
  processes: ManagedProcess[]
  interfaceName?: string
  proxy?: {
    socksPort: number
    transparent: boolean
    tunInterface?: string
  }
}

export interface ProtocolContext {
  nodeAddress: string
  remoteAddress: string
  nodeAddresses: string[]
  sessionId: string
  mode: TunnelMode
}

export interface PreflightResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface ProtocolAdapter<Client = unknown, HandshakeData = unknown> {
  readonly descriptor: ProtocolDescriptor
  createClient(): Client
  getPeerRequest(client: Client): unknown
  parseHandshake(
    client: Client,
    data: HandshakeData,
    context: ProtocolContext
  ): Promise<PreparedProtocolConfig>
  preflight(context: ProtocolContext): Promise<PreflightResult>
  connect(
    client: Client,
    prepared: PreparedProtocolConfig,
    context: ProtocolContext
  ): Promise<RuntimeConnection>
  disconnect(connection: RuntimeConnection): Promise<void>
  cleanup(client: Client, connection?: RuntimeConnection): Promise<void>
}

export interface ActiveConnection<Client = unknown> {
  operationId: number
  protocol: ProtocolId
  mode: TunnelMode
  nodeAddress: string
  remoteAddress: string
  sessionId: string
  adapter: ProtocolAdapter<Client>
  sdkClient: Client
  prepared?: PreparedProtocolConfig
  runtime?: RuntimeConnection
  createdAt: number
  phase: ConnectionPhase
}
