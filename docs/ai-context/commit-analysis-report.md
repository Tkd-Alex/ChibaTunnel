# Windows Transparent Setup — Commit Analysis

## Key Commits (April 14, 2026)

| Commit | Description | Notes |
|--------|-------------|-------|
| `13de42d` | Initial UAC implementation | Direct spawn for tun2socks, non-elevated routes |
| `b4213b8` | Intro `execPrivileged` (.bat) | First attempt at grouping privileged commands |
| `38ba7a3` | Unified PowerShell Script | First coherent script: routes + tun2socks launch |
| `e8f1043` | **Optimal version (pre-pipe)** | Async execPrivileged, real PID capture, robust wait loop |
| `d105c86` | **ElevatedChannel (Named Pipes)** | Current architecture: single persistent UAC |

## Target Version: `e8f1043` — Why It Was the Best Traditional Approach

1. **Coherent PowerShell script** — variables (gateway, `$p`) persisted across steps
2. **Real PID capture** — used `$p = Start-Process ... -PassThru; $p.Id | Out-File tun.pid` instead of relying on PowerShell's PID
3. **Async wait loop** — polled up to 20s for TUN adapter before configuring IP (avoids race conditions)
4. **Low-metric routing** — used `METRIC 2/5` to prioritize VPN routes without deleting the default route

## Current Status
This logic has been superseded by the `ChibaTunnelHelper` TCP architecture (see `helper-architecture.md`).
The robust PID capture and wait loop patterns from `e8f1043` are preserved inside `handleStartTransparent`.
