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

// Match the INSTALLED app's userData dir so the harness reads the same electron-store
// (wallets, settings, RPC) the real app uses. Launched via the raw electron binary,
// app.getName() defaults to 'Electron' → userData would be ...\Roaming\Electron and the
// app's Store({name:'chibatunnel'}) would land there (an empty parallel store). The
// installed exe resolves name 'chibatunnel' → ...\Roaming\chibatunnel. We force the same
// name BEFORE requiring the bundle so Store() resolves to the real path. This must run
// before app.whenReady() (the app constructs its Store at module load).
app.setName('chibatunnel')

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
// Opt-in: run wallet-store-mutating channels. The harness shares the installed app's
// real wallet store, so these are skipped by default to protect the user's wallets.
const allowWalletMutations = process.argv.includes('--allow-wallet-mutations')
// Hard opt-in: the LIVE tier brings a REAL tunnel up on this host (WireGuard/tun2socks)
// to exercise the feature branches gated behind an active session/config. Mutates the
// host network stack and spends on sessions — never run implicitly.
const allowLiveTunnel = process.argv.includes('--allow-live-tunnel')
// Hard opt-in: run the PROVIDER e2e (create plan → lease+link a live node → self-
// subscribe → connect → end lease) instead of the consumer live tier. Spends real
// funds (plan create + node lease + subscription). Requires --tier=live AND
// --allow-live-tunnel. Without it, the live tier runs the consumer path (runLive).
const providerE2E = process.argv.includes('--provider-e2e')
// How many nodes the live tier probes (real node:info RTT each) looking for a live one.
// The live network is large and mostly V2Ray; the default is generous so the probe
// reaches a live node of the dominant type rather than exhausting a tiny budget.
const maxProbeRaw = flag('max-probe')
const maxProbe = maxProbeRaw && Number.isFinite(Number(maxProbeRaw)) ? Number(maxProbeRaw) : undefined

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

  if (allowWalletMutations) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ WALLET MUTATIONS enabled — add/remove/switch/rename/setup/forget will run against the REAL store.\n`)
  }

  if (TIER_ORDER.indexOf(maxTier) >= TIER_ORDER.indexOf('live')) {
    // eslint-disable-next-line no-console
    console.log(
      allowLiveTunnel
        ? `  ⚠ LIVE tier enabled — a REAL tunnel will be brought up on this host and torn down.\n`
        : `  ⚠ LIVE tier selected but --allow-live-tunnel not passed — the live tunnel step will be skipped.\n`,
    )
  }

  if (providerE2E) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ PROVIDER e2e enabled — will CREATE a plan, LEASE a node (≤1 DVPN/1h), self-subscribe, connect, then END the lease.\n`)
  }

  await runEngine({ maxTier, mnemonic, allowWalletMutations, allowLiveTunnel, maxProbe, providerE2E }, reporter)

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
