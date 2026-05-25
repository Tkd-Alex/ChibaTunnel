# Sentinel dVPN — Privileged Helper: Full Implementation Context

**Purpose**: This document transfers the complete context of the privileged helper
architecture from a prior session. It covers every decision, implementation detail,
known bug, and open item. A new AI session can pick up exactly where this left off.

---

## 1. The Original Problem

The Electron app was calling `execPrivileged()` on Windows to run network commands
(route add, netsh, spawn tun2socks) via `Start-Process powershell -Verb RunAs`.
This caused the `await` in `setupTransparentV2Ray()` to hang indefinitely.

**Root cause**: `exec()` in Node.js keeps a pipe open between the parent and child
process. When PowerShell spawned `tun2socks` (a long-running daemon), tun2socks
inherited the pipe's stdout/stderr handles. The OS kept those handles open as long
as tun2socks was alive. Node never received EOF → the `exec()` callback never fired
→ `await` hung forever.

**The fix**: Move all privileged operations into a separate long-lived process
(`sentinel-helper`) that owns tun2socks in its own process tree, with
`stdio: 'ignore'` on all spawned daemons. Electron communicates with the helper
via TCP instead of process pipes.

---

## 2. Architecture

```
Electron (user-level process)
  │
  │  TCP 127.0.0.1:47391  (newline-delimited JSON)
  │
sentinel-helper (privileged long-lived process)
  │
  ├── tun2socks (owned here, stdio:'ignore')
  ├── wireguard.exe /installtunnelservice (Windows)
  └── wg-quick up/down (Linux/macOS)
```

The helper runs as:
- **Windows**: Scheduled Task with `/ru SYSTEM /rl HIGHEST` (via schtasks)
- **Linux**: systemd service as root
- **macOS**: LaunchDaemon as root

**Why schtasks and not Windows Service**: The Windows SCM requires the service
binary to call `SetServiceStatus` (a native Win32 API) within 30 seconds of start.
A Node.js/pkg process does not do this. The SCM times out with error 1053.
schtasks with `/sc onstart /ru SYSTEM` has no such requirement.

**Why TCP and not Named Pipe**: A Named Pipe created by an elevated process on
Windows gets a DACL that blocks connections from medium-integrity processes
(Electron). TCP on localhost has no integrity level restrictions.
Port: **47391**.

---

## 3. File Inventory

| File | Location | Purpose |
|------|----------|---------|
| `sentinel-helper.ts` | `helper/` | The privileged service — all platforms |
| `helper-client.ts` | `src/main/` | Electron-side TCP client — `sendToHelper()`, `pingHelper()` |
| `v2ray-process.ts` | `src/main/` | Replaces V2Ray SDK `connect()` with explicit binary path |
| `installer.nsh` | `build/` | NSIS hooks: schtasks create/delete on install/uninstall |
| `postinst.sh` | `build/linux/` | systemd install for deb/rpm/pacman |
| `postrm.sh` | `build/linux/` | systemd teardown for deb/rpm/pacman |
| `helper/tsconfig.json` | `helper/` | Standalone TS config for pkg build, `esModuleInterop: true` |

---

## 4. IPC Protocol

All messages are single-line JSON terminated by `\n`.

### Electron → Helper

```json
{ "command": "ping" }
{ "command": "start-transparent", "tun2socksPath": "...", "socksPort": 1080, "serverIp": "1.2.3.4", "killSwitch": false }
{ "command": "stop-transparent" }
{ "command": "set-kill-switch", "enabled": true }
{ "command": "wg-up",   "configFile": "...", "wgPath": "..." }
{ "command": "wg-down", "configFile": "...", "wgPath": "..." }
{ "command": "get-wg-stats" }
```

### Helper → Electron

```json
{ "status": "pong" }
{ "status": "ok", "pid": 1234 }
{ "status": "ok", "rx": 1024000, "tx": 512000 }
{ "status": "error", "error": "human-readable message" }
{ "status": "error", "error": "...", "isDnsError": true }
```

`sendToHelper()` in `helper-client.ts` always resolves (never rejects).
On timeout it resolves with `{ status: 'error', error: '...' }`.
Default timeout: 10 s for most commands, 60 s for `start-transparent`.

---

## 5. sentinel-helper.ts — Supported Commands Detail

