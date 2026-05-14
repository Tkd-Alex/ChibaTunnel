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
  type Price
} from '@sentinel-official/sentinel-js-sdk'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate'
import Long from 'long'
import QRCode from 'qrcode'
import { execFile, spawn, spawnSync, execSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as dns from 'dns'
import * as crypto from 'crypto'

import { pingHelper, sendToHelper } from './helper-client'

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
    'WireGuard for Windows is required. Download and install it from ' +
    'https://www.wireguard.com/install/ — then restart Sentinel.',

  darwin:
    'wireguard-tools is required. Install it with:\n' +
    '  brew install wireguard-tools\n' +
    'Then restart Sentinel.',

  // Linux AppImage — package manager not available, show manual command.
  linux_appimage:
    'wireguard-tools is required. Install it with your package manager:\n' +
    '  Ubuntu/Debian:  sudo apt install wireguard-tools\n' +
    '  Fedora/RHEL:    sudo dnf install wireguard-tools\n' +
    '  Arch:           sudo pacman -S wireguard-tools\n' +
    'Then restart Sentinel.',

  // Linux deb/rpm/pacman — wireguard-tools is declared as a dependency so
  // it should be installed automatically. This is a fallback message for
  // edge cases where it was manually removed after install.
  linux_package:
    'wireguard-tools was removed from your system. Reinstall it:\n' +
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

// ── Defaults ──────────────────────────────────────────────────────────────────
interface AppSettings {
  killSwitch:     boolean
  autoReconnect:  boolean
  splitTunnel:    boolean
  splitRoutes:    string
  dohIp:          string | null
}
const DEFAULT_SETTINGS: AppSettings = {
  killSwitch:    false,
  autoReconnect: true,
  splitTunnel:   false,
  splitRoutes:   '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  dohIp:         null,
}

const store = new Store({ name: 'sentinel-dvpn' })

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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.sentinel.dvpn-client')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  registerIpcHandlers()

  const alive = await pingHelper()
  if (!alive) {
    if (process.platform === 'linux') await installLinuxHelper()
    else if (process.platform === 'darwin') await installDarwinHelper()
  }

  createWindow()
})

app.on('window-all-closed', async () => {
  await killActiveConnections(true)
  if (process.platform !== 'darwin') app.quit()
})

async function installDarwinHelper(): Promise<void> {
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'dist-helper')

  const helperSrc  = path.join(resourcesPath, 'sentinel-helper-mac')
  const installDir = '/usr/local/lib/sentinel'
  const helperDest = `${installDir}/sentinel-helper-mac`
  const plistPath  = '/Library/LaunchDaemons/com.sentinel.helper.plist'

  const tmpPath = `/tmp/sentinel-helper-setup-${Date.now()}`
  fs.copyFileSync(helperSrc, tmpPath)
  fs.chmodSync(tmpPath, 0o755)

  const plistContent = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    '    <string>com.sentinel.helper</string>',
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
    '</plist>'
  ].join('\\n')

  const result = await execPrivileged([
    `mkdir -p ${installDir}`,
    `cp ${tmpPath} ${helperDest}`,
    `chmod 755 ${helperDest}`,
    `rm -f ${tmpPath}`,
    `printf '${plistContent}' > ${plistPath}`,
    `chmod 644 ${plistPath}`,
    `chown root:wheel ${plistPath}`,
    `launchctl load -w ${plistPath} || true`,
    `launchctl start com.sentinel.helper`,
  ])

  if (result.code !== 0) {
    throw new Error(`macOS Helper installation failed: ${result.stderr}`)
  }
}

