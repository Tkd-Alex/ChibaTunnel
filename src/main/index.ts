import { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import {
  SentinelClient,
  SigningSentinelClient,
  nodeInfo,
  handshake,
  NodeEventCreateSession,
  NodeVPNType,
  V2Ray,
  Wireguard,
  searchEvent,
  nodeStartSession,
  sessionCancel,
  privKeyFromMnemonic,
  Session,
  BaseSession,
  type TxNodeStartSession,
  type Price,
  Plan,
  Subscription,
  Status,
  subscriptionStart,
  subscriptionStartSession,
  RenewalPricePolicy,
  SubscriptionEventCreateSession,
  PageRequest
} from '@sentinel-official/sentinel-js-sdk'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate'
import { fromBech32 } from '@cosmjs/encoding'
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx'
import Long from 'long'
import QRCode from 'qrcode'
import { execFile, spawn, spawnSync, execSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as dns from 'dns'
import * as crypto from 'crypto'

import { verifyHelper, sendToHelper } from './helper-client'
import pkg from '../../package.json'

let pendingDeepLink: string | null = null

function parseDeepLink(url: string): {
  nodeAddress: string
  subscriptionType: 'gigabytes' | 'hours'
  amount: number
} | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'connect') return null
    const nodeAddress = parsed.searchParams.get('node')
    if (!nodeAddress || !nodeAddress.startsWith('sentnode')) return null
    const type = parsed.searchParams.get('type')
    const subscriptionType: 'gigabytes' | 'hours' = type === 'hours' ? 'hours' : 'gigabytes'
    const amountRaw = parseInt(parsed.searchParams.get('amount') ?? '1', 10)
    const amount = isNaN(amountRaw) || amountRaw < 1 ? 1 : amountRaw
    return { nodeAddress, subscriptionType, amount }
  } catch { return null }
}

function parseAndSendDeepLink(url: string): void {
  const args = parseDeepLink(url)
  if (args) mainWindow?.webContents.send('deeplink:connect', args)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const url = argv.find(a => a.startsWith('chibatun://'))
  if (!url) return
  if (mainWindow) parseAndSendDeepLink(url)
  else pendingDeepLink = url
})

// ── Project Configuration ─────────────────────────────────────────────────────
const PROJECT_WALLET_ADDRESS = process.env.PROJECT_WALLET_ADDRESS || 'sent1ppkl...zq7k0v' // Default dev address
const PROJECT_DONATION_MEMO  = process.env.PROJECT_DONATION_MEMO  || `${pkg.name} (Donation)`

// ── GasPrice shim ────────────────────────────────────────────────────────────
function makeGasPrice(str: string): unknown {
  const sdkDir = require.resolve('@sentinel-official/sentinel-js-sdk').replace(/[/\\]dist[/\\].*/, '')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GasPrice } = require(sdkDir + '/node_modules/@cosmjs/stargate')
  return GasPrice.fromString(str)
}

const STORE_KEY_BINARIES = 'binaryPaths'

// ---------------------------------------------------------------------------
// Install guide messages shown in the UI when wireguard-tools is not found.
// Keeps the guide strings centralised here so the UI just reads the result.
// ---------------------------------------------------------------------------
const WIREGUARD_GUIDES: Record<string, string> = {
  win32:
    'wireguard.exe is missing from the application resources. ' +
    'Please reinstall ChibaTunnel.',

  darwin:
    'wireguard-tools is required for WireGuard mode. Install it with:\n\n' +
    '  brew install wireguard-tools\n\n' +
    'Then restart ChibaTunnel.',

  linux_appimage:
    'wireguard-tools is required for WireGuard mode. ' +
    'Install it with your package manager:\n\n' +
    '  Ubuntu/Debian:  sudo apt install wireguard-tools\n' +
    '  Fedora/RHEL:    sudo dnf install wireguard-tools\n' +
    '  Arch:           sudo pacman -S wireguard-tools\n\n' +
    'Then restart ChibaTunnel.',

  linux_package:
    'wireguard-tools was removed from your system. Reinstall it:\n\n' +
    '  Ubuntu/Debian:  sudo apt install wireguard-tools\n' +
    '  Fedora/RHEL:    sudo dnf install wireguard-tools\n' +
    '  Arch:           sudo pacman -S wireguard-tools',
}

// ── RPC list ─────────────────────────────────────────────────────────────────
export const RPC_LIST = [
  { label: 'Sentinel Official',            url: 'https://rpc.sentinel.co:443',           region: 'Global' },
  { label: 'Busurnode (Global)',           url: 'https://rpc-sentinel.busurnode.com:443',     region: 'NA/EU/AS' },
  { label: 'Sentinel Growth DAO (Global)', url: 'https://rpc.sentineldao.com:443',            region: 'NA/EU/AS' },
  { label: 'PublicNode',                   url: 'https://sentinel-rpc.publicnode.com:443',    region: 'NA/EU' },
  { label: 'MathNodes (Global)',           url: 'https://rpc.mathnodes.com:443',              region: 'NA/EU' },
  { label: 'Busurnode (NA)',               url: 'https://na-rpc-sentinel.busurnode.com:443',  region: 'NA' },
  { label: 'Sentinel DAO (NA)',            url: 'https://na-rpc.sentineldao.com:443',         region: 'NA' },
  { label: 'Busurnode (EU)',               url: 'https://eu-rpc-sentinel.busurnode.com:443',  region: 'EU' },
  { label: 'Busurnode (AS)',               url: 'https://as-rpc-sentinel.busurnode.com:443',  region: 'AS' },
  { label: 'Sentinel DAO (AS)',            url: 'https://as-rpc.sentineldao.com:443',         region: 'AS' },
  { label: 'Sentinel DAO (EU)',            url: 'https://eu-rpc.sentineldao.com:443',         region: 'EU' },
  { label: 'MathNodes (US)',               url: 'https://rpc.sentinel.noncompliance.org:443', region: 'US' },
  { label: 'Trinity Stake',               url: 'https://rpc.trinitystake.io:443',            region: 'NA' },
  { label: 'Polkachu',                    url: 'https://sentinel-rpc.polkachu.com:443',      region: 'EU' },
  { label: 'Quokka Stake',               url: 'https://rpc.sentinel.quokkastake.io:443',    region: 'EU' },
  { label: 'SuchNode',                    url: 'https://rpc.sentinel.suchnode.net:443',      region: 'EU' },
  { label: 'RoomIT',                      url: 'https://rpc.dvpn.roomit.xyz:443',            region: 'EU' },
  { label: 'MathNodes (RO)',              url: 'https://rpc.ro.mathnodes.com:443',           region: 'EU' },
]

// ── DoH resolvers ────────────────────────────────────────────────────────────
export const DOH_LIST = [
  { label: 'System Default',  ip: null },
  { label: 'Cloudflare',      ip: '1.1.1.1' },
  { label: 'Cloudflare WARP', ip: '1.0.0.1' },
  { label: 'Google',          ip: '8.8.8.8' },
  { label: 'Quad9',           ip: '9.9.9.9' },
  { label: 'NextDNS',         ip: '45.90.28.0' },
]

const DEFAULT_RPC        = RPC_LIST[0].url
const STORE_KEY_RPC      = 'selected_rpc'
const STORE_KEY_WALLETS  = 'wallets'
const STORE_KEY_ACTIVE_W = 'active_wallet'
const STORE_KEY_SETTINGS = 'settings'
// const STORE_KEY_BINARIES = 'custom_binaries'
const NODES_API          = 'https://api.sentnodes.com/v2/nodes'
const RPC_TIMEOUT_MS     = 10_000
const PAGINATION_LIMIT   = 250

const MEMO = 'ChibaTunnel (Sentinel dVPN Desktop Client)'

// ── Defaults ──────────────────────────────────────────────────────────────────
interface AppSettings {
  killSwitch:     boolean
  autoReconnect:  boolean
  splitTunnel:    boolean
  splitRoutes:    string
  dohIp:          string | null
  hideSupportOption: boolean
}
const DEFAULT_SETTINGS: AppSettings = {
  killSwitch:    false,
  autoReconnect: true,
  splitTunnel:   false,
  splitRoutes:   '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  dohIp:         null,
  hideSupportOption: false,
}

const store = new Store({ name: 'chibatunnel' })

// Cache for wallet addresses (encrypted mnemonic -> address)
const addressCache: Record<string, string> = {}

let mainWindow: BrowserWindow | null = null

let walletState: {
  address: string | null
  label: string
  privkey: Uint8Array | null
  client: SigningSentinelClient | null
  readonlyClient: SentinelClient | null
  rpc: string
} = { address: null, label: '', privkey: null, client: null, readonlyClient: null, rpc: DEFAULT_RPC }

let activeWgInstance:   Wireguard | null = null
let activeWgConfigFile: string | null    = null
let activeV2Ray:        V2Ray | null     = null
let activeTun2Socks:    number | null = null
let activeTunInterface: string | null    = null
let activeV2RayServerIp: string | null    = null
let activeSessionId:    string | null    = null
let activeNodeAddress:  string | null    = null
let wasConnected:       boolean          = false
let connectInProgress:  boolean          = false

let trafficInterval: ReturnType<typeof setInterval> | null = null

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let lastConnectArgs: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number } | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700,
    show: false, autoHideMenuBar: true,
    frame: false, transparent: false, backgroundColor: '#060810',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getBundledBinDir(): string {
  const platformKey = process.platform === 'win32' ? 'win'
                    : process.platform === 'darwin' ? 'mac'
                    : 'linux'

  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', 'build', 'bins', platformKey)
}

function ensureBinariesUnquarantined(): void {
  if (process.platform !== 'darwin') return
  const binDir = getBundledBinDir()
  if (!fs.existsSync(binDir)) return

  try {
    // Run recursively to clear quarantine from the directory and all bundled binaries.
    // This allows them to be executed without a "Developer cannot be verified" dialog.
    execSync(`xattr -rd com.apple.quarantine "${binDir}"`, { stdio: 'pipe' })
    console.log(`[Gatekeeper] Automatically removed quarantine from ${binDir}`)
  } catch {
    // xattr fails if the attribute is not present, which is expected on subsequent runs.
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.chibatunnel')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  registerIpcHandlers()

  ensureBinariesUnquarantined()

  // Verify the helper's IDENTITY, not just that *something* answers on the pipe
  // / port. A bare ping can be answered by a foreign service (e.g. a leftover
  // sentinel-helper.exe squatting on 127.0.0.1:47391). If the responder is not
  // our genuine, protocol-compatible helper we (re)install — which force-creates
  // the ChibaTunnelHelper task and thereby evicts the stale/foreign one.
  const health = await verifyHelper()
  if (!health.ok) {
    if (health.reason === 'foreign') {
      console.warn('[helper] A foreign service answered the helper ping — reinstalling the genuine helper to evict it.')
    } else if (health.reason === 'incompatible') {
      console.warn(`[helper] Helper protocol mismatch (got ${health.protocol ?? 'none'}) — reinstalling to align.`)
    }
    try {
      if (process.platform === 'win32') await installWindowsHelper()
      else if (process.platform === 'linux') await installLinuxHelper()
      else if (process.platform === 'darwin') await installDarwinHelper()
    } catch (e) {
      console.error('Failed to install helper on startup:', e)
    }
  }

  app.setAsDefaultProtocolClient('chibatun')

  // macOS: deeplink arrives via open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (mainWindow) { mainWindow.focus(); parseAndSendDeepLink(url) }
    else pendingDeepLink = url
  })

  // Win/Linux cold start: deeplink is in process.argv
  const coldUrl = process.argv.find(a => a.startsWith('chibatun://'))
  if (coldUrl) pendingDeepLink = coldUrl

  createWindow()
})

app.on('window-all-closed', async () => {
  await killActiveConnections(true)
  if (process.platform !== 'darwin') app.quit()
})

async function installWindowsHelper(): Promise<void> {
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'dist-helper')

  const helperDest = path.join(resourcesPath, 'chibatunnel-helper.exe')
  
  if (!fs.existsSync(helperDest)) {
    throw new Error(`Helper executable not found at: ${helperDest}`)
  }

  // Force stop and remove old task, create new, and run
  const result = await execPrivileged([
    `schtasks /end /tn "ChibaTunnelHelper" *>$null`,
    `schtasks /delete /tn "ChibaTunnelHelper" /f *>$null`,
    `schtasks /create /tn "ChibaTunnelHelper" /tr "\\"${helperDest}\\" --service" /sc onstart /ru SYSTEM /rl HIGHEST /f`,
    `schtasks /run /tn "ChibaTunnelHelper"`
  ])

  if (result.code !== 0) {
    throw new Error(`Windows Helper install failed: ${result.stderr}`)
  }
}

