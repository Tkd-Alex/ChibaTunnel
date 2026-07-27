/**
 * chibatunnel-helper.ts
 *
 * Privileged helper service for ChibaTunnel. Runs as a Windows Service (LocalSystem)
 * or a systemd service (root on Linux), providing network operations that require
 * elevated privileges without prompting UAC or sudo at runtime.
 *
 * Communication model:
 *   TCP on 127.0.0.1:HELPER_PORT. Newline-delimited JSON messages in both directions.
 *   On Windows, the --namedpipe flag switches to \\.\pipe\chibatunnel-helper instead.
 *
 * Runtime modes:
 *   --service     Production. Started by the Windows SCM or systemd.
 *   --namedpipe   Windows Named Pipe transport (requires same integrity level).
 *   (no flags)    Development. TCP, run from an elevated terminal.
 *
 * Supported commands (all platforms unless noted):
 *   ping               → { status: 'pong' }
 *   start-transparent  → { status: 'ok', pid: number } | { status: 'error', error }
 *   stop-transparent   → { status: 'ok' }               | { status: 'error', error }
 *   set-kill-switch    → { status: 'ok' }               | { status: 'error', error }
 *
 * Kill switch — Windows:
 *   Sets the Windows Firewall default outbound policy to BLOCK, then adds named
 *   allow rules for the VPN server IP, TUN interface, loopback, and DHCP.
 *   The default policy is evaluated after explicit rules, so allow rules are
 *   true exceptions — unlike a block rule which would override them.
 *
 * Kill switch — Linux:
 *   Inserts a dedicated iptables chain (CHIBATUNNEL_KS) into OUTPUT, which drops
 *   all outbound traffic except the VPN server IP, the TUN interface, and loopback.
 *   Teardown removes the chain entirely, leaving the rest of iptables untouched.
 *
 * Build (CI produces platform-specific binaries via pkg):
 *   Windows: pkg dist-helper/chibatunnel-helper.js --target node18-win-x64   --output dist-helper/chibatunnel-helper.exe
 *   Linux:   pkg dist-helper/chibatunnel-helper.js --target node18-linux-x64 --output dist-helper/chibatunnel-helper
 */

import net  from 'net'
import path from 'path'
import fs   from 'fs'
import { execFileSync, execSync, spawn, ChildProcess } from 'child_process'
import {
  parseHelperCommand,
  type HelperCommand,
  type HelperResponse
} from '../src/main/helper-protocol'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELPER_HOST = '127.0.0.1'
const HELPER_PORT = 47391
const PIPE_PATH   = '\\\\.\\pipe\\chibatunnel-helper'   // Windows only
const MAX_CONNECTIONS = 4

const IS_SERVICE_MODE = process.argv.includes('--service')
const USE_NAMED_PIPE  = process.argv.includes('--namedpipe')
const PLATFORM        = process.platform   // 'win32' | 'linux' | 'darwin'

// Windows TUN constants (Wintun adapter created by tun2socks)
const WIN_TUN_NAME    = 'chiba-tun'
const WIN_TUN_ADDRESS = '10.0.0.1'
const WIN_TUN_NETMASK = '255.255.255.0'
const WIN_TUN_DNS     = '1.1.1.1'

// Linux TUN constants (kernel tun device created via ip tuntap)
const LIN_TUN_NAME    = 'chibatun0'
const LIN_TUN_CIDR    = '10.0.0.1/24'

// Darwin TUN constants (utun device created by tun2socks)
const DAR_TUN_NAME    = 'utun9'
const DAR_TUN_ADDRESS = '10.0.0.1'

const TUN_WAIT_TIMEOUT_MS  = 20_000
const TUN_POLL_INTERVAL_MS = 500

// Windows Firewall kill switch rule prefix — all our rules share this prefix
// so they can be deleted as a group.
const KS_RULE_PREFIX = 'chibatunnel-ks'
const KS_RULE_NAMES  = [
  `${KS_RULE_PREFIX}-Allow-Server`,
  `${KS_RULE_PREFIX}-Allow-TUN`,
  `${KS_RULE_PREFIX}-Allow-Loopback`,
  `${KS_RULE_PREFIX}-Allow-DHCP`,
]

// Linux iptables kill switch chain name.
const KS_CHAIN = 'CHIBATUNNEL_KS'

// Darwin PF (Packet Filter) anchor name for kill switch.
const KS_PF_ANCHOR = 'com.chibatunnel.ks'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StartTransparentPayload {
  /** Absolute path to tun2socks binary. */
  tun2socksPath: string
  /** SOCKS5 port v2ray is listening on. */
  socksPort: number
  /** Already-resolved IPv4 address of the V2Ray server. */
  serverIp: string
  /** Whether to enable the kill switch after the tunnel is up. Default false. */
  killSwitch?: boolean
}

interface SetKillSwitchPayload {
  enabled: boolean
}

/**
 * Payload for the 'wg-up' command. Instructs the helper to bring up a
 * WireGuard tunnel by installing it as a service (Windows) or running
 * wg-quick (Linux/macOS).
 */
interface WgUpPayload {
  /** Absolute path to the WireGuard config file (.conf). */
  configFile: string
  /**
   * Absolute path to wireguard.exe. Required on Windows because the binary
   * location is user-configured (checkBinaries in Electron resolves it).
   * Ignored on Linux/macOS.
   */
  wgPath?: string
}

/**
 * Payload for the 'wg-down' command. Instructs the helper to tear down
 * a WireGuard tunnel.
 */
interface WgDownPayload {
  /** Absolute path to the WireGuard config file (.conf). */
  configFile: string
  /** Same as WgUpPayload.wgPath — required on Windows only. */
  wgPath?: string
}

interface QuickTunnelSpec {
  commandPrefix: 'wg' | 'awg'
  windowsExecutable: 'wireguard.exe' | 'amneziawg.exe'
  unixExecutable: 'wg-quick' | 'awg-quick'
  unixControlExecutable: 'wg' | 'awg'
}

const WIREGUARD_TUNNEL_SPEC: QuickTunnelSpec = {
  commandPrefix: 'wg',
  windowsExecutable: 'wireguard.exe',
  unixExecutable: 'wg-quick',
  unixControlExecutable: 'wg'
}

const AMNEZIAWG_TUNNEL_SPEC: QuickTunnelSpec = {
  commandPrefix: 'awg',
  windowsExecutable: 'amneziawg.exe',
  unixExecutable: 'awg-quick',
  unixControlExecutable: 'awg'
}

// ---------------------------------------------------------------------------
// Active state
// ---------------------------------------------------------------------------

