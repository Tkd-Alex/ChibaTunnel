# ChibaTunnel — Core Rules

**These rules take absolute precedence over any other instructions.**

## Security & Work Integrity

1. **Re-read before editing** — always read the current file content before any modification. Never rely on memory or conversation history. Manual changes may have occurred.
2. **Surgical edits only** — use targeted replacements for existing files. Full rewrites only for new files or irreversible corruption (with user authorization).
3. **No placeholders** — never use `// ... rest of code` or similar. Every replacement must be complete, mentally tested, and syntactically correct.
4. **Secret protection** — Mnemonic and Private Key (Cosmos) live EXCLUSIVELY in `src/main/index.ts`. Never send to Renderer via IPC. Storage uses `safeStorage` (OS Keychain). No plain-text fallbacks.
5. **i18n sync** — every string, label, placeholder, or error message added or modified MUST be updated in ALL locale files: `en.json`, `it.json`, `ru.json`, `fa.json`, `ar.json`, `zh.json`, `es.json`, `de.json`, `fr.json` in `src/renderer/src/locales/`. No hardcoded text in components — always use `useTranslation`.
6. **Privileged commands** — never use hardcoded `sudo` requiring terminal input. Use `execPrivileged` (macOS: `osascript`, Linux: `pkexec`/`gksudo`). Group multiple commands into a single execution. On Windows/Linux transparent mode and WireGuard: delegate to `ChibaTunnelHelper` via `sendToHelper()`.

## Project Architecture

**Stack**: Electron + React + TypeScript + Vite

### Key Files
- `src/main/index.ts` — app core: Node.js, VPN binaries, `safeStorage`, Cosmos/Sentinel SDK
- `src/preload/index.ts` — Context Bridge, exposes `window.api`, uses `removeListener` to prevent leaks
- `src/renderer/src/App.tsx` — root component: router, global connection state, traffic polling
- `src/renderer/src/components/` — modular UI components
- `src/renderer/src/styles/globals.css` — global Cyberpunk style
- `helper/chibatunnel-helper.ts` — privileged helper service (TCP 127.0.0.1:47391)
- `src/main/helper-client.ts` — `sendToHelper()` / `pingHelper()`

### Data Flow
Renderer → async IPC calls (e.g. `window.api.connectNode`) → Main process → push events back (`vpn:status`, `traffic:update`).
Transparent mode and WireGuard operations → `sendToHelper()` → ChibaTunnelHelper → response.

## Aesthetics & UX

Strictly **Cyberpunk minimal dark theme**. All visual changes must follow:
- **Colors**: deep darks (`var(--bg-0)`, `var(--bg-1)`) + vivid neons (`var(--cyan)`, `var(--green)`, `var(--purple)`, `var(--red)`, `var(--orange)`, `var(--yellow)`)
- **Typography**: `JetBrains Mono`, `Share Tech Mono`
- **Effects**: scanlines (`.app-shell::after`), glow (`box-shadow`/`text-shadow`), glitch animation on primary buttons (hover)
- **Micro-interactions**: spinners, `transition: all .15s`, custom tooltips — user must never perceive the app as frozen

## Implementation Rules

- **Blockchain / System separation** — always distinguish on-chain data (quota, session ID) from local process data (PID, real RX/TX). If blockchain fails, system monitoring must continue.
- **Global traffic polling** — `window.api.startTraffic` managed only in `App.tsx` based on connection state. Never start/stop polling inside micro-components.
- **Shell error handling** — if a command fails, capture `stderr`, restore pre-tunnel state, inform user in UI. Never crash silently.
- **App quit** — broadcast `MsgCancelSession` if active, kill tunnels (`v2ray`/`tun2socks`/`wg-quick down`). Show `InfoModal` during this phase warning about possible password prompt.

## OS Dependencies

- **WireGuard**: Linux/macOS via `wg-quick`, Windows via `wireguard.exe /installtunnelservice`. All via `sendToHelper({ command: 'wg-up' })`.
- **V2Ray**: background daemon, SOCKS5/HTTP proxy on port 1080, stats via HTTP API `/stats/query`.
- **tun2socks**: transparent proxy via TUN interface. Spawned and owned by `ChibaTunnelHelper`.
- **TUN names**: Windows=`sentinel-tun`, Linux=`sentun0`, macOS=`utun10`.

# Git & Release Workflow Rules

## Branches
- `dev` — default branch, all active work goes here
- `main` — protected, stable only, no direct push

## Daily Work
```bash
git checkout dev
git commit -m "feat: description"
git push origin dev   # CI runs automatically
```

## Release
```bash
# 1. PR from dev → main, merge after CI passes
git checkout main && git pull origin main
# 2. Tag
git tag v1.x.x && git push origin v1.x.x
# 3. GitHub Actions builds Linux + Windows + macOS → Draft Release
# 4. Review on GitHub → Publish
```

## Commit Message Format
- `feat:` new feature
- `fix:` bug fix
- `chore:` tooling, deps, config
- `docs:` documentation only
- `refactor:` no behavior change

## What NOT to Do
- Never push directly to `main`
- Never tag from `dev` — always from `main` after merge
- Never commit secrets, API keys, or mnemonics
