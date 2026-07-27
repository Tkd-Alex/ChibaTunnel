import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Hysteria2,
  type Hysteria2HandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import { buildHysteria2Config } from './hysteria2-config'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface Hysteria2AdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  allocateSocksPort(): Promise<number>
  nextInterfaceName(): string
  startLocal(configFile: string): Promise<{ pid: number }>
  stopLocal(): Promise<void>
  startFull(configFile: string): Promise<{ pid: number; interfaceName?: string }>
  stopFull(): Promise<void>
}

export class Hysteria2ProtocolAdapter
implements ProtocolAdapter<Hysteria2, Hysteria2HandshakeData> {
  readonly descriptor = getProtocolDescriptor('hysteria2')
  private configPaths: string[] = []

  constructor(private readonly dependencies: Hysteria2AdapterDependencies) {}

  createClient(): Hysteria2 {
    return new Hysteria2()
  }

  getPeerRequest(client: Hysteria2): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: Hysteria2,
    data: Hysteria2HandshakeData,
    context: ProtocolContext
  ) {
    const interfaceName = this.dependencies.nextInterfaceName()
    client.parseConfig(data, context.nodeAddresses, { tunName: interfaceName })
    const socksPort = await this.dependencies.allocateSocksPort()
    const localConfig = buildHysteria2Config(client, 'local-proxy', socksPort)
    const fullConfig = buildHysteria2Config(client, 'full-tunnel')
    const configDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'chibatunnel-hysteria2-')
    )
    const localConfigFile = path.join(configDirectory, 'client-proxy.yaml')
    const fullConfigFile = path.join(configDirectory, 'client-tun.yaml')
    fs.writeFileSync(localConfigFile, localConfig, { mode: 0o600 })
    fs.writeFileSync(fullConfigFile, fullConfig, { mode: 0o600 })
    fs.chmodSync(localConfigFile, 0o600)
    fs.chmodSync(fullConfigFile, 0o600)
    this.configPaths = [localConfigFile, fullConfigFile]

    return {
      configPaths: [localConfigFile, fullConfigFile],
      localConfigFile,
      fullConfigFile,
      interfaceName,
      proxy: { socksPort, transparent: false }
    }
  }

  async connect(
    _client: Hysteria2,
    prepared: {
      configPaths: string[]
      localConfigFile?: string
      fullConfigFile?: string
      interfaceName?: string
      proxy?: { socksPort: number; transparent: boolean }
    },
    context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const configFile = context.mode === 'full-tunnel'
      ? prepared.fullConfigFile
      : prepared.localConfigFile
    if (!configFile) throw new Error('Hysteria2 configuration file is missing')

    if (context.mode === 'local-proxy') {
      const socksPort = prepared.proxy?.socksPort
      if (!socksPort) throw new Error('Hysteria2 SOCKS configuration is missing')
      await this.dependencies.startLocal(configFile)
      return {
        configPaths: [configFile],
        processes: [],
        proxy: {
          socksPort,
          transparent: false
        }
      }
    }

    const started = await this.dependencies.startFull(configFile)
    return {
      configPaths: [configFile],
      processes: [],
      interfaceName: started.interfaceName ?? prepared.interfaceName
    }
  }

  async disconnect(connection: RuntimeConnection): Promise<void> {
    if (connection.proxy) await this.dependencies.stopLocal()
    else await this.dependencies.stopFull()
  }

  async cleanup(client: Hysteria2, connection?: RuntimeConnection): Promise<void> {
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
