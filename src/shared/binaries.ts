import type { BinaryId, SupportedPlatform } from './protocols'

export type BinarySource = 'bundled' | 'custom' | 'system'
export type BinaryStatus = 'ok' | 'missing' | 'invalid' | 'unsupported'

export interface BinaryCheckResult {
  id: BinaryId
  status: BinaryStatus
  source?: BinarySource
  path?: string
  version?: string
  sha256?: string
  executable?: boolean
  errorCode?: string
  errorMessage?: string
}

export interface BinaryArchiveSpec {
  format: 'zip' | 'msi' | 'raw'
  url: string
  sha256: string
}

export interface PlatformBinarySpec {
  strategy: 'bundled' | 'system' | 'unsupported'
  executable?: string
  versionArgs?: string[]
  commonPaths?: string[]
  archive?: BinaryArchiveSpec
}

export interface BinaryManifestEntry {
  version: string
  license: string
  repository: string
  platforms: Record<SupportedPlatform, PlatformBinarySpec>
}

export interface BinaryManifest {
  schemaVersion: number
  architecture: 'x64'
  runtimes: Record<BinaryId, BinaryManifestEntry>
}
