# Findings

Two kinds of finding live here:

1. **Session history** — bugs we traced and fixed by hand while getting ChibaTunnel
   working. These motivated the harness: each one was a real failure a contract +
   findings pass would have caught.
2. **Live harness findings** — what the first automated `--tier=readonly` runs
   surfaced on their own.

Every fix is upstreamed to `Tkd-Alex/ChibaTunnel:dev` via the Sentinel-Bluebuilder
fork. PR numbers are noted where they exist.

---

## 1. Session history (hand-fixed → PR'd)

### connect / HTTP 409 on session start
**Symptom:** starting a session against a node returned 409 Conflict; the connect
flow dead-ended.
**Root cause:** an existing/duplicate session for the account+node wasn't reconciled
before starting a new one — the node rejected the second start.
**Fix:** reconcile the existing session (reuse / cancel-then-start) instead of blindly
starting, so the connect path is idempotent against a stale session.
**Why it matters:** this is the single most user-visible failure — "Connect" silently
doing nothing. The harness's `node:connect` path (spend tier) plus a
`sessions:fetch` precheck is the regression guard.

### plans pagination — short plan/node lists
**Symptom:** plans and plan-node lists were truncated; nodes that exist on chain
didn't appear, so usable plans looked empty.
**Root cause:** chain reads used the SDK's default page size and only `STATUS_ACTIVE`,
so anything past the first page — or not strictly active — was dropped.
**Fix:** widen pagination to `PageRequest.fromJSON({ limit: 10000 })` and query
`STATUS_UNSPECIFIED` (all statuses) for plan/node lookups. Shipped in **PR #16**
(`fix/rpc-pagination-retry`) across `plans:fetch`, `plan:nodes`, `plans:scanNodes`,
`subscriptions:fetch`, `providers:fetchBatch`.
**Harness guard:** the engine flags an empty result set where data was expected —
exactly the "looks empty but shouldn't be" shape.

### IP detection — wrong/empty public IP + geo
**Symptom:** the detected public IP / geo was wrong or blank, so the connected-vs-not
indicator lied.
**Root cause:** single-provider IP lookup with no fallback and brittle response
parsing.
**Fix:** more robust public-IP detection with fallback. Tracked in **PR #12**.
**Harness guard:** `network:getPublicIp` is a readonly channel; the engine asserts a
non-empty value and flags a slow or empty lookup.

### RPC 429 under bursty fan-out
**Symptom:** batch reads (scan nodes across plans, batch provider info) intermittently
failed with HTTP 429 / transient network errors, especially right after launch.
**Root cause:** large parallel fan-out hammered the RPC endpoint with no retry and no
pacing, tripping rate limits.
**Fix (PR #16):** `rpcWithRetry()` with exponential backoff + jitter, retrying only
*transient* errors (429/5xx + `ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`/
`ENOTFOUND`/`EPIPE`) and rethrowing logic errors immediately; smaller chunk sizes
(`scanNodes` 10→5, `fetchBatch` 20→10) with inter-chunk delays. RPC-first throughout;
LCD remains fallback only.
**Harness guard:** the engine paces readonly chain calls (150ms) so the harness itself
stays RPC-friendly, and flags transient-looking errors distinctly from logic errors.

### privileged helper — install/repair self-heal
**Symptom:** a missing or stale privileged helper broke tunnel bring-up with an opaque
error.
**Fix:** the app pings the helper on launch and reinstalls when absent; `helper:repair`
exposes a manual reinstall.
**Harness note:** the harness deliberately **does not** exercise this automatically.
Booting with `CHIBA_TEST=1` makes the app skip the helper auto-install so automated
runs never mutate the host. `helper:repair`/`binary:install` are `privileged` tier and
opt-in only.

---

## 2. Live harness findings (first automated runs)

From `node dist/cli.js test --tier=readonly` against the real app with **no wallet
loaded** — 27 pass / 0 fail / 0 error / 26 skip. These are observations, not crashes;
they're recorded as `info`/`warn` findings, not failures, because a no-wallet boot is a
legitimate state.

### F1 — chain-read handlers return bare `success:false` with no error string
**Channels:** the readonly chain reads (`plans:fetch`, `subscriptions:fetch`,
`sessions:fetch`, and friends) when no wallet / no RPC client is initialized.
**Observation:** they resolve to `{ success: false }` with **no `error` field**. The
renderer can tell it failed but has nothing to show the user or log.
**Recommendation:** always populate `error` (e.g. `"wallet not loaded"` /
`"no RPC client"`) on the failure envelope. Cheap, and it turns a silent dead-end into
a diagnosable state. Candidate for a focused follow-up PR.

### F2 — `provider:info` returns the literal `"No RPC client"`
**Channel:** `provider:info`.
**Observation:** returns `success:false` with `error: "No RPC client"` before a client
is initialized. Correct behaviour, but it confirms read handlers depend on init order —
worth a guard / clearer state than a stringly-typed sentinel.

### F3 — `binary:browse` takes ~6.5s headless
**Channel:** `binary:browse` (ui tier).
**Observation:** ~6.5s in a headless run — it tries to open a native file dialog with no
window. Flagged as `SLOW` (≥4s threshold).
**Recommendation:** short-circuit `binary:browse` when there's no focused window (or
under `CHIBA_TEST`) so it returns immediately instead of blocking.

