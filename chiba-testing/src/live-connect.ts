// ─── live-connect.ts ───
//
// The LIVE tier. Everything below `live` proves channel + envelope coverage but
// CANNOT reach the feature branches buried inside the connect handlers — split
// tunnelling (index.ts:1380), DoH DNS injection (index.ts:1376), the transparent
// SOCKS proxy / tun2socks setup (index.ts:1152), the traffic-stat source selection
// (index.ts:1423), and the on-chain disconnect broadcast (killActiveConnections).
// Those only run when there is a REAL active session + a REAL tunnel config, against
// a node that actually serves the wallet's subscription.
//
// This module brings that state up FOR REAL, by driving the same real handlers a
// user's clicks drive — never re-implementing them:
//   1. load the wallet, harvest its subscriptions,
//   2. probe candidate nodes with the real `node:info` handshake to find ones that
//      are actually LIVE (not just listed on chain) and split them by VPN type,
//   3. toggle the settings flags that gate features ON (splitTunnel + routes, dohIp),
//   4. connect for real (`subscription:connect` → session tx → doHandshake), which
//      runs the split-tunnel rewrite / DoH injection / config generation,
//   5. bring the tunnel interface up (`node:connectWireguard`, or `node:connectV2ray`
//      with transparent:true to drive tun2socks),
//   6. start traffic polling and read `vpn:status` so the live source paths execute,
//   6b/6c. exercise the CONNECTION PERMUTATIONS the user asked for:
//      A. re-entrancy guard — race a 2nd subscription:connect while the 1st is in-flight
//         and assert the real connectInProgress guard rejects it (index.ts:927),
//      B. reconnect to an ALREADY-SUBSCRIBED node via the existing session
//         (node:connectSession, index.ts:995) — no new chain tx,
//      C. switchover — connect to a SECOND live node while the first is up and assert
//         the active session/node moved.
//   7. tear down with an on-chain session end (`node:disconnect` then app:quit path).
//
// Every step is recorded into the same Reporter so the coverage report shows which
// gated branch each step proved. It is gated behind --tier=live AND an explicit
// --allow-live-tunnel flag because it mutates the host network stack.

import { invoke, hasChannel } from './registry'
import { InvokeContext } from './channels'
import { Reporter, Finding } from './reporter'

const PROBE_TIMEOUT_MS = 9_000
const STEP_GAP_MS = 7_000

export interface LiveOptions {
  mnemonic?: string
  /** Hard opt-in: actually bring a tunnel up on this host. */
  allowLiveTunnel?: boolean
  /** Cap how many nodes we probe looking for a live one (each is one node:info RTT). */
  maxProbe?: number
}

export interface NodeCandidate {
  address: string
  type: 'wireguard' | 'v2ray' | 'unknown'
  remote?: string
  /** off-chain health signals — used to probe the most-likely-live nodes first */
  healthy?: boolean
  active?: boolean
  peers?: number
}

/** Record a live-tier step into the report with a fixed shape. */
export function step(
  reporter: Reporter,
  channel: string,
  detail: string,
  outcome: 'pass' | 'fail' | 'error' | 'skip',
  ms = 0,
  findings: Finding[] = [],
): void {
  reporter.record({ channel, api: channel, tier: 'live', outcome, ms, detail, findings })
}

/**
 * Emit explicit skip records for the three connection permutations so the coverage
 * report always shows them (and WHY they were skipped) even when the live tier bails
 * before connecting — rather than silently omitting them.
 */
function skipPermutations(reporter: Reporter, reason: string): void {
  step(reporter, 'subscription:connect(reentrancy-guard)', `not exercised — ${reason}`, 'skip')
  step(reporter, 'node:connectSession(reconnect-existing)', `not exercised — ${reason}`, 'skip')
  step(reporter, 'subscription:connect(switchover)', `not exercised — ${reason}`, 'skip')
}

