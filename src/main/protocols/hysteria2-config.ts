import type { Hysteria2 } from '@sentinel-official/sentinel-js-sdk'
import type { TunnelMode } from '../../shared/protocols'

export function buildHysteria2Config(
  client: Hysteria2,
  mode: TunnelMode,
  socksPort?: number
): string {
  const tunConfig = client.buildConfigString()
  if (mode === 'full-tunnel') return tunConfig

  if (!Number.isInteger(socksPort) || socksPort! < 1 || socksPort! > 65535) {
    throw new RangeError('Hysteria2 SOCKS port must be an integer between 1 and 65535')
  }

  const lines = tunConfig.trimEnd().split('\n')
  const tunStart = lines.findIndex(line => line === 'tun:')
  if (tunStart < 0) {
    throw new Error('Hysteria2 SDK configuration does not contain a TUN section')
  }

  const nextTopLevelSection = lines.findIndex(
    (line, index) => index > tunStart && /^[A-Za-z][A-Za-z0-9]*:$/.test(line)
  )
  const prefix = lines.slice(0, tunStart)
  const suffix = nextTopLevelSection < 0 ? [] : lines.slice(nextTopLevelSection)

  return [
    ...prefix,
    'socks5:',
    `  listen: "127.0.0.1:${socksPort}"`,
    ...suffix,
    ''
  ].join('\n')
}