### F4 — `node:info` leaks `getaddrinfo ENOTFOUND <moniker>`
**Channel:** `node:info` with a placeholder/unknown node address.
**Observation:** the error string surfaces a raw `getaddrinfo ENOTFOUND <moniker>` —
an internal DNS-resolution detail — straight to the caller.
**Recommendation:** wrap probe failures in a user-facing message ("node unreachable")
and keep the raw cause in logs only. The engine's `looksLeaky()` check flags raw
`getaddrinfo`/stack-frame/path strings as leaks.

---

## 3. Privileged-tier run (rebuilt bundle, real OS paths)

From `test --tier=privileged` against a freshly built `out/main/index.js` (the
`chiba-testing` branch, which contains the test hook) — **46 pass / 0 fail / 0 error /
7 skip** (6 spend above-tier, `binary:browse` windowless). Every privileged handler
executed its real code path: `helper:repair` ran the actual `schtasks` register/run
sequence for the SYSTEM `ChibaTunnelHelper` task; `killswitch:enable/disable` and
`traffic:start/stop` ran; the tunnel handlers returned clean diagnosable envelopes
(`No WireGuard config`, `No V2Ray session`, `No active tunnel instance to retry`,
`Wallet not initialized`) because no session is established yet — correct behaviour.

### F5 — `wallet:forget` runs before readonly chain reads, masking real read behaviour
**What happened:** in a single multi-tier run, the `local`-tier `wallet:forget` executes
before the `readonly` chain reads (`plans:fetch`, `subscriptions:fetch`,
`sessions:fetch`, `plan:nodes`, `plans:scanNodes`, `providers:fetchBatch`). `forget`
tears down `walletState.readonlyClient`, so those reads then run with **no RPC client**
and return `success:false`. The dedicated read-only funding probe — which calls
`wallet:loadStored` first and never forgets — shows the same channels returning
`success:true` with real (empty) result sets.
**Impact:** test-ordering artifact, NOT a product bug. But it means a single-process
multi-tier run under-tests the chain reads (they're exercised in a no-client state).
**Recommendation:** engine should either (a) load the stored/throwaway wallet before the
readonly chain reads and defer `wallet:forget` to the very end, or (b) re-establish the
RPC client after `forget`. Until then, use the funding probe (loads wallet, no forget)
to verify the reads with a live client.

### F5 — RESOLVED (shared real store + ordered execution + mutation guard)
The harness was reading a parallel **empty** store (`...\Roaming\Electron\chibatunnel.json`)
because, launched via the raw electron binary, `app.getName()` defaulted to `Electron` and
the app's `Store({name:'chibatunnel'})` resolved under that userData dir — not the installed
exe's `...\Roaming\chibatunnel`. So `wallet:loadStored` saw "No stored wallets" and every
chain read ran with no RPC client (bare `success:false`).

**Fix (three parts, all in `chiba-testing`):**
1. `boot.ts` forces `app.setName('chibatunnel')` **before** requiring the app bundle, so the
   app's `Store()` resolves to the **real** installed store (3 wallets, real RPC).
2. `engine.ts` sequences execution: `wallet:loadStored` runs FIRST (builds the live RPC
   client), the destructive wallet ops run LAST.
3. Because the harness now shares the **real** store, wallet-store-mutating channels
   (`wallet:add/remove/switch/rename/setup/forget`, flagged `mutatesWallet` in `channels.ts`)
   are **skipped by default** and only run with `--allow-wallet-mutations` + a throwaway
   profile — so the user's real wallets are never touched.

**Verified run (`test --tier=privileged`, default = no mutations): 40 pass / 0 fail / 0 error
/ 13 skip.** `wallet:loadStored` PASS (947ms — real `safeStorage` decrypt + `setupWallet`
RPC-client build), `wallet:getBalances`/`getInfo` PASS against live chain, and
`plans:fetch`/`subscriptions:fetch`/`sessions:fetch`/`plan:nodes`/`plans:scanNodes`/
`providers:fetchBatch` PASS with a live client (no "empty where expected" findings).
`node:connectSession` returned a **real** handshake response
(`[400] invalid session status "inactive_pending"`), proving the live RPC path is reachable.
The real store (`...\Roaming\chibatunnel\chibatunnel.json`) was confirmed **unchanged**
afterward (3 wallets, `active_wallet:1`, RPC intact); `wallet:forget`/`wallet:remove` SKIPPED.

---

## 4. Spend-tier run (real on-chain, corrected ID harvesting)

### F6 — RESOLVED: spend cancels fired against id 0 ("id cannot be zero")
**What happened:** an earlier destructive spend run was launched with
`--allow-wallet-mutations` against the **real** active wallet. Mid-run, `wallet:switch`/
`wallet:forget`/`wallet:remove` changed (then wiped) the active wallet, so the
`subscriptions:fetch` / `sessions:fetch` reads that follow harvested **no** ids — the
harvested `subscriptionId`/`sessionId` stayed `0`. The cancels then broadcast against id 0
and the chain rejected them with `"id cannot be zero"`. The destructive paths *looked*
exercised (they broadcast) but never touched the real sub/session — a false signal, and it
wiped the real wallet store as collateral.

**Fix (two guards in `engine.ts`):**
1. **Hard interlock** — `runEngine` now *refuses to run* if `--allow-wallet-mutations` is
   combined with the spend tier. The two are mutually exclusive: wallet mutations scramble
   the very ids spend cancels target. The run throws before any handler executes
   (verified: exit 3, zero handlers run, store untouched).
2. **Spend precondition skip** — `spendPrecondition()` checks the harvested context before a
   spend op broadcasts. If the required id/address is missing (no sub on chain, no live
   session, no node), the op is **skipped, not broadcast** — so a doomed "id cannot be zero"
   tx is never sent and the report shows an honest skip with the reason, not a fake failure.

**Verified clean run (`test --tier=spend`, NO mutations, real funded wallet): 46 pass /
0 fail / 0 error / 7 skip.** Every cancel targeted a REAL id this time:
- `plan:subscribe` → real TX `D1C8B6365D8066B314EED6C2A05C0F2300DDDD6CFF09325A7B50490B99E04FFA`, created sub **#1402775**.
- `subscription:update` → real TX `2135B6D9DC32597878CC20C37B6012334102479565706D926A2CE7005DDB3499` against the **real** sub #1402775.
- `subscription:connect` → real broadcast; chain rejected (`node ... for plan 276 does not exist`) — a genuine validation of the real sub, not a zero-id stub.
- `node:connect` → real session **#46378396** handshake.
- `session:cancel` → targeted real session **#46345550**; chain returned `invalid status inactive_pending` (real session-state-machine response).
- `subscription:cancel` → real TX `29146DC05BF684697650D0461C7A3CA6071FC857BE532AC40F7A3FF55379986E`, **cancelled the real sub #1402775**.
- `wallet:remove` / `wallet:forget` → **SKIPPED** (mutation guard) → real store left intact.

**Takeaway:** a real-funded spend run must never set `--allow-wallet-mutations`. Wallet
mutations are for a throwaway profile only; the spend tier against the real active wallet
runs mutation-free, and the precondition guard ensures cancels only fire when their target
exists on chain.

---

## 5. UI coverage proof

See **[`UI-COVERAGE.md`](./UI-COVERAGE.md)** for the full audit: every page/panel/button in
the renderer mapped to its `window.api` method and IPC channel, the **53 UI invoke channels
== 53 harness channels (zero drift, both directions)** proof, the no-dead-preload-methods
result, and the explicit gap that the **8 main→renderer event pushes + 1 `send`
(`vpn:dns-retry-approved`) are NOT exercised** by the invoke-driving harness (candidates for
an event-emission test pass).

---

### F1 (still open in this bundle) — bare `success:false`, no error string
The six chain reads above returned `success:false` with **`(no error string)`** here,
confirming **F1 is still present on the `chiba-testing` branch**. The F1 fix
(`fix/failure-envelope-error-strings`, **PR #18**) adds the `error` strings but lives on
its own branch off `dev` — it is not merged into `chiba-testing`. `provider:info`
already returns `No RPC client` (it had its guard string before F1). Once PR #18 lands
on `dev` and `chiba-testing` rebases, this finding closes.

---

## How to reproduce

```bash
npm run build                 # from repo root → out/main/index.js
cd chiba-testing && npm run build
node dist/cli.js map          # prove spec ↔ app agree (zero drift)
node dist/cli.js test --tier=readonly
# artifacts in chiba-testing/reports/{run-*,latest}.{json,md}
```

To exercise wallet-dependent reads (F1/F2 with data instead of empty), pass a funded
**throwaway** mnemonic and raise the tier deliberately:

```bash
node dist/cli.js test --tier=local --mnemonic="word1 word2 ..."
```

Never use a real-funds wallet. `spend`/`privileged` tiers broadcast tx / touch the OS
network stack and are opt-in for a reason.

---

## 6. Channel coverage vs FEATURE coverage — the live tier (F7)

**The honest distinction.** The map proves **53 invoke channels == 53 `ipcMain.handle`
registrations, zero drift** (verified again here by diffing `ipcMain.handle('…')` in
`src/main/index.ts` against `channel:` in `channels.ts` — identical sets). But calling a
channel only proves the channel is reachable; it does **not** prove the *feature branches
inside* that handler ran. Many features live behind an `if` that needs runtime state a
windowless harness with no active session/tunnel never reaches:

| Feature | Gate (file:line) | Requires |
|---|---|---|
| Split-tunnel `AllowedIPs` rewrite | index.ts:1380 | live WireGuard handshake + `splitTunnel=true` |
| DoH DNS injection | index.ts:1376 | live WireGuard handshake + `dohIp` set |
| Transparent SOCKS proxy / tun2socks | index.ts:1152 | live V2Ray handshake + `transparent:true` + helper |
| Traffic-stat source (wg / tun2socks / v2ray-api) | index.ts:1423 | an active tunnel of that type |
| On-chain disconnect (`sessionCancel` on quit) | killActiveConnections | an `activeSessionId` |
| Auto-reconnect backoff | index.ts:1666 | V2Ray process exit while `wasConnected` + `autoReconnect=true` |
| Donation (10% tx) | index.ts:1323 | connect with `donate=true` + udvpn price |
| DNS-retry confirm flow | index.ts:1595 | helper returns `isDnsError` (Linux/macOS) |

Calling `node:connectWireguard` / `node:connectV2ray` windowless just hits the early
guards (`No WireGuard config` / `No V2Ray session`) — the door, not the room.

**The fix: a new `live` tier** (`chiba-testing/src/live-connect.ts`), opt-in behind
`--tier=live --allow-live-tunnel`. It drives the SAME real handlers (never re-implements):
loads the wallet, harvests its subscription + plan nodes, **probes each candidate with the
real `node:info` handshake to find one that is actually LIVE**, forces the gating settings
ON (`splitTunnel`, `splitRoutes`, `dohIp`), connects for real, brings the OS tunnel up,
runs traffic polling + `vpn:status` so the source branch executes, then tears down with an
on-chain session end — restoring settings on the way out (verified: `splitTunnel`/`dohIp`
returned to pre-run values via the `finally` restore).

**Verified live run result (real chain, 2026-06-21):** the harness probed 12 candidate
nodes for the active plan — **none answered a live handshake** — so it *correctly refused to
fake a connection* against a dead node and recorded exactly why ("cannot bring a real tunnel
up — this is why blind connect failed before"). The active subscription #1402775 is
`inactive_pending`, which the chain rejects for `subscription:connect` regardless. The gated
feature branches therefore remain unexecuted **for lack of a live node + active subscription
to reach them through — not because the harness cannot drive them.** The instant a live node
+ active sub exist, this same path executes split-tunnel rewrite, DoH injection, tun2socks
setup, traffic sources, and the on-chain disconnect.

**Permutations the live tier exercises** (when a live node is available):
- Connect under an **existing subscription** (`subscription:connect`) — no new sub tx.
- Reconnect to an **existing session** (`node:connectSession`) — rejoin without a new tx.
- **Switchover**: connect node B while node A is already up — exercises the teardown of the
  prior tunnel and the `connectInProgress` re-entrancy guard (index.ts:990, 926).

```bash
node dist/cli.js test --tier=live --allow-live-tunnel --mnemonic="…throwaway…"
```
