export const PROTOCOL_IDS = [
  'wireguard',
  'v2ray',
  'openvpn',
  'xray',
  'amneziawg',
  'hysteria2'
] as const

export type ProtocolId = (typeof PROTOCOL_IDS)[number]

export type TunnelMode = 'local-proxy' | 'full-tunnel'

export type ConfigKind = 'ini' | 'json' | 'yaml'

export const BINARY_IDS = [
  'wireguard',
  'v2ray',
  'tun2socks',
  'wintun',
  'openvpn',
  'xray',
  'amneziawg',
  'awg-quick',
  'hysteria2'
] as const

export type BinaryId = (typeof BINARY_IDS)[number]

export type CapabilityStatus = 'supported' | 'experimental' | 'unavailable'

export type SupportedPlatform = 'win32' | 'linux' | 'darwin'

export interface ProtocolCapabilities {
  killSwitch: CapabilityStatus
  splitTunnel: CapabilityStatus
  trafficStats: CapabilityStatus
  qrCode: CapabilityStatus
}

export interface ProtocolDescriptor {
  id: ProtocolId
  label: string
  aliases: readonly string[]
  modes: readonly TunnelMode[]
  defaultMode: TunnelMode
  configKind: ConfigKind
  requiredBinaries: Readonly<Record<TunnelMode, readonly BinaryId[]>>
  platformBinaries?: Readonly<
    Partial<Record<SupportedPlatform, Readonly<Partial<Record<TunnelMode, readonly BinaryId[]>>>>>
  >
  requiresElevation: Readonly<Record<TunnelMode, boolean>>
  capabilities: ProtocolCapabilities
}