async function installDarwinHelper(): Promise<void> {
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'dist-helper')

  const helperSrc  = path.join(resourcesPath, 'chibatunnel-helper-mac')
  const installDir = '/usr/local/lib/chibatunnel'
  const helperDest = `${installDir}/chibatunnel-helper-mac`
  const plistPath  = '/Library/LaunchDaemons/com.chibatunnel.helper.plist'

  const stamp    = Date.now()
  const tmpBin   = `/tmp/chibatunnel-helper-${stamp}`
  const tmpPlist = `/tmp/chibatunnel-helper-${stamp}.plist`

  fs.copyFileSync(helperSrc, tmpBin)
  fs.chmodSync(tmpBin, 0o755)

  const plistXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    '    <string>com.chibatunnel.helper</string>',
    '    <key>ProgramArguments</key>',
    '    <array>',
    `        <string>${helperDest}</string>`,
    '        <string>--service</string>',
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <true/>',
    '</dict>',
    '</plist>',
  ].join('\n')  // <-- newline, not '\\n'
  fs.writeFileSync(tmpPlist, plistXml, 'utf8')

  try {
    const result = await execPrivileged([
      `mkdir -p ${installDir}`,
      `cp ${tmpBin} ${helperDest}`,
      `chmod 755 ${helperDest}`,
      `cp ${tmpPlist} ${plistPath}`,
      `chmod 644 ${plistPath}`,
      `chown root:wheel ${plistPath}`,
      `launchctl load -w ${plistPath} || true`,
      `launchctl start com.chibatunnel.helper`,
    ])
    if (result.code !== 0) throw new Error(`macOS Helper install failed: ${result.stderr}`)
  } finally {
    try { fs.unlinkSync(tmpBin)   } catch {}
    try { fs.unlinkSync(tmpPlist) } catch {}
  }
}

