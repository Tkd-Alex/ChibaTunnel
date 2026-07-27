import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { BinaryCheckResult } from '../../shared/binaries'
import type { BinaryId, SupportedPlatform } from '../../shared/protocols'
import { BINARY_MANIFEST } from './manifest'

export interface ResolveBinaryOptions {
  id: BinaryId
  platform: SupportedPlatform
  architecture: string
  bundledDirectory: string
  customPaths?: Partial<Record<BinaryId, string>>
  environmentPath?: string
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function findOnPath(executable: string, environmentPath: string | undefined): string | null {
  for (const directory of (environmentPath ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, executable)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function validateCandidate(
  id: BinaryId,
  candidate: string,
  source: 'bundled' | 'custom' | 'system',
  platform: SupportedPlatform,
  versionArgs: string[]
): BinaryCheckResult {
  try {
    if (!isAbsolute(candidate)) {
      return { id, status: 'invalid', source, path: candidate, errorCode: 'PATH_NOT_ABSOLUTE' }
    }

    const stat = lstatSync(candidate)
    if (source !== 'system' && stat.isSymbolicLink()) {
      return { id, status: 'invalid', source, path: candidate, errorCode: 'SYMLINK_NOT_ALLOWED' }
    }
    const resolved = source === 'system' ? realpathSync(candidate) : candidate
    if (!lstatSync(resolved).isFile()) {
      return { id, status: 'invalid', source, path: resolved, errorCode: 'NOT_A_FILE' }
    }

    let executable = true
    if (platform !== 'win32') {
      try {
        accessSync(resolved, constants.X_OK)
      } catch {
        executable = false
      }
    }
    if (!executable) {
      return { id, status: 'invalid', source, path: resolved, executable, errorCode: 'NOT_EXECUTABLE' }
    }

    let version: string | undefined
    if (versionArgs.length > 0 && id !== 'wireguard' && id !== 'awg-quick') {
      const probe = spawnSync(resolved, versionArgs, {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
      })
      if (probe.status === null || probe.status !== 0) {
        return {
          id,
          status: 'invalid',
          source,
          path: resolved,
          executable,
          errorCode: probe.error?.message.includes('ETIMEDOUT') ? 'VERSION_TIMEOUT' : 'VERSION_FAILED'
        }
      }
      version = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim().split('\n')[0]
    }

    return {
      id,
      status: 'ok',
      source,
      path: resolved,
      version,
      sha256: sha256(resolved),
      executable
    }
  } catch (error) {
    return {
      id,
      status: 'invalid',
      source,
      path: candidate,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveBinary(options: ResolveBinaryOptions): BinaryCheckResult {
  const { id, platform, architecture, bundledDirectory, customPaths, environmentPath } = options
  if (architecture !== BINARY_MANIFEST.architecture) {
    return { id, status: 'unsupported', errorCode: 'UNSUPPORTED_ARCHITECTURE' }
  }

  const spec = BINARY_MANIFEST.runtimes[id].platforms[platform]
  if (spec.strategy === 'unsupported' || !spec.executable) {
    return { id, status: 'unsupported', errorCode: 'UNSUPPORTED_PLATFORM' }
  }

  const candidates: Array<{ path: string | undefined; source: 'bundled' | 'custom' | 'system' }> = []
  if (spec.strategy === 'bundled') {
    candidates.push({ path: join(bundledDirectory, spec.executable), source: 'bundled' })
  }
  candidates.push({ path: customPaths?.[id], source: 'custom' })
  for (const commonPath of spec.commonPaths ?? []) {
    candidates.push({ path: commonPath, source: 'system' })
  }
  candidates.push({
    path: findOnPath(spec.executable, environmentPath ?? process.env.PATH) ?? undefined,
    source: 'system'
  })

  let invalid: BinaryCheckResult | null = null
  for (const candidate of candidates) {
    if (!candidate.path || !existsSync(candidate.path)) continue
    const result = validateCandidate(id, candidate.path, candidate.source, platform, spec.versionArgs ?? [])
    if (result.status === 'ok') return result
    invalid ??= result
  }

  return invalid ?? { id, status: 'missing', errorCode: 'BINARY_NOT_FOUND' }
}