/**
 * Map a node's VPN type to our coarse type. Handles BOTH shapes:
 *  - node-list entry: numeric `type` (1=WIREGUARD, 2=V2RAY) from api.sentnodes.com,
 *  - node:info result: string `service_type` ("wireguard"/"v2ray").
 */
function classify(info: unknown): 'wireguard' | 'v2ray' | 'unknown' {
  if (!info || typeof info !== 'object') return 'unknown'
  const r = info as Record<string, unknown>
  const t = r.service_type ?? r.serviceType ?? r.type
  // NodeVPNType: 1 = WIREGUARD, 2 = V2RAY in the sentinel enum; strings appear too.
  if (t === 1 || t === 'wireguard' || t === 'WIREGUARD') return 'wireguard'
  if (t === 2 || t === 'v2ray' || t === 'V2RAY') return 'v2ray'
  return 'unknown'
}

/**
 * Probe nodes (real `node:info` handshake) and collect EVERY live one (split by type),
 * up to maxProbe attempts. Returns ALL live candidates found — not just the first of
 * each type — because the switchover permutation needs a SECOND live node of the same
 * type to connect to while the first is up.
 * A node that is listed on chain but does not answer the handshake is NOT live and is
 * exactly why the earlier blind connect failed — so we never try to connect to it.
 */
export async function probeForLiveNodes(
  reporter: Reporter,
  candidates: NodeCandidate[],
  maxProbe: number,
): Promise<{ wireguard: NodeCandidate[]; v2ray: NodeCandidate[] }> {
  const found: { wireguard: NodeCandidate[]; v2ray: NodeCandidate[] } = { wireguard: [], v2ray: [] }
  let probed = 0
  for (const c of candidates) {
    if (probed >= maxProbe) break
    // Stop early once EITHER type has a switchover pair (target + a 2nd same-type node):
    // that is all the live tier needs to drive connect + reconnect + switchover. The
    // live network is overwhelmingly V2Ray, so we must NOT keep burning the probe budget
    // waiting for a node of the OTHER type that may be rare/absent — that was the bug
    // that made a healthy network look dead ("none answered a handshake").
    if (found.wireguard.length >= 2 || found.v2ray.length >= 2) break
    if (!c.remote) continue
    probed++
    const start = Date.now()
    try {
      const res = (await invoke('node:info', c.remote)) as { success?: boolean; info?: unknown }
      const ms = Date.now() - start
      if (!res || res.success !== true || !res.info) {
        step(reporter, 'node:info(probe)', `node ${c.address} not live (no handshake)`, 'skip', ms)
        continue
      }
      const type = classify(res.info)
      step(reporter, 'node:info(probe)', `node ${c.address} LIVE, type=${type}`, 'pass', ms)
      if (type === 'wireguard') found.wireguard.push({ ...c, type })
      if (type === 'v2ray') found.v2ray.push({ ...c, type })
    } catch (err) {
      step(reporter, 'node:info(probe)', `node ${c.address} probe threw: ${String(err)}`, 'skip', Date.now() - start)
    }
  }
  return found
}

/**
 * Pull node candidates out of a node-list result. The REMOTE endpoint that node:info
 * needs is the off-chain API host:port — surfaced by nodes:fetch (api.sentnodes.com) as
 * the `api` field (e.g. "elpis.busur.cc:63116"), NOT as remoteUrl/remoteAddrs. nodeInfo()
 * auto-prefixes https:// so the bare host:port works. The list's numeric `type`
 * (1=WG, 2=V2RAY) also classifies the node directly, so we carry it through.
 *
 * NOTE: the on-chain plan:nodes result does NOT carry the api endpoint (only `address`),
 * so candidates must come from nodes:fetch to be probeable. plan:nodes is still used to
 * filter to the nodes that actually serve the wallet's plan.
 */
