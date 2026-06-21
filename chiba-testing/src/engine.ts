// ─── engine.ts ───
//
// The test engine. For each channel spec, in tier order:
//   1. gate by max tier (skip anything above the allowed tier),
//   2. build args from the live discovery context,
//   3. invoke the REAL handler via the registry, timed,
//   4. assert the coarse contract (envelope/value/void),
//   5. mine findings (slow call, empty result, malformed envelope, leaked internals),
//   6. thread discovered ids (plan/node/provider) forward for later specs.
//
// The engine never re-implements handler logic. It only drives + observes.

import { invoke, hasChannel } from './registry'
import { CHANNELS, channelsUpToTier, TIER_ORDER, InvokeContext, ChannelSpec, Tier } from './channels'
import { Reporter, ChannelResult, Finding } from './reporter'
import { runLive } from './live-connect'
import { runProviderE2E } from './provider-e2e'

const SLOW_MS = 4_000
// Chain-test pacing: spend-tier channels BROADCAST real transactions. Sentinel RPC
// rate-limits bursty broadcasts, and back-to-back tx from one account can land in the
// same block / race the sequence number. Pace every spend call by this gap. (Readonly
// reads keep their lighter 150ms pacing below.)
const SPEND_GAP_MS = 7_000

export interface EngineOptions {
  maxTier: Tier
  /** Optional mnemonic for a throwaway wallet, enabling wallet-dependent reads. */
  mnemonic?: string
  /**
   * Opt-in to running wallet-store-mutating channels (add/remove/switch/rename/
   * setup/forget). The harness shares the installed app's real wallet store, so these
   * are skipped by default to protect the user's wallets. Only set with a throwaway
   * profile.
   */
  allowWalletMutations?: boolean
  /**
   * Hard opt-in for the LIVE tier: actually bring a real tunnel up on this host
   * (WireGuard/tun2socks) to exercise the feature branches gated behind an active
   * session/config. Mutates the host network stack and spends on sessions.
   */
  allowLiveTunnel?: boolean
  /**
   * Cap how many nodes the LIVE tier probes (one real node:info RTT each) looking for a
   * live one. Defaults inside runLive when unset.
   */
  maxProbe?: number
  /**
   * Hard opt-in for the PROVIDER e2e: act as a plan OWNER — create a plan, lease a
   * live node into it (≤1 DVPN/1h ceiling), self-subscribe, connect, then end the
   * lease. Supersedes the consumer live tier (runLive) when set. Spends real funds.
   */
  providerE2E?: boolean
}

function isEnvelope(v: unknown): v is { success: boolean; error?: string } {
  return typeof v === 'object' && v !== null && 'success' in (v as Record<string, unknown>)
}

/** Heuristic: does this string leak internals a user should never see? */
function looksLeaky(s: string): boolean {
  const l = s.toLowerCase()
  return (
    l.includes('undefined is not') ||
    l.includes('cannot read prop') ||
    l.includes('\\users\\') ||
    l.includes('/users/') ||
    l.includes('node_modules') ||
    l.includes('econnrefused 127.0.0.1') ||
    /\bat .+\(.+:\d+:\d+\)/.test(s) // a raw stack frame
  )
}

