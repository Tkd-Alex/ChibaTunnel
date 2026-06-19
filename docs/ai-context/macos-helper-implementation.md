# macOS Privileged Helper — Implementation Reference

**Scope**: Technical decisions made in the `chibatunnel-helper` service for macOS
transparent proxy (V2Ray + tun2socks) and kill switch support.
**Status**: Implemented and reviewed. All choices below are final unless noted.

---

## Architecture Overview

The chibatunnel-helper runs as a **LaunchDaemon** under `root` on macOS, loaded
from `/Library/LaunchDaemons/com.chibatunnel.helper.plist`. The Electron app
communicates with it via **TCP on 127.0.0.1:47391** using newline-delimited
JSON messages.

The helper owns all privileged operations:
- Network route manipulation (`route add / delete`)
- TUN interface lifecycle (`ifconfig utunX`)
- tun2socks process spawning and ownership
- PF firewall kill switch (`pfctl`)

The Electron process handles all unprivileged operations:
- DNS resolution of the V2Ray server hostname
- Binary discovery (`checkBinaries`)
- Config file generation and patching
- UI state and IPC with the renderer

---

## 1. Gateway Detection

**Problem**: macOS does not have the `ip route` command available on Linux.

**Solution**: Parse the output of `route -n get default`.

```bash
route -n get default
# Output includes:
#    gateway: 192.168.1.1
```

**Implementation**: Regex `/gateway:\s+(\d+\.\d+\.\d+\.\d+)/` extracts the
gateway IP. This is the most reliable method on Darwin — `netstat -rn` works
too but requires more complex parsing of tabular output.

**Why this matters**: The bypass route for the V2Ray server IP must be added
via the real physical gateway before the 0/1 and 128/1 routes are installed.
Without it, V2Ray traffic would loop into the tunnel it is carrying.

---

## 2. Transparent Proxy (tun2socks)

### TUN Interface

**Interface name**: `utun9`

**Rationale**: Common VPN tools (WireGuard system tunnels, third-party VPNs)
start from `utun0`. Using `utun9` avoids collisions in the majority of cases.
The number is fixed (not dynamic) because the helper is the sole owner of the
transparent proxy state and cleanup always targets a known name.

**Address configuration**:
```bash
ifconfig utun9 10.0.0.1 10.0.0.1 netmask 255.255.255.0 up
```

On macOS, `utun` devices are point-to-point. The same address is used for both
the local and peer ends (`10.0.0.1 10.0.0.1`). This is intentional: it avoids
needing a separate peer address for routing and simplifies the route commands
(which use `-interface utun9` instead of a gateway IP).

**Waiting for the interface**: tun2socks creates the utun device asynchronously.
The helper polls with `ifconfig utun9` (exits 0 when the device exists) up to
`TUN_WAIT_TIMEOUT_MS` milliseconds before failing.

### Routing Strategy — Slash-One Routes

Instead of replacing or deleting the existing default route (risky: a crash
would leave the system without internet), two more-specific routes are added:

```bash
route add 0.0.0.0/1 -interface utun9
route add 128.0.0.0/1 -interface utun9
```

**Why this works**: These two /1 routes together cover the entire IPv4 address
space and are more specific than the standard default route (`0.0.0.0/0`).
The kernel prefers more-specific matches, so all traffic is attracted to utun9
without touching the original default route.

**Teardown**: Deleting just these two routes instantly restores the original
routing table. The physical default route was never modified.

**Bypass route for the V2Ray server** (added before the /1 routes):
```bash
route add -host <serverIp> <gateway>
```
This host route takes precedence over the /1 routes for the VPN server IP
specifically, preventing the routing loop.

---

## 3. Kill Switch (PF — Packet Filter)

### Design Principles

- **No modification of `/etc/pf.conf`**: Rules exist in memory only and are
  never written to disk. A system reboot restores the original PF state.
- **Isolated namespace**: A dedicated PF anchor (`com.chibatunnel.ks`) contains
  all ChibaTunnel rules and does not interfere with any user-configured firewall.
- **Atomic teardown**: `pfctl -a com.chibatunnel.ks -F all` flushes all rules in
  the anchor in a single command, with no partial-state window.

This approach is used by Mullvad VPN and ProtonVPN on macOS.

### Anchor Activation — Three-Step Sequence

A PF anchor only takes effect if the **main ruleset** references it. Without
step 1, the rules inside the anchor exist but PF never evaluates them — the
kill switch has no effect.

```bash
# Step 1: Register the anchor reference in the main ruleset.
echo 'anchor "com.chibatunnel.ks"' | pfctl -f -

# Step 2: Load blocking rules into the anchor.
printf '<rules>' | pfctl -a com.chibatunnel.ks -f -

# Step 3: Enable PF. pfctl -e returns exit code 1 if already enabled —
#          this is handled gracefully (caught and logged, not re-thrown).
pfctl -e
```

### Firewall Rules (loaded into the anchor)

```
set skip on lo0
block out all
pass out quick to <SERVER_IP>
pass out quick on utun9
```

Rule rationale:
- `set skip on lo0`: Exempts loopback traffic. Without this, the Electron ↔
  Helper TCP connection on 127.0.0.1:47391 would be blocked by the kill switch,
  making it impossible to send the `stop-transparent` command.
- `block out all`: Drop policy — anything not explicitly allowed is blocked.
- `pass out quick to <SERVER_IP>`: V2Ray must be able to reach the Sentinel node.
  Without this, the proxy cannot forward traffic even though the tunnel is up.
- `pass out quick on utun9`: Tunnelled user traffic exits via the TUN interface.

### Kill Switch Teardown

