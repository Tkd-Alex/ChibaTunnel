// ─── provider-e2e.ts ───
//
// The PROVIDER tier. Everything in live-connect.ts exercises the app as a
// CONSUMER — subscribe to someone else's plan, connect, delink. This module
// flips the wallet into the PROVIDER role and drives the full operator e2e the
// user asked for: "create your own plan, add a node to it, and try to connect
// to it".
//
// Flow (every step a REAL on-chain tx against the funded chiba wallet, single
// wallet acting as BOTH provider and subscriber — self-subscribe):
//   1. probe the off-chain node list for nodes that are ACTUALLY live,
//   2. for each live node read its on-chain hourly udvpn price and enforce a
//      hard lease ceiling (≤ 1 DVPN = 1,000,000 udvpn for a 1h lease); pick the
//      CHEAPEST qualifying node and ABORT if none qualify — never broadcast an
//      expensive lease blind,
//   3. MsgCreatePlanRequest → parse the new plan id from sentinel.plan.v3.EventCreate,
//   4. [MsgStartLeaseRequest(1h, maxPrice), MsgLinkNodeRequest(planId, node)]
//      bundled ATOMICALLY — lease pays the node provider, link attaches the node
//      to our plan; parse the lease id from sentinel.lease.v1.EventCreate,
//   5. self-subscribe to our own plan (plan:subscribe — as plan owner we are
//      always authorized), confirm ACTIVE, connect for real (subscription:connect),
//   6. tear down: disconnect / end session, then MsgEndLeaseRequest to release
//      the node — leaving the chain as we found it.
//
// The harness NEVER re-implements signing. The mnemonic never leaves the app's
// walletState: every broadcast goes through the IS_TEST_HARNESS-gated
// `test:providerBroadcast` handler (which signs via the real walletState.client
// and registers the lease msg types onto its registry), and pricing comes from
// `test:nodeHourlyPrice`. Gated behind --tier=live AND --allow-live-tunnel AND
// --provider-e2e because it spends real funds and brings a real tunnel up.

import { invoke, hasChannel } from './registry'
import { InvokeContext } from './channels'
import { Reporter } from './reporter'
import {
  NodeCandidate,
  asCandidates,
  probeForLiveNodes,
  step,
} from './live-connect'

// ── lease ceiling (locked decision, revised) ──
// Originally ≤ 1 DVPN/1h, but the cheapest ACTUALLY-LIVE node on mainnet leases
// at 50 DVPN/h — no live node exists under 1 DVPN, so the gate aborted every run
// before any broadcast. Per the user ("Fund + raise ceiling to ~55 DVPN") the
// ceiling is raised to 55 DVPN so the provider path can be proven end-to-end on a
// real live node. Lease cost for H hours = quoteValue × H udvpn; for H=1 the cost
// in udvpn IS quoteValue, so the ceiling is quoteValue ≤ 55,000,000.
const LEASE_HOURS = 1
const LEASE_CEILING_UDVPN = 55_000_000

const STEP_GAP_MS = 7_000
const PLAN_CONFIRM_MS = 6_000
const SUBSCRIBE_CONFIRM_MS = 6_000

// chiba-SDK proto typeUrls.
const TYPE_CREATE_PLAN = '/sentinel.plan.v3.MsgCreatePlanRequest'
const TYPE_LINK_NODE = '/sentinel.plan.v3.MsgLinkNodeRequest'
const TYPE_UPDATE_PLAN_STATUS = '/sentinel.plan.v3.MsgUpdatePlanStatusRequest'
const TYPE_START_LEASE = '/sentinel.lease.v1.MsgStartLeaseRequest'
const TYPE_END_LEASE = '/sentinel.lease.v1.MsgEndLeaseRequest'

interface BroadcastResult {
  success?: boolean
  error?: string
  txHash?: string
  height?: number
  rawLog?: string
  events?: Array<{ type?: string; attributes?: Array<{ key?: unknown; value?: unknown }> }>
}