async function installLinuxHelper(): Promise<void> {
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'dist-helper')

  const helperSrc  = path.join(resourcesPath, 'sentinel-helper')
  const installDir = '/usr/local/lib/sentinel'
  const helperDest = `${installDir}/sentinel-helper`

  // Copy to /tmp first — /tmp is readable by root even from FUSE mount.
  // The file in /tmp is removed by the privileged script after copying.
  const tmpPath = `/tmp/sentinel-helper-setup-${Date.now()}`
  fs.copyFileSync(helperSrc, tmpPath)
  fs.chmodSync(tmpPath, 0o755)

  const unitContent = [
    '[Unit]',
    'Description=Sentinel Privileged Helper',
    'After=network.target',
    '[Service]',
    'Type=simple',
    `ExecStart=${helperDest} --service`,
    'Restart=on-failure',
    'RestartSec=3s',
    'User=root',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\\n')

  const result = await execPrivileged([
    `mkdir -p ${installDir}`,
    `cp ${tmpPath} ${helperDest}`,
    `chmod 755 ${helperDest}`,
    `rm -f ${tmpPath}`,
    `printf '${unitContent}' > /etc/systemd/system/sentinel-helper.service`,
    `systemctl daemon-reload`,
    `systemctl enable sentinel-helper`,
    `systemctl start sentinel-helper`,
  ])

  if (result.code !== 0) {
    throw new Error(`Helper installation failed: ${result.stderr}`)
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
    const isWin = process.platform === 'win32'
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
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
    return { success: true, address: result.address, label }
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
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('sessions:fetch', async () => {
    if (!walletState.readonlyClient || !walletState.address) return { success: false, sessions: [] }
    try {
      const r = await walletState.readonlyClient.sentinelQuery?.session.sessionsForAccount(walletState.address, undefined)
      const sessions = (r?.sessions ?? []).map(anyVal => {
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
    } catch (err: unknown) { return { success: false, error: String(err), sessions: [] } }
  })

  ipcMain.handle('session:cancel', async (_e, sessionId: number) => {
    if (!walletState.client || !walletState.address) return { success: false, error: 'Wallet not initialized' }
    try {
      const msg = sessionCancel({ from: walletState.address, id: Long.fromNumber(sessionId, true) })
      const tx  = await walletState.client.signAndBroadcast(walletState.address, [msg], 'auto', 'sentinel-dvpn-client')
      assertIsDeliverTxSuccess(tx); return { success: true }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('traffic:start', () => {
    startTrafficPolling(); return { success: true }
  })
  ipcMain.handle('traffic:stop', () => {
    if (trafficInterval) { clearInterval(trafficInterval); trafficInterval = null }; return { success: true }
  })

  ipcMain.on('vpn:dns-retry-approved', () => { /* Logic handled via promise in wgQuickUp */ })

  ipcMain.handle('node:connect', async (_e, args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number }) => {
    if (!walletState.client || !walletState.address || !walletState.privkey) return { success: false, error: 'Wallet not initialized' }
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
    try {
      const pid = activeV2Ray.connect()
      if (transparent) {
        const result = await setupTransparentV2Ray(activeV2Ray)
        if (!result.success) {
          activeV2Ray.disconnect()
          return result
        }
      }
      wasConnected = true
      startTrafficPolling()
      return { success: true, pid }
    } catch (err: unknown) { return { success: false, error: String(err) } }
  })

  ipcMain.handle('node:retryTunnel', async (_e, { transparent }: { transparent?: boolean } = {}) => {
    if (activeWgConfigFile) return wgQuickUp(activeWgConfigFile)
    if (activeV2Ray) {
      try { activeV2Ray.disconnect() } catch (_) {}
      try {
        const pid = activeV2Ray.connect()
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
    await killActiveConnections(false)
    mainWindow?.webContents.send('vpn:disconnected', { reason: 'manual' })
    return { success: true }
  })

  ipcMain.handle('network:getPublicIp', async () => {
    const fetchIp = async () => {
      const res = await fetch('https://ipapi.co/json/', {
        headers: { 'User-Agent': 'sentinel-dvpn-client' },
        signal: AbortSignal.timeout(5000)
      })
      return await res.json() as any
    }

    console.log('[Main] Fetching public IP info...')
    // Retry logic for IP fetch during routing transitions
    for (let i = 0; i < 3; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 1500 * i))
        const data = await fetchIp()
        console.log('[Main] IP info fetched successfully:', data?.ip)
        return data
      } catch (err: unknown) {
        console.warn(`[Main] IP fetch attempt ${i+1} failed:`, String(err))
        if (i === 2) return { error: String(err) }
      }
    }
    return { error: 'Unknown error' }
  })

  ipcMain.handle('killswitch:enable', async () => {
    try {
      await sendToHelper({ command: 'set-kill-switch', enabled: true })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('killswitch:disable', async () => {
    try {
      await sendToHelper({ command: 'set-kill-switch', enabled: false })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('vpn:status', () => ({
    v2rayActive: !!activeV2Ray,
    v2rayPid: activeV2Ray?.child?.pid,
    wgActive: !!activeWgConfigFile,
    wgInterface: activeWgConfigFile ? path.basename(activeWgConfigFile, '.conf') : null,
    tunActive: activeTun2Socks !== null,
    tunPid: activeTun2Socks,
    tunInterface: activeTunInterface,
    sessionId: activeSessionId,
    nodeAddress: activeNodeAddress
  }))
}

function getNextTunInterface(): string {
  const plat = process.platform
  for (let i = 0; i < 10; i++) {
    const ifName = plat === 'darwin' ? `utun${i}` : `sentinel-tun${i}`
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
  return plat === 'darwin' ? 'utun9' : 'sentinel-tun9'
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
      if (process.platform === 'win32') activeTunInterface = 'sentinel-tun'
      else if (process.platform === 'darwin') activeTunInterface = 'utun9'
      else activeTunInterface = 'sentun0'
    }
    return { success: helperResponse.status === "ok" }
  } catch (err: any) { return { success: false, error: `Transparent setup failed: ${err.message}` } }
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as any
    if (e.response) {
      const status = e.response.status; const data = e.response.data
      if (data) {
        if (data.error && typeof data.error === 'object' && data.error.message) return `[${status}] ${data.error.message}`
        const msg = data.message || data.error || data.detail
        if (msg && typeof msg === 'string') return `[${status}] ${msg}`
        if (typeof data === 'object') return `[${status}] ${JSON.stringify(data)}`
        return `[${status}] ${String(data)}`
      }
      return `[${status}] ${e.message || 'No response body'}`
    }
    if (e.rawLog) return e.rawLog
    if (e.message) return e.message
  }
  return String(err)
}

async function doConnect(args: { nodeAddress: string; subscriptionType: 'gigabytes' | 'hours'; amount: number }) {
  try {
    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node' })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(args.nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${args.nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }
    const chainPrices = (args.subscriptionType === 'gigabytes' ? chainNode.gigabytePrices : chainNode.hourlyPrices) ?? []
    const udvpnPrice = chainPrices.find((p: Price) => p.denom === 'udvpn')
    if (!udvpnPrice) return { success: false, error: `No udvpn price on chain` }

    mainWindow?.webContents.send('vpn:status', { step: 'preparing_tx' })
    const txArgs: TxNodeStartSession = {
      from: walletState.address!, nodeAddress: args.nodeAddress,
      gigabytes: args.subscriptionType === 'gigabytes' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      hours: args.subscriptionType === 'hours' ? Long.fromNumber(Math.max(1, args.amount), true) : undefined,
      maxPrice: udvpnPrice, fee: 'auto', memo: 'sentinel-dvpn-client'
    }
    mainWindow?.webContents.send('vpn:status', { step: 'signing_tx' })
    mainWindow?.webContents.send('vpn:status', { step: 'broadcasting_tx' })
    const tx = await walletState.client!.signAndBroadcast(walletState.address!, [nodeStartSession(txArgs)], 'auto', 'sentinel-dvpn-client')
    assertIsDeliverTxSuccess(tx)

    mainWindow?.webContents.send('vpn:status', { step: 'extracting_tx' })
    const event = searchEvent(NodeEventCreateSession.type, tx.events)
    if (!event) return { success: false, error: 'Session creation event not found' }
    const parsed = NodeEventCreateSession.parse(event); const sessionId = parsed.value.sessionId
    activeSessionId = sessionId.toString(); activeNodeAddress = args.nodeAddress
    return doHandshake(args.nodeAddress, sessionId)
  } catch (err: unknown) { return { success: false, error: extractError(err) } }
}

function getNextWgInterface(): string {
  const plat = process.platform
  for (let i = 0; i < 10; i++) {
    const ifName = `sentinel${i}`
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
  return 'sentinel9'
}

async function doHandshake(nodeAddress: string, sessionId: Long) {
  try {
    activeSessionId = sessionId.toString(); activeNodeAddress = nodeAddress
    mainWindow?.webContents.send('vpn:status', { status: 'node_handshake', step: 'handshaking', sessionId: activeSessionId })
    const chainNode = await withTimeout(walletState.client!.sentinelQuery?.node.node(nodeAddress), RPC_TIMEOUT_MS, 'RPC timeout fetching node')
    if (!chainNode) return { success: false, error: `Node not found: ${nodeAddress}` }
    const remoteAddr = chainNode.remoteAddrs?.[0]
    if (!remoteAddr) return { success: false, error: 'Node has no remote addresses' }

    mainWindow?.webContents.send('vpn:status', { step: 'fetching_node_info' })
    const nInfo = await nodeInfo(remoteAddr).catch(e => { throw new Error(`[nodeInfo] ${extractError(e)}`) })
    const settings = getSettings()

    if (nInfo.service_type === NodeVPNType.WIREGUARD) {
      mainWindow?.webContents.send('vpn:status', { step: 'generating_config' })
      if (activeWgConfigFile) { try { await wgQuickDown(activeWgConfigFile) } catch (_) {}; activeWgConfigFile = null }
      const wg = new Wireguard(); const result = await handshake(sessionId, { public_key: wg.publicKey }, walletState.privkey!, remoteAddr).catch(e => { throw new Error(`[handshake] ${extractError(e)}`) })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))
      const dns = settings.dohIp ? [settings.dohIp] : undefined
      await wg.parseConfig(hd, result.addrs, dns)
      let configStr = wg.buildConfigString()
      if (!configStr) return { success: false, error: 'WireGuard: config null' }
      if (settings.splitTunnel && settings.splitRoutes) configStr = configStr.replace(/AllowedIPs\s*=\s*.+/g, `AllowedIPs = ${settings.splitRoutes}`)
      const qrCode = await QRCode.toDataURL(configStr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      const ifName = getNextWgInterface(); const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sentinel-${ifName}-`))
      activeWgConfigFile = path.join(tmpDir, `${ifName}.conf`); fs.writeFileSync(activeWgConfigFile, configStr, { mode: 0o600 }); activeWgInstance = wg
      return { success: true, vpnType: 'wireguard', sessionId: activeSessionId, configStr, qrCode }
    }

    if (nInfo.service_type === NodeVPNType.V2RAY) {
      if (activeV2Ray) { try { activeV2Ray.disconnect() } catch (_) {}; activeV2Ray = null }
      checkBinaries()
      const v2ray = new V2Ray(); const result = await handshake(sessionId, { uuid: v2ray.getKey() }, walletState.privkey!, remoteAddr).catch(e => { throw new Error(`[handshake] ${extractError(e)}`) })
      const hd = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8')); await v2ray.parseConfig(hd, result.addrs)
      const shareLinks = v2ray.buildShareLinks(`sentinel-${nodeAddress.slice(-8)}`)
      const qrCodes = await Promise.all(shareLinks.map(link => QRCode.toDataURL(link, { width: 280, margin: 1, color: { dark: '#34d399', light: '#060810' } })))
      const inbounds = (v2ray.config?.inbounds ?? []).filter((ib: any) => ib.protocol !== 'dokodemo-door').map((ib: any) => ({ protocol: ib.protocol, listen: ib.listen, port: ib.port }))
      activeV2Ray = v2ray; return { success: true, vpnType: 'v2ray', sessionId: activeSessionId, shareLinks, qrCodes, inbounds }
    }
    return { success: false, error: `Unknown VPN type: ${nInfo.service_type}` }
  } catch (err: unknown) {
    if (activeWgConfigFile) { try { fs.rmSync(path.dirname(activeWgConfigFile), { recursive: true, force: true }) } catch (_) {}; activeWgConfigFile = null; activeWgInstance = null }
    return { success: false, error: extractError(err) }
  }
}

async function getTrafficStats(): Promise<{ rx: number; tx: number; source: string }> {
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
      const lines = execSync('wg show all transfer', { stdio: 'pipe' }).toString().trim().split('\n')
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
        const output = execSync(`netstat -ibI ${activeTunInterface}`, { stdio: 'pipe' }).toString().trim()
        const lines = output.split('\n')
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
    const psPath = path.join(tmpDir, `sentinel-priv-${reqId}.ps1`)
    const logPath = path.join(tmpDir, `sentinel-priv-${reqId}.log`)

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
 * Brings up a WireGuard tunnel by delegating to the sentinel-helper service.
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
 * Tears down a WireGuard tunnel by delegating to the sentinel-helper service.
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
  } catch (err: unknown) { return { success: false, error: String(err) } }
}

function withTimeout<T>(promise: Promise<T> | undefined, ms: number, msg: string): Promise<T> { if (!promise) return Promise.reject(new Error(msg)); return Promise.race([promise, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]) }

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

  // Resolve the bundled bin directory.
  // In packaged app: process.resourcesPath/bin/
  // In dev: project root / build/bins/<platform>/ (so npm run dev works without installing)
  const platformKey = process.platform === 'win32' ? 'win'
                    : process.platform === 'darwin' ? 'mac'
                    : 'linux'

  const resourcesBinDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', 'build', 'bins', platformKey)

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
        } catch (e) {
          console.warn('[BinaryCheck] Could not copy geo data files:', e)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // WireGuard install guide — structured message for the UI
  // Only populated when wg-quick is missing.
  // -------------------------------------------------------------------------
  let wireguardGuide: string | null = null

  if (!wgPath) {
    if (isWin)       wireguardGuide = WIREGUARD_GUIDES.win32
    else if (isMac)  wireguardGuide = WIREGUARD_GUIDES.darwin
    else if (isLinux) {
      wireguardGuide = isAppImage
        ? WIREGUARD_GUIDES.linux_appimage
        : WIREGUARD_GUIDES.linux_package
    }
  }

  // -------------------------------------------------------------------------
  // macOS Gatekeeper Check
  // Check if binaries have the quarantine attribute.
  // -------------------------------------------------------------------------
  let quarantineGuide: string | null = null
  if (isMac) {
    const pathsToCheck = [v2Path, wgPath, t2sPath].filter(Boolean) as string[]
    for (const p of pathsToCheck) {
      try {
        const attrs = execSync(`xattr "${p}"`, { stdio: 'pipe' }).toString()
        if (attrs.includes('com.apple.quarantine')) {
          quarantineGuide =
            'Some binaries are blocked by macOS Gatekeeper. Please run this command in Terminal to authorize them:\n\n' +
            `  xattr -rd com.apple.quarantine "${path.dirname(p)}" \n\n` +
            'Alternatively, allow them manually in System Settings > Privacy & Security.'
          break
        }
      } catch { /* ignore */ }
    }
  }

  const distro = getDistro()

  return {
    platform: process.platform,
    distro,

    // WireGuard
    wireguard:      !!wgPath,
    wgPath,
    wgHash:         wgPath ? getHash(wgPath) : null,
    // Non-null when wireguard-tools is missing — the UI shows this string
    // as an onboarding guide rather than treating it as a hard error.
    wireguardGuide,

    // macOS Gatekeeper message
    quarantineGuide,

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

  // Disable Kill Switch immediately to restore local connectivity during teardown
  // try { await applyKillSwitch(false) } catch (e) { console.warn('[Teardown] Failed to disable Kill Switch', e) }

  if (sendEndSession && activeSessionId && walletState.client && walletState.address) {
    try { await walletState.client.signAndBroadcast(walletState.address, [sessionCancel({ from: walletState.address, id: Long.fromString(activeSessionId, true) })], 'auto', 'sentinel-dvpn-client') } catch { }
  }
  if (activeTun2Socks !== null) {
    const helperResponse = await sendToHelper({ command: 'stop-transparent' })
    if(helperResponse.status === "ok"){ activeTun2Socks = null; activeTunInterface = null; activeV2RayServerIp = null}
  }
  if (activeV2Ray) { try { activeV2Ray.disconnect() } catch { }; activeV2Ray = null }
  if (activeWgConfigFile) { await wgQuickDown(activeWgConfigFile); activeWgConfigFile = null; activeWgInstance = null }
  activeSessionId = null; activeNodeAddress = null; lastConnectArgs = null
}

const _origConnect = V2Ray.prototype.connect
V2Ray.prototype.connect = function (configFile?: string) {
  const pid = _origConnect.call(this, configFile) as number | undefined
  if (this.child) { (this.child as ChildProcess).on('exit', () => { if (activeV2Ray === this) { mainWindow?.webContents.send('vpn:disconnected', { reason: 'V2Ray exited' }); activeV2Ray = null; scheduleReconnect() } }) }
  return pid
}