async function installLinuxHelper(): Promise<void> {
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'dist-helper')

  const helperSrc  = path.join(resourcesPath, 'chibatunnel-helper')
  const installDir = '/usr/local/lib/chibatunnel'
  const helperDest = `${installDir}/chibatunnel-helper`

  const stamp    = Date.now()
  const tmpBin   = `/tmp/chibatunnel-helper-${stamp}`
  const tmpUnit  = `/tmp/chibatunnel-helper-${stamp}.service`

  fs.copyFileSync(helperSrc, tmpBin)
  fs.chmodSync(tmpBin, 0o755)

  const unitContent = [
    '[Unit]',
    'Description=ChibaTunnel Privileged Helper',
    'After=network.target',
    '[Service]',
    'Type=simple',
    `ExecStart=${helperDest} --service`,
    'Restart=on-failure',
    'RestartSec=3s',
    'User=root',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n')
  fs.writeFileSync(tmpUnit, unitContent, 'utf8')

  try {
    const result = await execPrivileged([
      `mkdir -p ${installDir}`,
      `cp ${tmpBin} ${helperDest}`,
      `chmod 755 ${helperDest}`,
      `cp ${tmpUnit} /etc/systemd/system/chibatunnel-helper.service`,
      `systemctl daemon-reload`,
      `systemctl enable chibatunnel-helper`,
      `systemctl start chibatunnel-helper`,
    ])
    if (result.code !== 0) throw new Error(`Linux Helper install failed: ${result.stderr}`)
  } finally {
    try { fs.unlinkSync(tmpBin)  } catch {}
    try { fs.unlinkSync(tmpUnit) } catch {}
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
  ipcMain.handle('window:close', async () => {
    if (activeSessionId) {
      mainWindow?.webContents.send('app:close-request')
      return
    }
    await killActiveConnections(true)
    mainWindow?.close()
  })

  ipcMain.handle('app:quit', async (_e, endSession: boolean) => {
    await killActiveConnections(endSession)
    mainWindow?.close()
  })

  ipcMain.handle('rpc:list', () => RPC_LIST)
  ipcMain.handle('rpc:get',  () => (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC)
  ipcMain.handle('rpc:set', async (_e, url: string) => {
    if (!RPC_LIST.find(r => r.url === url)) return { success: false, error: 'Unknown RPC' }
    store.set(STORE_KEY_RPC, url)
    walletState.rpc = url
    if (walletState.address) {
      const mn = getActiveMnemonic()
      if (mn) return setupWallet(mn, walletState.label, url)
    }
    return { success: true, url }
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const cur = getSettings()
    const next = { ...cur, ...patch }
    store.set(STORE_KEY_SETTINGS, next)
    return { success: true, settings: next }
  })

  ipcMain.handle('binary:check', () => checkBinaries())
  ipcMain.handle('binary:browse', async (_e, name: string) => {
    // Needs a real window to parent the modal dialog. Without one (e.g. headless)
    // showOpenDialog would block indefinitely on an orphan modal.
    if (!mainWindow) return { success: false, error: 'No window available for file dialog' }
    const isWin = process.platform === 'win32'
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Select ${name} executable`,
      filters: isWin ? [{ name: 'Executables', extensions: ['exe'] }] : [],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false }
    const custom = (store.get(STORE_KEY_BINARIES) as Record<string, string>) ?? {}
    custom[name] = filePaths[0]
    store.set(STORE_KEY_BINARIES, custom)
    return { success: true, path: filePaths[0] }
  })
  ipcMain.handle('binary:install', async (_e, cmd: string) => {
    const res = await execPrivileged([cmd])
    if (res.code === 0) return { success: true }
    return { success: false, error: res.stderr }
  })
  ipcMain.handle('helper:repair', async () => {
    try {
      if (process.platform === 'win32') {
        await installWindowsHelper()
      } else if (process.platform === 'linux') {
        await installLinuxHelper()
      } else if (process.platform === 'darwin') {
        await installDarwinHelper()
      }
      return { success: true }
    } catch (err: any) {
      console.error('[helper:repair] Failed to repair helper:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  ipcMain.handle('deeplink:getPending', () => {
    if (!pendingDeepLink) return null
    return parseDeepLink(pendingDeepLink)
  })

  ipcMain.handle('deeplink:clearPending', () => {
    pendingDeepLink = null
  })

  ipcMain.handle('wallet:list', async () => {
    const wallets = getWalletList()
    const active  = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0

    const list = await Promise.all(wallets.map(async (w, i) => {
      if (addressCache[w.encrypted]) {
        return { index: i, label: w.label, active: i === active, address: addressCache[w.encrypted] }
      }

      let address = ''
      const mn = decryptMnemonic(w.encrypted)
      if (mn) {
        try {
          const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mn.trim(), { prefix: 'sent' })
          const [acct] = await wallet.getAccounts()
          address = acct.address
          addressCache[w.encrypted] = address
        } catch (e) { console.error('Failed to get address for wallet', i, e) }
      }
      return { index: i, label: w.label, active: i === active, address }
    }))
    return list
  })

  ipcMain.handle('wallet:add', async (_e, mnemonic: string, label: string) => {
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    const result = await setupWallet(mnemonic, label, rpc)
    if (!result.success) return result
    const wallets = getWalletList()
    const encrypted = encryptMnemonic(mnemonic.trim())
    wallets.push({ label, encrypted })
    store.set(STORE_KEY_WALLETS, wallets)
    store.set(STORE_KEY_ACTIVE_W, wallets.length - 1)
    return { success: true, address: result.address, label, rpc: result.rpc }
  })

  ipcMain.handle('wallet:switch', async (_e, index: number) => {
    const wallets = getWalletList()
    if (index < 0 || index >= wallets.length) return { success: false, error: 'Invalid wallet index' }
    const mn = decryptMnemonic(wallets[index].encrypted)
    if (!mn) return { success: false, error: 'Failed to decrypt wallet' }
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    const result = await setupWallet(mn, wallets[index].label, rpc)
    if (result.success) store.set(STORE_KEY_ACTIVE_W, index)
    return result
  })

  ipcMain.handle('wallet:remove', (_e, index: number) => {
    const wallets = getWalletList()
    if (wallets.length <= 1) return { success: false, error: 'Cannot remove last wallet' }
    wallets.splice(index, 1)
    store.set(STORE_KEY_WALLETS, wallets)
    const active = Math.min((store.get(STORE_KEY_ACTIVE_W) as number) ?? 0, wallets.length - 1)
    store.set(STORE_KEY_ACTIVE_W, active)
    return { success: true }
  })

  ipcMain.handle('wallet:rename', (_e, index: number, label: string) => {
    const wallets = getWalletList()
    if (index < 0 || index >= wallets.length) return { success: false, error: 'Invalid wallet index' }
    wallets[index].label = label
    store.set(STORE_KEY_WALLETS, wallets)
    const active = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0
    if (index === active) {
      mainWindow?.webContents.send('wallet-changed', { label })
    }
    return { success: true }
  })

  ipcMain.handle('wallet:hasMnemonic', () => getWalletList().length > 0)
  ipcMain.handle('wallet:generateMnemonic', async () => {
    try {
      const wallet = await DirectSecp256k1HdWallet.generate(24)
      return { success: true, mnemonic: wallet.mnemonic }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('wallet:setup', async (_e, mnemonic: string, label?: string) => {
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    const result = await setupWallet(mnemonic, label || 'Default', rpc)
    if (result.success) {
      const wallets = getWalletList()
      const encrypted = encryptMnemonic(mnemonic.trim())
      if (encrypted) {
        wallets.push({ label: label || 'Default', encrypted })
        store.set(STORE_KEY_WALLETS, wallets)
        store.set(STORE_KEY_ACTIVE_W, wallets.length - 1)
      }
    }
    return result
  })
  ipcMain.handle('wallet:loadStored', async () => {
    const wallets = getWalletList()
    if (!wallets.length) return { success: false, error: 'No stored wallets' }
    const idx = (store.get(STORE_KEY_ACTIVE_W) as number | undefined) ?? 0
    const w   = wallets[Math.min(idx, wallets.length - 1)]
    const mn  = decryptMnemonic(w.encrypted)
    if (!mn) return { success: false, error: 'Decrypt failed' }
    const rpc = (store.get(STORE_KEY_RPC) as string | undefined) ?? DEFAULT_RPC
    return setupWallet(mn, w.label, rpc)
  })
  ipcMain.handle('wallet:forget', () => {
    store.delete(STORE_KEY_WALLETS); store.delete(STORE_KEY_ACTIVE_W)
    walletState = { address: null, label: '', privkey: null, client: null, readonlyClient: null, rpc: DEFAULT_RPC }
    return { success: true }
  })

  ipcMain.handle('wallet:getBalances', async (_e, addresses: string[]) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client' }
    try {
      const results = await Promise.all(addresses.map(async addr => {
        try {
          const balances = await walletState.readonlyClient!.getAllBalances(addr)
          return { address: addr, balances: balances.map(b => ({ denom: b.denom, amount: b.amount })) }
        } catch { return { address: addr, balances: [] } }
      }))
      return { success: true, results }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('wallet:getInfo', async () => {
    if (!walletState.address || !walletState.readonlyClient) return { success: false, error: 'Wallet not initialized' }
    try {
      const [balances, sessResult] = await Promise.allSettled([
        walletState.readonlyClient.getAllBalances(walletState.address),
        walletState.readonlyClient.sentinelQuery?.session.sessionsForAccount(walletState.address, undefined)
      ])
      const rawSessions = sessResult.status === 'fulfilled' ? (sessResult.value?.sessions ?? []) : []
      const sessions = rawSessions.map(anyVal => {
        try {
          const decoded = Session.decode(anyVal.value)
          const bs = decoded.baseSession
          if (!bs) return null
          return { id: longToNum(bs.id), nodeAddress: bs.nodeAddress ?? '', status: bs.status ?? 0 }
        } catch { return null }
      }).filter(Boolean)
      return {
        success: true, address: walletState.address, label: walletState.label, rpc: walletState.rpc,
        balances: balances.status === 'fulfilled' ? balances.value.map(b => ({ denom: b.denom, amount: b.amount })) : [],
        sessions
      }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('bookmark:list', () => (store.get('bookmarks') as string[] | undefined) ?? [])
  ipcMain.handle('bookmark:toggle', (_e, address: string) => {
    const bms = (store.get('bookmarks') as string[] | undefined) ?? []
    const idx = bms.indexOf(address)
    if (idx === -1) bms.push(address)
    else bms.splice(idx, 1)
    store.set('bookmarks', bms)
    return { bookmarks: bms }
  })

  ipcMain.handle('nodes:fetch', async () => {
    try {
      const res  = await fetch(NODES_API); const json = await res.json() as { data?: unknown[] }
      return { success: true, nodes: json.data ?? [] }
    } catch (err: unknown) { return { success: false, error: String(err), nodes: [] } }
  })

  ipcMain.handle('node:info', async (_e, remoteAddr: string) => {
    try {
      const info = await withTimeout(nodeInfo(remoteAddr), 8000, 'Node info timeout')
      return { success: true, info }
    } catch (err: unknown) { return { success: false, error: extractError(err) } }
  })

  ipcMain.handle('node:fetchByAddress', async (_e, address: string) => {
    try {
      const res = await fetch(`https://api.sentnodes.com/v2/node/${address}`)
      const json = await res.json() as { success?: boolean; data?: unknown }
      if (json.success && json.data) {
        return { success: true, node: json.data }
      }
      return { success: false, error: 'Node not found or API error' }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('sessions:fetch', async () => {
    if (!walletState.readonlyClient || !walletState.address) return { success: false, error: walletState.address ? 'No RPC client' : 'Wallet not loaded', sessions: [] }
    try {
      const sessionsRaw = await queryAllWithPagination(
        (pageReq) => walletState.readonlyClient!.sentinelQuery!.session.sessionsForAccount(
          walletState.address!,
          pageReq
        ),
        (res) => res?.sessions ?? [],
        'sessions:fetch',
        PAGINATION_LIMIT,
        true
      )
      const sessions = sessionsRaw.map(anyVal => {
        try {
          const decoded = Session.decode(anyVal.value); const bs = decoded.baseSession
          if (!bs) return null
          return {
            id: longToNum(bs.id), accAddress: bs.accAddress ?? '', nodeAddress: bs.nodeAddress ?? '',
            downloadBytes: bs.downloadBytes ?? '0', uploadBytes: bs.uploadBytes ?? '0', maxBytes: bs.maxBytes ?? '0',
            status: bs.status ?? 0, inactiveAt: bs.inactiveAt?.toISOString() ?? null, startAt: bs.startAt?.toISOString() ?? null,
            durationSecs: bs.duration ? longToNum(bs.duration.seconds) : 0,
            maxDurationSecs: bs.maxDuration ? longToNum(bs.maxDuration.seconds) : 0,
            price: decoded.price
              ? { denom: decoded.price.denom, baseValue: decoded.price.baseValue, quoteValue: decoded.price.quoteValue }
              : null,
          }
        } catch { return null }
      }).filter(Boolean)
      return { success: true, sessions }
    } catch (err: unknown) { return { success: false, error: extractError(err), sessions: [] } }
  })

  ipcMain.handle('session:cancel', async (_e, sessionId: number) => {
    if (!walletState.client || !walletState.address) return { success: false, error: 'Wallet not initialized' }
    try {
      const msg = sessionCancel({ from: walletState.address, id: Long.fromNumber(sessionId, true) })
      const tx  = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', MEMO)
      assertIsDeliverTxSuccess(tx); return { success: true }
    } catch (err: unknown) { return { success: false, error: extractError(err) } }
  })

  ipcMain.handle('plans:fetch', async () => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client', plans: [] }
    try {
      const plansRaw = await queryAllWithPagination(
        (pageReq) => walletState.readonlyClient!.sentinelQuery!.plan.plans(
          Status.STATUS_UNSPECIFIED,
          pageReq
        ),
        (res) => res?.plans ?? [],
        'plans:fetch'
      )
      const plans = plansRaw.map(p => ({
        id: longToNum(p.id),
        provAddress: p.provAddress,
        bytes: p.bytes,
        duration: p.duration ? longToNum(p.duration.seconds) : 0,
        prices: p.prices.map(price => {
          const rawVal = (price as any).quoteValue || (price as any).amount || (price as any).value || '0'
          return {
            denom: price.denom,
            amount: typeof rawVal === 'object' && rawVal !== null ? rawVal.toString() : String(rawVal)
          }
        }),
        status: p.status,
        private: p.private
      }))
      return { success: true, plans }
    } catch (err: unknown) { return { success: false, error: extractError(err), plans: [] } }
  })

  ipcMain.handle('subscriptions:fetch', async () => {
    if (!walletState.readonlyClient || !walletState.address) return { success: false, error: walletState.address ? 'No RPC client' : 'Wallet not loaded', subscriptions: [] }
    try {
      const subscriptionsRaw = await queryAllWithPagination(
        (pageReq) => walletState.readonlyClient!.sentinelQuery!.subscription.subscriptionsForAccount(
          walletState.address!,
          pageReq
        ),
        (res) => res?.subscriptions ?? [],
        'subscriptions:fetch'
      )
      const subscriptions = subscriptionsRaw.map(s => {
        try {
          return {
            id: longToNum(s.id),
            accAddress: s.accAddress,
            planId: longToNum(s.planId),
            price: s.price ? { denom: s.price.denom, baseValue: s.price.baseValue, quoteValue: s.price.quoteValue } : null,
            status: s.status,
            inactiveAt: s.inactiveAt?.toISOString() ?? null,
            startAt: s.startAt?.toISOString() ?? null,
            renewalPricePolicy: s.renewalPricePolicy
          }
        } catch { return null }
      }).filter(Boolean)
      return { success: true, subscriptions }
    } catch (err: unknown) { return { success: false, error: extractError(err), subscriptions: [] } }
  })

  ipcMain.handle('plan:subscribe', async (_e, { planId, denom, policy }: { planId: number; denom: string; policy: number }) => {
    if (!walletState.client || !walletState.address) return { success: false, error: 'Wallet not initialized' }
    try {
      console.log(`[Plan:Subscribe] Starting sub for Plan #${planId} with denom ${denom} and policy ${policy}`)
      const msg = subscriptionStart({
        from: walletState.address,
        id: Long.fromNumber(planId, true),
        denom: denom,
        renewalPricePolicy: policy
      })
      const tx = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', MEMO)
      assertIsDeliverTxSuccess(tx)
      console.log(`[Plan:Subscribe] Success! TX: ${tx.transactionHash}`)
      return { success: true, txHash: tx.transactionHash }
    } catch (err: unknown) { 
      console.error(`[Plan:Subscribe] Error:`, err)
      return { success: false, error: extractError(err) } 
    }
  })

  ipcMain.handle('plan:nodes', async (_e, planId: number) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client', nodes: [] }
    try {
      const id = Long.fromNumber(planId, true)
      const nodesRaw = await queryAllWithPagination(
        (pageReq) => walletState.readonlyClient!.sentinelQuery!.node.nodesForPlan(
          id,
          Status.STATUS_UNSPECIFIED,
          pageReq
        ),
        (res) => res?.nodes ?? [],
        `plan:nodes#${planId}`
      )

      const nodes = nodesRaw.map(n => ({
        address: n.address,
        moniker: n.address.slice(0, 12) + '...',
        version: (n as any).version || '',
        type: 1, 
        isActive: n.status === Status.STATUS_ACTIVE,
        isHealthy: true,
        country: '??',
        city: '',
        gigabytePrices: n.gigabytePrices.map(p => ({ denom: p.denom, value: p.quoteValue })),
        hourlyPrices: n.hourlyPrices.map(p => ({ denom: p.denom, value: p.quoteValue })),
        sessions: 0,
        peers: 0,
        isResidential: false,
        isWhitelisted: false,
        isDuplicate: false,
        errorMessage: null,
        fetchedAt: new Date().toISOString()
      }))
      return { success: true, nodes }
    } catch (err: unknown) { 
      console.error(`[IPC] Error fetching nodes for plan ${planId}:`, err)
      return { success: false, error: extractError(err), nodes: [] } 
    }
  })

  ipcMain.handle('plans:scanNodes', async (_e, planIds: number[]) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client', nodesMap: {} }
    const nodesMap: Record<number, any[]> = {}
    
    // Concurrency limit: 5 — keep fan-out small to stay under RPC 429 rate limits.
    const CHUNK_SIZE = 5
    const chunks = []
    for (let i = 0; i < planIds.length; i += CHUNK_SIZE) {
      chunks.push(planIds.slice(i, i + CHUNK_SIZE))
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]
      // Pace successive chunks so a large plan set doesn't hammer the endpoint.
      if (ci > 0) await delay(250)
      await Promise.all(chunk.map(async (id) => {
        try {
          const nodesRaw = await queryAllWithPagination(
            (pageReq) => walletState.readonlyClient!.sentinelQuery!.node.nodesForPlan(
              Long.fromNumber(id, true),
              Status.STATUS_UNSPECIFIED,
              pageReq
            ),
            (res) => res?.nodes ?? [],
            `scanNodes#${id}`
          )
          nodesMap[id] = nodesRaw.map(n => ({
            address: n.address,
            moniker: n.address.slice(0, 12) + '...',
            version: (n as any).version || '',
            type: 1, 
            isActive: n.status === Status.STATUS_ACTIVE,
            isHealthy: true,
            country: '??',
            city: '',
            gigabytePrices: n.gigabytePrices.map(p => ({ denom: p.denom, value: p.quoteValue })),
            hourlyPrices: n.hourlyPrices.map(p => ({ denom: p.denom, value: p.quoteValue })),
            sessions: 0,
            peers: 0,
            isResidential: false,
            isWhitelisted: false,
            isDuplicate: false,
            errorMessage: null,
            fetchedAt: new Date().toISOString()
          }))
        } catch (err) {
          console.error(`[IPC] Error scanning plan ${id}:`, err)
          nodesMap[id] = []
        }
      }))
    }
    return { success: true, nodesMap }
  })

  ipcMain.handle('provider:info', async (_e, address: string) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client' }
    try {
      const res = await walletState.readonlyClient.sentinelQuery?.provider.provider(address)
      if (!res) return { success: false, error: 'Provider not found' }
      return { 
        success: true, 
        provider: {
          address: res.address,
          name: res.name,
          identity: res.identity,
          website: res.website,
          description: res.description,
          status: (res as any).status,
          statusAt: (res as any).statusAt?.toISOString()
        } 
      }
    } catch (err: unknown) { return { success: false, error: extractError(err) } }
  })

  ipcMain.handle('providers:fetchBatch', async (_e, addresses: string[]) => {
    if (!walletState.readonlyClient) return { success: false, error: 'No RPC client', providers: {} }
    const providers: Record<string, any> = {}
    
    // Concurrency limit: 10 — providers are simpler reads, but still rate-limited.
    const CHUNK_SIZE = 10
    const chunks = []
    for (let i = 0; i < addresses.length; i += CHUNK_SIZE) {
      chunks.push(addresses.slice(i, i + CHUNK_SIZE))
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]
      if (ci > 0) await delay(200)
      await Promise.all(chunk.map(async (addr) => {
        try {
          const res = await rpcWithRetry(
            () => walletState.readonlyClient!.sentinelQuery?.provider.provider(addr),
            `provider#${addr.slice(0, 12)}`
          )
          if (res) {
            providers[addr] = {
              name: res.name,
              website: res.website,
              description: res.description
            }
          }
        } catch { /* ignore */ }
      }))
    }
    return { success: true, providers }
  })

  ipcMain.handle('subscription:cancel', async (_e, subscriptionId: number) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    try {
      console.log(`[Subscription:Cancel] Cancelling Sub #${subscriptionId}`)
      const msg = {
        typeUrl: '/sentinel.subscription.v3.MsgCancelSubscriptionRequest',
        value: {
          from: walletState.address,
          id: Long.fromNumber(subscriptionId, true)
        }
      }
      const tx = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', MEMO)
      assertIsDeliverTxSuccess(tx)
      console.log(`[Subscription:Cancel] Success! TX: ${tx.transactionHash}`)

      // Proactively disconnect if the active session belongs to this subscription
      if (activeSessionId && walletState.readonlyClient) {
        try {
          const res = await walletState.readonlyClient.sentinelQuery?.session.session(Long.fromString(activeSessionId, true))
          if ((res as any)?.session?.value) {
            const decoded = Session.decode((res as any).session.value)
            // @ts-ignore - subscriptionId exists on subscription.Session but not node.Session
            if (decoded.subscriptionId?.toString() === subscriptionId.toString()) {
              console.log(`[Subscription:Cancel] Active session #${activeSessionId} belongs to cancelled sub. Disconnecting locally...`)
              mainWindow?.webContents.send('vpn:disconnected', { reason: 'subscription_cancelled' })
              await killActiveConnections(false) // false: don't broadcast another sessionCancel
            }
          }
        } catch (e) {
          console.error('[Subscription:Cancel] Failed to check active session against cancelled sub', e)
        }
      }

      return { success: true, txHash: tx.transactionHash }
    } catch (err: unknown) {
      console.error(`[Subscription:Cancel] Error:`, err)
      return { success: false, error: extractError(err) }
    }
  })

  ipcMain.handle('subscription:update', async (_e, { subscriptionId, policy }: { subscriptionId: number; policy: number }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    try {
      console.log(`[Subscription:Update] Updating Sub #${subscriptionId} with policy ${policy}`)
      const msg = {
        typeUrl: '/sentinel.subscription.v3.MsgUpdateSubscriptionRequest',
        value: {
          from: walletState.address,
          id: Long.fromNumber(subscriptionId, true),
          renewalPricePolicy: policy
        }
      }
      const tx = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', MEMO)
      assertIsDeliverTxSuccess(tx)
      console.log(`[Subscription:Update] Success! TX: ${tx.transactionHash}`)
      return { success: true, txHash: tx.transactionHash }
    } catch (err: unknown) {
      console.error(`[Subscription:Update] Error:`, err)
      return { success: false, error: extractError(err) }
    }
  })

  ipcMain.handle('subscription:connect', async (_e, { subscriptionId, nodeAddress }: { subscriptionId: number; nodeAddress: string }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    if (connectInProgress) return { success: false, error: 'A connection is already in progress' }
    connectInProgress = true
    try {
      console.log(`[Subscription:Connect] Starting session with Sub #${subscriptionId} on node ${nodeAddress}`)
      mainWindow?.webContents.send('vpn:status', { step: 'signing_tx' })
      const msg = subscriptionStartSession({
        from: walletState.address,
        id: Long.fromNumber(subscriptionId, true),
        nodeAddress: nodeAddress
      })
      const tx = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', MEMO)
      assertIsDeliverTxSuccess(tx)

      mainWindow?.webContents.send('vpn:status', { step: 'extracting_tx' })
      
      // Parse event using SDK helper
      const event = searchEvent(SubscriptionEventCreateSession.type, tx.events)
      if (!event) {
        return { success: false, error: 'Session creation event not found in transaction' }
      }

      const parsed = SubscriptionEventCreateSession.parse(event)
      const sessionId = parsed.value.sessionId

      activeSessionId = sessionId.toString()
      activeNodeAddress = nodeAddress

      // Handshake with a small retry loop for propagation delay
      let lastErr: any = null
      for (let i = 0; i < 5; i++) {
        try {
          if (i > 0) await new Promise(r => setTimeout(r, 2000))
          console.log(`[Subscription:Connect] Handshake attempt ${i + 1} for Session #${sessionId}`)
          return await doHandshake(nodeAddress, sessionId)
        } catch (err: any) {
          lastErr = err
          const msg = (err.message || '').toLowerCase()
          if (msg.includes('not exist') || msg.includes('404')) {
            console.warn(`[Subscription:Connect] Session not indexed yet, retrying...`)
            continue
          }
          throw err // Other errors fail immediately
        }
      }
      throw lastErr
    } catch (err: unknown) {
      console.error(`[Subscription:Connect] Error:`, err)
      return { success: false, error: extractError(err) }
    } finally {
      connectInProgress = false
    }
  })

  ipcMain.handle('traffic:start', () => {
    startTrafficPolling(); return { success: true }
  })
  ipcMain.handle('traffic:stop', () => {
    if (trafficInterval) { clearInterval(trafficInterval); trafficInterval = null }; return { success: true }
  })

  ipcMain.on('vpn:dns-retry-approved', () => { /* Logic handled via promise in wgQuickUp */ })

  ipcMain.handle('node:connect', async (_e, args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number; donate?: boolean }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    if (connectInProgress) return { success: false, error: 'A connection is already in progress' }
    lastConnectArgs = args; reconnectAttempts = 0; wasConnected = false; return doConnect(args)
  })

  ipcMain.handle('node:connectSession', async (_e, args: { nodeAddress: string; sessionId: number }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
    activeSessionId = args.sessionId.toString(); activeNodeAddress = args.nodeAddress;
    reconnectAttempts = 0; wasConnected = false;
    return doHandshake(args.nodeAddress, Long.fromNumber(args.sessionId, true))
  })

  ipcMain.handle('node:connectWireguard', async () => {
    if (!activeWgConfigFile) return { success: false, error: 'No WireGuard config' }
    const res = await wgQuickUp(activeWgConfigFile)
    if (res.success) wasConnected = true
    return res
  })

  ipcMain.handle('node:connectV2ray', async (_e, { transparent }: { transparent?: boolean } = {}) => {
    if (!activeV2Ray) return { success: false, error: 'No V2Ray session' }
  
    // Resolve the v2ray binary path before attempting to spawn.
    // checkBinaries() looks in: custom store → PATH → resources/bin/ → exe dir.
    // This is the key fix: we no longer rely on the SDK calling spawn('v2ray')
    // which fails silently when 'v2ray' is not in PATH.
    const binaries = checkBinaries()
    if (!binaries.v2rayPath) {
      return {
        success: false,
        error: 'v2ray binary not found. Check resources/bin/ or set a custom path in settings.',
      }
    }
  
    try {
      // spawnV2Ray() writes the config to a temp file (using the SDK's writeConfig)
      // and spawns v2ray with the explicit binary path. Throws if v2ray crashes
      // within the first 500 ms (bad config, missing geo data, port conflict, etc.)
      const { pid } = await spawnV2Ray(activeV2Ray, binaries.v2rayPath)
  
      if (transparent) {
        const result = await setupTransparentV2Ray(activeV2Ray)
        if (!result.success) {
          // Kill v2ray if transparent setup fails so we don't leave a dangling process.
          killV2Ray()
          return result
        }
      }
  
      wasConnected = true
      startTrafficPolling()
      return { success: true, pid }
  
    } catch (err: unknown) {
      // spawnV2Ray throws on immediate crash — the error message includes the
      // exit code and a hint to check the config file. Surface this to the UI.
      killV2Ray() // ensure cleanup even on partial startup
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('node:retryTunnel', async (_e, { transparent }: { transparent?: boolean } = {}) => {
    if (activeWgConfigFile) return wgQuickUp(activeWgConfigFile)
    if (activeV2Ray) {
      try { /* activeV2Ray.disconnect() */ killV2Ray() } catch (_) {}
      try {
        const binaries = checkBinaries()
        const { pid, configFile } = await spawnV2Ray(activeV2Ray, binaries.v2rayPath) 
        // const pid = activeV2Ray.connect()
        if (transparent) {
          const result = await setupTransparentV2Ray(activeV2Ray)
          if (!result.success) return result
        }
        wasConnected = true
        startTrafficPolling()
        return { success: true, pid }
      } catch (err: unknown) { return { success: false, error: String(err) } }
    }
    return { success: false, error: 'No active tunnel instance to retry.' }
  })

  ipcMain.handle('node:disconnect', async () => {
    connectInProgress = false
    await killActiveConnections(false)
    mainWindow?.webContents.send('vpn:disconnected', { reason: 'manual' })
    return { success: true }
  })

  ipcMain.handle('network:getPublicIp', async () => {
    // Multiple providers so a single rate-limit / block / captive portal does not
    // take out IP detection entirely. Each maps its response onto the ipapi.co
    // shape the renderer expects ({ ip, country_name, ... }).
    const providers: Array<{ url: string; map: (j: any) => any }> = [
      // Ordered by reliability of GEO data + tolerance to rate limits. The free tiers
      // of ipapi.co / ipwho.is throttle aggressively (429/403), which would otherwise
      // fall through to ipify (IP only, no location -> empty LOCATION / PROVIDER in the
      // UI). ip-api.com and ipinfo.io return full geo without a key. Each map()
      // normalizes onto the shape the renderer reads: { ip, city, country_name, org, asn }.
      {
        url: 'http://ip-api.com/json/?fields=status,message,query,city,regionName,country,isp,org,as',
        map: j => ({
          ip: j.query,
          city: j.city,
          country_name: j.country,
          region: j.regionName,
          org: j.org || j.isp || '',
          asn: j.as ? String(j.as).split(' ')[0] : ''
        })
      },
      {
        url: 'https://ipinfo.io/json',
        map: j => ({
          ip: j.ip,
          city: j.city,
          country_name: j.country,
          region: j.region,
          org: j.org ? String(j.org).replace(/^AS\d+\s*/, '') : '',
          asn: j.org ? (String(j.org).match(/^AS\d+/)?.[0] || '') : ''
        })
      },
      {
        url: 'https://ipwho.is/',
        map: j => ({
          ip: j.ip,
          city: j.city,
          country_name: j.country,
          region: j.region,
          org: j.connection?.org || j.connection?.isp || '',
          asn: j.connection?.asn ? `AS${j.connection.asn}` : ''
        })
      },
      { url: 'https://ipapi.co/json/', map: j => j },
      { url: 'https://api.ipify.org?format=json', map: j => ({ ip: j.ip }) }
    ]

    const fetchIp = async (url: string, map: (j: any) => any) => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': MEMO,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000)
      })
      // A rate-limited / blocked endpoint (or a captive portal) often replies with
      // a non-JSON body like "Please contact ...". Reading it as JSON would throw
      // an opaque SyntaxError, so guard on status and content type and read text
      // first, then parse explicitly for a clean, actionable error.
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      const body = (await res.text()).trim()
      const looksJson = body.startsWith('{') || body.startsWith('[')
      if (!looksJson) {
        const snippet = body.slice(0, 80)
        throw new Error(`Non-JSON response (likely rate-limited or blocked): ${snippet}`)
      }
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        throw new Error('Invalid JSON in IP service response')
      }
      // ipapi.co signals throttling with { error: true, reason: "RateLimited" }.
      if (parsed && parsed.error) {
        throw new Error(`IP service error: ${parsed.reason || parsed.message || 'unknown'}`)
      }
      // ipwho.is signals failure with { success: false, message }.
      if (parsed && parsed.success === false) {
        throw new Error(`IP service error: ${parsed.message || 'request failed'}`)
      }
      // ip-api.com signals failure with { status: "fail", message }.
      if (parsed && parsed.status === 'fail') {
        throw new Error(`IP service error: ${parsed.message || 'request failed'}`)
      }
      return map(parsed)
    }

    console.log('[Main] Fetching public IP info...')
    let lastErr = 'Unknown error'
    // Retry across providers and routing transitions.
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500 * i))
      for (const { url, map } of providers) {
        try {
          const data = await fetchIp(url, map)
          if (!data?.ip) throw new Error('Response missing ip field')
          console.log(`[Main] IP info fetched successfully via ${url}:`, data.ip)
          return data
        } catch (err: unknown) {
          lastErr = String(err instanceof Error ? err.message : err)
          console.warn(`[Main] IP fetch via ${url} (attempt ${i + 1}) failed:`, lastErr)
        }
      }
    }
    return { error: lastErr }
  })

  ipcMain.handle('killswitch:enable', async () => {
    try {
      // set-kill-switch installs SYSTEM/root firewall rules via the helper — gate it
      // behind helper verification (reinstall once if needed) so we never drive a foreign
      // or missing helper, same contract as wg-up / start-transparent.
      const ready = await ensureHelperReady()
      if (!ready.ready) return { success: false, error: ready.error ?? 'Helper not ready.' }
      await sendToHelper({ command: 'set-kill-switch', enabled: true })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('killswitch:disable', async () => {
    try {
      // Disabling also clears privileged firewall rules through the helper. A foreign
      // squatter must be evicted (the gate reinstalls the genuine helper) before we can
      // actually clear the rules — driving an unverified helper here could leave traffic
      // blocked. Gate it like enable.
      const ready = await ensureHelperReady()
      if (!ready.ready) return { success: false, error: ready.error ?? 'Helper not ready.' }
      await sendToHelper({ command: 'set-kill-switch', enabled: false })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('vpn:status', () => {
    let inbounds: any = null
    if (activeV2Ray?.config?.inbounds) {
      inbounds = activeV2Ray.config.inbounds
        .filter((ib: any) => ib.protocol !== 'dokodemo-door')
        .map((ib: any) => ({ protocol: ib.protocol, listen: ib.listen, port: ib.port }))
    }
    return {
      v2rayActive: isV2RayRunning(),
      v2rayPid: getV2RayPid(),
      wgActive: !!activeWgConfigFile,
      wgInterface: activeWgConfigFile ? path.basename(activeWgConfigFile, '.conf') : null,
      tunActive: activeTun2Socks !== null,
      tunPid: activeTun2Socks,
      tunInterface: activeTunInterface,
      sessionId: activeSessionId,
      nodeAddress: activeNodeAddress,
      inbounds
    }
  })
}

function getNextTunInterface(): string {
  const plat = process.platform
  for (let i = 0; i < 10; i++) {
    const ifName = plat === 'darwin' ? `utun${i}` : `chiba-tun${i}`
    try {
      if (plat === 'darwin') {
        execSync(`ifconfig ${ifName}`, { stdio: 'ignore' })
      } else {
        execSync(`ip link show ${ifName}`, { stdio: 'ignore' })
      }
    } catch {
      return ifName
    }
  }
  return plat === 'darwin' ? 'utun9' : 'chiba-tun9'
}

async function setupTransparentV2Ray(v2ray: V2Ray): Promise<{ success: boolean; error?: string }> {
  const socksPort = v2ray.config.inbounds.find((ib: any) => ib.protocol === 'socks')?.port
  if (!socksPort) return { success: false, error: 'V2Ray SOCKS5 port not found' }

  try {
    const serverAddr = v2ray.config.outbounds.find((ob: any) => ob.protocol === 'vmess' || ob.protocol === 'vless')?.settings?.vnext?.[0]?.address
    if (!serverAddr) return { success: false, error: 'V2Ray server address not found' }

    let serverIp = serverAddr
    if (/[a-zA-Z]/.test(serverAddr)) {
      try {
        const ips = await dns.promises.resolve4(serverAddr)
        if (ips && ips.length > 0) serverIp = ips[0]
      } catch (e) { console.error('DNS resolve failed', e) }
    }
    activeV2RayServerIp = serverIp

    // Gate: start-transparent is a privileged op (the helper brings up tun2socks and,
    // with killSwitch, installs firewall rules at SYSTEM/root). Never hand it to an
    // unverified / foreign / missing helper — verify (and reinstall once) first, exactly
    // as wg-up does. This is the contract ensureHelperReady's own docstring promises.
    const ready = await ensureHelperReady()
    if (!ready.ready) return { success: false, error: ready.error ?? 'Helper not ready.' }

    const binaries = checkBinaries()
    const settings = getSettings()
    const helperResponse = await sendToHelper({
      command: 'start-transparent',
      tun2socksPath: binaries.tun2socksPath!,
      socksPort: socksPort,
      serverIp: activeV2RayServerIp,
      killSwitch: settings.killSwitch
    }, 60_000)

    if (helperResponse.status === "ok") {
      activeTun2Socks = helperResponse.pid as number
      if (process.platform === 'win32') activeTunInterface = 'chiba-tun'
      else if (process.platform === 'darwin') activeTunInterface = 'utun9'
      else activeTunInterface = 'chibatun0'
      return { success: true }
    } else {
      console.error('[setupTransparentV2Ray] Helper failed to start transparent proxy:', helperResponse)
      return { success: false, error: helperResponse.error || 'Unknown helper error' }
    }
  } catch (err: any) {
    console.error('[setupTransparentV2Ray] Exception during transparent proxy setup:', err)
    return { success: false, error: `Transparent setup failed: ${err.message}` }
  }
}

function extractError(err: unknown): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err.replace(/^Error:\s*/i, '')
  
  const e = err as any
  // 1. If it's already a formatted string from our logic (has [handshake], [nodeInfo], etc. or [4xx])
  if (e.message && typeof e.message === 'string' && e.message.match(/\[(handshake|nodeInfo|node|RPC|V2Ray|WireGuard|node:info|sessions)\]|\[\d{3}\]/)) {
    return e.message.replace(/^Error:\s*/i, '')
  }

  // 2. HTTP Response Error (Axios/Fetch-like)
  if (e.response) {
    const status = e.response.status; const data = e.response.data
    if (data) {
      if (typeof data === 'string') return `[${status}] ${data}`
      if (data.error && typeof data.error === 'object' && data.error.message) return `[${status}] ${data.error.message}`
      const msg = data.message || data.error || data.detail
      if (msg && typeof msg === 'string') return `[${status}] ${msg}`
      if (typeof data === 'object') return `[${status}] ${JSON.stringify(data)}`
      return `[${status}] ${String(data)}`
    }
    return `[${status}] ${e.response.statusText || e.message || 'No response body'}`
  }

  // 3. Standard Error or object with message
  if (e.message) return String(e.message).replace(/^Error:\s*/i, '')
  if (e.rawLog) return String(e.rawLog)

  return String(err).replace(/^Error:\s*/i, '')
}

async function doConnect(args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number; donate?: boolean }) {
  connectInProgress = true
  try {
    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node' })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(args.nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${args.nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }
    const chainPrices = (args.subscriptionType === 'gigabytes' ? chainNode.gigabytePrices : chainNode.hourlyPrices) ?? []
    const udvpnPrice = chainPrices.find((p: Price) => p.denom === 'udvpn')
    if (!udvpnPrice) return { success: false, error: `No up2p price on chain` }

    mainWindow?.webContents.send('vpn:status', { step: 'preparing_tx' })
    const txArgs: TxNodeStartSession = {
      from: walletState.address!, nodeAddress: args.nodeAddress,
      gigabytes: args.subscriptionType === 'gigabytes' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      hours: args.subscriptionType === 'hours' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      maxPrice: udvpnPrice, fee: 'auto', memo: MEMO
    }

    mainWindow?.webContents.send('vpn:status', { step: 'signing_tx' })
    mainWindow?.webContents.send('vpn:status', { step: 'broadcasting_tx' })
    const tx = await walletState.client!.signAndBroadcast(walletState.address!, [nodeStartSession(txArgs)], 'auto', MEMO)
    assertIsDeliverTxSuccess(tx)

    mainWindow?.webContents.send('vpn:status', { step: 'extracting_tx' })
    const event = searchEvent(NodeEventCreateSession.type, tx.events)
    if (!event) {
      return { success: false, error: 'Session creation event not found' }
    }

    const parsed = NodeEventCreateSession.parse(event)
    const sessionId = parsed.value.sessionId

    activeSessionId = sessionId.toString()
    activeNodeAddress = args.nodeAddress

    // Handshake with a small retry loop for propagation delay
    let lastErr: any = null
    for (let i = 0; i < 5; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 2000))
        console.log(`[Node:Connect] Handshake attempt ${i + 1} for Session #${sessionId}`)
        return await doHandshake(args.nodeAddress, sessionId, args.donate, args.amount, args.subscriptionType)
      } catch (err: any) {
        lastErr = err
        const msg = (err.message || '').toLowerCase()
        if (msg.includes('not exist') || msg.includes('404')) {
          console.warn(`[Node:Connect] Session not indexed yet, retrying...`)
          continue
        }
        throw err // Other errors fail immediately
      }
    }
    throw lastErr
  } catch (err: any) {
    console.error('[doConnect] Error:', err)
    return { success: false, error: extractError(err), details: err?.response?.data }
  } finally {
    connectInProgress = false
  }
}

