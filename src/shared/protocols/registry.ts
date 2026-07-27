import {
  PROTOCOL_IDS,
  type BinaryId,
  type ProtocolDescriptor,
  type ProtocolId,
  type SupportedPlatform,
  type TunnelMode
} from './types'

const NONE: readonly BinaryId[] = Object.freeze([])

export const PROTOCOL_REGISTRY: Readonly<Record<ProtocolId, ProtocolDescriptor>> = {
  wireguard: {
    id: 'wireguard',
    label: 'WireGuard',
    aliases: ['wireguard', 'wire_guard', 'wire-guard', 'wg'],
    modes: ['full-tunnel'],
    defaultMode: 'full-tunnel',
    configKind: 'ini',
    requiredBinaries: {
      'local-proxy': NONE,
      'full-tunnel': ['wireguard']
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'supported',
      splitTunnel: 'experimental',
      trafficStats: 'supported',
      qrCode: 'supported'
    }
  },
  v2ray: {
    id: 'v2ray',
    label: 'V2Ray',
    aliases: ['v2ray', 'v2_ray', 'v2-ray'],
    modes: ['local-proxy', 'full-tunnel'],
    defaultMode: 'local-proxy',
    configKind: 'json',
    requiredBinaries: {
      'local-proxy': ['v2ray'],
      'full-tunnel': ['v2ray', 'tun2socks']
    },
    platformBinaries: {
      win32: { 'full-tunnel': ['v2ray', 'tun2socks', 'wintun'] }
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'supported',
      splitTunnel: 'experimental',
      trafficStats: 'supported',
      qrCode: 'supported'
    }
  },
  openvpn: {
    id: 'openvpn',
    label: 'OpenVPN',
    aliases: ['openvpn', 'open_vpn', 'open-vpn'],
    modes: ['full-tunnel'],
    defaultMode: 'full-tunnel',
    configKind: 'ini',
    requiredBinaries: {
      'local-proxy': NONE,
      'full-tunnel': ['openvpn']
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'experimental',
      splitTunnel: 'experimental',
      trafficStats: 'experimental',
      qrCode: 'unavailable'
    }
  },
  xray: {
    id: 'xray',
    label: 'Xray',
    aliases: ['xray', 'x_ray', 'x-ray'],
    modes: ['local-proxy', 'full-tunnel'],
    defaultMode: 'local-proxy',
    configKind: 'json',
    requiredBinaries: {
      'local-proxy': ['xray'],
      'full-tunnel': ['xray', 'tun2socks']
    },
    platformBinaries: {
      win32: { 'full-tunnel': ['xray', 'tun2socks', 'wintun'] }
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'experimental',
      splitTunnel: 'experimental',
      trafficStats: 'experimental',
      qrCode: 'unavailable'
    }
  },
  amneziawg: {
    id: 'amneziawg',
    label: 'AmneziaWG',
    aliases: ['amneziawg', 'amnezia_wg', 'amnezia-wg', 'awg'],
    modes: ['full-tunnel'],
    defaultMode: 'full-tunnel',
    configKind: 'ini',
    requiredBinaries: {
      'local-proxy': NONE,
      'full-tunnel': ['amneziawg', 'awg-quick']
    },
    platformBinaries: {
      win32: { 'full-tunnel': ['amneziawg'] },
      linux: { 'full-tunnel': ['awg-quick'] },
      darwin: { 'full-tunnel': ['awg-quick'] }
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'experimental',
      splitTunnel: 'experimental',
      trafficStats: 'experimental',
      qrCode: 'unavailable'
    }
  },
  hysteria2: {
    id: 'hysteria2',
    label: 'Hysteria2',
    aliases: ['hysteria2', 'hysteria_2', 'hysteria-2', 'hy2'],
    modes: ['local-proxy', 'full-tunnel'],
    defaultMode: 'local-proxy',
    configKind: 'yaml',
    requiredBinaries: {
      'local-proxy': ['hysteria2'],
      'full-tunnel': ['hysteria2']
    },
    requiresElevation: { 'local-proxy': false, 'full-tunnel': true },
    capabilities: {
      killSwitch: 'experimental',
      splitTunnel: 'experimental',
      trafficStats: 'experimental',
      qrCode: 'unavailable'
    }
  }
}

export function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === 'string' && (PROTOCOL_IDS as readonly string[]).includes(value)
}

export function getProtocolDescriptor(protocol: ProtocolId): ProtocolDescriptor {
  return PROTOCOL_REGISTRY[protocol]
}

export function protocolSupportsMode(protocol: ProtocolId, mode: TunnelMode): boolean {
  return PROTOCOL_REGISTRY[protocol].modes.includes(mode)
}

export function getRequiredBinaries(
  protocol: ProtocolId,
  mode: TunnelMode,
  platform?: SupportedPlatform
): readonly BinaryId[] {
  if (!protocolSupportsMode(protocol, mode)) return NONE
  const descriptor = PROTOCOL_REGISTRY[protocol]
  return (platform && descriptor.platformBinaries?.[platform]?.[mode])
    ?? descriptor.requiredBinaries[mode]
}
