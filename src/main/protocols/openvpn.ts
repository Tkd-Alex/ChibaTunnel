import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OpenVPN,
  type OpenVPNHandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface OpenVPNAdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  start(configFile: string): Promise<{ pid: number; interfaceName?: string }>
  stop(): Promise<void>
}

export class OpenVPNProtocolAdapter
implements ProtocolAdapter<OpenVPN, OpenVPNHandshakeData> {
  readonly descriptor = getProtocolDescriptor('openvpn')
  private configPaths: string[] = []

  constructor(private readonly dependencies: OpenVPNAdapterDependencies) {}

  createClient(): OpenVPN {
    return new OpenVPN()
  }

  getPeerRequest(client: OpenVPN): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: OpenVPN,
    data: OpenVPNHandshakeData,
    context: ProtocolContext
  ) {
    client.parseConfig(data, context.nodeAddresses)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chibatunnel-openvpn-'))
    const configFile = path.join(directory, 'client.ovpn')
    client.writeConfig(configFile)
    fs.chmodSync(directory, 0o700)
    fs.chmodSync(configFile, 0o600)
    this.configPaths = [configFile]
    return {
      configPaths: [configFile],
      interfaceName: 'ovpn0'
    }
  }

  async connect(
    _client: OpenVPN,
    prepared: { configPaths: string[]; interfaceName?: string },
    _context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const configFile = prepared.configPaths[0]
    if (!configFile) throw new Error('OpenVPN configuration file is missing')
    const started = await this.dependencies.start(configFile)
    return {
      configPaths: [configFile],
      processes: [],
      interfaceName: started.interfaceName ?? prepared.interfaceName ?? 'ovpn0'
    }
  }

  async disconnect(_connection: RuntimeConnection): Promise<void> {
    await this.dependencies.stop()
  }

  async cleanup(client: OpenVPN, connection?: RuntimeConnection): Promise<void> {
    client.cleanup()
    for (const configFile of connection?.configPaths ?? this.configPaths) {
      try {
        fs.rmSync(path.dirname(configFile), { recursive: true, force: true })
      } catch {
        // Privileged teardown may already have removed the temporary directory.
      }
    }
    this.configPaths = []
  }
}
