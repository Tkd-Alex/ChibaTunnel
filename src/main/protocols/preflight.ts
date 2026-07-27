import type { BinaryCheckResult } from '../../shared/binaries'
import {
  getProtocolDescriptor,
  getRequiredBinaries,
  protocolSupportsMode,
  type BinaryId,
  type ProtocolId,
  type SupportedPlatform,
  type TunnelMode
} from '../../shared/protocols'
import type { PreflightResult } from './types'

export interface ProtocolPreflightOptions {
  protocol: ProtocolId
  mode: TunnelMode
  platform: SupportedPlatform
  resolveBinary: (id: BinaryId) => BinaryCheckResult
  checkHelper: () => Promise<boolean>
}

export async function preflightProtocol(options: ProtocolPreflightOptions): Promise<PreflightResult> {
  const { protocol, mode, platform } = options
  if (!protocolSupportsMode(protocol, mode)) {
    return {
      ok: false,
      errors: [`UNSUPPORTED_MODE:${protocol}:${mode}`],
      warnings: []
    }
  }

  const binaries = getRequiredBinaries(protocol, mode, platform).map(options.resolveBinary)
  const errors = binaries
    .filter(result => result.status !== 'ok')
    .map(result => `BINARY_${result.status.toUpperCase()}:${result.id}:${result.errorCode ?? 'UNKNOWN'}`)

  const descriptor = getProtocolDescriptor(protocol)
  if (descriptor.requiresElevation[mode] && !(await options.checkHelper())) {
    errors.push('HELPER_UNAVAILABLE')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    binaries
  }
}