let activeTun2Socks: ChildProcess | null = null
let activeHysteria2: ChildProcess | null = null
let activeOpenVPN: ChildProcess | null = null
let activeServerIp:  string | null = null
let killSwitchActive = false

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Writes a timestamped log line to stdout. In service mode the output is
 * captured by the Windows SCM or systemd journal. In dev mode it goes to the
 * elevated terminal.
 *
 * @param level  'INFO', 'WARN', or 'ERROR'.
 * @param msg    Human-readable message.
 * @param data   Optional extra data serialised as JSON.
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: unknown): void {
  const ts    = new Date().toISOString()
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : ''
  const line  = `[${ts}] [${level}] [ChibaTunnelHelper] ${msg}${extra}`
  console.log(line)

  try {
    const logDir = PLATFORM === 'win32' ? 'C:\\Windows\\Temp' : '/tmp'
    const logPath = path.join(logDir, 'chibatunnel-helper.log')
    fs.appendFileSync(logPath, line + '\n', 'utf8')
  } catch (_) {
    // Fail-safe
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a HelperResponse to a newline-terminated JSON string and writes
 * it to the socket. The newline is the message delimiter used by helper-client.ts.
 *
 * @param socket    Connected Electron client socket.
 * @param response  Response to send.
 */
function sendResponse(socket: net.Socket, response: HelperResponse): void {
  if (socket.destroyed) {
    log('WARN', 'Attempted to send response to a destroyed socket — skipping.')
    return
  }
  try { socket.write(JSON.stringify(response) + '\n') }
  catch (err) { log('ERROR', 'Failed to write response.', err) }
}

// ---------------------------------------------------------------------------
// Shared system helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether a stderr string from wg-quick indicates a DNS
 * configuration failure. wg-quick on Linux fails with DNS errors when
 * resolvconf is not installed or when systemd-resolved is not available.
 * In that case Electron will ask the user whether to retry without DNS
 * injection (using a patched config file).
 *
 * @param stderr  The stderr output from the wg-quick invocation.
 * @returns       True if the error is DNS-related.
 */
function isWgDnsError(stderr: string): boolean {
  return (
    stderr.includes('resolvconf') ||
    stderr.includes('resolve1') ||
    stderr.includes('Failed to set DNS') ||
    stderr.includes('DNS')
  )
}

/**
 * Runs a command synchronously and returns its trimmed stdout. stdio is always
 * 'pipe' so that no handles are inherited by child processes — inheriting handles
 * would cause Electron's TCP connection to block indefinitely (the original bug).
 *
 * @param cmd  Command string to execute.
 * @returns    Trimmed stdout.
 * @throws     Error if the command exits non-zero.
 */
function runCmd(cmd: string): string {
  log('INFO', `Executing: ${cmd}`)
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

function runFile(executable: string, args: string[]): string {
  log('INFO', `Executing allowlisted binary: ${path.basename(executable)}`, { args })
  return execFileSync(executable, args, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/**
 * Polls until the named network interface appears in the OS, or until the
 * timeout expires. Used on both platforms after spawning tun2socks.
 *
 * On Windows it queries the adapter via netsh. On Linux it checks /sys/class/net.
 *
 * @param ifName     Interface name to wait for.
 * @param timeoutMs  Maximum wait in milliseconds.
 * @param intervalMs Poll interval in milliseconds.
 * @returns          Promise resolving to true if the interface appeared.
 */
function waitForInterface(
  ifName:     string,
  timeoutMs  = TUN_WAIT_TIMEOUT_MS,
  intervalMs = TUN_POLL_INTERVAL_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs

    const poll = (): void => {
      try {
        if (PLATFORM === 'win32') {
          execSync(`netsh interface show interface name="${ifName}"`, { stdio: 'pipe' })
        } else if (PLATFORM === 'linux') {
          execSync(`test -d /sys/class/net/${ifName}`, { stdio: 'pipe' })
        } else if (PLATFORM === 'darwin') {
          execSync(`ifconfig ${ifName}`, { stdio: 'pipe' })
        }
        log('INFO', `Interface "${ifName}" is now available.`)
        resolve(true)
        return
      } catch { /* not yet */ }

      if (Date.now() >= deadline) {
        log('WARN', `Interface "${ifName}" did not appear within ${timeoutMs} ms.`)
        resolve(false)
        return
      }
      setTimeout(poll, intervalMs)
    }

    poll()
  })
}

// ---------------------------------------------------------------------------
// Windows network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway IP from the Windows routing table by parsing
 * `route print 0.0.0.0`. Needed to add the V2Ray server bypass route before
 * redirecting all traffic through the TUN — without it traffic to V2Ray would
 * enter the tunnel and cause an infinite routing loop.
 *
 * @returns Gateway IP string, or null if not found.
 */
function detectGatewayWindows(): string | null {
  try {
    const output = execSync('route print 0.0.0.0', { encoding: 'utf8', stdio: 'pipe' })
    const match  = output.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (err) {
    log('WARN', 'Failed to run "route print 0.0.0.0".', err)
    return null
  }
}

/**
 * Retrieves the numeric Windows interface index of the Wintun adapter via
 * PowerShell's Get-NetIPInterface. Required by `route add ... IF <idx>`.
 *
 * @param tunName  Adapter name to look up.
 * @returns        Interface index, or null on failure.
 */
function getTunIndexWindows(tunName: string): number | null {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command ` +
      `"(Get-NetIPInterface -InterfaceAlias '${tunName}' -AddressFamily IPv4 -ErrorAction Stop).InterfaceIndex"`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    const idx = parseInt(raw, 10)
    return isNaN(idx) ? null : idx
  } catch (err) {
    log('WARN', 'Failed to retrieve TUN interface index.', err)
    return null
  }
}

/**
 * Removes routing entries added during start-transparent on Windows.
 * Errors on individual deletions are logged but do not throw — cleanup must
 * be best-effort because the TUN adapter may have already vanished.
 *
 * @param serverIp  V2Ray server IP whose bypass route must be deleted.
 */
function removeRoutesWindows(serverIp: string): void {
  for (const cmd of [
    `route delete ${serverIp}`,
    `route delete 0.0.0.0 mask 128.0.0.0`,
    `route delete 128.0.0.0 mask 128.0.0.0`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `Route removal failed (may already be gone): ${cmd}`, err) }
  }
}

// ---------------------------------------------------------------------------
// Linux network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway and outbound interface from `ip route show default`.
 * Returns both values because Linux route add requires the interface name.
 * Filters out our own TUN interface name to avoid reading a stale entry.
 *
 * @returns Object with gateway IP and interface name, or null if not found.
 */
function detectGatewayLinux(): { gateway: string; iface: string } | null {
  try {
    const output = execSync(
      `ip route show default | grep -v '${LIN_TUN_NAME}' | head -n1`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    // Format: "default via 192.168.1.1 dev eth0 proto dhcp metric 100"
    const parts = output.split(/\s+/)
    const viaIdx = parts.indexOf('via')
    const devIdx = parts.indexOf('dev')
    if (viaIdx === -1 || devIdx === -1) return null
    return { gateway: parts[viaIdx + 1], iface: parts[devIdx + 1] }
  } catch (err) {
    log('WARN', 'Failed to detect default gateway on Linux.', err)
    return null
  }
}

/**
 * Removes routing entries and the TUN interface added during start-transparent
 * on Linux. All commands use `|| true` semantics via try/catch so cleanup
 * continues even if individual steps fail.
 *
 * @param serverIp  V2Ray server IP whose bypass route must be deleted.
 * @param tunName   TUN interface name to tear down.
 */
function removeRoutesLinux(serverIp: string, tunName: string): void {
  for (const cmd of [
    `ip route del 0.0.0.0/1 dev ${tunName}`,
    `ip route del 128.0.0.0/1 dev ${tunName}`,
    `ip route del ${serverIp}`,
    `ip link set dev ${tunName} down`,
    `ip tuntap del dev ${tunName} mode tun`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `Linux route/interface removal failed: ${cmd}`, err) }
  }
}

// ---------------------------------------------------------------------------
// Darwin network helpers
// ---------------------------------------------------------------------------

/**
 * Reads the default gateway IP on macOS using `route -n get default`.
 *
 * @returns Gateway IP string, or null if not found.
 */
function detectGatewayDarwin(): string | null {
  try {
    const output = execSync('route -n get default', { encoding: 'utf8', stdio: 'pipe' })
    const match = output.match(/gateway:\s+(\d+\.\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (err) {
    log('WARN', 'Failed to detect default gateway on Darwin.', err)
    return null
  }
}

/**
 * Removes routing entries added during start-transparent on Darwin.
 *
 * @param serverIp  V2Ray server IP whose bypass route must be deleted.
 */
function removeRoutesDarwin(serverIp: string): void {
  for (const cmd of [
    `route delete ${serverIp}`,
    `route delete 0.0.0.0/1`,
    `route delete 128.0.0.0/1`,
  ]) {
    try { runCmd(cmd) }
    catch (err) { log('WARN', `Darwin route removal failed: ${cmd}`, err) }
  }
}

// ---------------------------------------------------------------------------
// Windows kill switch
// ---------------------------------------------------------------------------

/**
 * Enables the Windows Firewall kill switch by setting the default outbound
 * policy to BLOCK and adding named allow rules for:
 *   - The V2Ray server IP (so the proxy connection survives)
 *   - The TUN adapter (so tunnelled traffic can leave)
 *   - Loopback 127.0.0.0/8 (localhost IPC must not break)
 *   - DHCP UDP 67/68 (physical NIC must renew its lease)
 *
 * The default policy is evaluated after all explicit rules, so allow rules
 * act as true exceptions — this is different from adding an explicit block
 * rule which would override them.
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @throws          Error if any netsh command fails.
 */
function enableKillSwitchWindows(serverIp: string): void {
  if (killSwitchActive) {
    log('WARN', 'Kill switch already active — skipping enableKillSwitchWindows.')
    return
  }
  log('INFO', `Enabling Windows kill switch. Server IP exempt: ${serverIp}`)

  runCmd('netsh advfirewall set allprofiles firewallpolicy allowinbound,blockoutbound')
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-Server" dir=out action=allow protocol=any remoteip=${serverIp}`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-TUN" dir=out action=allow protocol=any interface="${WIN_TUN_NAME}"`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-Loopback" dir=out action=allow protocol=any remoteip=127.0.0.0/8`)
  runCmd(`netsh advfirewall firewall add rule name="${KS_RULE_PREFIX}-Allow-DHCP" dir=out action=allow protocol=UDP localport=68 remoteport=67`)

  killSwitchActive = true
  log('INFO', 'Windows kill switch enabled.')
}

/**
 * Disables the Windows Firewall kill switch by removing all chibatunnel-ks-*
 * rules and restoring the default outbound policy to ALLOW. Safe to call even
 * if the kill switch was never enabled — it attempts orphan rule cleanup.
 */
function disableKillSwitchWindows(): void {
  log('INFO', 'Disabling Windows kill switch.')
  for (const name of KS_RULE_NAMES) {
    try { runCmd(`netsh advfirewall firewall delete rule name="${name}"`) }
    catch (err) { log('WARN', `Could not delete firewall rule "${name}".`, err) }
  }
  try { runCmd('netsh advfirewall set allprofiles firewallpolicy allowinbound,allowoutbound') }
  catch (err) { log('ERROR', 'Failed to restore default outbound policy.', err) }
  killSwitchActive = false
  log('INFO', 'Windows kill switch disabled.')
}

// ---------------------------------------------------------------------------
// Linux kill switch
// ---------------------------------------------------------------------------

/**
 * Enables the Linux kill switch using iptables. Creates a dedicated chain
 * CHIBATUNNEL_KS and inserts it into OUTPUT. The chain drops everything except:
 *   - Traffic to the V2Ray server IP
 *   - Traffic leaving via the TUN interface
 *   - Loopback (lo)
 *
 * Using a dedicated chain instead of modifying the default OUTPUT policy means:
 *   - We never touch rules that were there before us
 *   - Teardown is a single chain flush + delete — clean and atomic
 *   - If the helper crashes, the chain remains and blocks traffic (desired)
 *     and is cleaned up on the next start before creating a new one
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @param tunName   TUN interface name to exempt.
 * @throws          Error if any iptables command fails.
 */
function enableKillSwitchLinux(serverIp: string, tunName: string): void {
  if (killSwitchActive) {
    log('WARN', 'Kill switch already active — skipping enableKillSwitchLinux.')
    return
  }
  log('INFO', `Enabling Linux kill switch. Server: ${serverIp}, TUN: ${tunName}`)

  // Clean up any orphaned chain from a previous crash before creating a new one.
  try { runCmd(`iptables -D OUTPUT -j ${KS_CHAIN}`) } catch { /* not present */ }
  try { runCmd(`iptables -F ${KS_CHAIN}`) }           catch { /* not present */ }
  try { runCmd(`iptables -X ${KS_CHAIN}`) }           catch { /* not present */ }

  runCmd(`iptables -N ${KS_CHAIN}`)

  // Allow rules must be inserted BEFORE the DROP catch-all at the end.
  runCmd(`iptables -A ${KS_CHAIN} -d ${serverIp} -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -o ${tunName} -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -o lo -j ACCEPT`)
  runCmd(`iptables -A ${KS_CHAIN} -j DROP`)

  // Insert our chain into OUTPUT before any existing rules.
  runCmd(`iptables -I OUTPUT -j ${KS_CHAIN}`)

  killSwitchActive = true
  log('INFO', 'Linux kill switch enabled.')
}

/**
 * Disables the Linux kill switch by removing the CHIBATUNNEL_KS chain from OUTPUT
 * and then flushing and deleting the chain. Safe to call even if never enabled.
 */
function disableKillSwitchLinux(): void {
  log('INFO', 'Disabling Linux kill switch.')
  try { runCmd(`iptables -D OUTPUT -j ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not remove ${KS_CHAIN} from OUTPUT.`, err) }
  try { runCmd(`iptables -F ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not flush ${KS_CHAIN}.`, err) }
  try { runCmd(`iptables -X ${KS_CHAIN}`) }
  catch (err) { log('WARN', `Could not delete ${KS_CHAIN}.`, err) }
  killSwitchActive = false
  log('INFO', 'Linux kill switch disabled.')
}

// ---------------------------------------------------------------------------
// Darwin kill switch (PF)
// ---------------------------------------------------------------------------

/**
 * Enables the Darwin kill switch using PF (Packet Filter).
 * Creates a dedicated anchor that blocks all outbound traffic except:
 *   - Traffic to the V2Ray server IP
 *   - Traffic leaving via the utun interface
 *   - Loopback
 *
 * PF is the native firewall on macOS. We use an anchor to keep our rules
 * isolated from the system's main pf.conf.
 *
 * @param serverIp  IPv4 address of the V2Ray server to exempt.
 * @param tunName   TUN interface name to exempt (e.g., utun9).
 */
function enableKillSwitchDarwin(serverIp: string, tunName: string): void {
  if (killSwitchActive) return

  log('INFO', `Enabling Darwin kill switch (PF). Server: ${serverIp}, TUN: ${tunName}`)

  const pfRules = [
    `set skip on lo0`,
    `block out all`,
    `pass out quick to ${serverIp}`,
    `pass out quick on ${tunName}`,
  ].join('\\n')

  try {
    // 1. Register our anchor in the main ruleset.
    // Without this step, PF will never evaluate the rules inside the anchor.
    execSync(`echo 'anchor "${KS_PF_ANCHOR}"' | pfctl -f -`, { stdio: 'pipe' })

    // 2. Load the actual blocking rules into the anchor.
    execSync(`printf "${pfRules}" | pfctl -a ${KS_PF_ANCHOR} -f -`, { stdio: 'pipe' })

    // 3. Enable PF. If already enabled, pfctl -e might return 1, so we handle it.
    try { runCmd('pfctl -e') } catch (e) { log('INFO', 'PF already enabled or started.') }

    killSwitchActive = true
    log('INFO', 'Darwin kill switch enabled.')
  } catch (err) {
    log('ERROR', 'Failed to enable PF kill switch.', err)
    throw err
  }
}

/**
 * Disables the Darwin kill switch by flushing our PF anchor and
 * reloading the default system ruleset to remove our anchor reference.
 */
function disableKillSwitchDarwin(): void {
  log('INFO', 'Disabling Darwin kill switch.')
  try {
    // Flush the rules in our anchor.
    runCmd(`pfctl -a ${KS_PF_ANCHOR} -F all`)
    // Restore the default system ruleset (usually /etc/pf.conf) to
    // remove the 'anchor com.chibatunnel.ks' reference from the main ruleset.
    runCmd('pfctl -f /etc/pf.conf')
  } catch (err) {
    log('WARN', `Could not teardown PF cleanly: ${err}`)
  }
  killSwitchActive = false
}

// ---------------------------------------------------------------------------
// Platform-agnostic kill switch dispatch
// ---------------------------------------------------------------------------

/**
 * Enables the kill switch for the current platform. Dispatches to the
 * platform-specific implementation.
 *
 * @param serverIp  V2Ray server IP to exempt.
 * @param tunName   TUN interface name to exempt (Linux only).
 */
function enableKillSwitch(serverIp: string, tunName: string): void {
  if (PLATFORM === 'win32') enableKillSwitchWindows(serverIp)
  else if (PLATFORM === 'linux') enableKillSwitchLinux(serverIp, tunName)
  else if (PLATFORM === 'darwin') enableKillSwitchDarwin(serverIp, tunName)
  else log('WARN', `Kill switch not implemented for platform: ${PLATFORM}`)
}

/**
 * Disables the kill switch for the current platform.
 */
function disableKillSwitch(): void {
  if (PLATFORM === 'win32') disableKillSwitchWindows()
  else if (PLATFORM === 'linux') disableKillSwitchLinux()
  else if (PLATFORM === 'darwin') disableKillSwitchDarwin()
  else log('WARN', `Kill switch teardown not implemented for platform: ${PLATFORM}`)
}

// ---------------------------------------------------------------------------
// Platform handlers — Windows
// ---------------------------------------------------------------------------

/**
 * Windows implementation of start-transparent. Sets up the Wintun/tun2socks
 * transparent proxy by:
 *   1. Detecting the real default gateway.
 *   2. Adding a bypass route for the V2Ray server IP.
 *   3. Spawning tun2socks (stdio:'ignore' — critical, prevents handle leak).
 *   4. Waiting for the Wintun adapter to appear.
 *   5. Assigning IP/DNS to the adapter via netsh.
 *   6. Getting the adapter's interface index.
 *   7. Adding 0/1 + 128/1 default routes through the TUN.
 *   8. Enabling the kill switch if requested.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentWindows(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  let bypassRouteAdded = false

  try {
    const gateway = detectGatewayWindows()
    if (!gateway) throw new Error('Could not detect the default gateway.')
    log('INFO', `Gateway: ${gateway}`)

    runCmd(`route add ${serverIp} mask 255.255.255.255 ${gateway} METRIC 1`)
    bypassRouteAdded = true

    // stdio:'ignore' is critical — any inherited handle keeps the TCP connection
    // alive from the OS perspective, causing Electron's sendToHelper() to hang.
    const child = spawn(
      tun2socksPath,
      ['-device', `tun://${WIN_TUN_NAME}`, '-proxy', `socks5://127.0.0.1:${socksPort}`],
      { stdio: 'ignore', detached: false },
    )

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 400)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed to start: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediately (code ${c ?? '?'}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid}`)
    child.on('exit', (code, sig) => { log('WARN', 'tun2socks exited.', { code, sig }); activeTun2Socks = null })

    const ready = await waitForInterface(WIN_TUN_NAME)
    if (!ready) throw new Error(`Wintun adapter "${WIN_TUN_NAME}" did not appear. Check wintun.dll.`)

    runCmd(`netsh interface ipv4 set address name="${WIN_TUN_NAME}" static ${WIN_TUN_ADDRESS} ${WIN_TUN_NETMASK} none`)
    runCmd(`netsh interface ipv4 set dnsservers name="${WIN_TUN_NAME}" static address=${WIN_TUN_DNS} register=none validate=no`)

    const ifIdx = getTunIndexWindows(WIN_TUN_NAME)
    if (ifIdx === null) throw new Error(`Could not get interface index for "${WIN_TUN_NAME}".`)

    runCmd(`route add 0.0.0.0 mask 128.0.0.0 ${WIN_TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)
    runCmd(`route add 128.0.0.0 mask 128.0.0.0 ${WIN_TUN_ADDRESS} METRIC 2 IF ${ifIdx}`)

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, WIN_TUN_NAME)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Windows start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded) removeRoutesWindows(serverIp)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Windows implementation of stop-transparent.
 * Disables kill switch → kills tun2socks → removes routes.
 * Order matters: kill switch is removed first so the user regains internet
 * access even if subsequent cleanup steps fail.
 *
 * @param socket  Connected client socket for sending the response.
 */
function stopTransparentWindows(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`) }
    catch (err) {
      log('WARN', 'kill() failed, trying taskkill.', err)
      try { execSync('taskkill /f /im tun2socks.exe', { stdio: 'pipe' }) }
      catch { log('WARN', 'taskkill also failed.') }
    }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesWindows(activeServerIp); activeServerIp = null }
}

// ---------------------------------------------------------------------------
// Platform handlers — Linux
// ---------------------------------------------------------------------------

/**
 * Linux implementation of start-transparent. Sets up a kernel TUN device and
 * tun2socks transparent proxy by:
 *   1. Detecting the default gateway and outbound interface.
 *   2. Creating and configuring the TUN device (ip tuntap / ip addr / ip link).
 *   3. Adding a bypass route for the V2Ray server IP.
 *   4. Spawning tun2socks.
 *   5. Waiting for the TUN device to appear in /sys/class/net.
 *   6. Adding 0/1 + 128/1 default routes through the TUN.
 *   7. Enabling the kill switch if requested.
 *
 * On Linux the TUN device is created by the helper (ip tuntap) before spawning
 * tun2socks, unlike Windows where Wintun is created by tun2socks itself.
 *
 * @param socket   Connected client socket.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentLinux(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  const tunName = LIN_TUN_NAME
  let tunCreated = false
  let bypassRouteAdded = false

  try {
    const gw = detectGatewayLinux()
    if (!gw) throw new Error('Could not detect the default gateway on Linux.')
    const { gateway, iface } = gw
    log('INFO', `Gateway: ${gateway} via ${iface}`)

    // Create TUN device before spawning tun2socks (Linux requires this order).
    runCmd(`ip tuntap add dev ${tunName} mode tun`)
    runCmd(`ip addr add ${LIN_TUN_CIDR} dev ${tunName}`)
    runCmd(`ip link set dev ${tunName} up`)
    tunCreated = true
    log('INFO', `TUN device ${tunName} created and brought up.`)

    // Bypass route for V2Ray server — must exist before the 0/1 routes.
    runCmd(`ip route add ${serverIp} via ${gateway} dev ${iface}`)
    bypassRouteAdded = true

    // stdio:'ignore' — same reason as Windows: no inherited handles.
    const child = spawn(
      tun2socksPath,
      ['-device', `tun://${tunName}`, '-proxy', `socks5://127.0.0.1:${socksPort}`],
      { stdio: 'ignore', detached: false },
    )

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 400)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediately (code ${c ?? '?'}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid}`)
    child.on('exit', (code, sig) => { log('WARN', 'tun2socks exited.', { code, sig }); activeTun2Socks = null })

    const ready = await waitForInterface(tunName)
    if (!ready) throw new Error(`TUN device "${tunName}" did not appear in /sys/class/net.`)

    runCmd(`ip route add 0.0.0.0/1 dev ${tunName}`)
    runCmd(`ip route add 128.0.0.0/1 dev ${tunName}`)
    log('INFO', 'Default routes via TUN added. Transparent mode active.')

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, tunName)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Linux start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded || tunCreated) removeRoutesLinux(serverIp, tunName)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Linux implementation of stop-transparent.
 *
 * @param socket  Connected client socket.
 */
function stopTransparentLinux(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', `tun2socks (PID ${activeTun2Socks.pid}) killed.`) }
    catch (err) { log('WARN', 'Failed to kill tun2socks.', err) }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesLinux(activeServerIp, LIN_TUN_NAME); activeServerIp = null }
}

// ---------------------------------------------------------------------------
// Platform handlers — Darwin
// ---------------------------------------------------------------------------

/**
 * Darwin (macOS) implementation of start-transparent.
 *
 * @param socket   Connected client socket.
 * @param payload  Validated StartTransparentPayload.
 */
async function startTransparentDarwin(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  const { tun2socksPath, socksPort, serverIp, killSwitch = false } = payload
  const tunName = DAR_TUN_NAME
  let bypassRouteAdded = false

  try {
    const gateway = detectGatewayDarwin()
    if (!gateway) throw new Error('Could not detect the default gateway on macOS.')
    log('INFO', `Gateway: ${gateway}`)

    // Bypass route for V2Ray server.
    runCmd(`route add ${serverIp} ${gateway}`)
    bypassRouteAdded = true

    // tun2socks on macOS using utun.
    const child = spawn(
      tun2socksPath,
      ['-device', `${tunName}`, '-proxy', `socks5://127.0.0.1:${socksPort}`],
      { stdio: 'ignore', detached: false },
    )

    await new Promise<void>((resolve, reject) => {
      const w = setTimeout(resolve, 500)
      child.once('error', (e) => { clearTimeout(w); reject(new Error(`tun2socks failed: ${e.message}`)) })
      child.once('exit',  (c) => { clearTimeout(w); reject(new Error(`tun2socks exited immediate (code ${c}).`)) })
    })

    activeTun2Socks = child
    log('INFO', `tun2socks PID ${child.pid} on ${tunName}`)

    const ready = await waitForInterface(tunName)
    if (!ready) throw new Error(`utun interface "${tunName}" did not appear.`)

    // Configure the utun interface.
    runCmd(`ifconfig ${tunName} ${DAR_TUN_ADDRESS} ${DAR_TUN_ADDRESS} netmask 255.255.255.0 up`)

    // Redirect all traffic.
    runCmd(`route add 0.0.0.0/1 -interface ${tunName}`)
    runCmd(`route add 128.0.0.0/1 -interface ${tunName}`)

    activeServerIp = serverIp
    if (killSwitch) enableKillSwitch(serverIp, tunName)

    sendResponse(socket, { status: 'ok', pid: child.pid })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', 'Darwin start-transparent failed. Rolling back.', { message })
    if (killSwitchActive) disableKillSwitch()
    if (activeTun2Socks) { try { activeTun2Socks.kill() } catch { /* best effort */ }; activeTun2Socks = null }
    if (bypassRouteAdded) removeRoutesDarwin(serverIp)
    activeServerIp = null
    sendResponse(socket, { status: 'error', error: message })
  }
}

