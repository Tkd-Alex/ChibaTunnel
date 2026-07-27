import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AmneziaWG,
  type AmneziaWGHandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import { applyWireGuardSplitRoutes } from './wireguard'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface AmneziaWGAdapterOptions {
  dns?: string[]
  splitRoutes?: string
}

export interface AmneziaWGAdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  nextInterfaceName(): string
  up(configFile: string): Promise<{ success: boolean; error?: string }>
  down(configFile: string): Promise<void>
}

export class AmneziaWGProtocolAdapter
implements ProtocolAdapter<AmneziaWG, AmneziaWGHandshakeData> {
  readonly descriptor = getProtocolDescriptor('amneziawg')
  private configPaths: string[] = []

  constructor(
    private readonly dependencies: AmneziaWGAdapterDependencies,
    private readonly options: AmneziaWGAdapterOptions = {}
  ) {}

  createClient(): AmneziaWG {
    return new AmneziaWG()
  }

  getPeerRequest(client: AmneziaWG): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: AmneziaWG,
    data: AmneziaWGHandshakeData,
    context: ProtocolContext
  ) {
    client.parseConfig(data, context.nodeAddresses, { dns: this.options.dns })
    const publicConfig = applyWireGuardSplitRoutes(
      client.buildConfigString(),
      this.options.splitRoutes
    )
    const interfaceName = this.dependencies.nextInterfaceName()
    const configDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), `chibatunnel-${interfaceName}-`)
    )
    const configFile = path.join(configDirectory, `${interfaceName}.conf`)
    fs.writeFileSync(configFile, publicConfig, { mode: 0o600 })
    fs.chmodSync(configFile, 0o600)
    this.configPaths = [configFile]

    return {
      configPaths: [configFile],
      publicConfig,
      interfaceName
    }
  }

  async connect(
    _client: AmneziaWG,
    prepared: { configPaths: string[]; interfaceName?: string },
    _context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const configFile = prepared.configPaths[0]
    if (!configFile) throw new Error('AmneziaWG configuration file is missing')
    const result = await this.dependencies.up(configFile)
    if (!result.success) throw new Error(result.error ?? 'AmneziaWG runtime failed to start')
    return {
      configPaths: [configFile],
      processes: [],
      interfaceName: prepared.interfaceName ?? path.basename(configFile, '.conf')
    }
  }

  async disconnect(connection: RuntimeConnection): Promise<void> {
    const configFile = connection.configPaths[0]
    if (configFile) await this.dependencies.down(configFile)
  }

  async cleanup(client: AmneziaWG, connection?: RuntimeConnection): Promise<void> {
    client.cleanup()
    for (const configFile of connection?.configPaths ?? this.configPaths) {
      try {
        fs.rmSync(path.dirname(configFile), { recursive: true, force: true })
      } catch {
        // Runtime teardown may already have removed the temporary directory.
      }
    }
    this.configPaths = []
  }
}