function getNextWgInterface(): string {
  const plat = process.platform
  for (let i = 0; i < 10; i++) {
    const ifName = `chibatunnel${i}`
    try {
      if (plat === 'win32') {
        // On Windows, check if the WireGuard tunnel service already exists (non-privileged check)
        execSync(`sc.exe query WireGuardTunnel$${ifName}`, { stdio: 'ignore' })
      } else {
        execSync(`ip link show ${ifName}`, { stdio: 'ignore' })
      }
    } catch {
      // Command failed = service/interface does not exist, name is FREE
      return ifName
    }
  }
  return 'chibatunnel9'
}

async function doHandshake(nodeAddress: string, sessionId: Long, donate?: boolean, amount?: number, subType?: 'gigabytes' | 'hours') {
  try {
    activeSessionId = sessionId.toString(); activeNodeAddress = nodeAddress
    mainWindow?.webContents.send('vpn:status', { status: 'node_handshake', step: 'handshaking', sessionId: activeSessionId })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }

    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node_info' })
    const nInfo = await nodeInfo(remoteAddr).catch(e => {
      const err: any = new Error(`[nodeInfo] ${extractError(e)}`); err.response = e.response; throw err
    })
    const settings = getSettings()

    const finalize = async (res: any) => {
      if (res.success && donate && amount && subType && walletState.client && walletState.address) {
        try {
          const prices = subType === 'gigabytes' ? chainNode.gigabytePrices : chainNode.hourlyPrices
          const udvpnPrice = (prices ?? []).find((p: Price) => p.denom === 'udvpn')
          
          if (udvpnPrice) {
            console.log(`\n[SUPPORT] DEBUG DATA:`, {
              subType, amount,
              priceObject: JSON.stringify(udvpnPrice),
              recipient: PROJECT_WALLET_ADDRESS
            })

            // In Sentinel v3, quoteValue is the actual price in udvpn, 
            // while baseValue is the scale factor (usually 10^15).
            const unitPrice = BigInt(udvpnPrice.quoteValue)
            const qty = BigInt(amount)
            const donationAmount = (unitPrice * qty) / 10n // 10%

            // Validate the recipient before attempting any transfer. The default
            // PROJECT_WALLET_ADDRESS is a placeholder and an invalid/misconfigured
            // address must never abort or even attempt the donation.
            let recipientValid = false
            try { recipientValid = fromBech32(PROJECT_WALLET_ADDRESS).prefix === 'sent' } catch { recipientValid = false }

            if (donationAmount > 0n && !recipientValid) {
              console.log(`[SUPPORT] Donation skipped: invalid recipient address "${PROJECT_WALLET_ADDRESS}"`)
            } else if (donationAmount > 0n) {
              console.log(`[SUPPORT] Calculated Donation: ${donationAmount.toString()} up2p`)
              mainWindow?.webContents.send('vpn:warning', { message: `Project donation triggered: ${donationAmount.toString()} up2p` })

              walletState.client.sendTokens(
                walletState.address, 
                PROJECT_WALLET_ADDRESS, 
                [{ denom: 'udvpn', amount: donationAmount.toString() }], 
                'auto', 
                PROJECT_DONATION_MEMO
              )
                .then(tx => console.log(`[SUPPORT] TX SUCCESS: ${tx.transactionHash}`))
                .catch(e => console.error(`[SUPPORT] TX FAILED:`, e))
            }
          }
        } catch (e) { console.error('[SUPPORT] Runtime error in donation logic:', e) }
      }
      return res
    }

    if (nInfo.service_type === NodeVPNType.WIREGUARD) {
      mainWindow?.webContents.send('vpn:status', { step: 'generating_config' })
      if (activeWgConfigFile) { try { await wgQuickDown(activeWgConfigFile) } catch (_) {}; activeWgConfigFile = null }
      const wg = new Wireguard(); const result = await handshake(sessionId, { public_key: wg.publicKey }, walletState.privkey!, remoteAddr).catch(e => {
        const err: any = new Error(`[handshake] ${extractError(e)}`); err.response = e.response; throw err
      })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))
      const dns = settings.dohIp ? [settings.dohIp] : undefined
      await wg.parseConfig(hd, result.addrs, dns)
      let configStr = wg.buildConfigString()
      if (!configStr) return { success: false, error: 'WireGuard: config null' }
      if (settings.splitTunnel && settings.splitRoutes) configStr = configStr.replace(/AllowedIPs\s*=\s*.+/g, `AllowedIPs = ${settings.splitRoutes}`)
      const qrCode = await QRCode.toDataURL(configStr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      const ifName = getNextWgInterface(); const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `chibatunnel-${ifName}-`))
      activeWgConfigFile = path.join(tmpDir, `${ifName}.conf`); fs.writeFileSync(activeWgConfigFile, configStr, { mode: 0o600 }); activeWgInstance = wg
      return finalize({ success: true, vpnType: 'wireguard', sessionId: activeSessionId, configStr, qrCode })
    }

    if (nInfo.service_type === NodeVPNType.V2RAY) {
      if (activeV2Ray) { try { /* activeV2Ray.disconnect() */ killV2Ray() } catch (_) {}; activeV2Ray = null }
      checkBinaries()
      const v2ray = new V2Ray(); const result = await handshake(sessionId, { uuid: v2ray.getKey() }, walletState.privkey!, remoteAddr).catch(e => {
        const err: any = new Error(`[handshake] ${extractError(e)}`); err.response = e.response; throw err
      })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8')); await v2ray.parseConfig(hd, result.addrs)
      const configAny = v2ray.config as any
      if (configAny) {
        // Fix V2Ray v5 sniffing panic on QUIC traffic by disabling sniffing
        const proxyInbound = configAny.inbounds?.find((ib: any) => ib.tag === 'proxy')
        if (proxyInbound?.sniffing) {
          proxyInbound.sniffing.enabled = false
        }

        if (configAny.routing?.balancers?.[0]) {
          configAny.observatory = {
            subjectSelector: [...configAny.routing.balancers[0].selector],
            probeInterval: '30s',
            probeUrl: 'https://www.google.com/generate_204'
          }
        }
      }
      const shareLinks = v2ray.buildShareLinks(`chibatunnel-${nodeAddress.slice(-8)}`)
      const qrCodes = await Promise.all(shareLinks.map(link => QRCode.toDataURL(link, { width: 280, margin: 1, color: { dark: '#34d399', light: '#060810' } })))
      const inbounds = (v2ray.config?.inbounds ?? []).filter((ib: any) => ib.protocol !== 'dokodemo-door').map((ib: any) => ({ protocol: ib.protocol, listen: ib.listen, port: ib.port }))
      activeV2Ray = v2ray; return finalize({ success: true, vpnType: 'v2ray', sessionId: activeSessionId, shareLinks, qrCodes, inbounds })
    }
    return { success: false, error: `Unknown VPN type: ${nInfo.service_type}` }
  } catch (err: any) {
    console.error('[doHandshake] Error:', err)
    if (activeWgConfigFile) { try { fs.rmSync(path.dirname(activeWgConfigFile), { recursive: true, force: true }) } catch (_) {}; activeWgConfigFile = null; activeWgInstance = null }
    return { success: false, error: extractError(err), details: err?.response?.data }
  }
}