/**
 * Darwin implementation of stop-transparent.
 *
 * @param socket  Connected client socket.
 */
function stopTransparentDarwin(socket: net.Socket): void {
  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill(); log('INFO', 'tun2socks killed.') }
    catch (err) { log('WARN', 'Failed to kill tun2socks.', err) }
    activeTun2Socks = null
  }

  if (activeServerIp) { removeRoutesDarwin(activeServerIp); activeServerIp = null }
}

// ---------------------------------------------------------------------------
// Command handlers (platform-agnostic entry points)
// ---------------------------------------------------------------------------

/** Handles 'ping'. @param socket Connected client socket. */
function handlePing(socket: net.Socket): void {
  log('INFO', 'Ping received — sending pong.')
  sendResponse(socket, { status: 'pong' })
}

/**
 * Handles 'start-transparent'. Dispatches to the platform implementation.
 * If the platform is unsupported, responds with an error immediately.
 *
 * @param socket   Connected client socket.
 * @param payload  Validated StartTransparentPayload.
 */
async function handleStartTransparent(
  socket:  net.Socket,
  payload: StartTransparentPayload,
): Promise<void> {
  if (activeTun2Socks !== null) {
    sendResponse(socket, { status: 'error', error: 'Transparent mode already active. Send stop-transparent first.' })
    return
  }

  if (PLATFORM === 'win32')        await startTransparentWindows(socket, payload)
  else if (PLATFORM === 'linux')   await startTransparentLinux(socket, payload)
  else if (PLATFORM === 'darwin')  await startTransparentDarwin(socket, payload)
  else sendResponse(socket, { status: 'error', error: `start-transparent not implemented for platform: ${PLATFORM}` })
}

