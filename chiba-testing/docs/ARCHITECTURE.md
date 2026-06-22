# Architecture

Chiba Testing has one job: invoke the **real** ChibaTunnel handlers and observe
what actually happens. Everything below serves that.

## The pipeline

```
electron dist/boot.js --mode=test --tier=readonly
        │
        ▼
  ┌───────────────┐   1. install capture shim over ipcMain.handle
  │   boot.ts     │      (BEFORE the app registers anything)
  └──────┬────────┘
         │  require('../../out/main/index.js')   ← the REAL app main bundle
         ▼
  ┌───────────────────────────────────────────────┐
  │  app/main (out/main/index.js)                  │
  │   app.whenReady() → registerIpcHandlers()      │
  │     ipcMain.handle('plans:fetch', fn)  ───────┐│
  │     ipcMain.handle('node:connect', fn)  ──────┼┼──▶ captured into registry.ts
  │     ... 53 channels ...                       ││
  │   CHIBA_TEST=1 → skip window + helper install ││
  │   app.emit('chiba-test:ready')  ──────────────┘│
  └───────────────────────────────────────────────┘
         │ on 'chiba-test:ready'
         ▼
  ┌───────────────┐   2. engine.ts walks channels.ts specs in tier order
  │   engine.ts   │      invoke(channel, ...args)  → calls the app's own fn
  └──────┬────────┘      asserts contract, mines findings, threads discovery ctx
         ▼
  ┌───────────────┐   3. reporter.ts → console + reports/*.json + reports/*.md
  │  reporter.ts  │
  └───────────────┘
```

## Why boot the app instead of importing functions

The handlers are closures. `plans:fetch` closes over `walletState.readonlyClient`,
the Sentinel SDK clients, `store`, and module-level state set up during
`app.whenReady()`. You cannot meaningfully call them without that initialization.
Booting the real main process gives us the handlers *fully wired* — the same state a
running app has. Importing individual functions would force us to reconstruct that
state by hand, which is exactly the re-implementation the manifesto forbids.

## The capture shim (`registry.ts`)

`installCapture()` replaces `ipcMain.handle` with a wrapper that:

1. records `(channel, fn)` into a `Map`, and
2. still calls the original `ipcMain.handle`, so the app behaves identically.

It must run **before** `require(APP_MAIN)`, because the app registers handlers
synchronously inside `app.whenReady()`. `boot.ts` installs it first thing.

`invoke(channel, ...args)` then calls the captured `fn` with a synthetic
`IpcMainInvokeEvent` stub (the app's handlers never read the event, but we pass a
minimal one for safety). This is the precise path `ipcRenderer.invoke` triggers,
minus the IPC serialization boundary.

## The app-side hook (one tiny change)

`src/main/index.ts` gains a single behaviour-neutral branch:

```ts
const IS_TEST_HARNESS = process.env.CHIBA_TEST === '1'
// inside app.whenReady():
registerIpcHandlers()
ensureBinariesUnquarantined()
if (IS_TEST_HARNESS) { app.emit('chiba-test:ready'); return }   // skip window + helper install
```

This is the only app change the harness needs. It:
- still registers every handler (so coverage is real), but
- skips creating the `BrowserWindow` (no UI in CI / headless), and
- skips the privileged-helper auto-install (so automated runs never mutate the host
  machine's scheduled tasks / network stack), and
- signals the harness via a custom `chiba-test:ready` event.

In normal use (`CHIBA_TEST` unset) the branch is dead and the app is unchanged.

## The channel map (`channels.ts`)

The authoritative inventory of all 53 channels, derived from `src/preload/index.ts`
(the real renderer→main contract) and the handler signatures. Each spec carries:

- `channel` / `api` — the IPC name and the preload method, for cross-reference,
- `tier` — the safety gate (see README),
- `args(ctx)` — builds invocation args from live discovery context,
- `returns` — the coarse contract: `envelope` (`{ success, ... }`), `value`, or `void`.

Coverage is measured against this map. `--mode=map` prints map-vs-captured drift in
both directions: spec channels the app didn't register (removed/renamed handlers),
and captured channels missing from the spec (new handlers needing a spec entry).

## The engine (`engine.ts`)

For each spec at or below the max tier:

1. **gate** — anything above the tier is recorded as `skip` (keeps the map complete),
2. **build args** from a mutable `InvokeContext` that earlier specs populate
   (e.g. `plans:fetch` harvests a `planId` for `plan:nodes`; `sessions:fetch`
   harvests a `sessionId` and `nodeAddress`),
3. **invoke** the real handler, timed,
4. **assert** the coarse contract,
5. **mine findings** — slow (`>= 4s`), empty result sets, `success:false` with no
   error string, error strings that leak internals (paths, raw stack frames), throws,
6. **pace** read-only chain calls (150ms) to stay RPC-first and 429-friendly.

A handler returning `success:false` is **not** an automatic failure: when no wallet is
loaded, read-only chain channels legitimately report "not initialized". The engine
records that as an `info` finding. It only fails when the contract shape is wrong, the
handler throws, or an error string leaks internals.

## Extending

- **New channel in the app?** `--mode=map` will list it as "registered but NOT in
  spec". Add a `ChannelSpec` to `channels.ts` with the right tier and args.
- **Deeper effect verification?** Today the engine asserts contract + findings. The
  next layer is effect verification — e.g. after `node:connect`, confirm the session
  exists on chain and the route is actually installed. Add per-channel verifiers
  keyed by channel name (the `InvokeContext` already threads discovered ids).
