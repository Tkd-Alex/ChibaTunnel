# Chiba Testing — Manifesto

> Every function the app can run, we can run. Every issue a user can hit, we hit first.

## Why this exists

ChibaTunnel is a desktop dVPN client for the Sentinel network. Its real logic
does not live in the UI — it lives in **53 `ipcMain.handle` channels** in the
Electron main process. Wallets, balances, plans, nodes, sessions, subscriptions,
on-chain broadcasts, the privileged WireGuard helper, the kill switch, public-IP
detection — all of it is reached by the renderer calling `ipcRenderer.invoke(channel, args)`.

That means the honest way to test ChibaTunnel end-to-end is **not** to re-implement
its logic in a test file. Re-implemented tests drift from the app and lie to you.
The honest way is to **drive the app's own IPC handlers** — the exact code path a
real click takes — and observe what actually happens against the real RPC, the real
chain, and the real helper.

Chiba Testing is that harness.

## First principles

1. **Reuse, never re-implement.** We do not copy handler logic into tests. We boot
   the real app's main bundle, capture every `ipcMain.handle(channel, fn)` as it
   registers, and invoke the captured `fn` with synthetic args — byte-for-byte the
   path `ipcRenderer.invoke` triggers. If the app changes, our coverage changes with it.

2. **Map everything, then test everything.** The first job of the harness is a
   complete inventory: every channel, its arguments, its return shape. Coverage is
   measured against that map. A channel with no test is a visible gap, not an unknown.

3. **End-to-end by default, with honest tiers.** Read-only chain queries run against
   live RPC. Anything that spends money, broadcasts a transaction, or touches the
   privileged helper / OS network stack is **gated** and runs only with an explicit
   opt-in flag and a funded throwaway wallet. We never silently move funds or rewrite
   routes on someone's machine.

4. **Discover issues, don't just assert green.** Tests record what they find — slow
   RPC, 429 storms, empty result sets where data should exist, malformed envelopes,
   handlers that hang, error strings that leak internals. Findings are written to disk
   as durable, reviewable reports, not just pass/fail.

5. **RPC-first, rate-limit-aware.** All Sentinel reads go through RPC (LCD is fallback
   only). The harness paces itself; it never parallelizes chain calls into a 429 storm.

6. **Trace the real path.** A handler that returns `{ success: true }` has not been
   verified until we've confirmed the effect it claims — the session exists on chain,
   the route is actually installed, the balance actually changed. Function names lie;
   execution traces don't.

## What it is not

- Not a unit-test suite. Unit tests live next to the code they test. This is the
  whole-app, real-dependencies harness.
- Not a fork of the app's logic. It imports/boots the app; it does not shadow it.
- Not a fund-spending bot. Money- and OS-touching paths are opt-in and sandboxed.

## The bar

A channel is "covered" when the harness can invoke it through the real handler,
assert its contract (shape + success semantics), and — for stateful channels —
verify the claimed effect actually happened. Anything less is a TODO in the map.