/**
 * Handles 'stop-transparent'. Dispatches to the platform implementation.
 * Idempotent — calling when nothing is active returns ok.
 *
 * @param socket  Connected client socket.
 */
function handleStopTransparent(socket: net.Socket): void {
  if (activeTun2Socks === null && !killSwitchActive && activeServerIp === null) {
    log('INFO', 'stop-transparent called but nothing is active.')
    sendResponse(socket, { status: 'ok' })
    return
  }

  log('INFO', 'Stopping transparent mode.')

  if (PLATFORM === 'win32')       stopTransparentWindows(socket)
  else if (PLATFORM === 'linux')  stopTransparentLinux(socket)
  else if (PLATFORM === 'darwin') stopTransparentDarwin(socket)
  else { sendResponse(socket, { status: 'error', error: `stop-transparent not implemented for: ${PLATFORM}` }); return }

  log('INFO', 'Transparent mode stopped.')
  sendResponse(socket, { status: 'ok' })
}

/**
 * Handles 'set-kill-switch'. Enables or disables the kill switch at runtime
 * without requiring a full reconnect. Enabling requires transparent mode to
 * be active (we need activeServerIp for the allow rules).
 *
 * @param socket   Connected client socket.
 * @param payload  Validated SetKillSwitchPayload.
 */