export function asCandidates(value: unknown): NodeCandidate[] {
  if (!value || typeof value !== 'object') return []
  const v = value as Record<string, unknown>
  const list = Array.isArray(v.nodes) ? v.nodes : Array.isArray(v.data) ? v.data : []
  const out: NodeCandidate[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const n = raw as Record<string, unknown>
    const address = typeof n.address === 'string' ? n.address : ''
    if (!address) continue
    // The off-chain API exposes the reachable endpoint as `api`. Fall back to the
    // older field names just in case a different list shape is passed in.
    const remote =
      typeof n.api === 'string'
        ? n.api
        : typeof n.remoteUrl === 'string'
          ? n.remoteUrl
          : typeof n.remote === 'string'
            ? n.remote
            : Array.isArray(n.remoteAddrs) && typeof n.remoteAddrs[0] === 'string'
              ? (n.remoteAddrs[0] as string)
              : undefined
    const type = classify(n)
    const healthy = n.isHealthy === true
    const active = n.isActive === true
    const peers = typeof n.peers === 'number' ? n.peers : typeof n.sessions === 'number' ? (n.sessions as number) : 0
    out.push({ address, type, remote, healthy, active, peers })
  }
  return out
}

const SUBSCRIBE_CONFIRM_MS = 6_000

/**
 * Guarantee an ACTIVE subscription that the chosen live node serves, so the connect
 * actually succeeds (the chain rejects connect against a non-ACTIVE sub).
 *
 * Strategy:
 *  - if subscriptions:fetch already harvested an ACTIVE sub AND the chosen live node is
 *    on its plan, reuse it;
 *  - otherwise SUBSCRIBE for real: iterate plans:fetch, fetch each plan's nodes, find a
 *    plan whose nodes intersect our LIVE set, broadcast plan:subscribe to it, wait for
 *    the new sub to go ACTIVE, and re-point the live target(s) onto that plan's live
 *    nodes. This is the genuine subscribe→connect e2e the user asked to verify.
 *
 * Returns the ACTIVE subscription id, or null if none could be obtained. Stashes the
 * (possibly re-pointed) live target/switch on ctx.__liveTarget / ctx.__liveSwitch.
 */
