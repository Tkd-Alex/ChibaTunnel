# Windows Privilege Execution — Evolution History

## Summary of execPrivileged Evolution

| Commit | Change | UI Effect | UAC Effect |
|--------|--------|-----------|------------|
| `51416c9`-`85dd01e` | Async execPrivileged, `.ps1` + `-Wait` | **FREEZE** | OK |
| `e8f1043` | Fix PS variable expansion, unique reqId | **FREEZE** | OK |
| `f50223d` | `exec` → `spawn` | OK (partial) | OK |
| `bfb4b4b` | `stdio: 'ignore'` + `detached: true` | OK | **BROKEN** |

## Critical Regression: `bfb4b4b`
Adding `stdio: 'ignore'` + `detached: true` to `spawn` broke UAC entirely.
**Why**: PowerShell needs a console to trigger `Start-Process -Verb RunAs`. With `stdio: 'ignore'`, it cannot initialize the console → UAC prompt never appears → `tun2socks` never starts.

## Recovery Plan (from this regression)
1. Remove `stdio: 'ignore'` — Node needs minimal attachment to PowerShell for UAC to work
2. Remove `-Wait` from outer PowerShell command — don't wait for long-lived children
3. Keep manual logging (`echo >>`) — `Start-Transcript` locks files
4. Use `shell: true` in `spawn` on Windows — more robust for UAC elevation

## Current Status
This entire `execPrivileged` approach for transparent mode is **superseded** by `ChibaTunnelHelper`.
`execPrivileged` now only handles WireGuard one-shot commands on Windows and macOS.