function handleSetKillSwitch(socket: net.Socket, payload: SetKillSwitchPayload): void {
  if (payload.enabled) {
    if (activeServerIp === null) {
      sendResponse(socket, { status: 'error', error: 'Cannot enable kill switch: transparent mode is not active.' })
      return
    }
    try {
      let tunName = ''
      if (PLATFORM === 'win32')       tunName = WIN_TUN_NAME
      else if (PLATFORM === 'linux')  tunName = LIN_TUN_NAME
      else if (PLATFORM === 'darwin') tunName = DAR_TUN_NAME

      enableKillSwitch(activeServerIp, tunName)
      sendResponse(socket, { status: 'ok' })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log('ERROR', 'enableKillSwitch failed.', { message })
      sendResponse(socket, { status: 'error', error: message })
    }
  } else {
    disableKillSwitch()
    sendResponse(socket, { status: 'ok' })
  }
}

/**
 * Handles the 'wg-up' command. Brings up a WireGuard tunnel with elevated
 * privileges. The implementation differs by platform:
 *
 *   Windows: runs `wireguard.exe /installtunnelservice <configFile>`.
 *            wireguard.exe installs the tunnel as a Windows service under its
 *            own service manager — no UAC prompt needed because this helper
 *            already runs as SYSTEM via Task Scheduler.
 *
 *   Linux:   runs `wg-quick up <configFile>` as root.
 *            If the command fails with a DNS-related error, the response
 *            includes { isDnsError: true } so Electron can offer the user
 *            the option to retry with a patched config (DNS injection removed).
 *
 * The helper does NOT handle the DNS retry logic — that involves a UI dialog
 * and config file patching that belong in Electron. The helper simply reports
 * the error type and waits for Electron to call wg-up again with a fixed config.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated WgUpPayload.
 */
