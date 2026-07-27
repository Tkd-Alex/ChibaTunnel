import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const manifest = JSON.parse(
  readFileSync(new URL('../build/binary-manifest.json', import.meta.url), 'utf8')
)
const aliases = {
  win: { manifest: 'win32', output: 'win' },
  win32: { manifest: 'win32', output: 'win' },
  linux: { manifest: 'linux', output: 'linux' },
  mac: { manifest: 'darwin', output: 'mac' },
  darwin: { manifest: 'darwin', output: 'mac' }
}
const hostPlatform = process.platform === 'win32'
  ? 'win'
  : process.platform === 'darwin'
    ? 'mac'
    : process.platform
const requestedPlatform = process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? hostPlatform
const selected = aliases[requestedPlatform]
const verifyOnly = process.argv.includes('--verify')

if (!selected) {
  throw new Error('Usage: node scripts/materialize-binary-runtimes.mjs [win|linux|mac] [--verify]')
}

const outputDirectory = resolve('build', 'bins', selected.output)
const bundled = Object.entries(manifest.runtimes)
  .filter(([, runtime]) => runtime.platforms[selected.manifest].strategy === 'bundled')

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? 'unknown'}`)
  }
}

function filesUnder(directory) {
  const files = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.push(target)
    }
  }
  visit(directory)
  return files
}

function findExtracted(files, id, expectedName) {
  const expected = expectedName.toLowerCase()
  const matches = files.filter(file => basename(file).toLowerCase() === expected)
  if (id === 'wintun') {
    return matches.find(file => /(?:^|[\\/])amd64(?:[\\/]|$)/i.test(file))
  }
  if (id === 'tun2socks' && matches.length === 0) {
    return files.find(file => basename(file).toLowerCase().startsWith('tun2socks'))
  }
  return matches[0]
}

function copyRequired(files, id, sourceName, targetName = sourceName) {
  const source = findExtracted(files, id, sourceName)
  if (!source) throw new Error(`${id}: ${sourceName} was not found in the pinned archive`)
  copyFileSync(source, join(outputDirectory, targetName))
}

function extractArchive(archiveFile, destination) {
  mkdirSync(destination, { recursive: true })
  if (selected.manifest === 'win32') {
    const quote = value => value.replaceAll("'", "''")
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${quote(archiveFile)}' -DestinationPath '${quote(destination)}' -Force`
    ])
  } else {
    run('unzip', ['-q', archiveFile, '-d', destination])
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function materialize(id, runtime) {
  const spec = runtime.platforms[selected.manifest]
  const archive = spec.archive
  const bytes = await download(archive.url)
  const actualHash = sha256(bytes)
  if (actualHash !== archive.sha256) {
    throw new Error(`${id}: SHA-256 mismatch (expected ${archive.sha256}, received ${actualHash})`)
  }

  const workspace = mkdtempSync(join(tmpdir(), `chibatunnel-${id}-`))
  try {
    const archiveFile = join(workspace, `download.${archive.format}`)
    writeFileSync(archiveFile, bytes, { mode: 0o600 })

    if (archive.format === 'raw') {
      copyFileSync(archiveFile, join(outputDirectory, spec.executable))
    } else {
      const extracted = join(workspace, 'extracted')
      if (archive.format === 'msi') {
        mkdirSync(extracted)
        run('msiexec.exe', ['/a', archiveFile, '/qn', `TARGETDIR=${extracted}`])
      } else {
        extractArchive(archiveFile, extracted)
      }
      const files = filesUnder(extracted)
      copyRequired(files, id, spec.executable)
      if (id === 'v2ray') {
        copyRequired(files, id, 'geoip.dat')
        copyRequired(files, id, 'geosite.dat')
      }
    }

    if (selected.manifest !== 'win32' && !spec.executable.endsWith('.dll')) {
      chmodSync(join(outputDirectory, spec.executable), 0o755)
    }
    console.log(`Materialized ${id}@${runtime.version} -> ${relative(process.cwd(), outputDirectory)}`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function verifyOutputs() {
  const missing = []
  for (const [id, runtime] of bundled) {
    const executable = runtime.platforms[selected.manifest].executable
    if (!existsSync(join(outputDirectory, executable))) missing.push(`${id}:${executable}`)
    if (id === 'v2ray') {
      for (const asset of ['geoip.dat', 'geosite.dat']) {
        if (!existsSync(join(outputDirectory, asset))) missing.push(`${id}:${asset}`)
      }
    }
  }
  if (missing.length > 0) throw new Error(`Missing bundled runtime outputs: ${missing.join(', ')}`)
  console.log(`Verified ${bundled.length} bundled runtimes for ${selected.manifest}.`)
}

if (verifyOnly) {
  verifyOutputs()
} else {
  rmSync(outputDirectory, { recursive: true, force: true })
  mkdirSync(outputDirectory, { recursive: true })
  for (const [id, runtime] of bundled) await materialize(id, runtime)
  verifyOutputs()
}
