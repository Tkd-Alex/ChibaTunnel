# ChibaTunnelHelper — Architecture Decisions

## Why TCP (127.0.0.1:47391) Instead of Named Pipe
Named Pipes created by SYSTEM-level processes have a DACL blocking connections from
medium-integrity processes (Electron). TCP localhost has no integrity level restrictions.
Port 47391 is fixed and non-standard — unlikely to conflict.

## Why Task Scheduler Instead of Windows Service
Windows SCM requires the process to call `SetServiceStatus()` within 30s of start.
Node.js/pkg binaries don't implement the SCM protocol → timeout error 1053.
Task Scheduler with `/ru SYSTEM /sc onstart` has no such requirement.

## Why tun2socks Is Owned by the Helper, Not Electron
Original chain: `Node exec() → PowerShell (UAC elevated) → tun2socks (daemon)`
tun2socks inherited the stdout pipe → Node waited for EOF forever → **await forever**.
Helper owns tun2socks in its process tree → no inherited pipes → Electron gets response immediately.

## Why /tmp Copy Before pkexec on Linux AppImage
AppImage mounts via FUSE as the current user. `pkexec` runs as root.
Root cannot access FUSE mounts owned by another user → `Permission denied`.
Fix: `fs.copyFileSync(helperSrc, tmpPath)` before calling `execPrivileged`.

## IPC Protocol
JSON messages delimited by `\n`. Line-buffered on receipt (TCP may chunk data).

**Electron → Helper:**
```json
{ "command": "start-transparent", "tun2socksPath": "...", "socksPort": 10808, "serverIp": "1.2.3.4", "killSwitch": true }
{ "command": "stop-transparent" }
{ "command": "set-kill-switch", "enabled": false }
{ "command": "wg-up", "wgPath": "...", "configFile": "..." }
{ "command": "wg-down", "wgPath": "...", "configFile": "..." }
{ "command": "get-wg-stats" }
{ "command": "ping" }
```

**Helper → Electron:**
```json
{ "status": "ok", "pid": 4821 }
{ "status": "error", "error": "..." }
{ "status": "pong" }
{ "status": "ok", "rx": 1024, "tx": 2048 }
```

## TUN Interface Names (hardcoded)
- Windows: `sentinel-tun`
- Linux: `sentun0`
- macOS: `utun10`

## Per-Platform Service Installation
| Platform | Mechanism | Installed by |
|----------|-----------|--------------|
| Windows | Task Scheduler (`schtasks /create /ru SYSTEM`) | NSIS installer → `installer.nsh` |
| Linux deb/rpm | systemd unit | `postinst` / `prerm` scripts |
| Linux AppImage | systemd unit | `installLinuxHelper()` via `execPrivileged` at first run |
| macOS | launchd plist in `/Library/LaunchDaemons/` | `installMacHelper()` via `osascript` at first run |

## Key Files
| File | Purpose |
|------|---------|
| `helper/chibatunnel-helper.ts` | The privileged service (all platforms) |
| `src/main/helper-client.ts` | Electron-side connector (`sendToHelper`, `pingHelper`) |
| `build/installer.nsh` | NSIS: registers schtasks, handles uninstall |
| `build/linux/postinst` | deb/rpm: installs + enables systemd service |

## start-transparent Timeout
`sendToHelper({ command: 'start-transparent' }, 60_000)` — 60s required.
`netsh set dnsservers` + Wintun driver init can take 20–25s on first run.
Default 10s timeout causes ECONNRESET before setup completes.

## Kill Switch Implementation
- **Windows**: `netsh advfirewall set allprofiles firewallpolicy blockinbound,blockoutbound` + explicit ALLOW rules for VPN server IP, TUN interface, loopback, DHCP
- **Linux**: dedicated `SENTINEL_KS` iptables chain in OUTPUT
- **macOS**: `pfctl` rules loaded in-memory only (`pfctl -ef /tmp/sentinel-ks.pf`) — not written to `/etc/pf.conf` to avoid persistence after crash

## execPrivileged — Current Usage (post-helper)
| Operation | Windows | Linux | macOS |
|-----------|---------|-------|-------|
| transparent mode | helper | helper | helper |
| WireGuard up/down | helper | helper | helper |
| first-run install | — | execPrivileged (once) | execPrivileged (once) |
