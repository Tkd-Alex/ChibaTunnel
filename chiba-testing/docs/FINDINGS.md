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
