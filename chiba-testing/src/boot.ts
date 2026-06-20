// ─── boot.ts ───
//
// Electron MAIN entry for the harness. This is the file `electron` launches.
// Sequence:
//   1. install the ipcMain.handle capture shim (BEFORE the app registers anything),
//   2. require the app's compiled main bundle (out/main/index.js) — it runs its
//      own app.whenReady(), registers all handlers (captured by our shim), and —
//      because CHIBA_TEST=1 — skips the window and the privileged-helper install,
//      then emits 'chiba-test:ready',
//   3. on ready, run the selected mode (map | test) and exit.
//
// We never re-implement handlers. We boot the real app and drive its real ipcMain.

import { app } from 'electron'
import * as path from 'path'
import { installCapture, capturedChannels } from './registry'
import { CHANNELS, Tier, TIER_ORDER } from './channels'
import { Reporter } from './reporter'
import { runEngine } from './engine'

// ── 0. force test mode for the app bundle we are about to require ──
process.env.CHIBA_TEST = '1'

// ── 1. capture shim must be live before the app registers handlers ──
installCapture()

// ── arg parsing ──
function flag(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const mode = (flag('mode', 'map') ?? 'map') as 'map' | 'test'
const maxTier = (flag('tier', 'readonly') ?? 'readonly') as Tier
const mnemonic = flag('mnemonic') || process.env.CHIBA_TEST_MNEMONIC

if (!TIER_ORDER.includes(maxTier)) {
  // eslint-disable-next-line no-console
  console.error(`Unknown tier '${maxTier}'. Valid: ${TIER_ORDER.join(', ')}`)
  app.exit(2)
}

// nowIso avoids Date.now-style nondeterminism concerns here (this is a leaf process).
function nowIso(): string {
  return new Date().toISOString()
}

// ── 2. require the real app main bundle (runs its whenReady) ──
// boot.js lives at chiba-testing/dist/boot.js → app bundle is ../../out/main/index.js
const APP_MAIN = path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')

function reportDir(): string {
  return path.resolve(__dirname, '..', 'reports')
}

async function printMap(): Promise<void> {
  const captured = new Set(capturedChannels())
  // eslint-disable-next-line no-console
  console.log(`\n  Chiba Testing — channel map (${CHANNELS.length} in spec, ${captured.size} captured from app)\n`)
  const byTier: Record<string, typeof CHANNELS> = {}
  for (const c of CHANNELS) (byTier[c.tier] ||= []).push(c)
  for (const tier of TIER_ORDER) {
    const list = byTier[tier]
    if (!list?.length) continue
    // eslint-disable-next-line no-console
    console.log(`  [${tier}]`)
    for (const c of list) {
      const mark = captured.has(c.channel) ? '✓' : '✗ NOT REGISTERED'
      // eslint-disable-next-line no-console
      console.log(`    ${mark.padEnd(18)} ${c.channel.padEnd(26)} ${c.desc}`)
    }
    // eslint-disable-next-line no-console
    console.log('')
  }
  // Surface drift in both directions.
  const specChannels = new Set(CHANNELS.map((c) => c.channel))
  const unmapped = [...captured].filter((c) => !specChannels.has(c))
  if (unmapped.length) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ${unmapped.length} channel(s) registered by app but NOT in spec map:`)
    for (const c of unmapped) console.log(`      + ${c}`)
    console.log('')
  }
}

async function run(): Promise<void> {
  // Surface what the app actually registered.
  if (mode === 'map') {
    await printMap()
    app.exit(0)
    return
  }

  // mode === 'test'
  const started = nowIso()
  const reporter = new Reporter(mode, maxTier, started)
  reporter.setMeta(CHANNELS.length, capturedChannels().length)

  // eslint-disable-next-line no-console
  console.log(`\n  Chiba Testing — end-to-end run (max tier: ${maxTier})\n`)
  if (TIER_ORDER.indexOf(maxTier) >= TIER_ORDER.indexOf('spend')) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ SPEND tier enabled — on-chain transactions may be broadcast. Use a throwaway wallet.\n`)
  }

  await runEngine({ maxTier, mnemonic }, reporter)

  const { json, md } = reporter.finish(nowIso(), reportDir())
  const t = reporter.totals
  // eslint-disable-next-line no-console
  console.log(`\n  Done: ${t.pass} pass, ${t.fail} fail, ${t.error} error, ${t.skip} skip`)
  // eslint-disable-next-line no-console
  console.log(`  Report: ${json}\n          ${md}\n`)
  app.exit(t.fail + t.error > 0 ? 1 : 0)
}

// 'chiba-test:ready' is a custom event the app emits (see src/main/index.ts
// IS_TEST_HARNESS branch). Electron's typings don't know it, so cast to a plain
// EventEmitter-shaped listener registrar.
;(app as unknown as { on(event: string, cb: () => void): void }).on('chiba-test:ready', () => {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Harness run failed:', err)
    app.exit(3)
  })
})

// Require the app bundle last — it triggers app.whenReady → registers handlers → emits ready.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require(APP_MAIN)
