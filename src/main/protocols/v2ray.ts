import {
  V2Ray,
  type V2RayHandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface V2RayConfig {
  inbounds?: Array<{
    tag?: string
    port?: number
    protocol?: string
    sniffing?: { enabled?: boolean }
  }>
  routing?: {
    balancers?: Array<{ selector?: string[] }>
  }
  observatory?: {
    subjectSelector: string[]
    probeInterval: string
    probeUrl: string
  }
}

export interface V2RayAdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  start(client: V2Ray): Promise<{ pid: number; configFile: string }>
  stop(): void
  startTransparent(client: V2Ray): Promise<{
    success: boolean
    error?: string
    tunInterface?: string
  }>
  stopTransparent(): Promise<void>
}

export function hardenV2RayConfig(config: V2RayConfig): void {
  const proxyInbound = config.inbounds?.find(inbound => inbound.tag === 'proxy')
  if (proxyInbound?.sniffing) proxyInbound.sniffing.enabled = false

  const selectors = config.routing?.balancers?.[0]?.selector
  if (selectors?.length) {
    config.observatory = {
      subjectSelector: [...selectors],
      probeInterval: '30s',
      probeUrl: 'https://www.google.com/generate_204'
    }
  }
}

export class V2RayProtocolAdapter
implements ProtocolAdapter<V2Ray, V2RayHandshakeData> {
  readonly descriptor = getProtocolDescriptor('v2ray')

  constructor(private readonly dependencies: V2RayAdapterDependencies) {}

  createClient(): V2Ray {
    return new V2Ray()
  }

  getPeerRequest(client: V2Ray): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: V2Ray,
    data: V2RayHandshakeData,
    context: ProtocolContext
  ) {
    await client.parseConfig(data, context.nodeAddresses)
    hardenV2RayConfig(client.config)
    return {
      configPaths: [],
      proxy: {
        socksPort: client.socksPort,
        transparent: context.mode === 'full-tunnel'
      }
    }
  }

  async connect(
    client: V2Ray,
    prepared: { proxy?: { socksPort: number; transparent: boolean } },
    context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const started = await this.dependencies.start(client)
    let transparentStarted = false
    try {
      if (context.mode === 'full-tunnel') {
        const transparent = await this.dependencies.startTransparent(client)
        if (!transparent.success) {
          throw new Error(transparent.error ?? 'V2Ray transparent mode failed to start')
        }
        transparentStarted = true
        return {
          configPaths: [started.configFile],
          processes: [],
          proxy: {
            socksPort: client.socksPort,
            transparent: true,
            tunInterface: transparent.tunInterface
          }
        }
      }

      return {
        configPaths: [started.configFile],
        processes: [],
        proxy: {
          socksPort: prepared.proxy?.socksPort ?? client.socksPort,
          transparent: false
        }
      }
    } catch (error) {
      if (transparentStarted) await this.dependencies.stopTransparent()
      this.dependencies.stop()
      throw error
    }
  }

  async disconnect(connection: RuntimeConnection): Promise<void> {
    if (connection.proxy?.transparent) await this.dependencies.stopTransparent()
    this.dependencies.stop()
  }

  async cleanup(client: V2Ray): Promise<void> {
    client.cleanup()
  }
}