async function getTrafficStats(): Promise<{ rx: number; tx: number; source: string }> {
  const { promisify } = require('util')
  const execFileAsync = promisify(execFile)

  // 1. WireGuard Stats
  if (activeWgConfigFile && activeWgInstance) {
    const ifName = path.basename(activeWgConfigFile, '.conf')
    if (process.platform === 'linux') {
      try {
        const rx = parseInt(fs.readFileSync(`/sys/class/net/${ifName}/statistics/rx_bytes`, 'utf8').trim()) || 0
        const tx = parseInt(fs.readFileSync(`/sys/class/net/${ifName}/statistics/tx_bytes`, 'utf8').trim()) || 0
        return { rx, tx, source: 'wireguard' }
      } catch { /* Fallback */ }
    }
    try {
      const { stdout } = await execFileAsync('wg', ['show', 'all', 'transfer'])
      const lines = stdout.trim().split('\n')
      let rx = 0, tx = 0; for (const line of lines) { const parts = line.trim().split(/\s+/); if (parts.length >= 3) { rx += parseInt(parts[1]) || 0; tx += parseInt(parts[2]) || 0 } }
      return { rx, tx, source: 'wireguard' }
    } catch { }
  }

  // 2. tun2socks Stats (TUN fallback)
  if (activeTunInterface) {
    if (process.platform === 'linux') {
      try {
        const rx = parseInt(fs.readFileSync(`/sys/class/net/${activeTunInterface}/statistics/rx_bytes`, 'utf8').trim()) || 0
        const tx = parseInt(fs.readFileSync(`/sys/class/net/${activeTunInterface}/statistics/tx_bytes`, 'utf8').trim()) || 0
        if (rx > 0 || tx > 0) return { rx, tx, source: 'tun2socks' }
      } catch { }
    } else if (process.platform === 'darwin') {
      try {
        // netstat -ibI <iface> returns a table. We want the 7th (IBytes) and 10th (OBytes) columns.
        const { stdout } = await execFileAsync('netstat', ['-ibI', activeTunInterface])
        const lines = stdout.trim().split('\n')
        if (lines.length > 1) {
          const stats = lines[1].split(/\s+/)
          return { rx: parseInt(stats[6]) || 0, tx: parseInt(stats[9]) || 0, source: 'tun2socks' }
        }
      } catch { }
    }
  }

  // 3. V2Ray API Stats
  if (activeV2Ray?.config?.inbounds) {
    try {
      const apiInbound = activeV2Ray.config.inbounds.find((ib: any) => ib.tag === 'api')
      if (apiInbound) {
        const res = await fetch(`http://127.0.0.1:${apiInbound.port}/stats/query`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
        if (res?.ok) {
          const data = await res.json() as any; const vals = (data.stat ?? []).map((s: any) => parseInt(s.value) || 0)
          return { rx: vals.filter((_: any, i: number) => i % 2 === 0).reduce((a: any, b: any) => a + b, 0), tx: vals.filter((_: any, i: number) => i % 2 === 1).reduce((a: any, b: any) => a + b, 0), source: 'v2ray' }
        }
      }
    } catch { }
  }
  return { rx: 0, tx: 0, source: 'none' }
}

function startTrafficPolling() {
  if (trafficInterval) clearInterval(trafficInterval)
  trafficInterval = setInterval(async () => { const stats = await getTrafficStats(); mainWindow?.webContents.send('traffic:update', stats) }, 2000)
}


async function execPrivileged(cmds: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const plat = process.platform
  const { exec } = require('child_process')
  console.log(`[ExecPrivileged] Platform: ${plat}`)
  cmds.forEach((c, i) => console.log(`  [Cmd #${i+1}]: ${c}`))

  if (plat === 'darwin') {
    const fullCmd = cmds.join(' && ')
    // Homebrew should NOT be run with sudo/administrator privileges.
    // If the command is a brew command, run it directly without osascript elevation.
    if (fullCmd.trim().startsWith('brew ')) {
      return new Promise((res) => {
        exec(fullCmd, (error: any, stdout: string, stderr: string) => {
          res({ code: error ? (error.code || 1) : 0, stdout, stderr })
        })
      })
    }
    const osaCmd = `osascript -e 'do shell script "${fullCmd.replace(/"/g, '\\"')}" with administrator privileges'`
    return new Promise((res) => {
      exec(osaCmd, (error: any, stdout: string, stderr: string) => {
        res({ code: error ? (error.code || 1) : 0, stdout, stderr })
      })
    })
  } else if (plat === 'win32') {
    const tmpDir = app.getPath('temp')
    const reqId = crypto.randomBytes(4).toString('hex')
    const psPath = path.join(tmpDir, `chibatunnel-priv-${reqId}.ps1`)
    const logPath = path.join(tmpDir, `chibatunnel-priv-${reqId}.log`)

    const psLines = [
      `$ErrorActionPreference = "Continue"`,
      `Start-Transcript -Path "${logPath}" -Force`,
      ...cmds.map(c => `Write-Output '[EXEC] ${c.replace(/'/g, "''")}'; ${c}`),
      `Stop-Transcript`
    ]
    fs.writeFileSync(psPath, psLines.join('\r\n'), { encoding: 'utf8' })

    const psCmd = `powershell -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','""${psPath}""' -Verb RunAs -Wait -WindowStyle Hidden"`

    return new Promise((res) => {
      exec(psCmd, (error: any) => {
        const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
        if (error) {
          console.error(`[ExecPrivileged] Script failed. Log kept at: ${logPath}`)
          res({ code: error.code || 1, stdout: '', stderr: output || error.message })
        } else {
          try { fs.unlinkSync(psPath); fs.unlinkSync(logPath) } catch {}
          res({ code: 0, stdout: output, stderr: '' })
        }
      })
    })
  } else {
    const fullCmd = cmds.join(' && ')
    const bin = ['pkexec', 'gksudo', 'kdesudo', 'sudo'].find(b => {
      try { execSync(`which ${b}`, { stdio: 'ignore' }); return true } catch { return false }
    }) || 'sudo'
    const cmdPrefix = bin === 'sudo' ? 'sudo -A' : bin
    const finalCmd = `${cmdPrefix} bash -c "${fullCmd.replace(/"/g, '\\"')}"`
    return new Promise((res) => {
      exec(finalCmd, (error: any, stdout: string, stderr: string) => {
        res({ code: error ? (error.code || 1) : 0, stdout, stderr })
      })
    })
  }
}

function findPrivEscBin(): string {
  if (process.platform === 'darwin') return 'osascript'
  for (const bin of ['pkexec', 'gksudo', 'kdesudo', 'sudo']) { try { execSync(`which ${bin}`, { stdio: 'ignore' }); return bin } catch (_) {} }
  return 'sudo'
}

function patchConfigFileForDns(configFile: string): void {
  try {
    const raw = fs.readFileSync(configFile, 'utf8'); const patched = raw.replace(/^DNS\s*=.*$/gm, '# DNS= stripped'); if (patched !== raw) { fs.writeFileSync(configFile, patched, { mode: 0o600 }) }
  } catch (_) {}
}

/**
 * Verifies that the genuine, protocol-compatible helper is up — and, if it is
 * not, attempts a single (re)install before re-verifying. This is the gate that
 * must pass before we hand the helper ANY privileged command (wg-up,
 * start-transparent, set-kill-switch), so we never drive a foreign squatter or a
 * missing helper.
 *
 * Returns { ready: true } when a verified helper is confirmed, otherwise
 * { ready: false, error } with a user-facing reason.
 *
 * @returns { ready: true } | { ready: false, error }
 */
async function ensureHelperReady(): Promise<{ ready: boolean; error?: string }> {
  let health = await verifyHelper()
  if (health.ok) return { ready: true }

  // Reinstalling force-recreates the helper (Windows: schtasks /create /f),
  // which also evicts a stale or foreign holder before we retry verification.
  if (health.reason === 'foreign') {
    console.warn('[helper] Foreign responder on the helper channel — reinstalling genuine helper before privileged op.')
  } else if (health.reason === 'incompatible') {
    console.warn(`[helper] Helper protocol mismatch (got ${health.protocol ?? 'none'}) — reinstalling before privileged op.`)
  } else {
    console.warn('[helper] Helper unreachable — installing before privileged op.')
  }

  try {
    if (process.platform === 'win32')      await installWindowsHelper()
    else if (process.platform === 'linux') await installLinuxHelper()
    else if (process.platform === 'darwin') await installDarwinHelper()
  } catch (e: any) {
    return { ready: false, error: `Helper install failed: ${e?.message ?? String(e)}` }
  }

  // Give the freshly-started service a moment to bind the pipe/port, then
  // re-verify a few times before giving up.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 600))
    health = await verifyHelper()
    if (health.ok) return { ready: true }
  }

  return {
    ready: false,
    error:
      health.reason === 'foreign'
        ? 'A conflicting privileged service is holding the helper channel and could not be evicted.'
        : 'The privileged helper is not available. Try "Repair helper" from settings.',
  }
}

