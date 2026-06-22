# Chiba Testing

An end-to-end harness that **drives ChibaTunnel's real `ipcMain` handlers** to map
and test every function the app can run — and to discover issues before users do.

It does not re-implement the app's logic. It boots the app's compiled main bundle,
captures every `ipcMain.handle(channel, fn)` as the app registers it, and invokes
the captured handler exactly as `ipcRenderer.invoke` would. If the app changes, the
harness's coverage changes with it.

See [`MANIFESTO.md`](./MANIFESTO.md) for the why, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the how.

## Quick start

```bash
# from the repo root, build the app once so out/main/index.js exists
npm run build

# then, in chiba-testing/
cd chiba-testing
npm run build            # compile the harness (uses the parent repo's tsc)

# map every channel — shows what the app actually registered vs the spec
npm run map

# run end-to-end tests at the safe (read-only) tier
npm run test:safe
```

Or via the CLI launcher after building:

```bash
node dist/cli.js map
node dist/cli.js test --tier=readonly
node dist/cli.js test --tier=local
```

## Safety tiers

Tests are gated by tier so the harness never spends money or rewrites your network
stack by accident. `--tier=X` runs everything **at or below** X.

| Tier         | What it touches                                              | Default? |
|--------------|-------------------------------------------------------------|----------|
| `ui`         | window/app lifecycle (no-ops headless)                      | included |
| `readonly`   | pure reads: RPC/chain queries, balances, settings, node info| **yes**  |
| `local`      | local state only: settings, bookmarks, wallet store         | opt-in   |
| `privileged` | OS network stack / privileged helper: tunnels, kill switch  | opt-in   |
| `spend`      | broadcasts on-chain tx / moves funds                        | opt-in   |

```bash
# include local-state mutations (reversible, no chain)
node dist/cli.js test --tier=local

# DANGER: include on-chain spend — use a funded THROWAWAY wallet only
node dist/cli.js test --tier=spend --mnemonic="word1 word2 ..."
```

The `spend` and `privileged` tiers are intentionally not in the default run. Privileged
operations are skipped because the harness boots with `CHIBA_TEST=1`, which makes the
app skip the privileged-helper auto-install (so automated runs never mutate the host).

## Output

Every `test` run writes durable artifacts to `reports/`:

- `run-<timestamp>.json` — full machine-readable result
- `run-<timestamp>.md`   — human-readable summary with a findings section
- `latest.json` / `latest.md` — stable copies for easy diffing between runs

**Findings** are first-class: slow calls, empty result sets where data was expected,
`success:false` with no error string, error strings that leak internals (paths, stack
frames), and handlers that throw are all recorded — not just pass/fail.

## How "reuse the real handlers" works

The app registers all 53 IPC channels inside `registerIpcHandlers()` in
`src/main/index.ts`. The harness installs a shim over `ipcMain.handle` **before**
requiring the app bundle, so each `(channel, fn)` lands in a registry. Invoking a
channel calls the app's own `fn` with a synthetic event — byte-for-byte the path a
real click takes. The app cooperates via one tiny, behaviour-neutral hook: when
`process.env.CHIBA_TEST === '1'`, it registers handlers but skips the window and the
privileged-helper auto-install, then emits `chiba-test:ready`.

## Layout

```
chiba-testing/
  MANIFESTO.md          # purpose & first principles
  README.md             # this file
  docs/
    ARCHITECTURE.md     # how the capture/boot/engine pipeline works
    CHANNELS.md         # the full channel reference (all 53)
    FINDINGS.md         # known issues — session history + live harness findings
  src/
    boot.ts             # Electron main entry: capture → require app → run mode
    registry.ts         # ipcMain.handle capture + invoke
    channels.ts         # the authoritative channel map + safety tiers
    engine.ts           # runs specs, asserts contracts, mines findings
    reporter.ts         # console + JSON/Markdown reports
    cli.ts              # thin launcher (spawns electron with boot.js)
```