/** Pull a usable plan/node/provider id out of a fetch result, if present. */
function harvestContext(channel: string, value: unknown, ctx: InvokeContext): void {
  if (!isEnvelope(value)) return
  const v = value as Record<string, unknown>
  // A loaded wallet yields the active address — thread it into ctx so balance/info
  // reads (and any later spend specs) target the real wallet instead of an empty list.
  if ((channel === 'wallet:loadStored' || channel === 'wallet:setup' || channel === 'wallet:getInfo') &&
      v.success === true && typeof v.address === 'string') {
    ctx.address = v.address
  }
  if (channel === 'plans:fetch' && Array.isArray(v.plans) && v.plans.length) {
    const p = v.plans[0] as Record<string, unknown>
    if (typeof p.id === 'number') ctx.planId = p.id
    if (typeof p.provAddress === 'string') ctx.providerAddress = p.provAddress
  }
  if ((channel === 'plan:nodes' || channel === 'nodes:fetch') && Array.isArray(v.nodes) && v.nodes.length) {
    const n = v.nodes[0] as Record<string, unknown>
    if (typeof n.address === 'string' && !ctx.nodeAddress) ctx.nodeAddress = n.address
  }
  if (channel === 'sessions:fetch' && Array.isArray(v.sessions) && v.sessions.length) {
    const s = v.sessions[0] as Record<string, unknown>
    if (typeof s.id === 'number') ctx.sessionId = s.id
    if (typeof s.nodeAddress === 'string' && !ctx.nodeAddress) ctx.nodeAddress = s.nodeAddress
  }
  if (channel === 'subscriptions:fetch' && Array.isArray(v.subscriptions) && v.subscriptions.length) {
    // Status enum: 1=ACTIVE, 2=INACTIVE_PENDING, 3=INACTIVE. The chain REJECTS connect/
    // update/cancel against anything that is not ACTIVE ("invalid status inactive_pending
    // for subscription …"). So we must pick an ACTIVE sub, not blindly subscriptions[0].
    const subs = v.subscriptions as Array<Record<string, unknown>>
    const active = subs.find((s) => s.status === 1)
    const chosen = active ?? subs[0]
    if (typeof chosen.id === 'number') ctx.subscriptionId = chosen.id
    // Thread the chosen sub's planId so the live tier probes nodes ON that plan.
    if (typeof chosen.planId === 'number') ctx.planId = chosen.planId
    // Record whether we actually have a usable ACTIVE sub — the live tier needs this to
    // decide whether it must create a fresh subscription before connecting.
    ctx.subscriptionActive = !!active
  }
}

/**
 * Returns a human-readable description of the missing precondition for a spend channel,
 * or null if all required context is present. Used to SKIP (not broadcast) spend tx that
 * would only fail with "id cannot be zero" / empty-address because an upstream harvest
 * found nothing on chain. `plan:subscribe` / `node:connect` only need a planId / nodeAddress
 * (which default sensibly), so they are not gated here — the id-dependent cancels/updates are.
 */
function spendPrecondition(channel: string, ctx: InvokeContext): string | null {
  const hasSub = typeof ctx.subscriptionId === 'number' && ctx.subscriptionId > 0
  const hasSess = typeof ctx.sessionId === 'number' && ctx.sessionId > 0
  const hasNode = typeof ctx.nodeAddress === 'string' && ctx.nodeAddress.length > 0
  switch (channel) {
    case 'subscription:update':
    case 'subscription:cancel':
      return hasSub ? null : 'no subscriptionId harvested (subscriptions:fetch returned none)'
    case 'subscription:connect':
      if (!hasSub) return 'no subscriptionId harvested (subscriptions:fetch returned none)'
      return hasNode ? null : 'no nodeAddress harvested (nodes/plan-nodes returned none)'
    case 'session:cancel':
      return hasSess ? null : 'no sessionId harvested (sessions:fetch returned none)'
    default:
      return null
  }
}

/** Assert a single spec's contract and mine findings; returns a ChannelResult. */
function evaluate(spec: ChannelSpec, value: unknown, ms: number): ChannelResult {
  const findings: Finding[] = []
  let outcome: ChannelResult['outcome'] = 'pass'
  let detail: string | undefined

  if (ms >= SLOW_MS) findings.push({ severity: 'warn', message: `slow: ${ms}ms (>= ${SLOW_MS}ms)` })

  if (spec.returns === 'envelope') {
    if (!isEnvelope(value)) {
      outcome = 'fail'
      detail = `expected { success } envelope, got ${typeof value}`
    } else {
      const env = value as { success: boolean; error?: string; [k: string]: unknown }
      if (env.success === false) {
        // A clean "not initialized / empty" failure is acceptable for read-only
        // channels when no wallet is loaded — record as info, not a hard fail.
        const err = String(env.error ?? '')
        detail = err || 'success:false'
        if (looksLeaky(err)) {
          findings.push({ severity: 'error', message: `error string leaks internals: ${err}` })
          outcome = 'fail'
        } else {
          findings.push({ severity: 'info', message: `handler returned success:false — ${err || '(no error string)'}` })
        }
      } else {
        // success:true — note empty result sets where data was expected.
        for (const key of ['plans', 'nodes', 'sessions', 'subscriptions']) {
          if (Array.isArray(env[key]) && (env[key] as unknown[]).length === 0) {
            findings.push({ severity: 'info', message: `${key} returned empty` })
          }
        }
      }
    }
  } else if (spec.returns === 'value') {
    if (value === undefined || value === null) {
      findings.push({ severity: 'warn', message: 'value handler returned null/undefined' })
    }
  }
  return { channel: spec.channel, api: spec.api, tier: spec.tier, outcome, ms, detail, findings }
}