/**
 * Brings up a WireGuard tunnel by delegating to the chibatunnel-helper service.
 * On Windows the helper runs wireguard.exe /installtunnelservice (SYSTEM privilege).
 * On Linux/macOS the helper runs wg-quick up (root privilege).
 *
 * If the first attempt fails due to a DNS error on Linux/macOS, the user is
 * asked whether to retry without DNS injection. If approved, the config file
 * is patched and the command is retried once.
 *
 * @param configFile  Absolute path to the WireGuard .conf file.
 * @returns           { success: true } on success, { success: false, error } on failure.
 */
async function wgQuickUp(configFile: string): Promise<{ success: boolean; error?: string }> {
  // Gate: never hand wg-up to an unverified / foreign helper.
  const ready = await ensureHelperReady()
  if (!ready.ready) return { success: false, error: ready.error ?? 'Helper not ready.' }

  const info   = checkBinaries()
  const wgPath = info.wgPath ?? undefined

  // Helper timeout for wg-up: 30 s is enough for wireguard.exe installtunnelservice
  // and wg-quick up. These are one-shot commands, not daemons.
  const TIMEOUT = 30_000

  const attemptUp = () => sendToHelper({ command: 'wg-up', configFile, wgPath }, TIMEOUT)

  // First attempt.
  let res = await attemptUp()

  if (res.status === 'ok') {
    startTrafficPolling()
    return { success: true }
  }

  // DNS retry path — Linux / macOS only.
  if (res.isDnsError === true) {
    // Tell the renderer to show the DNS retry dialog.
    mainWindow?.webContents.send('vpn:dns-retry-ask')

    // Wait for the user to approve or cancel.
    const approved = await new Promise<boolean>((resolve) => {
      // Resolve true when the user approves.
      ipcMain.once('vpn:dns-retry-approved', () => resolve(true))
      // Resolve false if the window is closed or a timeout elapses (60 s).
      const guard = setTimeout(() => resolve(false), 60_000)
      ipcMain.once('vpn:dns-retry-approved', () => clearTimeout(guard))
    })

    if (!approved) {
      return { success: false, error: res.error ?? 'DNS error — user cancelled retry.' }
    }

    // Patch the config file in place — removes DNS = lines from [Interface].
    // patchConfigFileForDns() is a plain fs.writeFileSync call, no privileges needed.
    patchConfigFileForDns(configFile)

    // Second attempt with the patched config (same path, new content).
    res = await attemptUp()

    if (res.status === 'ok') {
      startTrafficPolling()
      mainWindow?.webContents.send('vpn:warning', { message: 'Connected without DNS injection.' })
      return { success: true }
    }

    return { success: false, error: res.error ?? 'wg-quick up failed after DNS patch.' }
  }

  // Any other error.
  return { success: false, error: res.error ?? 'wg-up failed.' }
}

