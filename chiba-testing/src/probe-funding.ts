// ─── probe-funding.ts ───
//
// Read-only funding probe. Boots the real app under CHIBA_TEST=1, loads the
// active STORED wallet via the app's own wallet:loadStored (machine-bound
// safeStorage decryption — works as this OS user), then reports address,
// balances, subscriptions and sessions on-chain.
//
// It NEVER prints the mnemonic. The decrypted secret stays inside the app's
// walletState; we only ever read back the derived address and chain balances.
//
// Run:  electron chiba-testing/dist/probe-funding.js   (with CHIBA_TEST=1)

import { app } from 'electron'
import * as path from 'path'
import { installCapture, invoke, hasChannel } from './registry'

process.env.CHIBA_TEST = '1'
// Match the INSTALLED app's userData dir (see boot.ts) so this probe reads the REAL
// wallet store (...\Roaming\chibatunnel), not the empty parallel ...\Roaming\Electron
// store the raw electron binary would otherwise resolve. Must run before requiring the
// bundle (the app constructs its Store at module load).
app.setName('chibatunnel')
installCapture()

const APP_MAIN = path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')

function line(s = ''): void {
  // eslint-disable-next-line no-console
  console.log(s)
}

async function run(): Promise<void> {
  line('\n  Chiba — funding probe (read-only)\n')

  // 1. What wallets are stored?
  if (hasChannel('wallet:list')) {
    const list = await invoke('wallet:list')
    line(`  wallet:list → ${JSON.stringify(list)}`)
  }

  // 2. Load the active stored wallet (decrypts via safeStorage; mnemonic never leaves walletState).
  if (!hasChannel('wallet:loadStored')) {
    line('  ✗ wallet:loadStored not registered')
    app.exit(1)
    return
  }
  const loaded = (await invoke('wallet:loadStored')) as { success: boolean; address?: string; error?: string }
  if (!loaded?.success || !loaded.address) {
    line(`  ✗ loadStored failed: ${JSON.stringify(loaded)}`)
    app.exit(1)
    return
  }
  const address = loaded.address
  line(`  ✓ loaded wallet address: ${address}`)

  // 3. Balances for that address.
  const bal = await invoke('wallet:getBalances', [address])
  line(`\n  balances → ${JSON.stringify(bal)}`)

  // 4. Rich info (balances + sessions) from the loaded wallet.
  const info = await invoke('wallet:getInfo')
  line(`  getInfo  → ${JSON.stringify(info)}`)

  // 5. Subscriptions + sessions on chain.
  if (hasChannel('subscriptions:fetch')) {
    const subs = await invoke('subscriptions:fetch')
    line(`\n  subscriptions:fetch → ${JSON.stringify(subs)}`)
  }
  if (hasChannel('sessions:fetch')) {
    const sess = await invoke('sessions:fetch')
    line(`  sessions:fetch      → ${JSON.stringify(sess)}`)
  }

  // 6. Plan pricing — what a live subscribe would actually COST. Dump every active plan's
  //    udvpn price, public/private flag and bytes/duration so we can pick the cheapest
  //    PUBLIC plan and never broadcast an expensive subscribe by accident.
  if (hasChannel('plans:fetch')) {
    const res = (await invoke('plans:fetch')) as { plans?: Array<Record<string, unknown>> }
    const plans = Array.isArray(res?.plans) ? res.plans : []
    line(`\n  plans:fetch → ${plans.length} active plan(s)`)
    const priced = plans
      .map((p) => {
        const prices = Array.isArray(p.prices) ? (p.prices as Array<{ denom: string; amount: string }>) : []
        const udvpn = prices.find((x) => x.denom === 'udvpn')
        return {
          id: p.id,
          private: p.private === true,
          udvpn: udvpn ? Number(udvpn.amount) : null,
          denoms: prices.map((x) => x.denom).join(','),
          bytes: p.bytes,
          duration: p.duration,
        }
      })
      .sort((a, b) => (a.udvpn ?? Infinity) - (b.udvpn ?? Infinity))
    for (const r of priced) {
      line(
        `    plan ${String(r.id).padStart(5)} ${r.private ? 'PRIVATE' : 'public '} udvpn=${
          r.udvpn ?? '—'
        } denoms=[${r.denoms}] bytes=${r.bytes} dur=${r.duration}`,
      )
    }
    const cheapestPublic = priced.find((r) => !r.private && r.udvpn != null)
    line(
      `\n  cheapest PUBLIC udvpn plan → ${
        cheapestPublic ? `plan ${cheapestPublic.id} @ ${cheapestPublic.udvpn} udvpn` : 'none found'
      }`,
    )
  }

  line('\n  funding probe done\n')
  app.exit(0)
}

;(app as unknown as { on(event: string, cb: () => void): void }).on('chiba-test:ready', () => {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Funding probe failed:', err)
    app.exit(3)
  })
})

require(APP_MAIN)
