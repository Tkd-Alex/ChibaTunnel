import { PROTOCOL_REGISTRY } from './registry'
import type { ProtocolId } from './types'

const ALIASES = new Map<string, ProtocolId>()

for (const descriptor of Object.values(PROTOCOL_REGISTRY)) {
  for (const alias of descriptor.aliases) {
    ALIASES.set(normalizeAlias(alias), descriptor.id)
  }
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * Normalizes the authoritative service_type returned by a Sentinel node.
 * Unknown values intentionally remain unsupported instead of falling back.
 */
export function normalizeServiceType(value: unknown): ProtocolId | null {
  if (typeof value !== 'string') return null
  return ALIASES.get(normalizeAlias(value)) ?? null
}

/**
 * The public node index historically exposes only 1=WireGuard and 2=V2Ray.
 * Do not guess future numeric values; nodeInfo.service_type remains authoritative.
 */
export function normalizeIndexedNodeType(value: unknown): ProtocolId | null {
  if (value === 1 || value === '1') return 'wireguard'
  if (value === 2 || value === '2') return 'v2ray'
  return normalizeServiceType(value)
}