/**
 * Tears down a WireGuard tunnel by delegating to the chibatunnel-helper service.
 * On Windows the helper runs wireguard.exe /uninstalltunnelservice.
 * On Linux/macOS the helper runs wg-quick down.
 *
 * After the helper confirms teardown, the temporary config directory is removed
 * by Electron (plain fs.rmSync — no privileges needed for the temp directory).
 *
 * This function never throws — failures are logged as warnings so that the
 * rest of the killActiveConnections() teardown sequence is not interrupted.
 *
 * @param configFile  Absolute path to the WireGuard .conf file.
 */
async function wgQuickDown(configFile: string): Promise<void> {
  const info   = checkBinaries()
  const wgPath = info.wgPath ?? undefined

  try {
    const res = await sendToHelper({ command: 'wg-down', configFile, wgPath }, 15_000)
    if (res.status !== 'ok') {
      console.warn('[wgQuickDown] Helper returned error:', res.error)
    }
  } catch (err) {
    console.warn('[wgQuickDown] sendToHelper failed:', err)
  }

  // Remove the temporary config directory regardless of the helper result.
  // The config file contains private keys — clean it up even if the tunnel
  // teardown itself failed.
  try {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true })
  } catch (err) {
    console.warn('[wgQuickDown] Failed to remove config directory:', err)
  }
}

function scheduleReconnect() {
  const settings = getSettings(); if (!settings.autoReconnect || !lastConnectArgs || !wasConnected) return
  if (reconnectAttempts >= 5) { mainWindow?.webContents.send('vpn:reconnect', { status: 'failed' }); return }
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60_000); reconnectAttempts++
  mainWindow?.webContents.send('vpn:reconnect', { status: 'waiting', attempt: reconnectAttempts, delay })
  reconnectTimer = setTimeout(async () => {
    mainWindow?.webContents.send('vpn:reconnect', { status: 'reconnecting' });
    let result: any
    if (activeSessionId && activeNodeAddress) {
      result = await doHandshake(activeNodeAddress, Long.fromString(activeSessionId, true))
    } else {
      result = await doConnect(lastConnectArgs!)
    }
    if (result.success) { reconnectAttempts = 0; mainWindow?.webContents.send('vpn:reconnect', { status: 'connected' }) } else { scheduleReconnect() }
  }, delay)
}

function getSettings(): AppSettings { return { ...DEFAULT_SETTINGS, ...((store.get(STORE_KEY_SETTINGS) as Partial<AppSettings>) ?? {}) } }
function longToNum(v: any): number { if (v == null) return 0; if (typeof v === 'number') return v; if (typeof v === 'string') return parseInt(v, 10) || 0; return v.toNumber ? v.toNumber() : 0 }
function getWalletList(): Array<{ label: string; encrypted: string }> { return (store.get(STORE_KEY_WALLETS) as any) ?? [] }
function encryptMnemonic(mnemonic: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('CRITICAL: safeStorage is NOT available. Insecure fallback blocked.')
    return null
  }
  return safeStorage.encryptString(mnemonic).toString('base64')
}
function decryptMnemonic(encrypted: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch { return null }
}
function getActiveMnemonic(): string | null { const wallets = getWalletList(); if (!wallets.length) return null; const idx = (store.get(STORE_KEY_ACTIVE_W) as number) ?? 0; return decryptMnemonic(wallets[Math.min(idx, wallets.length - 1)].encrypted) }

async function setupWallet(mnemonic: string, label: string, rpc: string) {
  try {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'sent' })
    const [acct] = await wallet.getAccounts(); const privkey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })
    const client = await withTimeout(SigningSentinelClient.connectWithSigner(rpc, wallet, { gasPrice: makeGasPrice('0.2udvpn') as any }), RPC_TIMEOUT_MS, 'RPC timeout')
    const readonlyClient = await withTimeout(SentinelClient.connect(rpc), RPC_TIMEOUT_MS, 'RPC timeout')
    walletState = { address: acct.address, label, privkey, client, readonlyClient, rpc }

    // Notify UI immediately
    mainWindow?.webContents.send('wallet-changed', { address: acct.address, label })

    return { success: true, address: acct.address, label, rpc }
  } catch (err: unknown) { return { success: false, error: extractError(err) } }
}

function withTimeout<T>(promise: Promise<T> | undefined, ms: number, msg: string): Promise<T> { if (!promise) return Promise.reject(new Error(msg)); return Promise.race([promise, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]) }

// ── RPC retry / backoff ───────────────────────────────────────────────────────
// The Sentinel RPC endpoints rate-limit bursty fan-out (HTTP 429) and may briefly
// drop connections (ECONNRESET / ETIMEDOUT / EAI_AGAIN). A single transient hiccup
// shouldn't surface as "no nodes for this plan" in the UI, so wrap chain reads in a
// bounded exponential backoff that ONLY retries transient failures — never on-chain
// logic errors (those are returned verbatim so callers see the real cause).

function isTransientNetworkError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; status?: number; response?: { status?: number } }
  const status = e?.status ?? e?.response?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  const code = e?.code
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  const msg = String(e?.message ?? err ?? '').toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway')
  )
}

/**
 * Runs an RPC read with exponential backoff on transient failures only.
 * Non-transient (on-chain/logic) errors reject immediately so the real cause
 * is preserved. Backoff grows 400ms → 800ms → 1600ms (+ jitter), capped at 3 tries.
 */
async function rpcWithRetry<T>(fn: () => Promise<T>, label = 'rpc', maxRetries = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientNetworkError(err) || attempt === maxRetries - 1) throw err
      const backoff = 400 * 2 ** attempt + Math.floor(Math.random() * 200)
      console.warn(`[rpc:retry] ${label} transient failure (attempt ${attempt + 1}/${maxRetries}), retrying in ${backoff}ms:`, extractError(err))
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastErr
}

/**
 * Automatically pages through Cosmos RPC queries using key-based pagination.
 * Runs page requests sequentially with rpcWithRetry.
 */
async function queryAllWithPagination<T = any>(
  queryFn: (pageReq: PageRequest) => Promise<any>,
  extractor: (res: any) => T[],
  label = 'query',
  limit = PAGINATION_LIMIT,
  reverse = false
): Promise<T[]> {
  const allItems: T[] = []
  let nextKey: Uint8Array | undefined = undefined
  let isFirst = true

  while (isFirst || (nextKey && nextKey.length > 0)) {
    isFirst = false
    const pageReq = PageRequest.fromPartial({
      key: nextKey,
      limit: Long.fromNumber(limit),
      reverse
    })
    const res = await rpcWithRetry(() => queryFn(pageReq), `${label}:page`, 3)
    const items = extractor(res)
    if (items) {
      allItems.push(...items)
    }
    nextKey = res?.pagination?.nextKey
  }

  return allItems
}

/** Sleep helper for inter-chunk pacing to stay under RPC rate limits. */
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/*
 * Drop-in replacement for checkBinaries() in the Electron main process.
 *
 * Binary resolution priority (same for all binaries):
 *   1. User-configured custom path (saved in electron-store)
 *   2. System PATH  (distro-installed packages, Homebrew, etc.)
 *   3. resources/bin/  (bundled by electron-builder via extraResources)
 *   4. Executable directory  (legacy fallback, kept for compatibility)
 *
 * WireGuard special handling:
 *   wireguard-tools is NOT bundled. If missing, the app returns a structured
 *   result with `wireguardGuide` containing platform-specific install instructions
 *   that the UI renders as an onboarding step, NOT a hard error.
 *   wireguard.exe is now bundled in resources/bin/ on Windows.
 *   The wireguardGuide is therefore only shown on macOS and Linux AppImage —
 *   never on Windows, where the binary is always present after installation.
 *
 * Geodata (geoip.dat + geosite.dat):
 *   These files are bundled alongside v2ray in resources/bin/.
 *   If v2ray was found in PATH (system install), this function copies the
 *   bundled geo files next to it so v2ray can find them at startup.
 *   v2ray looks for geo files in its own directory by default.
 *
 * wintun.dll (Windows only):
 *   tun2socks.exe requires wintun.dll in the same directory.
 *   This function ensures the DLL is copied next to tun2socks.exe
 *   if they ended up in different directories.
 */