```bash
# 1. Flush all rules from our anchor.
pfctl -a com.chibatunnel.ks -F all

# 2. Restore the system default ruleset, removing the anchor reference.
pfctl -f /etc/pf.conf
```

Step 2 reloads `/etc/pf.conf` which does not contain the `anchor "com.chibatunnel.ks"`
line — this effectively unregisters the anchor from the main ruleset. The
system is left in its original state as if the kill switch was never activated.

**Edge case**: If the user had custom PF rules active before ChibaTunnel modified
the ruleset, those rules are also restored by `pfctl -f /etc/pf.conf` (since
they originate from that file). This is the correct behaviour.

---

## 4. tun2socks Process Ownership

tun2socks is spawned as a child of the **helper** (not Electron) with
`stdio: 'ignore'` and `detached: false`.

**Why `stdio: 'ignore'` is critical**: If the helper held open stdout/stderr
pipes into tun2socks, the OS would keep those handles alive as long as
tun2socks runs. When Electron disconnects from the TCP socket after receiving
the `start-transparent` response, Node.js would never see EOF on those handles,
causing `sendToHelper()` in Electron to hang indefinitely — the exact bug this
service architecture was built to solve.

**Why `detached: false`**: Keeps tun2socks in the helper's process group.
If launchd stops the helper service, macOS terminates the group automatically,
preventing tun2socks from becoming an orphan.

---

## 5. Teardown Order and Safety

The `stopTransparentMacOS` and `shutdown` functions always follow this order:

1. **Disable kill switch first** — restore internet access before any other
   cleanup. If a subsequent step fails, the user is not left without connectivity.
2. **Kill tun2socks** — sends SIGTERM. The utun9 device disappears automatically
   when tun2socks exits (it was created by tun2socks; the OS reclaims it).
3. **Remove routes** — delete the bypass host route and the two /1 routes.
   These may already be gone if tun2socks cleaned up the utun device first,
   so all route deletions are wrapped in try/catch.

**Crash resilience**: The helper is a persistent service. If Electron crashes
while the tunnel is active, the helper keeps tun2socks running and the kill
switch in place (if it was enabled). Traffic remains protected. The user must
explicitly disconnect from the Electron UI — or kill the helper service — to
restore normal routing. This is the desired behaviour for a kill switch.

---

## 6. LaunchDaemon Service

**Plist location**: `/Library/LaunchDaemons/com.chibatunnel.helper.plist`

**Key properties**:
- `RunAtLoad: true` — starts at system boot before user login
- `KeepAlive: true` — launchd restarts the helper if it crashes
- `UserName: root` — required for route manipulation, tun2socks spawn, pfctl

**First-run install**: Performed by `installMacOSHelper()` in the Electron
main process via `execPrivileged` (osascript with administrator privileges).
Requires a single password prompt — never repeated after installation.

The binary is first copied from `process.resourcesPath` to `/tmp/` before the
privileged copy step. This avoids macOS app bundle sandbox restrictions that
prevent a root process from reading directly from the `.app` bundle's resources.

**Service management** (`ensureMacOSHelper`):
- If the helper responds to ping → already running, nothing to do.
- If the plist exists but the helper is not responding → `launchctl start`
  (no password required for already-registered plists).
- If the plist is absent → first-run install flow.

---

## 7. Gatekeeper Quarantine

**Problem**: Binaries downloaded from GitHub during CI (tun2socks, v2ray) may
receive the `com.apple.quarantine` extended attribute when the user downloads
and opens the DMG. macOS Gatekeeper blocks execution of quarantined binaries
from unidentified developers.

**Detection**: At startup, `xattr` is run against each resolved binary path.
If `com.apple.quarantine` is present, the quarantine is removed automatically:

```typescript
execSync(`xattr -rd com.apple.quarantine "${path.dirname(binaryPath)}"`)
```

**Why the app can do this**: The Electron process itself is already approved
by Gatekeeper (the user launched it). It has permission to modify extended
attributes on files within its own resource directories.

**Timing**: This runs in `app.whenReady()` before `checkBinaries()`, so by
the time binary resolution occurs the quarantine flags are already cleared.

**Permanent solution**: Code-signing and notarizing the bundled binaries with
an Apple Developer certificate would eliminate the quarantine issue entirely.
The current automatic-removal approach is the pragmatic alternative for
unsigned distributions.

---

## 8. WireGuard on macOS

wireguard-tools is **not bundled**. The helper's `handleWgUp` and `handleWgDown`
commands call `wg-quick up/down` which must be present in PATH.

**Install guide** (shown in-app when `wg-quick` is not found):
```
brew install wireguard-tools
```

`checkBinaries()` returns a `wireguardGuide` string (non-null when missing)
that the renderer displays as an onboarding step, not a hard error. The connect
button for WireGuard mode is disabled until `wireguard` is `true` in the
binary check result.

---

## 9. Open Items / Future Work

| Item | Priority | Notes |
|------|----------|-------|
| Code-sign bundled binaries (tun2socks, v2ray) | Medium | Requires Apple Developer account. Eliminates Gatekeeper quarantine permanently. |
| `launchctl bootstrap` migration | Low | `launchctl load` is soft-deprecated on macOS 13+. Migration: `launchctl bootstrap system <plist>` / `launchctl bootout system/<label>`. Both still work as of macOS 15. |
| Apple Silicon native v2ray | Low | Current bundle uses `v2ray-macos-64` (x86_64). A universal binary or arm64-specific download would remove Rosetta 2 dependency on M-series Macs. tun2socks is already universal (lipo-merged in CI). |
| Dynamic utun interface selection | Low | Fixed `utun9` works in practice. If a conflict is ever reported, implement a scan of existing `utunX` devices via `ifconfig -a` and pick the next available slot. |
