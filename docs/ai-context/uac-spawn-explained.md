# UAC Spawn — Why the Original Approach Was Broken

## How UAC Works on Windows

UAC uses `ShellExecute` with the `runas` verb. The `AppInfo` service launches `consent.exe` on a secure desktop. If approved, the elevated process runs with a **completely different token** — it is NOT a normal child process. No reliable bidirectional pipe exists between caller and elevated process by design.

## The Two Overlapping Problems

**Problem A — Handle inheritance (the real culprit)**
`exec(psCmd)` creates a stdout/stderr pipe between Node and PowerShell. Windows keeps the parent waiting until **all** processes that inherited that handle close — including grandchildren. `tun2socks` (a daemon that never exits) inherits the pipe → Node's `exec` callback is never called → **await forever**.

**Problem B — Security context separation**
The elevated PowerShell spawns `tun2socks` in a different integrity level. Retrieving info (e.g. the real PID) requires explicit out-of-band mechanisms.

## How Professional VPN Clients Solve This

**Pattern A — Windows Service** (WireGuard, OpenVPN): daemon installed once at setup with UAC. GUI communicates via Named Pipe. No runtime UAC, no spawn chains.

**Pattern B — Helper EXE with `requireAdministrator` manifest** (Tailscale): small EXE with manifest triggers UAC automatically on spawn. EXE exposes a Named Pipe. GUI communicates over it. The elevated process is long-lived, not temporary.

## Our Solution
`ChibaTunnelHelper` implements Pattern B via **TCP localhost** (port 47391) instead of Named Pipe, to avoid DACL integrity restrictions in dev mode. See `helper-architecture.md`.