### `start-transparent` (Windows)
1. Detect gateway: `route print 0.0.0.0` → regex
2. Add bypass route: `route add <serverIp> mask 255.255.255.255 <gateway> METRIC 1`
3. Spawn tun2socks: `-device tun://sentinel-tun -proxy socks5://127.0.0.1:<socksPort>`
   - `stdio: 'ignore'` — **critical**: prevents handle inheritance that caused the original bug
   - `detached: false` — keeps tun2socks in helper's process group
4. Wait for `sentinel-tun` adapter: poll `netsh interface show interface` up to 20 s
5. `netsh interface ipv4 set address name="sentinel-tun" static 10.0.0.1 255.255.255.0 none`
6. `netsh interface ipv4 set dnsservers name="sentinel-tun" static address=1.1.1.1`
7. Get interface index: PowerShell `Get-NetIPInterface`
8. `route add 0.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 2 IF <idx>`
9. `route add 128.0.0.0 mask 128.0.0.0 10.0.0.1 METRIC 2 IF <idx>`
10. If `killSwitch: true` → `enableKillSwitchWindows(serverIp)`

### `start-transparent` (Linux)
TUN device: `sentun0`. Unlike Windows, the helper creates the TUN device first:
1. `ip tuntap add dev sentun0 mode tun`
2. `ip addr add 10.0.0.1/24 dev sentun0`
3. `ip link set dev sentun0 up`
4. `ip route add <serverIp> via <gateway> dev <iface>`
5. Spawn tun2socks: `-device tun://sentun0 -proxy socks5://127.0.0.1:<socksPort>`
6. Wait for `/sys/class/net/sentun0` to exist
7. `ip route add 0.0.0.0/1 dev sentun0`
8. `ip route add 128.0.0.0/1 dev sentun0`

### `start-transparent` (macOS)
TUN device: `utun9`. tun2socks creates the utun device itself.
1. Detect gateway: `route -n get default` → regex
2. Spawn tun2socks: `-device utun9 -proxy socks5://127.0.0.1:<socksPort>`
3. Wait for `ifconfig utun9` to return 0
4. `ifconfig utun9 10.0.0.1 10.0.0.1 netmask 255.255.255.0 up`
   - Same address for both ends (point-to-point, avoids needing a peer address)
5. `route add -host <serverIp> <gateway>`
6. `route add 0.0.0.0/1 -interface utun9`
7. `route add 128.0.0.0/1 -interface utun9`

### Kill Switch

| Platform | Mechanism | Enable | Disable |
|----------|-----------|--------|---------|
| Windows | Windows Firewall default policy | `netsh advfirewall set allprofiles firewallpolicy allowinbound,blockoutbound` + named allow rules | Delete rules + restore `allowoutbound` |
| Linux | iptables chain `SENTINEL_KS` | `iptables -N SENTINEL_KS`, insert into OUTPUT | `iptables -D OUTPUT -j SENTINEL_KS`, flush + delete chain |
| macOS | PF anchor `com.sentinel.ks` | Three steps: (1) register anchor in main ruleset, (2) load rules into anchor, (3) `pfctl -e` | `pfctl -a com.sentinel.ks -F all` + `pfctl -f /etc/pf.conf` |

**Windows allow rules** (all named `Sentinel-KS-*` for easy bulk delete):
- `Sentinel-KS-Allow-Server` — V2Ray server IP
- `Sentinel-KS-Allow-TUN` — sentinel-tun interface
- `Sentinel-KS-Allow-Loopback` — 127.0.0.0/8
- `Sentinel-KS-Allow-DHCP` — UDP 67/68

**macOS PF rules** (loaded into anchor, never written to /etc/pf.conf):
```
set skip on lo0
block out all
pass out quick to <SERVER_IP>
pass out quick on utun9
```

**Critical macOS PF detail**: The anchor must be registered in the main ruleset
first (`echo 'anchor "com.sentinel.ks"' | pfctl -f -`), otherwise the rules inside
the anchor are never evaluated by PF. This is step 1 of the three-step enable.

### Teardown Order (all platforms)
Always: **kill switch first** → kill tun2socks → remove routes.
Reason: restores internet access even if subsequent cleanup steps fail.

---

## 6. WireGuard Integration

### `wg-up` command
- Windows: `wireguard.exe /installtunnelservice "<configFile>"` (SYSTEM privileges via helper)
- Linux/macOS: `wg-quick up "<configFile>"`
- DNS error detection: checks stderr for `resolvconf`, `resolve1`, `Failed to set DNS`, `DNS`
- On DNS error: returns `{ status: 'error', isDnsError: true }` — Electron shows retry dialog