function handleQuickTunnelUp(
  socket: net.Socket,
  payload: WgUpPayload,
  spec: QuickTunnelSpec
): void {
  const { configFile, wgPath } = payload

  try {
    if (PLATFORM === 'win32') {
      const exe = wgPath || spec.windowsExecutable
      // /installtunnelservice takes the full config file path.
      // wireguard.exe derives the tunnel/service name from the filename.
      runFile(exe, ['/installtunnelservice', configFile])
      sendResponse(socket, { status: 'ok' })

    } else if (PLATFORM === 'linux' || PLATFORM === 'darwin') {
      const exe = wgPath || spec.unixExecutable
      try {
        runFile(exe, ['up', configFile])
        sendResponse(socket, { status: 'ok' })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const dnsError = isWgDnsError(message)
        log(dnsError ? 'WARN' : 'ERROR', `${spec.unixExecutable} up failed.`, { message, dnsError })
        sendResponse(socket, {
          status: 'error',
          error: message,
          // Signals Electron to show the DNS retry dialog.
          isDnsError: dnsError,
        })
      }

    } else {
      sendResponse(socket, {
        status: 'error',
        error: `${spec.commandPrefix}-up not implemented for platform: ${PLATFORM}`
      })
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', `${spec.commandPrefix}-up failed.`, { message })
    sendResponse(socket, { status: 'error', error: message })
  }
}

function handleWgUp(socket: net.Socket, payload: WgUpPayload): void {
  handleQuickTunnelUp(socket, payload, WIREGUARD_TUNNEL_SPEC)
}

/**
 * Handles the 'wg-down' command. Tears down a WireGuard tunnel.
 *
 *   Windows: runs `wireguard.exe /uninstalltunnelservice <ifName>`.
 *            ifName is derived from the config file basename (without .conf).
 *
 *   Linux/macOS: first checks whether the interface exists.
 *            On Linux uses 'ip link show'. On macOS (Darwin) checks for the
 *            existence of the wg-quick control socket in /var/run/wireguard/.
 *            If the interface is already gone, returns ok immediately.
 *            Otherwise runs `wg-quick down <configFile>`.
 *
 * @param socket   Connected client socket for sending the response.
 * @param payload  Validated WgDownPayload.
 */
function handleQuickTunnelDown(
  socket: net.Socket,
  payload: WgDownPayload,
  spec: QuickTunnelSpec
): void {
  const { configFile, wgPath } = payload
  // Derive the interface / tunnel name from the config filename.
  const ifName = path.basename(configFile, '.conf')

  try {
    if (PLATFORM === 'win32') {
      const exe = wgPath || spec.windowsExecutable
      try {
        runFile(exe, ['/uninstalltunnelservice', ifName])
      } catch (err) {
        // If the tunnel service is already gone (e.g. previous crash), treat
        // it as success — wgDown is always idempotent from Electron's view.
        log('WARN', `${spec.commandPrefix} uninstalltunnelservice failed (may already be gone).`, err)
      }
      sendResponse(socket, { status: 'ok' })

    } else if (PLATFORM === 'linux' || PLATFORM === 'darwin') {
      const exe = wgPath || spec.unixExecutable
      const controlBinary = wgPath
        ? path.join(path.dirname(wgPath), spec.unixControlExecutable)
        : spec.unixControlExecutable

      // Check whether the interface is still up before calling wg-quick down.
      // On Linux 'ip link' is native; on macOS 'wg show' handles logical naming.
      try {
        if (PLATFORM === 'linux') {
          execFileSync('ip', ['link', 'show', ifName], { stdio: 'pipe' })
        } else {
          // Darwin check: use 'wg' command to verify if the logical interface exists.
          // This is more robust than checking for a specific socket file path.
          execFileSync(controlBinary, ['show', ifName], { stdio: 'pipe' })
        }
      } catch {
        log('INFO', `${spec.commandPrefix}-down: interface ${ifName} already absent — nothing to do.`)
        sendResponse(socket, { status: 'ok' })
        return
      }

      try {
        runFile(exe, ['down', configFile])
      } catch (err) {
        log('WARN', `${spec.unixExecutable} down failed.`, err)
        // Still return ok — the interface check above confirmed it is gone
        // or wg-quick cleaned it up partially. Do not leave Electron hanging.
      }
      sendResponse(socket, { status: 'ok' })

    } else {
      sendResponse(socket, {
        status: 'error',
        error: `${spec.commandPrefix}-down not implemented for platform: ${PLATFORM}`
      })
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('ERROR', `${spec.commandPrefix}-down failed.`, { message })
    sendResponse(socket, { status: 'error', error: message })
  }
}

function handleWgDown(socket: net.Socket, payload: WgDownPayload): void {
  handleQuickTunnelDown(socket, payload, WIREGUARD_TUNNEL_SPEC)
}

async function handleHysteria2Start(
  socket: net.Socket,
  payload: Extract<HelperCommand, { command: 'hysteria2-start' }>
): Promise<void> {
  if (activeHysteria2 && activeHysteria2.exitCode === null) {
    sendResponse(socket, { status: 'error', error: 'Hysteria2 is already running' })
    return
  }

  const config = fs.readFileSync(payload.configFile, 'utf8')
  const interfaceMatch = /^  name: "([A-Za-z0-9._-]{1,15})"$/m.exec(config)
  if (!interfaceMatch) {
    sendResponse(socket, {
      status: 'error',
      error: 'Hysteria2 TUN interface is missing from the configuration'
    })
    return
  }
  const interfaceName = interfaceMatch[1]
  const child = spawn(
    payload.hysteria2Path,
    ['client', '-c', payload.configFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  activeHysteria2 = child

  // Drain output without logging it: Hysteria2 configuration contains
  // authentication and obfuscation secrets which must never reach logs.
  child.stdout?.resume()
  child.stderr?.resume()
  child.once('close', () => {
    if (activeHysteria2 === child) activeHysteria2 = null
  })

  const startup = await new Promise<HelperResponse>(resolve => {
    let settled = false
    let poll: NodeJS.Timeout | null = null
    const finish = (response: HelperResponse) => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      resolve(response)
    }
    child.once('error', () => {
      if (activeHysteria2 === child) activeHysteria2 = null
      finish({ status: 'error', error: 'Hysteria2 failed to start' })
    })
    child.once('exit', code => {
      if (activeHysteria2 === child) activeHysteria2 = null
      finish({ status: 'error', error: `Hysteria2 exited during startup (${code ?? 'unknown'})` })
    })
    const deadline = Date.now() + 15_000
    poll = setInterval(() => {
      let interfaceReady = false
      try {
        if (PLATFORM === 'win32') {
          execFileSync('netsh.exe', ['interface', 'show', 'interface', `name=${interfaceName}`], { stdio: 'ignore' })
        } else if (PLATFORM === 'darwin') {
          execFileSync('ifconfig', [interfaceName], { stdio: 'ignore' })
        } else {
          execFileSync('ip', ['link', 'show', interfaceName], { stdio: 'ignore' })
        }
        interfaceReady = true
      } catch {
        interfaceReady = false
      }
      if (interfaceReady && child.exitCode === null && child.pid) {
        finish({ status: 'ok', pid: child.pid })
      } else if (Date.now() >= deadline) {
        finish({
          status: 'error',
          error: 'Hysteria2 started but its TUN interface did not appear'
        })
      }
    }, 250)
    poll.unref()
  })

  if (startup.status !== 'ok' && child.exitCode === null) child.kill('SIGTERM')
  sendResponse(socket, startup)
}

function handleHysteria2Stop(socket: net.Socket): void {
  const child = activeHysteria2
  activeHysteria2 = null
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Idempotent teardown: an already-exited process is considered stopped.
    }
  }
  sendResponse(socket, { status: 'ok' })
}

async function handleOpenVPNStart(
  socket: net.Socket,
  payload: Extract<HelperCommand, { command: 'openvpn-start' }>
): Promise<void> {
  if (activeOpenVPN && activeOpenVPN.exitCode === null) {
    sendResponse(socket, { status: 'error', error: 'OpenVPN is already running' })
    return
  }

  const child = spawn(
    payload.openvpnPath,
    ['--config', payload.configFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  activeOpenVPN = child
  child.once('close', () => {
    if (activeOpenVPN === child) activeOpenVPN = null
  })

  const startup = await new Promise<HelperResponse>(resolve => {
    let settled = false
    let tail = ''
    const deadline = setTimeout(() => {
      finish({ status: 'error', error: 'OpenVPN connection timed out' })
    }, 20_000)
    deadline.unref()
    const finish = (response: HelperResponse) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(response)
    }
    const inspectOutput = (chunk: Buffer) => {
      // Keep only a short in-memory tail to detect readiness. Never log output:
      // paths and certificate diagnostics can disclose sensitive runtime data.
      tail = `${tail}${chunk.toString('utf8')}`.slice(-512)
      if (tail.includes('Initialization Sequence Completed') && child.pid) {
        finish({ status: 'ok', pid: child.pid })
      }
    }
    child.stdout?.on('data', inspectOutput)
    child.stderr?.on('data', inspectOutput)
    child.once('error', () => {
      if (activeOpenVPN === child) activeOpenVPN = null
      finish({ status: 'error', error: 'OpenVPN failed to start' })
    })
    child.once('exit', code => {
      if (activeOpenVPN === child) activeOpenVPN = null
      finish({ status: 'error', error: `OpenVPN exited during startup (${code ?? 'unknown'})` })
    })
  })

  if (startup.status !== 'ok' && child.exitCode === null) child.kill('SIGTERM')
  sendResponse(socket, startup)
}

function handleOpenVPNStop(socket: net.Socket): void {
  const child = activeOpenVPN
  activeOpenVPN = null
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Idempotent teardown.
    }
  }
  sendResponse(socket, { status: 'ok' })
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a parsed command to the appropriate handler. Unknown commands
 * receive an error response immediately so Electron never waits for a timeout.
 *
 * @param socket   Connected client socket.
 * @param command  Parsed HelperCommand.
 */
function processCommand(socket: net.Socket, command: HelperCommand): void {
  log('INFO', `Command: ${command.command}`, command)

  switch (command.command) {
    case 'ping':
      handlePing(socket)
      break

    case 'start-transparent': {
      handleStartTransparent(socket, command).catch((err) => log('ERROR', 'Unhandled error in handleStartTransparent.', err))
      break
    }

    case 'stop-transparent':
      handleStopTransparent(socket)
      break

    case 'set-kill-switch': {
      handleSetKillSwitch(socket, command)
      break
    }

    case 'wg-up': {
      handleWgUp(socket, command)
      break
    }

    case 'wg-down': {
      handleWgDown(socket, command)
      break
    }

    case 'awg-up': {
      handleQuickTunnelUp(
        socket,
        { configFile: command.configFile, wgPath: command.awgPath },
        AMNEZIAWG_TUNNEL_SPEC
      )
      break
    }

    case 'awg-down': {
      handleQuickTunnelDown(
        socket,
        { configFile: command.configFile, wgPath: command.awgPath },
        AMNEZIAWG_TUNNEL_SPEC
      )
      break
    }

    case 'hysteria2-start': {
      handleHysteria2Start(socket, command)
        .catch(() => sendResponse(socket, {
          status: 'error',
          error: 'Unexpected Hysteria2 startup failure'
        }))
      break
    }

    case 'hysteria2-stop':
      handleHysteria2Stop(socket)
      break

    case 'openvpn-start':
      handleOpenVPNStart(socket, command)
        .catch(() => sendResponse(socket, {
          status: 'error',
          error: 'Unexpected OpenVPN startup failure'
        }))
      break

    case 'openvpn-stop':
      handleOpenVPNStop(socket)
      break
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Handles one client connection. Accumulates data in a line buffer and
 * dispatches each complete newline-terminated JSON line as a command.
 *
 * @param socket  net.Socket from the server for this client.
 */
function handleConnection(socket: net.Socket): void {
  const label = `client@${socket.remoteAddress ?? 'pipe'}`
  log('INFO', `New connection: ${label}`)

  let buf = ''
  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let command: HelperCommand
      try {
        command = parseHelperCommand(JSON.parse(trimmed) as unknown)
      } catch (error) {
        sendResponse(socket, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Invalid helper request.'
        })
        continue
      }
      processCommand(socket, command)
    }
  })

  socket.on('end',   ()  => log('INFO',  `${label} disconnected.`))
  socket.on('close', ()  => log('INFO',  `${label} socket closed.`))
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET') log('WARN', `${label} reset by peer.`)
    else log('ERROR', `Socket error from ${label}.`, { code: err.code, message: err.message })
  })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Creates and starts the server. Uses Named Pipe on Windows if --namedpipe
 * was passed, TCP otherwise. On Linux, if the Unix socket file already exists
 * from a previous crash, it is removed before binding (TCP has no such issue).
 *
 * @returns Running net.Server instance.
 */