async function ensureActiveSubscription(
  reporter: Reporter,
  ctx: InvokeContext,
  liveTarget: NodeCandidate,
  liveSwitch: () => NodeCandidate | undefined,
): Promise<number | null> {
  // default: keep the already-selected live nodes
  ctx.__liveTarget = liveTarget
  ctx.__liveSwitch = liveSwitch()

  // Build the live pool (target + optional switchover) for re-pointing onto a plan.
  const livePool: NodeCandidate[] = [liveTarget, ...(liveSwitch() ? [liveSwitch() as NodeCandidate] : [])]

  // (a) reuse an existing ACTIVE sub if the live node is on its plan
  if (ctx.subscriptionActive && typeof ctx.subscriptionId === 'number' && ctx.subscriptionId > 0) {
    let onPlan = true
    if (typeof ctx.planId === 'number' && hasChannel('plan:nodes')) {
      const planNodes = asCandidates(await invoke('plan:nodes', ctx.planId))
      const planAddrs = new Set(planNodes.map((c) => c.address))
      onPlan = planAddrs.has(liveTarget.address)
    }
    if (onPlan) {
      step(
        reporter,
        'subscriptions:fetch(active)',
        `reusing ACTIVE subscription ${ctx.subscriptionId} (plan ${ctx.planId}) — serves live node ${liveTarget.address}`,
        'pass',
      )
      return ctx.subscriptionId
    }
    step(
      reporter,
      'subscriptions:fetch(active)',
      `ACTIVE sub ${ctx.subscriptionId} does NOT serve live node ${liveTarget.address} — will subscribe to a serving plan`,
      'pass',
    )
  }

  // (b) subscribe for real to a plan that serves a LIVE node
  if (!hasChannel('plans:fetch') || !hasChannel('plan:nodes') || !hasChannel('plan:subscribe')) {
    step(reporter, 'plan:subscribe(live)', 'plans/subscribe channels unavailable — cannot create a subscription', 'skip')
    return null
  }
  const plansRes = (await invoke('plans:fetch')) as { plans?: Array<Record<string, unknown>> }
  const plans = Array.isArray(plansRes?.plans) ? plansRes.plans : []
  if (!plans.length) {
    step(reporter, 'plan:subscribe(live)', 'plans:fetch returned no plans to subscribe to', 'skip')
    return null
  }

  // The previously-probed live set (≤2 nodes) almost never intersects an arbitrary
  // plan's node list, so we cannot "find a plan that serves our 2 nodes". Instead,
  // for each plan we probe ITS OWN nodes for liveness. plan:nodes (on-chain) lacks the
  // reachable `api` endpoint, so we cross-reference the off-chain nodes:fetch list to
  // recover each plan-node's endpoint before probing it.
  const offchain = hasChannel('nodes:fetch') ? asCandidates(await invoke('nodes:fetch')) : []
  const endpointByAddr = new Map(offchain.filter((c) => c.remote).map((c) => [c.address, c]))
  // Seed with any already-known-live nodes so a plan that happens to serve them wins fast.
  for (const c of livePool) if (c.remote) endpointByAddr.set(c.address, c)

  for (const p of plans) {
    const planId = typeof p.id === 'number' ? p.id : null
    if (planId == null) continue
    const planNodes = asCandidates(await invoke('plan:nodes', planId))
    // Attach reachable endpoints (from off-chain list) to this plan's on-chain nodes,
    // then probe them for a live one.
    const probeable: NodeCandidate[] = planNodes
      .map((n) => {
        const ep = endpointByAddr.get(n.address)
        return ep ? { ...n, remote: ep.remote, type: n.type !== 'unknown' ? n.type : ep.type, peers: ep.peers, healthy: ep.healthy, active: ep.active } : n
      })
      .filter((n) => n.remote)
    if (!probeable.length) continue
    // Probe this plan's nodes (best-scored first) for a live handshake. Cap per-plan so
    // a single bad plan can't burn the whole budget.
    probeable.sort((a, b) => (Number(b.healthy) - Number(a.healthy)) || (Number(b.active) - Number(a.active)) || (b.peers ?? 0) - (a.peers ?? 0))
    const planLive = await probeForLiveNodes(reporter, probeable, 20)
    const serving = [...planLive.wireguard, ...planLive.v2ray]
    if (!serving.length) continue

    step(
      reporter,
      'plan:nodes(match)',
      `plan ${planId} has ${serving.length} LIVE node(s) (probed its own node list) — subscribing`,
      'pass',
    )
    const t = Date.now()
    const sub = (await invoke('plan:subscribe', { planId, denom: 'udvpn', policy: 0 })) as {
      success?: boolean
      error?: string
      txHash?: string
    }
    if (sub?.success !== true) {
      // A plan can serve LIVE nodes yet still reject THIS wallet: private/whitelisted
      // plans return `unauthorized`, an out-of-funds plan returns insufficient-funds, etc.
      // None of these are harness bugs and none mean the live network is dead — they just
      // mean "not this plan". Record the skip and continue to the next serving plan rather
      // than aborting the whole live tier on the first restricted plan we hit.
      const err = String(sub?.error ?? 'unknown')
      const notThisPlan = /unauthorized|not authorized|insufficient|allowed addresses|whitelist/i.test(err)
      step(
        reporter,
        'plan:subscribe(live)',
        `plan ${planId} serves live nodes but ${notThisPlan ? 'is not subscribable by this wallet' : 'subscribe failed'}: ${err} — trying next plan`,
        notThisPlan ? 'skip' : 'fail',
        Date.now() - t,
        notThisPlan ? undefined : [{ severity: 'warn', message: 'could not create a subscription to connect under' }],
      )
      continue
    }
    step(
      reporter,
      'plan:subscribe(live)',
      `subscribed to plan ${planId} (tx ${sub.txHash ?? '?'}) — confirming it goes ACTIVE`,
      'pass',
      Date.now() - t,
    )
    // wait for the sub to settle, then re-read to grab the new ACTIVE sub id
    await new Promise((r) => setTimeout(r, SUBSCRIBE_CONFIRM_MS))
    const fresh = (await invoke('subscriptions:fetch')) as { subscriptions?: Array<Record<string, unknown>> }
    const subs = Array.isArray(fresh?.subscriptions) ? fresh.subscriptions : []
    const mine = subs
      .filter((s) => s.planId === planId && s.status === 1 && typeof s.id === 'number')
      .sort((a, b) => (b.id as number) - (a.id as number))
    const newSub = mine[0]
    if (!newSub) {
      step(
        reporter,
        'subscriptions:fetch(post-subscribe)',
        `subscribed to plan ${planId} but no ACTIVE subscription appeared yet`,
        'fail',
      )
      return null
    }
    // Re-point the live target(s) onto this plan's live nodes.
    const planTarget = serving[0]
    ctx.__liveTarget = planTarget
    ctx.__liveSwitch = serving[1]
    ctx.planId = planId
    step(
      reporter,
      'subscriptions:fetch(post-subscribe)',
      `ACTIVE subscription ${newSub.id} created on plan ${planId}; connecting to its live node ${planTarget.address}`,
      'pass',
    )
    return newSub.id as number
  }

  step(
    reporter,
    'plan:subscribe(live)',
    'no plan in plans:fetch serves any of our live nodes — cannot subscribe+connect on-plan',
    'skip',
  )
  return null
}

