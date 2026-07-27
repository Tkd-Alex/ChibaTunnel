import {
  AmneziaWG,
  Hysteria2,
  OpenVPN,
  V2Ray,
  Wireguard,
  Xray
} from '@sentinel-official/sentinel-js-sdk'
import type { ProtocolId } from '../../shared/protocols'

export type SdkVpnClient =
  | Wireguard
  | V2Ray
  | OpenVPN
  | Xray
  | AmneziaWG
  | Hysteria2

export function createSdkVpnClient(protocol: ProtocolId): SdkVpnClient {
  switch (protocol) {
    case 'wireguard': return new Wireguard()
    case 'v2ray': return new V2Ray()
    case 'openvpn': return new OpenVPN()
    case 'xray': return new Xray()
    case 'amneziawg': return new AmneziaWG()
    case 'hysteria2': return new Hysteria2()
  }
}

export function getSdkPeerRequest(client: SdkVpnClient): unknown {
  return client.getPeerRequest()
}

export function decodeHandshakeData(encoded: unknown): unknown {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new TypeError('Handshake data must be a non-empty Base64 string')
  }
  if (encoded.length > 2_000_000) {
    throw new RangeError('Handshake data exceeds the maximum accepted size')
  }

  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new TypeError('Handshake data is not valid canonical Base64')
  }

  try {
    return JSON.parse(decoded.toString('utf8')) as unknown
  } catch {
    throw new TypeError('Handshake data does not contain valid JSON')
  }
}