function createServer(): net.Server {
  const server = net.createServer({ allowHalfOpen: false })
  server.maxConnections = MAX_CONNECTIONS
  server.on('connection', handleConnection)
  server.on('error', (err: NodeJS.ErrnoException) => {
    log('ERROR', 'Server error.', { code: err.code, message: err.message })
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') { log('ERROR', 'Fatal bind error — exiting.'); process.exit(1) }
  })

  if (PLATFORM === 'win32' && USE_NAMED_PIPE) {
    server.listen(PIPE_PATH, () => log('INFO', `Named Pipe listening on ${PIPE_PATH}`))
  } else {
    server.listen(HELPER_PORT, HELPER_HOST, () => {
      log('INFO', `TCP listening on ${HELPER_HOST}:${HELPER_PORT}`)
      log('INFO', `Platform: ${PLATFORM} | Mode: ${IS_SERVICE_MODE ? 'service' : 'standalone (dev)'}`)
    })
  }

  return server
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Graceful shutdown. Always: disable kill switch → kill tun2socks → remove
 * routes → close server. The kill switch is disabled first so the user regains
 * internet access regardless of whether subsequent steps succeed.
 *
 * @param server  Running net.Server to close.
 * @param reason  Short label for why shutdown was triggered.
 */
function shutdown(server: net.Server, reason: string): void {
  log('INFO', `Shutdown: ${reason}`)

  if (killSwitchActive) disableKillSwitch()

  if (activeTun2Socks) {
    try { activeTun2Socks.kill() } catch { /* best effort */ }
    activeTun2Socks = null
  }

  if (activeHysteria2) {
    try { activeHysteria2.kill('SIGTERM') } catch { /* best effort */ }
    activeHysteria2 = null
  }

  if (activeOpenVPN) {
    try { activeOpenVPN.kill('SIGTERM') } catch { /* best effort */ }
    activeOpenVPN = null
  }

  if (activeServerIp) {
    if (PLATFORM === 'win32') removeRoutesWindows(activeServerIp)
    else if (PLATFORM === 'linux') removeRoutesLinux(activeServerIp, LIN_TUN_NAME)
    else if (PLATFORM === 'darwin') removeRoutesDarwin(activeServerIp)
    activeServerIp = null
  }

  server.close(() => { log('INFO', 'Server closed. Exiting.'); process.exit(0) })
  setTimeout(() => { log('WARN', 'Shutdown timed out — force-exiting.'); process.exit(1) }, 5000).unref()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Creates the server and registers OS signal handlers.
 *
 *   SIGTERM   Windows SCM stop / systemd stop.
 *   SIGBREAK  Windows Ctrl+Break.
 *   SIGINT    Ctrl+C in dev mode.
 */
function main(): void {
  log('INFO', 'ChibaTunnel Helper starting...')
  const server = createServer()

  process.on('SIGTERM',  () => shutdown(server, 'SIGTERM'))
  process.on('SIGBREAK', () => shutdown(server, 'SIGBREAK'))
  process.on('SIGINT',   () => shutdown(server, 'SIGINT'))

  process.on('uncaughtException', (err: Error) => {
    log('ERROR', 'Uncaught exception — keeping service alive.', { message: err.message, stack: err.stack })
    // Not exiting: a bug in one handler must not crash the service and leave
    // the kill switch or routes in an unclean state.
  })
  process.on('unhandledRejection', (reason: unknown) => {
    log('ERROR', 'Unhandled promise rejection.', { reason })
  })
}

main()