### `wg-down` command
- Windows: `wireguard.exe /uninstalltunnelservice "<ifName>"`
- Linux: checks `ip link show <ifName>` first (idempotent if already gone)
- macOS: same as Linux but uses `ifconfig`

### `get-wg-stats` command
Runs `wg show all transfer` as root (needed on Linux), parses tab-separated output,
returns `{ status: 'ok', rx: N, tx: N }`.

---

## 7. Binary Bundling Strategy

**Bundled on all platforms** (downloaded in GitHub Actions CI, included via `extraResources`):
- `tun2socks` (xjasonlyu/tun2socks)
- `v2ray` + `geoip.dat` + `geosite.dat` (v2fly/v2ray-core)

**Bundled on Windows only**:
- `wintun.dll` (from wintun.net — required by tun2socks)
- `wireguard.exe` + `wg.exe` (extracted from official WireGuard MSI via `msiexec /a`)

**Not bundled — package manager dependency**:
- `wireguard-tools` on Linux: declared as `Depends`/`Requires` in deb/rpm/pacman
- `wireguard-tools` on macOS: user installs via `brew install wireguard-tools`

**Location at runtime**: `process.resourcesPath/bin/` (packaged) or
`build/bins/<platform>/` (dev).

**checkBinaries() priority order**:
1. User custom path (electron-store)
2. System PATH
3. `resources/bin/` (bundled)
4. Executable directory (legacy Windows fallback)

**Geoip/geosite copy-on-demand**: If v2ray is found in PATH (system install) but
geo data files are missing beside it, `checkBinaries()` copies them from
`resources/bin/` next to the system v2ray binary.

**wintun.dll copy-on-demand**: Same pattern — if tun2socks was found elsewhere but
wintun.dll is not beside it, copy from `resources/bin/`.

**macOS Gatekeeper quarantine**: Binaries downloaded and bundled in DMG receive
`com.apple.quarantine` xattr. The app removes this automatically at startup:
```typescript
execSync(`xattr -rd com.apple.quarantine "${path.dirname(binaryPath)}"`)
```
Called in `app.whenReady()` before `checkBinaries()`.

---

## 8. First-Run Helper Installation

### Windows
1. `ensureWindowsHelper()` checks `pingHelper(3000)`
2. If dead: checks `schtasks /query /tn "SentinelHelper"`
3. If task missing: calls `execPrivileged(["schtasks /create ..."])` → one UAC prompt
4. If task exists: calls `schtasks /run /tn "SentinelHelper"` (no UAC needed)
5. Polls `pingHelper()` for up to 5 s

### Linux (deb/rpm/pacman)
postinst.sh runs as root automatically during package install:
- Copies `sentinel-helper` to `/usr/local/lib/sentinel/`
- Writes systemd unit to `/etc/systemd/system/sentinel-helper.service`
- `systemctl enable --now sentinel-helper`