export function checkBinaries() {
  const custom = (store.get(STORE_KEY_BINARIES) as Record<string, string>) ?? {}

  const resourcesBinDir = getBundledBinDir()

  // Add the bundled bin dir to PATH so binaries found there work when spawned
  // by name (e.g. spawn('v2ray', [...])) without needing the full path.
  if (fs.existsSync(resourcesBinDir)) {
    const sep = process.platform === 'win32' ? ';' : ':'
    if (!process.env.PATH?.includes(resourcesBinDir)) {
      process.env.PATH = `${resourcesBinDir}${sep}${process.env.PATH}`
      console.log(`[BinaryCheck] Added to PATH: ${resourcesBinDir}`)
    }
  }

  /**
   * Returns the SHA-256 hex digest of a file, or null on error.
   * Used for optional integrity display in the settings UI.
   */
  const getHash = (p: string): string | null => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    } catch { return null }
  }

  /**
   * Resolves the absolute path of a binary following the priority order.
   * Adds its parent directory to PATH when found so peer files are reachable.
   *
   * @param name  Binary filename (with .exe on Windows, without on Linux/macOS).
   * @returns     Absolute path string, or null if not found anywhere.
   */
  const find = (name: string): string | null => {
    const nameNoExt = name.replace(/\.exe$/i, '')

    // 1. User-configured custom path
    const customPath = custom[name] || custom[nameNoExt]
    if (customPath && fs.existsSync(customPath)) {
      console.log(`[BinaryCheck] Custom: ${name} → ${customPath}`)
      const dir = path.dirname(customPath)
      const sep = process.platform === 'win32' ? ';' : ':'
      if (!process.env.PATH?.includes(dir)) process.env.PATH = `${dir}${sep}${process.env.PATH}`
      return customPath
    }

    // 2. System PATH
    try {
      const cmd   = process.platform === 'win32' ? `where ${name}` : `which ${name}`
      const found = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0]
      if (found) { console.log(`[BinaryCheck] PATH: ${name} → ${found}`); return found }
    } catch { /* not in PATH */ }

    // 3. Bundled resources/bin/
    const bundled = path.join(resourcesBinDir, name)
    if (fs.existsSync(bundled)) {
      console.log(`[BinaryCheck] Bundled: ${name} → ${bundled}`)
      return bundled
    }

    // 4. Legacy: executable directory (Windows only)
    if (process.platform === 'win32') {
      if (name === 'wireguard.exe') {
        const std = 'C:\\Program Files\\WireGuard\\wireguard.exe'
        if (fs.existsSync(std)) return std
      }
      const exeDir = path.join(path.dirname(app.getPath('exe')), name)
      if (fs.existsSync(exeDir)) { console.log(`[BinaryCheck] ExeDir: ${name} → ${exeDir}`); return exeDir }
    }

    console.warn(`[BinaryCheck] NOT FOUND: ${name}`)
    return null
  }

  const getDistro = (): string => {
    if (process.platform !== 'linux') return process.platform
    try {
      const c = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase()
      if (c.includes('id=arch')   || c.includes('id_like=arch'))               return 'arch'
      if (c.includes('id=ubuntu') || c.includes('id=debian') || c.includes('id_like=debian')) return 'debian'
      if (c.includes('id=fedora') || c.includes('id=rhel')   || c.includes('id_like=fedora')) return 'fedora'
      if (c.includes('id=suse')   || c.includes('id_like=suse'))               return 'suse'
    } catch { }
    return 'linux'
  }

  // Detect whether the Linux app was installed from a package (deb/rpm/pacman)
  // or run as AppImage. Package installs have wireguard-tools as a declared
  // dependency, so it should be present. AppImage has no such guarantee.
  const isAppImage = !!process.env.APPIMAGE

  const isWin     = process.platform === 'win32'
  const isMac     = process.platform === 'darwin'
  const isLinux   = process.platform === 'linux'

  // -------------------------------------------------------------------------
  // Resolve each binary
  // -------------------------------------------------------------------------

  const wgName  = isWin ? 'wireguard.exe' : 'wg-quick'
  const v2Name  = isWin ? 'v2ray.exe'     : 'v2ray'
  const t2sName = isWin ? 'tun2socks.exe' : 'tun2socks'

  const wgPath  = find(wgName)
  const v2Path  = find(v2Name)
  const t2sPath = find(t2sName)

  // -------------------------------------------------------------------------
  // wintun.dll — Windows only
  // Must sit in the same directory as tun2socks.exe at runtime.
  // If bundled in resources/bin/ but tun2socks was found elsewhere, copy it.
  // -------------------------------------------------------------------------
  let wintunFound = !isWin  // always true on non-Windows

  if (isWin && t2sPath) {
    const wintunNextToT2s  = path.join(path.dirname(t2sPath), 'wintun.dll')
    const wintunInBundled  = path.join(resourcesBinDir, 'wintun.dll')

    if (fs.existsSync(wintunNextToT2s)) {
      wintunFound = true
    } else if (fs.existsSync(wintunInBundled)) {
      // Copy wintun.dll next to tun2socks.exe so it loads correctly.
      try {
        fs.copyFileSync(wintunInBundled, wintunNextToT2s)
        console.log('[BinaryCheck] Copied wintun.dll alongside tun2socks.exe')
        wintunFound = true
      } catch (e) {
        console.warn('[BinaryCheck] Could not copy wintun.dll:', e)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Geo data files — geoip.dat and geosite.dat
  // v2ray looks for these in its own directory. If v2ray was found in PATH
  // (system install) rather than in resources/bin/, copy the bundled geo
  // files next to it. If neither exists, v2ray works but geo routing fails.
  // -------------------------------------------------------------------------
  let geoDataOk = false

  if (v2Path) {
    const v2Dir        = path.dirname(v2Path)
    const geoipDest    = path.join(v2Dir, 'geoip.dat')
    const geositeDest  = path.join(v2Dir, 'geosite.dat')

    if (fs.existsSync(geoipDest) && fs.existsSync(geositeDest)) {
      geoDataOk = true
      process.env.V2RAY_LOCATION_ASSET = v2Dir
    } else if (isLinux && fs.existsSync('/usr/share/v2ray/geoip.dat') && fs.existsSync('/usr/share/v2ray/geosite.dat')) {
      geoDataOk = true
      process.env.V2RAY_LOCATION_ASSET = '/usr/share/v2ray'
    } else {
      // Try copying from resources/bin/
      const geoipSrc   = path.join(resourcesBinDir, 'geoip.dat')
      const geositeSrc = path.join(resourcesBinDir, 'geosite.dat')

      if (fs.existsSync(geoipSrc) && fs.existsSync(geositeSrc)) {
        try {
          fs.copyFileSync(geoipSrc,   geoipDest)
          fs.copyFileSync(geositeSrc, geositeDest)
          console.log('[BinaryCheck] Copied geo data files alongside v2ray')
          geoDataOk = true
          process.env.V2RAY_LOCATION_ASSET = v2Dir
        } catch (e) {
          console.warn('[BinaryCheck] Could not copy geo data files:', e)
          // Fallback: use geo data files from bundled resources directly
          console.log('[BinaryCheck] Fallback: using geo data files from resources/bin')
          geoDataOk = true
          process.env.V2RAY_LOCATION_ASSET = resourcesBinDir
        }
      }
    }
  }

  // wireguardGuide is only populated when wg-quick / wireguard.exe is genuinely
  // missing. On Windows this should never happen post-install since wireguard.exe
  // is bundled. On macOS and Linux AppImage it guides the user to install via
  // their platform's standard mechanism.

  let wireguardGuide: string | null = null

  if (!wgPath) {
    if (isWin) {
      // wireguard.exe is bundled — if it is missing something went wrong
      // with the installation. Show a reinstall message rather than a setup guide.
      wireguardGuide = WIREGUARD_GUIDES.win32
    } else if (isMac) {
      wireguardGuide = WIREGUARD_GUIDES.darwin
    } else if (isLinux) {
      wireguardGuide = isAppImage
        ? WIREGUARD_GUIDES.linux_appimage
        : WIREGUARD_GUIDES.linux_package
    }
  }

  const distro = getDistro()

  return {
    platform: process.platform,
    distro,

    // WireGuard
    wireguard:      !!wgPath,
    wgPath:         wgPath,
    wgCliPath:      isWin ? find('wg.exe') : null,
    wgHash:         wgPath ? getHash(wgPath) : null,
    // Non-null when wireguard-tools is missing — the UI shows this string
    // as an onboarding guide rather than treating it as a hard error.
    wireguardGuide,

    // macOS Gatekeeper status
    quarantineFixed: isMac,

    // V2Ray
    v2ray:          !!v2Path && geoDataOk,
    v2rayPath:      v2Path,
    v2rayHash:      v2Path ? getHash(v2Path) : null,
    // Whether geoip.dat and geosite.dat were found/copied next to v2ray.
    // false means geo-based routing rules won't work, but basic proxy will.
    geoDataOk,

    // tun2socks
    tun2socks:      !!t2sPath && (isWin ? wintunFound : true),
    tun2socksPath:  t2sPath,
    tun2socksHash:  t2sPath ? getHash(t2sPath) : null,
    // Windows only — false if wintun.dll could not be resolved
    wintunFound:    isWin ? wintunFound : null,
  }
}

// ---------------------------------------------------------------------------
// Convenience: check if all dependencies for a given VPN type are met.
// Use these in the UI to decide whether to show the connect button or a guide.
// ---------------------------------------------------------------------------

export type BinaryCheckResult = ReturnType<typeof checkBinaries>

/**
 * Returns true if all binaries needed for WireGuard mode are present.
 * If false, show `result.wireguardGuide` in the UI.
 */
export function canUseWireGuard(result: BinaryCheckResult): boolean {
  return result.wireguard
}

/**
 * Returns true if all binaries needed for V2Ray transparent mode are present.
 */
export function canUseV2RayTransparent(result: BinaryCheckResult): boolean {
  return result.v2ray && result.tun2socks
}

/**
 * Returns true if V2Ray can be used in standard (non-transparent) mode.
 * Does not require tun2socks.
 */
export function canUseV2RayStandard(result: BinaryCheckResult): boolean {
  return result.v2ray
}

async function killActiveConnections(sendEndSession = true) {
  if (trafficInterval) { clearInterval(trafficInterval); trafficInterval = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  // Clean up local tunnel processes and interfaces immediately
  if (activeTun2Socks !== null) {
    const helperResponse = await sendToHelper({ command: 'stop-transparent' })
    if(helperResponse.status === "ok"){ activeTun2Socks = null; activeTunInterface = null; activeV2RayServerIp = null}
  }
  if (activeV2Ray) { try { /* activeV2Ray.disconnect() */ killV2Ray() } catch { }; activeV2Ray = null }
  if (activeWgConfigFile) { await wgQuickDown(activeWgConfigFile); activeWgConfigFile = null; activeWgInstance = null }

  // Only clear blockchain session state if explicitly requested (intentional disconnect or session end)
  if (sendEndSession) {
    if (activeSessionId && walletState.client && walletState.address) {
      try {
        await walletState.client.signAndBroadcast(
          walletState.address,
          [sessionCancel({ from: walletState.address, id: Long.fromString(activeSessionId, true) })],
          'auto',
          'chibatunnel'
        )
      } catch (err) {
        console.warn('[killActiveConnections] Failed to cancel session on-chain:', err)
      }
    }
    activeSessionId = null; activeNodeAddress = null; lastConnectArgs = null
  }
}



/**
 * Handle to the running v2ray child process.
 * Null when v2ray is not running. Owned exclusively by this module —
 * do not spawn or kill v2ray from anywhere else in the codebase.
 */
let activeV2RayProcess: ChildProcess | null = null

/**
 * Path to the temporary config file written for the current session.
 * Kept so it can be cleaned up when the process exits or is killed.
 */
let activeV2RayConfigFile: string | null = null

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Writes the V2Ray config to a temporary file and spawns the v2ray binary
 * with an explicit binary path instead of relying on PATH resolution.
 *
 * This replaces `activeV2Ray.connect()` in the ipcMain handler. The V2Ray
 * SDK instance is still required because we call its writeConfig() method
 * to produce the JSON config file — we just take over the spawning step.
 *
 * @param v2ray       The V2Ray SDK instance after parseConfig() has been called.
 * @param binaryPath  Absolute path to the v2ray executable, from checkBinaries().
 * @returns           Object with { pid, configFile } on success.
 * @throws            Error if the binary is not found, fails to start, or exits
 *                    within the first 500 ms (indicating an immediate crash).
 */
export async function spawnV2Ray(
  v2ray:      { writeConfig: (p: string) => void },
  binaryPath: string,
): Promise<{ pid: number; configFile: string }> {
  if (activeV2RayProcess !== null) {
    throw new Error('V2Ray is already running. Call killV2Ray() first.')
  }

  // Write config to a temp directory — same pattern as the SDK.
  const tempDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'chibatunnel-v2ray-'))
  const configFile = path.join(tempDir, `v2ray_${crypto.randomBytes(8).toString('hex')}.json`)
  v2ray.writeConfig(configFile)
  console.log('[V2Ray] Config written to:', configFile)

  // Verify the binary exists before attempting to spawn — gives a clear error
  // instead of a cryptic ENOENT from spawn().
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`v2ray binary not found at: ${binaryPath}`)
  }

  const child = spawn(binaryPath, ['run', '--config', configFile], {
    // stdio is piped so we can capture output for logging.
    // Do NOT use 'inherit' — that would attach v2ray's stdout/stderr to
    // Electron's process handles, causing the same "await forever" issue
    // we solved for tun2socks.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached false: v2ray stays in our process group. If Electron exits,
    // the OS cleans up v2ray too (on Windows, detached=false is the default
    // and ensures the child is in the parent's job object).
    detached: false,
  })

  // Capture stdout and stderr. v2ray writes its log to stderr by default.
  child.stdout?.on('data', (data: Buffer) => {
    console.log('[V2Ray stdout]', data.toString().trim())
  })

  child.stderr?.on('data', (data: Buffer) => {
    console.log('[V2Ray stderr]', data.toString().trim())
  })

  child.on('exit', (code, signal) => {
    console.warn('[V2Ray] Process exited.', { code, signal, pid: child.pid })
    const wasActive = (activeV2RayProcess === child)
    activeV2RayProcess   = null
    activeV2RayConfigFile = null
    // Attempt cleanup of the temp config directory on exit.
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}

    // Replicate the previous disconnect detection logic:
    // If v2ray exits unexpectedly while we consider it connected, trigger reconnect.
    if (wasActive && activeV2Ray && wasConnected) {
      mainWindow?.webContents.send('vpn:disconnected', { reason: 'V2Ray exited' })
      activeV2Ray = null
      scheduleReconnect()
    }
  })

  child.on('error', (err) => {
    console.error('[V2Ray] Spawn error:', err.message)
    activeV2RayProcess   = null
    activeV2RayConfigFile = null
  })

  // Give the process a short window to surface an immediate crash (bad config,
  // wrong architecture, missing geo data, port already in use, etc.) before
  // declaring success. 500 ms is enough for v2ray to start or fail on startup.
  await new Promise<void>((resolve, reject) => {
    const earlyWindow = setTimeout(resolve, 500)

    child.once('error', (err) => {
      clearTimeout(earlyWindow)
      reject(new Error(`v2ray failed to spawn: ${err.message}`))
    })

    child.once('exit', (code) => {
      clearTimeout(earlyWindow)
      reject(new Error(
        `v2ray exited immediately (code ${code ?? '?'}). ` +
        `Check the config file at ${configFile} and the logs above.`
      ))
    })
  })

  if (!child.pid) {
    throw new Error('v2ray spawned but returned no PID.')
  }

  activeV2RayProcess    = child
  activeV2RayConfigFile = configFile
  console.log('[V2Ray] Spawned successfully. PID:', child.pid, '| Binary:', binaryPath)

  return { pid: child.pid, configFile }
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

/**
 * Kills the running v2ray process and cleans up its temporary config directory.
 * Safe to call when v2ray is not running — returns immediately without error.
 *
 * Call this from killActiveConnections() instead of activeV2Ray.disconnect().
 */
export function killV2Ray(): void {
  if (activeV2RayProcess === null) {
    console.log('[V2Ray] killV2Ray called but no process is running.')
    return
  }

  const pid = activeV2RayProcess.pid
  try {
    activeV2RayProcess.kill()
    console.log('[V2Ray] Killed process PID:', pid)
  } catch (err) {
    console.warn('[V2Ray] Failed to kill process:', err)
  }

  activeV2RayProcess    = null
  activeV2RayConfigFile = null
}

// ---------------------------------------------------------------------------
// Status query
// ---------------------------------------------------------------------------

/**
 * Returns true if a v2ray process is currently running.
 * Use this in the UI or health checks instead of checking activeV2Ray directly.
 */
export function isV2RayRunning(): boolean {
  return activeV2RayProcess !== null
}

/**
 * Returns the PID of the running v2ray process, or null if not running.
 */
export function getV2RayPid(): number | null {
  return activeV2RayProcess?.pid ?? null
}