export async function runEngine(opts: EngineOptions, reporter: Reporter): Promise<void> {
  const ctx: InvokeContext = {}
  if (opts.mnemonic) ctx.mnemonic = opts.mnemonic

  // Safety interlock: a spend-tier run broadcasts REAL tx against the loaded (real)
  // active wallet, and its cancels target ids harvested from subscriptions:fetch /
  // sessions:fetch. If wallet mutations are ALSO enabled, wallet:switch/forget/remove
  // can change the active wallet MID-RUN — so those fetches harvest ids from the wrong
  // (or no) wallet, the harvested subscriptionId/sessionId stay 0, and the cancels fire
  // against id 0 ("id cannot be zero") instead of the real sub/session. The two modes
  // are mutually exclusive; refuse the combination outright rather than silently
  // producing a run whose destructive paths never touched anything real.
  const spendActive = TIER_ORDER.indexOf(opts.maxTier) >= TIER_ORDER.indexOf('spend')
  if (spendActive && opts.allowWalletMutations) {
    throw new Error(
      'refusing to run: --allow-wallet-mutations cannot be combined with the spend tier. ' +
        'Wallet mutations change the active wallet mid-run, which scrambles the ids the spend ' +
        'cancels target (you get "id cannot be zero" and the real sub/session is never touched). ' +
        'Run spend WITHOUT --allow-wallet-mutations against a real funded wallet.',
    )
  }

  const inTier = channelsUpToTier(opts.maxTier)
  const skipped = CHANNELS.filter((c) => !inTier.includes(c))

  // Record skipped (above-tier) channels up front so the map stays complete.
  for (const s of skipped) {
    reporter.record({
      channel: s.channel, api: s.api, tier: s.tier, outcome: 'skip', ms: 0,
      detail: `tier '${s.tier}' above max '${opts.maxTier}'`, findings: [],
    })
  }

  // Execution order (F5): the canonical CHANNELS array doubles as the map, so we don't
  // reorder it — instead we sequence execution so the chain reads run against a LIVE
  // RPC client. wallet:loadStored must run before any read that needs a client, and the
  // destructive wallet ops (forget/remove) must run LAST or they tear the client down
  // mid-run and mask what the reads actually do. Without this, a multi-tier run exercises
  // the chain reads in a no-client state (they all return success:false) — a false signal.
  const DEFER_LAST = new Set(['wallet:forget', 'wallet:remove'])
  const LOAD_FIRST = new Set(['wallet:loadStored'])

  // Spend-tier ordering. These broadcast real tx; inputs must be valid at call time and
  // CREATES must run before CANCELS (a cancel consumes the id a create produced, and a
  // cancel of the only sub/session would starve later connect ops of context). Lower rank
  // runs earlier. Anything spend-tier not listed defaults to rank 50 (between creates and
  // cancels). Readonly reads (which harvest planId/subscriptionId/sessionId/nodeAddress)
  // already ran by here because they sit in `middle` before the spend ops are appended.
  const SPEND_RANK: Record<string, number> = {
    'plan:subscribe': 10, // create a fresh subscription first
    'subscription:update': 20, // mutate the (now-known) subscription
    'subscription:connect': 30, // start a session under a subscription
    'node:connect': 40, // full connect: session start + tunnel
    'session:cancel': 90, // cancels LAST — they tear down session...
    'subscription:cancel': 95, // ...then the subscription (most destructive last)
  }
  const isSpend = (s: ChannelSpec): boolean => s.tier === 'spend'

  const loadFirst = inTier.filter((s) => LOAD_FIRST.has(s.channel))
  const deferLast = inTier.filter((s) => DEFER_LAST.has(s.channel))
  const spend = inTier
    .filter((s) => isSpend(s) && !DEFER_LAST.has(s.channel))
    .sort((a, b) => (SPEND_RANK[a.channel] ?? 50) - (SPEND_RANK[b.channel] ?? 50))
  const middle = inTier.filter(
    (s) => !LOAD_FIRST.has(s.channel) && !DEFER_LAST.has(s.channel) && !isSpend(s),
  )
  // readonly reads (in middle) run first to harvest ids, THEN spend tx, THEN wallet teardown.
  const specs = [...loadFirst, ...middle, ...spend, ...deferLast]

  for (const spec of specs) {
    // The harness now shares the INSTALLED app's real wallet store (boot.ts forces
    // app.setName('chibatunnel')). Channels that mutate that store (add/remove/switch/
    // rename/setup/forget) would corrupt or destroy the user's real wallets. Skip them
    // unless explicitly opted in with a throwaway profile.
    if (spec.mutatesWallet && !opts.allowWalletMutations) {
      reporter.record({
        channel: spec.channel, api: spec.api, tier: spec.tier, outcome: 'skip', ms: 0,
        detail: 'mutates the shared/real wallet store — skipped (pass --allow-wallet-mutations to run)',
        findings: [],
      })
      continue
    }

    // Spend-tier preconditions. These broadcast a REAL tx and cost money. Several need
    // an id/address harvested from an earlier readonly read (subscriptionId from
    // subscriptions:fetch, sessionId from sessions:fetch, nodeAddress from nodes/plan
    // nodes). If that harvest produced nothing — no sub on chain, no live session, no
    // node — the arg falls back to 0 / '' and the handler broadcasts a doomed tx that
    // the chain rejects with "id cannot be zero". That's not a real test of the path; it
    // just burns fees and pollutes the report with a fake failure. SKIP (don't broadcast)
    // when the precondition isn't met, and say exactly what was missing.
    if (spec.tier === 'spend') {
      const missing = spendPrecondition(spec.channel, ctx)
      if (missing) {
        reporter.record({
          channel: spec.channel, api: spec.api, tier: spec.tier, outcome: 'skip', ms: 0,
          detail: `spend precondition not met: ${missing} — not broadcast (would fail "id cannot be zero")`,
          findings: [],
        })
        continue
      }
    }

    // The harness boots windowless; channels that open a native dialog would block
    // on a modal with no parent window. Never invoke them — record an explicit skip.
    if (spec.requiresWindow) {
      reporter.record({
        channel: spec.channel, api: spec.api, tier: spec.tier, outcome: 'skip', ms: 0,
        detail: 'requires a focused window (native dialog) — not invoked headless', findings: [],
      })
      continue
    }

    if (!hasChannel(spec.channel)) {
      reporter.record({
        channel: spec.channel, api: spec.api, tier: spec.tier, outcome: 'fail', ms: 0,
        detail: 'channel in map but NOT registered by app', findings: [
          { severity: 'error', message: 'app did not register this channel — map drift or removed handler' },
        ],
      })
      continue
    }

    const args = spec.args ? spec.args(ctx) : []
    const start = Date.now()
    try {
      const value = await invoke(spec.channel, ...args)
      const ms = Date.now() - start
      harvestContext(spec.channel, value, ctx)
      reporter.record(evaluate(spec, value, ms))
    } catch (err) {
      const ms = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      reporter.record({
        channel: spec.channel, api: spec.api, tier: spec.tier, outcome: 'error', ms,
        detail: msg, findings: [{ severity: 'error', message: `handler threw: ${msg}` }],
      })
    }

    // RPC-first, rate-limit-aware pacing.
    // Spend tier broadcasts tx → 7s gap (sequence-number + rate-limit safety).
    // Readonly chain reads → light 150ms gap.
    if (spec.tier === 'spend') await new Promise((r) => setTimeout(r, SPEND_GAP_MS))
    else if (spec.tier === 'readonly') await new Promise((r) => setTimeout(r, 150))
  }

  // ── LIVE tier ──
  // Runs only at --tier=live. By here the readonly pass has harvested the wallet's
  // planId/subscriptionId/sessionId into ctx, so the live pass can probe the plan's
  // nodes for a live one and bring a REAL tunnel up against it — the only way to
  // execute the feature branches gated behind an active session/config (split tunnel,
  // DoH, transparent tun2socks, traffic sources, on-chain disconnect).
  if (TIER_ORDER.indexOf(opts.maxTier) >= TIER_ORDER.indexOf('live')) {
    if (opts.providerE2E) {
      // PROVIDER e2e supersedes the consumer live tier: instead of subscribing to
      // someone else's plan, we OWN the plan — create it, lease+link a live node,
      // self-subscribe, connect, end the lease. The readonly pass already harvested
      // the wallet address into ctx, which the provider path uses as `from`.
      await runProviderE2E(
        { mnemonic: opts.mnemonic, allowLiveTunnel: opts.allowLiveTunnel, maxProbe: opts.maxProbe },
        ctx,
        reporter,
      )
    } else {
      await runLive(
        { mnemonic: opts.mnemonic, allowLiveTunnel: opts.allowLiveTunnel, maxProbe: opts.maxProbe },
        ctx,
        reporter,
      )
    }
  }
}
