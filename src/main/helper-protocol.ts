import { isIP } from 'node:net'
import path from 'node:path'

export type HelperCommand =
  | { command: 'ping' }
  | {
      command: 'start-transparent'
      tun2socksPath: string
      socksPort: number
      serverIp: string
      killSwitch?: boolean
    }
  | { command: 'stop-transparent' }
  | { command: 'set-kill-switch'; enabled: boolean }
  | { command: 'wg-up'; configFile: string; wgPath?: string }
  | { command: 'wg-down'; configFile: string; wgPath?: string }
  | { command: 'awg-up'; configFile: string; awgPath?: string }
  | { command: 'awg-down'; configFile: string; awgPath?: string }
  | { command: 'hysteria2-start'; configFile: string; hysteria2Path: string }
  | { command: 'hysteria2-stop' }

export interface HelperResponse {
  status: 'ok' | 'error' | 'pong'
  error?: string
  pid?: number
  isDnsError?: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Helper request must be an object')
  }
  return value as Record<string, unknown>
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`Unexpected helper field: ${unexpected[0]}`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${field} must be a non-empty bounded string`)
  }
  if (value.includes('\0')) throw new TypeError(`${field} contains a null byte`)
  return value
}

function runtimeConfigPath(value: unknown): string {
  const configFile = requiredString(value, 'configFile')
  if (!path.isAbsolute(configFile)) throw new TypeError('configFile must be absolute')
  if (configFile.split(/[\\/]+/).includes('..')) throw new TypeError('configFile contains traversal')
  const runtimeDirectory = path.basename(path.dirname(configFile))
  if (!/^(?:chibatunnel-|sentinel-js-sdk-)[A-Za-z0-9._-]+$/.test(runtimeDirectory)) {
    throw new TypeError('configFile is outside an approved runtime directory')
  }
  if (!/^[A-Za-z0-9._-]+\.(?:conf|ovpn|json|ya?ml)$/i.test(path.basename(configFile))) {
    throw new TypeError('configFile name is not allowed')
  }
  if (!/\.(?:conf|ovpn|json|ya?ml)$/i.test(configFile)) {
    throw new TypeError('configFile extension is not allowed')
  }
  return configFile
}

function runtimeExecutable(value: unknown, allowedNames: readonly string[], field: string): string {
  const executable = requiredString(value, field)
  if (!path.isAbsolute(executable)) throw new TypeError(`${field} must be absolute`)
  const basename = path.basename(executable).toLowerCase()
  if (!allowedNames.includes(basename)) throw new TypeError(`${field} executable is not allowlisted`)
  return executable
}

export function parseHelperCommand(value: unknown): HelperCommand {
  const command = asRecord(value)
  if (typeof command.command !== 'string') throw new TypeError('Missing helper command')

  switch (command.command) {
    case 'ping':
    case 'stop-transparent':
      assertAllowedKeys(command, ['command'])
      return { command: command.command }

    case 'set-kill-switch':
      assertAllowedKeys(command, ['command', 'enabled'])
      if (typeof command.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      return { command: 'set-kill-switch', enabled: command.enabled }

    case 'start-transparent': {
      assertAllowedKeys(command, ['command', 'tun2socksPath', 'socksPort', 'serverIp', 'killSwitch'])
      const tun2socksPath = runtimeExecutable(
        command.tun2socksPath,
        ['tun2socks', 'tun2socks.exe'],
        'tun2socksPath'
      )
      if (!Number.isInteger(command.socksPort) || (command.socksPort as number) < 1 || (command.socksPort as number) > 65535) {
        throw new TypeError('socksPort must be an integer between 1 and 65535')
      }
      if (typeof command.serverIp !== 'string' || isIP(command.serverIp) !== 4) {
        throw new TypeError('serverIp must be a valid IPv4 address')
      }
      if (command.killSwitch !== undefined && typeof command.killSwitch !== 'boolean') {
        throw new TypeError('killSwitch must be a boolean')
      }
      return {
        command: 'start-transparent',
        tun2socksPath,
        socksPort: command.socksPort as number,
        serverIp: command.serverIp,
        killSwitch: command.killSwitch === true
      }
    }

    case 'wg-up':
    case 'wg-down': {
      assertAllowedKeys(command, ['command', 'configFile', 'wgPath'])
      const configFile = runtimeConfigPath(command.configFile)
      const wgPath = command.wgPath === undefined
        ? undefined
        : runtimeExecutable(command.wgPath, ['wireguard.exe', 'wg-quick'], 'wgPath')
      return { command: command.command, configFile, wgPath }
    }

    case 'awg-up':
    case 'awg-down': {
      assertAllowedKeys(command, ['command', 'configFile', 'awgPath'])
      const configFile = runtimeConfigPath(command.configFile)
      const awgPath = command.awgPath === undefined
        ? undefined
        : runtimeExecutable(command.awgPath, ['amneziawg.exe', 'awg-quick'], 'awgPath')
      return { command: command.command, configFile, awgPath }
    }

    case 'hysteria2-start': {
      assertAllowedKeys(command, ['command', 'configFile', 'hysteria2Path'])
      return {
        command: 'hysteria2-start',
        configFile: runtimeConfigPath(command.configFile),
        hysteria2Path: runtimeExecutable(
          command.hysteria2Path,
          ['hysteria2', 'hysteria2.exe'],
          'hysteria2Path'
        )
      }
    }

    case 'hysteria2-stop':
      assertAllowedKeys(command, ['command'])
      return { command: 'hysteria2-stop' }

    default:
      throw new TypeError(`Unknown helper command: ${command.command}`)
  }
}
