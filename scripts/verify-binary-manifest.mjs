import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(
  await readFile(new URL('../build/binary-manifest.json', import.meta.url), 'utf8')
)
const platforms = ['win32', 'linux', 'darwin']
const sha256 = /^[0-9a-f]{64}$/

if (manifest.schemaVersion !== 1) throw new Error('Unsupported binary manifest schema')
if (manifest.architecture !== 'x64') throw new Error('Only the current x64 release architecture is allowed')

for (const [id, runtime] of Object.entries(manifest.runtimes)) {
  if (!runtime.version || /latest/i.test(runtime.version)) throw new Error(`${id}: version is not pinned`)
  if (!runtime.license || !runtime.repository) throw new Error(`${id}: missing license or repository`)

  for (const platform of platforms) {
    const spec = runtime.platforms?.[platform]
    if (!spec) throw new Error(`${id}: missing ${platform} strategy`)
    if (!['bundled', 'system', 'unsupported'].includes(spec.strategy)) {
      throw new Error(`${id}/${platform}: invalid strategy`)
    }
    if (spec.strategy === 'unsupported') continue
    if (!spec.executable) throw new Error(`${id}/${platform}: missing executable`)
    if (spec.strategy === 'bundled') {
      if (!spec.archive) throw new Error(`${id}/${platform}: bundled runtime has no archive`)
      if (!spec.archive.url.startsWith('https://')) throw new Error(`${id}/${platform}: archive URL is not HTTPS`)
      if (/\/latest(?:\/|$)/i.test(spec.archive.url)) throw new Error(`${id}/${platform}: archive URL uses latest`)
      if (!sha256.test(spec.archive.sha256)) throw new Error(`${id}/${platform}: invalid SHA-256`)
    }
  }
}

console.log(`Verified ${Object.keys(manifest.runtimes).length} pinned runtime definitions.`)