### Linux (AppImage)
1. `ensureLinuxHelper()` checks `pingHelper(3000)`
2. Checks `systemctl status sentinel-helper` (exit 3 = stopped, exit 4 = not found)
3. If stopped: `execPrivileged(['systemctl start sentinel-helper'])`
4. If not found: `installLinuxHelper()` which calls `execPrivileged([...])` with:
   - Copy binary from `/tmp/` (not directly from FUSE mount — root can't read AppImage FUSE mount)
   - Write systemd unit via `printf`
   - `systemctl daemon-reload && systemctl enable --now sentinel-helper`

### macOS
Known bug in installDarwinHelper: using `join('\\n')` produces literal `\n` strings.
`printf '<?xml...\n...'` then interprets `<` as shell redirect → error `?xml: No such file`.

**Fix**: Write plist XML to `/tmp` from Node.js (no shell quoting), then copy with privileges:
```typescript
const tmpPlist = `/tmp/sentinel-helper-${Date.now()}.plist`
fs.writeFileSync(tmpPlist, plistXml, 'utf8')  // join('\n') not '\\n'
await execPrivileged([
  `cp ${tmpPlist} ${plistPath}`,
  `chmod 644 ${plistPath}`,
  `chown root:wheel ${plistPath}`,
  `launchctl load -w ${plistPath} || true`,
  `launchctl start com.sentinel.helper`,
])
```

Also: `helperSrc` should be `sentinel-helper` (not `sentinel-helper-mac`) because
electron-builder.json maps `"from": "dist-helper/sentinel-helper-mac"` → `"to": "sentinel-helper"`.

---

## 9. V2Ray Process Ownership

The V2Ray SDK's `connect()` method calls `spawn("v2ray", [...])` which relies on
PATH. This fails silently on Windows when v2ray is in `resources/bin/` but not
in the system PATH.

**Fix**: `v2ray-process.ts` provides `spawnV2Ray(v2rayInstance, binaryPath)` which:
- Uses the explicit path from `checkBinaries().v2rayPath`
- Pipes stdout/stderr for logging
- Detects immediate crashes via a 500 ms window
- Owns the `ChildProcess` reference independently of the SDK

The SDK (`activeV2Ray`) is still used for `parseConfig()`, `getKey()`, `writeConfig()`,
`buildShareLinks()`, and the `config` property. Only `connect()` and `disconnect()`
are replaced.

In `ipcMain.handle('node:connectV2ray')`:
```typescript
const { pid } = await spawnV2Ray(activeV2Ray, binaries.v2rayPath)
// instead of: const pid = activeV2Ray.connect()
```

In `killActiveConnections()`:
```typescript
killV2Ray()          // instead of: activeV2Ray.disconnect()
activeV2Ray = null
```

---

## 10. Build System

### package.json scripts
```json
"dev:helper":         "ts-node --project helper/tsconfig.json helper/sentinel-helper.ts",
"build:helper:win":   "tsc --project helper/tsconfig.json && pkg dist-helper/sentinel-helper.js --target node18-win-x64 --output dist-helper/sentinel-helper.exe",
"build:helper:linux": "tsc --project helper/tsconfig.json && pkg dist-helper/sentinel-helper.js --target node18-linux-x64 --output dist-helper/sentinel-helper",
"build:helper:mac":   "tsc --project helper/tsconfig.json && pkg dist-helper/sentinel-helper.js --target node18-macos-x64 --output dist-helper/sentinel-helper-mac"
```

### electron-builder.json (relevant sections)
```json
"win":   { "extraResources": [{ "from": "dist-helper/sentinel-helper.exe", "to": "sentinel-helper.exe" }, { "from": "build/bins/win/", "to": "bin/" }] },
"linux": { "extraResources": [{ "from": "dist-helper/sentinel-helper",     "to": "sentinel-helper"     }, { "from": "build/bins/linux/", "to": "bin/" }] },
"mac":   { "extraResources": [{ "from": "dist-helper/sentinel-helper-mac", "to": "sentinel-helper"     }, { "from": "build/bins/mac/",  "to": "bin/" }] },
"deb":   { "depends": ["wireguard-tools"] },
"rpm":   { "requires": ["wireguard-tools"] },
"pacman":{ "depends":  ["wireguard-tools"] }
```

### GitHub Actions binary versions (env vars in release.yml)
```yaml
TUN2SOCKS_VERSION:  'v2.6.0'
V2RAY_VERSION:      'v5.16.1'
WINTUN_VERSION:     '0.14.1'
WIREGUARD_VERSION:  '0.5.3'
```
wireguard.exe extracted from MSI via `msiexec /a wireguard.msi /qn TARGETDIR=...`

---

## 11. Development Workflow

```bash
# Terminal 1 — elevated (admin / sudo)
npm run dev:helper
# Wait for: "TCP listening on 127.0.0.1:47391"

# Terminal 2 — normal user
npm run dev
```

The helper must start first. If Electron connects before the helper is listening,
`sendToHelper()` returns `{ status: 'error', error: 'Connection refused...' }`
instead of hanging.

---

## 12. Open Items

| Item | Priority | Notes |
|------|----------|-------|
| macOS helper not auto-installing during setup | High | `ensureMacOSHelper()` not wired into `app.whenReady()` flow — needs investigation |
| macOS plist XML quoting bug | Fixed | Use `fs.writeFileSync` for plist, not shell `printf` |
| V2Ray not spawning on Windows | Fixed | Use `spawnV2Ray()` with explicit path |
| wireguard-go / boringtun userspace (Windows) | Low | Eliminate WireGuard MSI dependency entirely. See wireguard-go repo. |
| macOS code-signing + notarization | Low | Eliminates Gatekeeper quarantine permanently. Requires Apple Developer account. |
| `launchctl bootstrap` migration (macOS 13+) | Low | `launchctl load` soft-deprecated. Migration: `launchctl bootstrap system <plist>` |
| Traffic stats via helper for wg show (Windows) | Done | `get-wg-stats` command implemented |
| macOS transparent proxy testing | Pending | User implementing, not fully tested end-to-end |
| wg-up / wg-down in helper | Implemented, untested | Written in sentinel-helper-wg-additions.ts |