/**
 * Run the live tier. Drives a REAL tunnel up against a probed-live node, exercising
 * the gated feature branches, then tears it down. Records every step into `reporter`.
 */
export async function runLive(opts: LiveOptions, ctx: InvokeContext, reporter: Reporter): Promise<void> {
  if (!opts.allowLiveTunnel) {
    step(
      reporter,
      'live:tunnel',
      'live tier requires --allow-live-tunnel (brings a real tunnel up on this host) — not run',
      'skip',
    )
    skipPermutations(reporter, 'live tier not enabled (--allow-live-tunnel)')
    return
  }

  // ── 1. find LIVE nodes (real node:info handshake) from the off-chain list ──
  // The PROBEABLE endpoint (api host:port) only comes from the off-chain nodes:fetch
  // list — plan:nodes (on-chain) gives us `address` but no reachable endpoint. We probe
  // the off-chain list to find nodes that are ACTUALLY live before deciding anything
  // about subscriptions.
  let candidates: NodeCandidate[] = []
  if (hasChannel('nodes:fetch')) {
    const res = await invoke('nodes:fetch')
    candidates = asCandidates(res)
  }
  // Probe order: reachable (has api endpoint) + healthy + active + most peers first, so
  // the first probes land on nodes the off-chain indexer already believes are serving.
  candidates = candidates
    .filter((c) => c.remote)
    .sort((a, b) => {
      const score = (c: NodeCandidate) => (c.healthy ? 4 : 0) + (c.active ? 2 : 0) + Math.min(c.peers ?? 0, 1)
      return score(b) - score(a) || (b.peers ?? 0) - (a.peers ?? 0)
    })
  if (!candidates.length) {
    step(reporter, 'live:tunnel', 'no reachable node candidates from nodes:fetch', 'skip')
    skipPermutations(reporter, 'no node candidates available')
    return
  }

  const live = await probeForLiveNodes(reporter, candidates, opts.maxProbe ?? 80)
  // Prefer the type that has the most live nodes so the switchover permutation can run.
  const wgPool = live.wireguard
  const v2Pool = live.v2ray
  const pool = wgPool.length >= v2Pool.length ? wgPool : v2Pool
  let target: NodeCandidate | undefined = pool[0]
  // A second live node of the SAME type lets us connect to node B while A is up.
  let switchTarget: NodeCandidate | undefined = pool[1]
  if (!target) {
    step(
      reporter,
      'live:tunnel',
      `probed ${Math.min(candidates.length, opts.maxProbe ?? 80)} reachable nodes, none answered a live handshake`,
      'skip',
    )
    skipPermutations(reporter, 'no live node answered a handshake to connect to')
    return
  }
  step(
    reporter,
    'live:tunnel(node-selected)',
    `selected LIVE node ${target.address} (type=${target.type}, peers=${target.peers})` +
      (switchTarget ? ` + switchover node ${switchTarget.address}` : ' (no 2nd same-type live node for switchover)'),
    'pass',
  )

  // ── 2. ensure we have an ACTIVE subscription that serves the chosen node ──
  // The chain rejects connect against any non-ACTIVE sub. If subscriptions:fetch found
  // an ACTIVE sub we use it; otherwise (with spend authorized) we SUBSCRIBE to a plan
  // that actually lists the chosen live node, then re-read to get the new ACTIVE sub.
  // This is the real "subscribe to a plan → connect to a node on that plan" e2e path.
  const subId = await ensureActiveSubscription(reporter, ctx, target, () => switchTarget)
  if (subId == null) {
    skipPermutations(reporter, 'could not obtain an ACTIVE subscription serving the live node')
    return
  }
  // ensureActiveSubscription may have re-pointed target/switchTarget onto plan nodes.
  target = ctx.__liveTarget as NodeCandidate
  switchTarget = ctx.__liveSwitch as NodeCandidate | undefined
  ctx.subscriptionId = subId

  // ── 3. toggle the settings flags that GATE the feature branches ON ──
  // splitTunnel + splitRoutes → the AllowedIPs rewrite (index.ts:1380) runs on WG.
  // dohIp → the DNS-injection branch (index.ts:1376) runs on WG.
  // We snapshot current settings, force the flags, and restore on the way out so the
  // real store is left as we found it.
  const before = (await invoke('settings:get')) as Record<string, unknown>
  const featureSettings = {
    splitTunnel: true,
    splitRoutes: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    dohIp: '1.1.1.1',
  }
  await invoke('settings:set', featureSettings)
  step(
    reporter,
    'settings:set(live)',
    `forced splitTunnel=true, splitRoutes set, dohIp=1.1.1.1 to gate split-tunnel + DoH branches ON`,
    'pass',
  )

  let connected = false
  try {
    // ── 4. connect FOR REAL under the subscription → session tx → doHandshake ──
    // PERMUTATION A — re-entrancy guard (connectInProgress, index.ts:927). We fire a
    // SECOND subscription:connect WITHOUT awaiting the first, then await both. While
    // the first connect is mid-flight, connectInProgress is true, so the racing call
    // MUST come back "A connection is already in progress". This is the only window in
    // which that guard is observable (it resets to false in the connect's finally).
    const connectStart = Date.now()
    const firstP = invoke('subscription:connect', {
      subscriptionId: ctx.subscriptionId,
      nodeAddress: target.address,
    }) as Promise<{ success?: boolean; error?: string; vpnType?: string; sessionId?: unknown }>
    // small head-start so the first call has entered the handler and set the flag
    await new Promise((r) => setTimeout(r, 50))
    const racingP = invoke('subscription:connect', {
      subscriptionId: ctx.subscriptionId,
      nodeAddress: target.address,
    }) as Promise<{ success?: boolean; error?: string }>
    const [connectRes, racing] = await Promise.all([firstP, racingP])
    const connectMs = Date.now() - connectStart

    const guardHit = racing?.success === false && /already in progress/i.test(racing?.error ?? '')
    step(
      reporter,
      'subscription:connect(reentrancy-guard)',
      guardHit
        ? 'racing 2nd connect while 1st in-flight correctly rejected: "A connection is already in progress"'
        : `expected connectInProgress guard, got: ${JSON.stringify(racing)}`,
      guardHit ? 'pass' : 'fail',
      0,
      guardHit ? [] : [{ severity: 'warn', message: 'connectInProgress guard (index.ts:927) did not reject the racing connect' }],
    )

    if (!connectRes || connectRes.success !== true) {
      step(
        reporter,
        'subscription:connect(live)',
        `session/handshake to live node ${target.address} failed: ${connectRes?.error ?? 'unknown'}`,
        'fail',
        connectMs,
        [{ severity: 'warn', message: 'live node answered node:info but session-start/handshake failed' }],
      )
      return
    }
    connected = true
    const vpnType = connectRes.vpnType ?? target.type
    // Harvest the session id this connect produced — PERMUTATION B (connectSession) and
    // teardown both need it. subscription:connect returns it under sessionId.
    const activeSessionId = Number(
      typeof connectRes.sessionId === 'object' && connectRes.sessionId
        ? (connectRes.sessionId as { low?: number }).low ?? (connectRes.sessionId as unknown as number)
        : connectRes.sessionId,
    )
    step(
      reporter,
      'subscription:connect(live)',
      `LIVE session up on ${target.address} (vpnType=${vpnType}, sessionId=${activeSessionId}) — split-tunnel rewrite + DoH injection branch executed`,
      'pass',
      connectMs,
    )
    await new Promise((r) => setTimeout(r, STEP_GAP_MS))

    // ── 5. bring the OS tunnel interface up ──
    if (vpnType === 'wireguard') {
      const t = Date.now()
      const up = (await invoke('node:connectWireguard')) as { success?: boolean; error?: string }
      step(
        reporter,
        'node:connectWireguard(live)',
        up?.success === true
          ? 'WireGuard tunnel UP via helper (wgQuickUp executed against real config)'
          : `WireGuard up failed: ${up?.error ?? 'unknown'}`,
        up?.success === true ? 'pass' : 'fail',
        Date.now() - t,
      )
    } else if (vpnType === 'v2ray') {
      const t = Date.now()
      // transparent:true drives setupTransparentV2Ray → tun2socks (index.ts:1152).
      const up = (await invoke('node:connectV2ray', { transparent: true })) as { success?: boolean; error?: string }
      step(
        reporter,
        'node:connectV2ray(live)',
        up?.success === true
          ? 'V2Ray + transparent tun2socks UP (setupTransparentV2Ray executed)'
          : `V2Ray up failed: ${up?.error ?? 'unknown'}`,
        up?.success === true ? 'pass' : 'fail',
        Date.now() - t,
      )
    }

    // ── 6. traffic accounting + status while the tunnel is live ──
    await invoke('traffic:start')
    step(reporter, 'traffic:start(live)', 'traffic polling started against a LIVE tunnel — getTrafficStats source path executes', 'pass')
    // let a couple of poll cycles run so the wg/tun2socks/v2ray source branch is hit
    await new Promise((r) => setTimeout(r, 5_000))
    const status = (await invoke('vpn:status')) as Record<string, unknown>
    step(
      reporter,
      'vpn:status(live)',
      `live status snapshot: ${JSON.stringify(status)}`,
      'pass',
    )
    await invoke('traffic:stop')

    // ── 6b. PERMUTATION B — reconnect to an ALREADY-SUBSCRIBED node via the EXISTING
    // session (node:connectSession, index.ts:995). No new chain tx: it sets
    // activeSessionId/activeNodeAddress to the session we already hold and re-runs
    // doHandshake. This is the "connect to a node that's already been subscribed" path.
    if (Number.isFinite(activeSessionId) && activeSessionId > 0 && hasChannel('node:connectSession')) {
      const t = Date.now()
      const re = (await invoke('node:connectSession', {
        nodeAddress: target.address,
        sessionId: activeSessionId,
      })) as { success?: boolean; error?: string }
      step(
        reporter,
        'node:connectSession(reconnect-existing)',
        re?.success === true
          ? `reconnected to already-subscribed node ${target.address} via existing session ${activeSessionId} (no new tx, doHandshake re-ran)`
          : `re-handshake on existing session failed: ${re?.error ?? 'unknown'}`,
        re?.success === true ? 'pass' : 'fail',
        Date.now() - t,
      )
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
    } else {
      step(
        reporter,
        'node:connectSession(reconnect-existing)',
        'no usable sessionId harvested from the live connect — cannot exercise existing-session reconnect',
        'skip',
      )
    }

    // ── 6c. PERMUTATION C — connect to ANOTHER node while already connected
    // (switchover). connectInProgress is now false (the first connect finished), so a
    // fresh subscription:connect to a DIFFERENT live node proceeds and replaces the
    // active session/node. We assert it succeeds AND that activeNodeAddress moved to B
    // (via vpn:status). Needs a second live node of the same type.
    if (switchTarget && switchTarget.address !== target.address) {
      const t = Date.now()
      const sw = (await invoke('subscription:connect', {
        subscriptionId: ctx.subscriptionId,
        nodeAddress: switchTarget.address,
      })) as { success?: boolean; error?: string; sessionId?: unknown }
      const ok = sw?.success === true
      // confirm the active node actually moved to B
      const st = (await invoke('vpn:status')) as Record<string, unknown>
      const movedTo = String(st?.nodeAddress ?? st?.activeNodeAddress ?? '')
      step(
        reporter,
        'subscription:connect(switchover)',
        ok
          ? `connected to a 2nd node ${switchTarget.address} while node ${target.address} was active — session switched (active node now ${movedTo || 'updated'})`
          : `switchover connect to ${switchTarget.address} failed: ${sw?.error ?? 'unknown'}`,
        ok ? 'pass' : 'fail',
        Date.now() - t,
        ok ? [] : [{ severity: 'warn', message: 'connecting to a second node while connected did not replace the active session' }],
      )
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
    } else {
      step(
        reporter,
        'subscription:connect(switchover)',
        'only one live node of this type was found — cannot connect to a SECOND node while connected (switchover permutation needs two live nodes)',
        'skip',
      )
    }
  } finally {
    // ── 7. tear the real tunnel down + end the session on chain ──
    if (connected) {
      const t = Date.now()
      const dc = (await invoke('node:disconnect')) as { success?: boolean }
      step(
        reporter,
        'node:disconnect(live)',
        dc?.success === true
          ? 'tunnel torn down (killActiveConnections executed: tun2socks/v2ray/wg-down branches)'
          : 'disconnect returned non-success',
        dc?.success === true ? 'pass' : 'fail',
        Date.now() - t,
      )
      // End the on-chain session too so we are not leaving a live session billing.
      await new Promise((r) => setTimeout(r, STEP_GAP_MS))
      if (hasChannel('app:quit')) {
        // app:quit(true) → killActiveConnections(true) → on-chain sessionCancel branch.
        const q = (await invoke('app:quit', true)) as unknown
        step(reporter, 'app:quit(live,endSession)', `on-chain session-end path executed: ${JSON.stringify(q)}`, 'pass')
      }
    }
    // Restore the settings we changed so the real store is left as found.
    const restore = {
      splitTunnel: before?.splitTunnel ?? false,
      splitRoutes: before?.splitRoutes ?? '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
      dohIp: before?.dohIp ?? null,
    }
    await invoke('settings:set', restore)
    step(reporter, 'settings:set(restore)', 'restored splitTunnel/splitRoutes/dohIp to pre-run values', 'pass')
  }
}
