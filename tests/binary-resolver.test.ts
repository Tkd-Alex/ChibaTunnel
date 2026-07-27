import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { BINARY_MANIFEST, resolveBinary } from '../src/main/binaries'
import { BINARY_IDS } from '../src/shared/protocols'

test('manifest covers every binary ID and platform', () => {
  assert.deepEqual(Object.keys(BINARY_MANIFEST.runtimes), [...BINARY_IDS])
  for (const runtime of Object.values(BINARY_MANIFEST.runtimes)) {
    assert.ok(runtime.version)
    assert.ok(runtime.license)
    assert.ok(runtime.platforms.win32)
    assert.ok(runtime.platforms.linux)
    assert.ok(runtime.platforms.darwin)
  }
})

test('resolves and hashes a custom executable without invoking a shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'chibatunnel-resolver-'))
  const binary = join(root, 'openvpn')
  writeFileSync(binary, '#!/bin/sh\necho "OpenVPN 2.7.5"\n')
  chmodSync(binary, 0o700)

  const result = resolveBinary({
    id: 'openvpn',
    platform: 'linux',
    architecture: 'x64',
    bundledDirectory: join(root, 'bundle'),
    customPaths: { openvpn: binary },
    environmentPath: ''
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.source, 'custom')
  assert.equal(result.version, 'OpenVPN 2.7.5')
  assert.match(result.sha256 ?? '', /^[0-9a-f]{64}$/)
})

test('rejects custom symlinks used by privileged runtimes', () => {
  const root = mkdtempSync(join(tmpdir(), 'chibatunnel-resolver-'))
  const target = join(root, 'target')
  const link = join(root, 'openvpn')
  writeFileSync(target, '#!/bin/sh\nexit 0\n')
  chmodSync(target, 0o700)
  symlinkSync(target, link)

  const result = resolveBinary({
    id: 'openvpn',
    platform: 'linux',
    architecture: 'x64',
    bundledDirectory: join(root, 'bundle'),
    customPaths: { openvpn: link },
    environmentPath: ''
  })

  assert.equal(result.status, 'invalid')
  assert.equal(result.errorCode, 'SYMLINK_NOT_ALLOWED')
})

test('reports unsupported platforms and architectures explicitly', () => {
  assert.equal(resolveBinary({
    id: 'amneziawg',
    platform: 'darwin',
    architecture: 'x64',
    bundledDirectory: '/missing',
    environmentPath: ''
  }).status, 'unsupported')

  assert.equal(resolveBinary({
    id: 'xray',
    platform: 'linux',
    architecture: 'arm64',
    bundledDirectory: '/missing',
    environmentPath: ''
  }).errorCode, 'UNSUPPORTED_ARCHITECTURE')
})

test('does not treat an absent runtime as available', () => {
  const result = resolveBinary({
    id: 'hysteria2',
    platform: 'linux',
    architecture: 'x64',
    bundledDirectory: '/definitely/missing/chibatunnel',
    environmentPath: ''
  })
  assert.equal(result.status, 'missing')
})
