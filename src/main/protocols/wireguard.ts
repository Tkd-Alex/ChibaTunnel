import { isIP } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Wireguard,
  type WireGuardHandshakeData
} from '@sentinel-official/sentinel-js-sdk'
import { getProtocolDescriptor } from '../../shared/protocols'
import type {
  PreflightResult,
  ProtocolAdapter,
  ProtocolContext,
  RuntimeConnection
} from './types'

export interface WireGuardAdapterOptions {
  dns?: string[]
  splitRoutes?: string
}

export interface WireGuardAdapterDependencies {
  preflight(context: ProtocolContext): Promise<PreflightResult>
  nextInterfaceName(): string
  up(configFile: string): Promise<{ success: boolean; error?: string }>
  down(configFile: string): Promise<void>
}

function validateCidr(value: string): string {
  const [address, prefix, ...extra] = value.trim().split('/')
  const version = isIP(address)
  const numericPrefix = Number(prefix)
  const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1
  if (
    extra.length > 0
    || prefix === undefined
    || !Number.isInteger(numericPrefix)
    || numericPrefix < 0
    || numericPrefix > maxPrefix
  ) {
    throw new TypeError(`Invalid split-tunnel route: ${value}`)
  }
  return `${address}/${numericPrefix}`
}

export function applyWireGuardSplitRoutes(config: string, routes?: string): string {
  if (!routes) return config
  const normalized = routes.split(',').map(validateCidr)
  if (normalized.length === 0) throw new TypeError('At least one split-tunnel route is required')
  return config.replace(
    /^AllowedIPs\s*=.*$/gm,
    `AllowedIPs = ${normalized.join(',')}`
  )
}

export function stripWireGuardDns(config: string): string {
  return config.replace(/^DNS\s*=.*$/gm, '# DNS= stripped')
}

export class WireGuardProtocolAdapter
implements ProtocolAdapter<Wireguard, WireGuardHandshakeData> {
  readonly descriptor = getProtocolDescriptor('wireguard')
  private configPaths: string[] = []

  constructor(
    private readonly dependencies: WireGuardAdapterDependencies,
    private readonly options: WireGuardAdapterOptions = {}
  ) {}

  createClient(): Wireguard {
    return new Wireguard()
  }

  getPeerRequest(client: Wireguard): unknown {
    return client.getPeerRequest()
  }

  async preflight(context: ProtocolContext): Promise<PreflightResult> {
    return this.dependencies.preflight(context)
  }

  async parseHandshake(
    client: Wireguard,
    data: WireGuardHandshakeData,
    context: ProtocolContext
  ) {
    await client.parseConfig(data, context.nodeAddresses, this.options.dns)
    const rawConfig = client.buildConfigString()
    if (!rawConfig) throw new Error('WireGuard returned an empty configuration')

    const publicConfig = applyWireGuardSplitRoutes(rawConfig, this.options.splitRoutes)
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
    _client: Wireguard,
    prepared: { configPaths: string[]; interfaceName?: string },
    _context: ProtocolContext
  ): Promise<RuntimeConnection> {
    const configFile = prepared.configPaths[0]
    if (!configFile) throw new Error('WireGuard configuration file is missing')
    const result = await this.dependencies.up(configFile)
    if (!result.success) throw new Error(result.error ?? 'WireGuard runtime failed to start')
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

  async cleanup(client: Wireguard, connection?: RuntimeConnection): Promise<void> {
    client.cleanup()
    for (const configFile of connection?.configPaths ?? this.configPaths) {
      try {
        fs.rmSync(path.dirname(configFile), { recursive: true, force: true })
      } catch {
        // The runtime teardown may already have removed the temporary directory.
      }
    }
    this.configPaths = []
  }
}
