import {
  Xray,
  type XrayClientConfig,
  type XrayHandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

interface XrayInbound {
  tag?: string
  sniffing?: { enabled?: boolean }
}

export interface XrayAdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  start(client: Xray): Promise<{ pid: number; configFile: string }>
  stop(): void
  startTransparent(client: Xray): Promise<{
    success: boolean
    error?: string
    tunInterface?: string
  }>
  stopTransparent(): Promise<void>
}

export function hardenXrayConfig(config: XrayClientConfig): void {
  const inbounds = config.inbounds as XrayInbound[]
  const proxyInbound = inbounds.find(inbound => inbound.tag === 'proxy')
  if (proxyInbound?.sniffing) proxyInbound.sniffing.enabled = false
}

export class XrayProtocolAdapter
implements ProtocolAdapter<Xray, XrayHandshakeData> {
  readonly descriptor = getProtocolDescriptor('xray')

  constructor(private readonly dependencies: XrayAdapterDependencies) {}

  createClient(): Xray {
    return new Xray()
  }

  getPeerRequest(client: Xray): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: Xray,
    data: XrayHandshakeData,
    context: ProtocolContext
  ) {
    await client.parseConfig(data, context.nodeAddresses)
    hardenXrayConfig(client.config)
    return {
      configPaths: [],
      proxy: {
        socksPort: client.socksPort,
        transparent: context.mode === 'full-tunnel'
      }
    }
  }

  async connect(
    client: Xray,
    prepared: { proxy?: { socksPort: number; transparent: boolean } },
    context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const started = await this.dependencies.start(client)
    try {
      if (context.mode === 'full-tunnel') {
        const transparent = await this.dependencies.startTransparent(client)
        if (!transparent.success) {
          throw new Error(transparent.error ?? 'Xray transparent mode failed to start')
        }
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
      try {
        if (context.mode === 'full-tunnel') await this.dependencies.stopTransparent()
      } catch {
        // Preserve the original startup error while still stopping Xray.
      } finally {
        this.dependencies.stop()
      }
      throw error
    }
  }

  async disconnect(connection: RuntimeConnection): Promise<void> {
    try {
      if (connection.proxy?.transparent) await this.dependencies.stopTransparent()
    } finally {
      this.dependencies.stop()
    }
  }

  async cleanup(client: Xray): Promise<void> {
    client.cleanup()
  }
}
