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
import { CHANNELS, channelsUpToTier, InvokeContext, ChannelSpec, Tier } from './channels'
import { Reporter, ChannelResult, Finding } from './reporter'

const SLOW_MS = 4_000

export interface EngineOptions {
  maxTier: Tier
  /** Optional mnemonic for a throwaway wallet, enabling wallet-dependent reads. */
  mnemonic?: string
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
    const sub = v.subscriptions[0] as Record<string, unknown>
    if (typeof sub.id === 'number') ctx.subscriptionId = sub.id
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

  const specs = channelsUpToTier(opts.maxTier)
  const skipped = CHANNELS.filter((c) => !specs.includes(c))

  // Record skipped (above-tier) channels up front so the map stays complete.
  for (const s of skipped) {
    reporter.record({
      channel: s.channel, api: s.api, tier: s.tier, outcome: 'skip', ms: 0,
      detail: `tier '${s.tier}' above max '${opts.maxTier}'`, findings: [],
    })
  }

  for (const spec of specs) {
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

    // RPC-first, rate-limit-aware: small pacing between chain reads.
    if (spec.tier === 'readonly') await new Promise((r) => setTimeout(r, 150))
  }
}