interface NodeHourlyPrice {
  success?: boolean
  error?: string
  price?: { denom: string; baseValue: string; quoteValue: string }
  remote?: string | null
}

/**
 * Pull the first matching attribute value out of a tx's decoded events. cosmjs
 * returns event attrs already decoded ({key, value} as plain strings) from
 * signAndBroadcast, so no base64 handling is needed here.
 */
function eventId(
  events: BroadcastResult['events'],
  typeRe: RegExp,
  keys: string[],
): string | null {
  if (!Array.isArray(events)) return null
  for (const ev of events) {
    if (typeof ev?.type !== 'string' || !typeRe.test(ev.type)) continue
    for (const attr of ev.attributes ?? []) {
      const k = typeof attr?.key === 'string' ? attr.key : ''
      if (!keys.includes(k)) continue
      const v = typeof attr?.value === 'string' ? attr.value : String(attr?.value ?? '')
      if (v) return v.replace(/"/g, '')
    }
  }
  return null
}

/** Broadcast a provider message bundle via the test-only handler. */
async function providerBroadcast(
  msgs: Array<{ typeUrl: string; value: unknown }>,
  memo?: string,
): Promise<BroadcastResult> {
  return (await invoke('test:providerBroadcast', { msgs, memo })) as BroadcastResult
}

/**
 * For each live node, read its on-chain hourly udvpn price and keep only those
 * at or under the lease ceiling. Returns the cheapest qualifying node (with its
 * maxPrice for the lease msg) or null if none qualify. NEVER returns a node we
 * haven't priced — this is the "check the plan pricing" gate before any spend.
 */
async function cheapestLeasableNode(
  reporter: Reporter,
  live: NodeCandidate[],
): Promise<{ node: NodeCandidate; price: { denom: string; baseValue: string; quoteValue: string } } | null> {
  let best: { node: NodeCandidate; price: { denom: string; baseValue: string; quoteValue: string }; quote: number } | null = null
  for (const node of live) {
    const res = (await invoke('test:nodeHourlyPrice', node.address)) as NodeHourlyPrice
    if (res?.success !== true || !res.price) {
      step(reporter, 'test:nodeHourlyPrice', `node ${node.address}: no udvpn hourly price (${res?.error ?? 'unknown'}) — skipping`, 'skip')
      continue
    }
    const quote = Number(res.price.quoteValue)
    const cost1h = quote * LEASE_HOURS // udvpn for a 1h lease
    if (!Number.isFinite(quote) || quote <= 0) {
      step(reporter, 'test:nodeHourlyPrice', `node ${node.address}: unparseable quoteValue=${res.price.quoteValue} — skipping`, 'skip')
      continue
    }
    if (cost1h > LEASE_CEILING_UDVPN) {
      step(
        reporter,
        'test:nodeHourlyPrice',
        `node ${node.address}: ${LEASE_HOURS}h lease = ${cost1h} udvpn > ceiling ${LEASE_CEILING_UDVPN} (1 DVPN) — over budget, skipping`,
        'skip',
      )
      continue
    }
    step(
      reporter,
      'test:nodeHourlyPrice',
      `node ${node.address}: ${LEASE_HOURS}h lease = ${cost1h} udvpn ≤ ceiling ${LEASE_CEILING_UDVPN} — leasable`,
      'pass',
    )
    if (!best || quote < best.quote) best = { node, price: res.price, quote }
  }
  if (!best) return null
  step(
    reporter,
    'provider:node-selected',
    `cheapest leasable live node: ${best.node.address} @ ${best.quote} udvpn/h (${best.quote * LEASE_HOURS} udvpn for ${LEASE_HOURS}h)`,
    'pass',
  )
  return { node: best.node, price: best.price }
}

export interface ProviderOptions {
  mnemonic?: string
  allowLiveTunnel?: boolean
  maxProbe?: number
}

/**
 * Run the provider e2e: create a plan, lease+link a live node into it, self-
 * subscribe, connect, then end the lease. Records every step into `reporter`.
 * The consumer live tier (runLive) is NOT run alongside this — the provider
 * path supersedes it when --provider-e2e is set.
 */
export async function runProviderE2E(opts: ProviderOptions, ctx: InvokeContext, reporter: Reporter): Promise<void> {
  if (!opts.allowLiveTunnel) {
    step(reporter, 'provider:e2e', 'provider e2e requires --allow-live-tunnel (spends real funds, brings a tunnel up) — not run', 'skip')
    return
  }

  // Preconditions: the test-only provider channels must be registered (they are,
  // under CHIBA_TEST=1), and we need a loaded wallet address to be `from`.
  if (!hasChannel('test:providerBroadcast') || !hasChannel('test:nodeHourlyPrice')) {
    step(reporter, 'provider:e2e', 'test:providerBroadcast / test:nodeHourlyPrice not registered — app build missing the provider handlers', 'fail', 0, [
      { severity: 'error', message: 'provider broadcast channels absent — rebuild the app bundle' },
    ])
    return
  }
  const from = ctx.address
  if (!from) {
    step(reporter, 'provider:e2e', 'no wallet address in context (wallet:loadStored did not harvest one) — cannot act as provider', 'fail')
    return
  }

  // ── 0. fund the provider wallet from the user's OTHER stored wallets ──
  // The cheapest live node leases at ~50 DVPN/h; the provider wallet had drained
  // to ~18 DVPN across prior test runs. Consolidate udvpn from every other wallet
  // in the real store into the provider address so lease + self-subscribe + gas
  // clear. Read-balances first, only broadcasts from wallets with a movable
  // surplus, and leaves 0.5 DVPN + fee in each source. Mnemonics never printed.
  if (hasChannel('test:fundProvider')) {
    const fundT = Date.now()
    const fund = (await invoke('test:fundProvider', { target: from, keep: '500000' })) as {
      success?: boolean
      error?: string
      target?: string
      targetBalance?: string
      moves?: Array<{ from: string; label: string; amount: string; txHash?: string; error?: string; skipped?: string }>
    }
    if (fund?.success === true) {
      const sent = (fund.moves ?? []).filter((m) => m.txHash)
      const detail = sent.length
        ? `consolidated from ${sent.length} wallet(s): ${sent.map((m) => `${m.label}→${Number(m.amount) / 1e6}DVPN`).join(', ')} | provider now ${Number(fund.targetBalance ?? '0') / 1e6} DVPN`
        : `no surplus to move (provider at ${Number(fund.targetBalance ?? '0') / 1e6} DVPN) — proceeding with existing balance`
      step(reporter, 'provider:fund', detail, 'pass', Date.now() - fundT)
      // settle the consolidation txs before spending against the new balance.
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
    } else {
      step(reporter, 'provider:fund', `funding sweep failed: ${fund?.error ?? 'unknown'} — proceeding with existing balance`, 'skip', Date.now() - fundT)
    }
  }

  // ── 1. find LIVE nodes (real node:info handshake) from the off-chain list ──
  let candidates: NodeCandidate[] = []
  if (hasChannel('nodes:fetch')) candidates = asCandidates(await invoke('nodes:fetch'))
  candidates = candidates
    .filter((c) => c.remote)
    .sort((a, b) => {
      const score = (c: NodeCandidate) => (c.healthy ? 4 : 0) + (c.active ? 2 : 0) + Math.min(c.peers ?? 0, 1)
      return score(b) - score(a) || (b.peers ?? 0) - (a.peers ?? 0)
    })
  if (!candidates.length) {
    step(reporter, 'provider:e2e', 'no reachable node candidates from nodes:fetch — cannot lease a node', 'skip')
    return
  }
  const liveSplit = await probeForLiveNodes(reporter, candidates, opts.maxProbe ?? 80)
  const live = [...liveSplit.wireguard, ...liveSplit.v2ray]
  if (!live.length) {
    step(reporter, 'provider:e2e', 'no live node answered a handshake — cannot lease a node into a plan', 'skip')
    return
  }

  // ── 2. price-gate: cheapest node whose 1h lease is ≤ 1 DVPN, else ABORT ──
  const pick = await cheapestLeasableNode(reporter, live)
  if (!pick) {
    step(
      reporter,
      'provider:e2e',
      `no live node has a ${LEASE_HOURS}h lease at or under ${LEASE_CEILING_UDVPN} udvpn (1 DVPN) — aborting before any spend`,
      'skip',
    )
    return
  }
  const targetNode = pick.node

  // ── 2b. ensure we are a REGISTERED + ACTIVE provider (sentprov) before any plan tx ──
  // Provider/plan/lease/link messages require the `from` field to use the bech32 `sentprov`
  // prefix; the chain rejects a plain `sent` from with "expected sentprov, got sent". The app
  // handler derives the sentprov address, registers + activates the provider if needed (one
  // atomic tx, idempotent if already active), and returns the provAddr we must use as `from`.
  if (!hasChannel('test:ensureProvider')) {
    step(reporter, 'provider:ensure', 'test:ensureProvider not registered — rebuild the app bundle (provider register/activate handler missing)', 'fail', 0, [
      { severity: 'error', message: 'provider register handler absent — cannot become a provider' },
    ])
    return
  }
  let pt = Date.now()
  const prov = (await invoke('test:ensureProvider', { name: 'Chiba Tunnel Test Provider' })) as {
    success?: boolean
    error?: string
    provAddr?: string
    sentAddr?: string
    registered?: boolean
    activated?: boolean
    alreadyActive?: boolean
    freshRegistration?: boolean
    txHash?: string
  }
  if (prov?.success !== true || !prov.provAddr) {
    step(reporter, 'provider:ensure', `could not register/activate provider: ${prov?.error ?? 'unknown'}`, 'fail', Date.now() - pt, [
      { severity: 'error', message: 'provider not active — plan creation will be rejected (expected sentprov)' },
    ])
    return
  }
  const provFrom = prov.provAddr // sentprov-prefixed — the `from` for ALL plan/lease/link/end msgs
  const ensureDetail = prov.alreadyActive
    ? `already a registered+ACTIVE provider (${provFrom}) — no tx needed`
    : `provider ${prov.freshRegistration ? 'registered + activated' : 'activated'} (${provFrom}) ${prov.txHash ? `tx ${prov.txHash}` : ''}`
  step(reporter, 'provider:ensure', ensureDetail, 'pass', Date.now() - pt)
  if (!prov.alreadyActive) await new Promise((r) => setTimeout(r, STEP_GAP_MS))

  // ── 2c. reconcile any PRE-EXISTING lease on the target node ──
  // A prior provider run that crashed before lease:end leaves an orphaned lease on this node.
  // The chain enforces one lease per (node, provider): StartLease then reverts with
  // "duplicate lease" and the whole run fails on un-cleaned state from a previous run. Query
  // the node's leases up front; if THIS provider already holds one, end it so the fresh
  // StartLease below succeeds. (Leases held by OTHER providers are left untouched — they are
  // not ours to end, and the cheapest-node picker can still select this node since the chain
  // only blocks a second lease by the SAME provider.) Honest no-op if the channel is absent.
  if (hasChannel('test:leasesForNode')) {
    const rt = Date.now()
    const lr = (await invoke('test:leasesForNode', targetNode.address)) as {
      success?: boolean
      error?: string
      leases?: Array<{ id: number; provAddress: string; nodeAddress: string }>
    }
    if (lr?.success !== true) {
      step(reporter, 'lease:reconcile(provider)', `could not query existing leases for ${targetNode.address}: ${lr?.error ?? 'unknown'} — proceeding (StartLease will surface a duplicate if one exists)`, 'skip', Date.now() - rt)
    } else {
      const mine = (lr.leases ?? []).filter((l) => l.provAddress === provFrom && Number.isFinite(l.id) && l.id > 0)
      if (!mine.length) {
        step(reporter, 'lease:reconcile(provider)', `no pre-existing lease by this provider on ${targetNode.address} — clean to lease`, 'pass', Date.now() - rt)
      } else {
        for (const orphan of mine) {
          const et = Date.now()
          const ended = await providerBroadcast([{ typeUrl: TYPE_END_LEASE, value: { from: provFrom, id: String(orphan.id) } }])
          step(
            reporter,
            'lease:reconcile(provider)',
            ended?.success === true
              ? `ended orphaned lease ${orphan.id} on ${targetNode.address} (tx ${ended.txHash}) — node freed for a fresh lease`
              : `could not end orphaned lease ${orphan.id}: ${ended?.error ?? 'unknown'} — fresh StartLease may still revert`,
            ended?.success === true ? 'pass' : 'fail',
            Date.now() - et,
          )
          await new Promise((r) => setTimeout(r, STEP_GAP_MS))
        }
      }
    }
  }

  // ── 3. create our own plan ──
  // chiba-SDK MsgCreatePlanRequest shape: { from, bytes (string), duration
  // (Duration {seconds, nanos}), prices (Price[]), private (NOT isPrivate) }.
  // `from` MUST be the sentprov provider address (provFrom), not the sent account address.
  // Modest, public plan: 1 GB, 1h duration, priced so a self-subscribe is cheap.
  const planBytes = String(1_000_000_000n) // 1 GB
  const planPrices = [{ denom: 'udvpn', baseValue: '1000000', quoteValue: '1000000' }]
  const createValue = {
    from: provFrom,
    bytes: planBytes,
    duration: { seconds: String(3600), nanos: 0 }, // protobuf Duration, 1h
    prices: planPrices,
    private: false,
  }
  let t = Date.now()
  const created = await providerBroadcast([{ typeUrl: TYPE_CREATE_PLAN, value: createValue }])
  if (created?.success !== true) {
    step(reporter, 'plan:create(provider)', `MsgCreatePlanRequest failed: ${created?.error ?? 'unknown'}`, 'fail', Date.now() - t, [
      { severity: 'error', message: 'could not create the provider plan — no plan to link/subscribe' },
    ])
    return
  }
  const planIdStr = eventId(created.events, /plan.*EventCreate|EventCreate/i, ['plan_id', 'id'])
  const planId = planIdStr != null ? Number(planIdStr) : NaN
  if (!Number.isFinite(planId) || planId <= 0) {
    step(reporter, 'plan:create(provider)', `plan created (tx ${created.txHash}) but could not parse plan id from events`, 'fail', Date.now() - t, [
      { severity: 'error', message: 'plan_id not found in tx events — cannot link/subscribe' },
    ])
    return
  }
  ctx.planId = planId
  step(reporter, 'plan:create(provider)', `created plan ${planId} (tx ${created.txHash}) — public, 1GB, 1h`, 'pass', Date.now() - t)
  await new Promise((r) => setTimeout(r, PLAN_CONFIRM_MS))

  // ── 4. lease + link the node into our plan ATOMICALLY ──
  // MsgStartLeaseRequest: { from, nodeAddress, hours (Long), maxPrice (Price),
  // renewalPricePolicy }. MsgLinkNodeRequest: { from, id (Long planId), nodeAddress }.
  // Bundling both in one tx means the node is leased AND attached together — if
  // either fails the whole tx reverts (no orphaned lease, no dangling link).
  let leaseId: number | null = null
  try {
    const leaseValue = {
      from: provFrom, // sentprov — lease is taken by the provider linking the node
      nodeAddress: targetNode.address,
      hours: String(LEASE_HOURS), // Long-compatible string
      maxPrice: { denom: pick.price.denom, baseValue: pick.price.baseValue, quoteValue: pick.price.quoteValue },
      renewalPricePolicy: 1, // RENEWAL_PRICE_POLICY_IF_LESSER — only renew if cheaper
    }
    const linkValue = { from: provFrom, id: String(planId), nodeAddress: targetNode.address }
    t = Date.now()
    const leaseLink = await providerBroadcast([
      { typeUrl: TYPE_START_LEASE, value: leaseValue },
      { typeUrl: TYPE_LINK_NODE, value: linkValue },
    ])
    if (leaseLink?.success !== true) {
      step(reporter, 'lease+link(provider)', `[StartLease, LinkNode] failed: ${leaseLink?.error ?? 'unknown'}`, 'fail', Date.now() - t, [
        { severity: 'error', message: 'lease/link bundle reverted — node not attached to plan' },
      ])
      return
    }
    const leaseIdStr = eventId(leaseLink.events, /lease.*EventCreate|EventCreate/i, ['lease_id', 'id'])
    leaseId = leaseIdStr != null ? Number(leaseIdStr) : null
    step(
      reporter,
      'lease+link(provider)',
      `leased node ${targetNode.address} for ${LEASE_HOURS}h (lease ${leaseId ?? '?'}) AND linked it to plan ${planId} (tx ${leaseLink.txHash})`,
      'pass',
      Date.now() - t,
    )
    await new Promise((r) => setTimeout(r, STEP_GAP_MS))

    // ── 4b. activate the plan ──
    // A freshly created plan lands status=inactive; the chain rejects a subscribe to an
    // inactive plan ("invalid status inactive for plan N"). MsgUpdatePlanStatusRequest
    // (status=STATUS_ACTIVE=1, from = sentprov provider addr, id = planId) flips it ACTIVE.
    // The typeUrl is in the SDK's plan registry, so providerBroadcast signs it directly.
    t = Date.now()
    const activated = await providerBroadcast([
      { typeUrl: TYPE_UPDATE_PLAN_STATUS, value: { from: provFrom, id: String(planId), status: 1 } },
    ])
    if (activated?.success !== true) {
      step(reporter, 'plan:activate(provider)', `MsgUpdatePlanStatusRequest(ACTIVE) for plan ${planId} failed: ${activated?.error ?? 'unknown'}`, 'fail', Date.now() - t, [
        { severity: 'error', message: 'plan stayed inactive — subscribe will be rejected' },
      ])
      return
    }
    step(reporter, 'plan:activate(provider)', `plan ${planId} set ACTIVE (tx ${activated.txHash}) — now subscribable`, 'pass', Date.now() - t)
    await new Promise((r) => setTimeout(r, PLAN_CONFIRM_MS))

    // ── 5. self-subscribe to our own plan, confirm ACTIVE, connect for real ──
    if (!hasChannel('plan:subscribe')) {
      step(reporter, 'plan:subscribe(provider)', 'plan:subscribe channel unavailable — cannot self-subscribe', 'skip')
      return
    }
    t = Date.now()
    const sub = (await invoke('plan:subscribe', { planId, denom: 'udvpn', policy: 0 })) as { success?: boolean; error?: string; txHash?: string }
    if (sub?.success !== true) {
      step(reporter, 'plan:subscribe(provider)', `self-subscribe to own plan ${planId} failed: ${sub?.error ?? 'unknown'}`, 'fail', Date.now() - t, [
        { severity: 'error', message: 'plan owner could not subscribe to own plan' },
      ])
      return
    }
    step(reporter, 'plan:subscribe(provider)', `self-subscribed to own plan ${planId} (tx ${sub.txHash}) — confirming ACTIVE`, 'pass', Date.now() - t)
    await new Promise((r) => setTimeout(r, SUBSCRIBE_CONFIRM_MS))

    const fresh = (await invoke('subscriptions:fetch')) as { subscriptions?: Array<Record<string, unknown>> }
    const subs = Array.isArray(fresh?.subscriptions) ? fresh.subscriptions : []
    const mine = subs
      .filter((s) => Number(s.planId) === planId && s.status === 1 && typeof s.id === 'number')
      .sort((a, b) => (b.id as number) - (a.id as number))
    const subId = mine[0]?.id as number | undefined
    if (!subId) {
      step(reporter, 'subscriptions:fetch(provider)', `self-subscribed to plan ${planId} but no ACTIVE subscription appeared`, 'fail')
      return
    }
    ctx.subscriptionId = subId
    ctx.subscriptionActive = true
    ctx.nodeAddress = targetNode.address
    step(reporter, 'subscriptions:fetch(provider)', `ACTIVE subscription ${subId} on own plan ${planId} — connecting to leased node ${targetNode.address}`, 'pass')

    // connect for real under our own subscription to our own leased node.
    t = Date.now()
    const conn = (await invoke('subscription:connect', { subscriptionId: subId, nodeAddress: targetNode.address })) as {
      success?: boolean
      error?: string
      vpnType?: string
      sessionId?: unknown
    }
    if (conn?.success !== true) {
      step(reporter, 'subscription:connect(provider)', `connect to own leased node ${targetNode.address} failed: ${conn?.error ?? 'unknown'}`, 'fail', Date.now() - t, [
        { severity: 'warn', message: 'session-start/handshake to the self-leased node failed' },
      ])
      // fall through to teardown — the lease/sub still need releasing.
    } else {
      const vpnType = conn.vpnType ?? targetNode.type
      step(reporter, 'subscription:connect(provider)', `LIVE session up on own plan→leased node ${targetNode.address} (vpnType=${vpnType}) — full provider→consumer round trip`, 'pass', Date.now() - t)
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
      // bring the OS tunnel up so the connect actually reaches the node.
      if (vpnType === 'wireguard' && hasChannel('node:connectWireguard')) {
        const up = (await invoke('node:connectWireguard')) as { success?: boolean; error?: string }
        step(reporter, 'node:connectWireguard(provider)', up?.success === true ? 'WireGuard tunnel UP against self-leased node' : `WG up failed: ${up?.error ?? 'unknown'}`, up?.success === true ? 'pass' : 'fail')
      } else if (vpnType === 'v2ray' && hasChannel('node:connectV2ray')) {
        const up = (await invoke('node:connectV2ray', { transparent: true })) as { success?: boolean; error?: string }
        step(reporter, 'node:connectV2ray(provider)', up?.success === true ? 'V2Ray + transparent tun2socks UP against self-leased node' : `V2Ray up failed: ${up?.error ?? 'unknown'}`, up?.success === true ? 'pass' : 'fail')
      }
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
      // disconnect the tunnel + end the on-chain session.
      if (hasChannel('node:disconnect')) {
        const dc = (await invoke('node:disconnect')) as { success?: boolean }
        step(reporter, 'node:disconnect(provider)', dc?.success === true ? 'tunnel torn down (killActiveConnections)' : 'disconnect returned non-success', dc?.success === true ? 'pass' : 'fail')
      }
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
    }

    // cancel the self-subscription so we are not left billing against our own plan.
    if (hasChannel('subscription:cancel')) {
      t = Date.now()
      const cancel = (await invoke('subscription:cancel', subId)) as { success?: boolean; error?: string }
      step(reporter, 'subscription:cancel(provider)', cancel?.success === true ? `cancelled self-subscription ${subId}` : `cancel sub ${subId} failed: ${cancel?.error ?? 'unknown'}`, cancel?.success === true ? 'pass' : 'fail', Date.now() - t)
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
    }
  } finally {
    // ── 6. end the lease (release the node) — leave the chain as we found it ──
    if (leaseId != null && Number.isFinite(leaseId) && leaseId > 0) {
      const endT = Date.now()
      const ended = await providerBroadcast([{ typeUrl: TYPE_END_LEASE, value: { from: provFrom, id: String(leaseId) } }])
      step(
        reporter,
        'lease:end(provider)',
        ended?.success === true ? `ended lease ${leaseId} (tx ${ended.txHash}) — node released, refund settled` : `MsgEndLeaseRequest for lease ${leaseId} failed: ${ended?.error ?? 'unknown'}`,
        ended?.success === true ? 'pass' : 'fail',
        Date.now() - endT,
      )
    } else {
      step(reporter, 'lease:end(provider)', 'no lease id parsed — cannot explicitly end lease (it will expire after its term)', 'skip')
    }
  }
}
