// ─── channels.ts ───
//
// The authoritative inventory of every ipcMain channel the app exposes, derived
// from src/preload/index.ts (the real renderer→main contract) and the handler
// signatures in src/main/index.ts. This is the map coverage is measured against.
//
// Safety tiers gate what the harness is allowed to do automatically:
//   readonly   — pure reads / local queries. Safe to run anywhere, anytime.
//   local      — mutates local state only (electron-store, settings, bookmarks).
//                Reversible, no chain, no money, no OS network changes.
//   privileged — touches the OS network stack or the privileged helper
//                (wg-up, routes, kill switch). Opt-in only.
//   spend      — broadcasts an on-chain tx and/or moves funds. Opt-in only,
//                requires a funded throwaway wallet.
//   ui         — window/app lifecycle. Mostly no-ops headless; run but don't assert effects.

export type Tier = 'readonly' | 'local' | 'privileged' | 'spend' | 'ui'

export interface ChannelSpec {
  /** IPC channel name as registered by ipcMain.handle. */
  channel: string
  /** Renderer-facing api method name (from preload), for cross-reference. */
  api: string
  /** One-line description of what it does. */
  desc: string
  /** Safety tier — gates automatic execution. */
  tier: Tier
  /**
   * Builds the argument list to invoke the handler with, given a live context
   * (e.g. an address discovered earlier). Omit for zero-arg channels.
   * Kept as a function so args can depend on prior discovery.
   */
  args?: (ctx: InvokeContext) => unknown[]
  /**
   * Expected coarse return shape. The engine uses this to assert the contract.
   *   'envelope' — { success: boolean, ... } | 'value' — any non-envelope value
   *   'void'     — undefined/no meaningful return.
   */
  returns: 'envelope' | 'value' | 'void'
  /**
   * True if this channel opens a native dialog or otherwise needs a real focused
   * window. The harness boots windowless (CHIBA_TEST=1), so invoking it would pop
   * a modal dialog and block. The engine skips these automatically — never invoke.
   */
  requiresWindow?: boolean
}

/** Mutable context threaded through a test run so later specs can use earlier results. */
export interface InvokeContext {
  /** Active wallet address, once a wallet is loaded. */
  address?: string
  /** A plan id discovered from plans:fetch, for plan:nodes / scanNodes. */
  planId?: number
  /** A node address discovered from nodes:fetch, for node:info / provider:info. */
  nodeAddress?: string
  /** Provider address discovered from a node, for provider:info. */
  providerAddress?: string
  /** Arbitrary scratch space. */
  [key: string]: unknown
}

export const CHANNELS: ChannelSpec[] = [
  // ── window / app lifecycle (ui) ──
  { channel: 'window:minimize', api: 'minimizeWindow', desc: 'Minimize main window', tier: 'ui', returns: 'void' },
  { channel: 'window:maximize', api: 'maximizeWindow', desc: 'Toggle maximize', tier: 'ui', returns: 'void' },
  { channel: 'window:close', api: 'closeWindow', desc: 'Close window (guards active session)', tier: 'ui', returns: 'void' },
  { channel: 'app:quit', api: 'quitApp', desc: 'Quit app, optionally ending session', tier: 'ui', args: () => [false], returns: 'void' },

  // ── rpc config (readonly / local) ──
  { channel: 'rpc:list', api: 'getRpcList', desc: 'List configured RPC endpoints', tier: 'readonly', returns: 'value' },
  { channel: 'rpc:get', api: 'getCurrentRpc', desc: 'Get current RPC url', tier: 'readonly', returns: 'value' },
  { channel: 'rpc:set', api: 'setRpc', desc: 'Set current RPC url', tier: 'local', args: (c) => [c.rpcUrl ?? ''], returns: 'envelope' },

  // ── settings (readonly / local) ──
  { channel: 'settings:get', api: 'getSettings', desc: 'Read app settings', tier: 'readonly', returns: 'value' },
  { channel: 'settings:set', api: 'saveSettings', desc: 'Patch app settings', tier: 'local', args: () => [{}], returns: 'value' },

  // ── binaries (readonly / local) ──
  { channel: 'binary:check', api: 'checkBinaries', desc: 'Check for wireguard/v2ray binaries', tier: 'readonly', returns: 'value' },
  { channel: 'binary:browse', api: 'browseBinary', desc: 'Open file picker for a binary (native dialog — needs a window)', tier: 'ui', args: () => ['wireguard'], returns: 'value', requiresWindow: true },
  { channel: 'binary:install', api: 'installBinary', desc: 'Run a binary install command', tier: 'privileged', args: () => ['true'], returns: 'value' },
  { channel: 'helper:repair', api: 'repairHelper', desc: 'Reinstall the privileged helper', tier: 'privileged', returns: 'envelope' },

  // ── wallet (mixed) ──
  { channel: 'wallet:list', api: 'listWallets', desc: 'List stored wallets', tier: 'readonly', returns: 'value' },
  { channel: 'wallet:add', api: 'addWallet', desc: 'Add a wallet from mnemonic', tier: 'local', args: (c) => [c.mnemonic ?? '', 'chiba-test'], returns: 'envelope' },
  { channel: 'wallet:switch', api: 'switchWallet', desc: 'Switch active wallet by index', tier: 'local', args: () => [0], returns: 'envelope' },
  { channel: 'wallet:remove', api: 'removeWallet', desc: 'Remove a wallet by index', tier: 'local', args: () => [0], returns: 'envelope' },
  { channel: 'wallet:rename', api: 'renameWallet', desc: 'Rename a wallet', tier: 'local', args: () => [0, 'renamed'], returns: 'envelope' },
  { channel: 'wallet:hasMnemonic', api: 'hasMnemonic', desc: 'Whether a mnemonic is stored', tier: 'readonly', returns: 'value' },
  { channel: 'wallet:generateMnemonic', api: 'generateMnemonic', desc: 'Generate a fresh mnemonic', tier: 'readonly', returns: 'value' },
  { channel: 'wallet:setup', api: 'setupWallet', desc: 'Set up wallet from mnemonic', tier: 'local', args: (c) => [c.mnemonic ?? '', 'chiba-test'], returns: 'envelope' },
  { channel: 'wallet:loadStored', api: 'loadStoredWallet', desc: 'Load the stored wallet', tier: 'readonly', returns: 'envelope' },
  { channel: 'wallet:forget', api: 'forgetWallet', desc: 'Forget the active wallet', tier: 'local', returns: 'envelope' },
  { channel: 'wallet:getBalances', api: 'getBalances', desc: 'Fetch balances for addresses', tier: 'readonly', args: (c) => [c.address ? [c.address] : []], returns: 'value' },
  { channel: 'wallet:getInfo', api: 'getWalletInfo', desc: 'Get active wallet info', tier: 'readonly', returns: 'value' },

  // ── bookmarks (local) ──
  { channel: 'bookmark:list', api: 'listBookmarks', desc: 'List bookmarked nodes', tier: 'readonly', returns: 'value' },
  { channel: 'bookmark:toggle', api: 'toggleBookmark', desc: 'Toggle a node bookmark', tier: 'local', args: (c) => [c.nodeAddress ?? 'sent1test'], returns: 'value' },

  // ── nodes (readonly) ──
  { channel: 'nodes:fetch', api: 'fetchNodes', desc: 'Fetch the node list (REST API)', tier: 'readonly', returns: 'envelope' },
  { channel: 'node:info', api: 'fetchNodeInfo', desc: 'Fetch live node info (handshake probe)', tier: 'readonly', args: (c) => [c.nodeAddress ?? ''], returns: 'envelope' },

  // ── plans / subscriptions reads (readonly) ──
  { channel: 'plans:fetch', api: 'fetchPlans', desc: 'Fetch plans from chain', tier: 'readonly', returns: 'envelope' },
  { channel: 'plan:nodes', api: 'fetchPlanNodes', desc: 'Fetch nodes for a plan', tier: 'readonly', args: (c) => [c.planId ?? 1], returns: 'envelope' },
  { channel: 'plans:scanNodes', api: 'scanPlanNodes', desc: 'Batch fetch nodes for many plans', tier: 'readonly', args: (c) => [c.planId ? [c.planId] : [1]], returns: 'envelope' },
  { channel: 'subscriptions:fetch', api: 'fetchSubscriptions', desc: 'Fetch account subscriptions', tier: 'readonly', returns: 'envelope' },
  { channel: 'provider:info', api: 'fetchProviderInfo', desc: 'Fetch provider info', tier: 'readonly', args: (c) => [c.providerAddress ?? ''], returns: 'envelope' },
  { channel: 'providers:fetchBatch', api: 'fetchProvidersBatch', desc: 'Batch fetch provider info', tier: 'readonly', args: (c) => [c.providerAddress ? [c.providerAddress] : []], returns: 'envelope' },

  // ── sessions (readonly read + spend cancel) ──
  { channel: 'sessions:fetch', api: 'fetchSessions', desc: 'Fetch account sessions', tier: 'readonly', returns: 'envelope' },
  { channel: 'session:cancel', api: 'cancelSession', desc: 'Cancel a session on chain', tier: 'spend', args: (c) => [c.sessionId ?? 0], returns: 'envelope' },

  // ── plan / subscription mutations (spend) ──
  { channel: 'plan:subscribe', api: 'subscribeToPlan', desc: 'Subscribe to a plan (broadcasts tx)', tier: 'spend', args: (c) => [{ planId: c.planId ?? 1, denom: 'udvpn', policy: 0 }], returns: 'envelope' },
  { channel: 'subscription:update', api: 'updateSubscription', desc: 'Update subscription renewal policy', tier: 'spend', args: (c) => [{ subscriptionId: c.subscriptionId ?? 0, policy: 0 }], returns: 'envelope' },
  { channel: 'subscription:cancel', api: 'cancelSubscription', desc: 'Cancel a subscription on chain', tier: 'spend', args: (c) => [c.subscriptionId ?? 0], returns: 'envelope' },
  { channel: 'subscription:connect', api: 'connectSubscriptionNode', desc: 'Start a session under a subscription', tier: 'spend', args: (c) => [{ subscriptionId: c.subscriptionId ?? 0, nodeAddress: c.nodeAddress ?? '' }], returns: 'envelope' },

  // ── traffic (privileged) ──
  { channel: 'traffic:start', api: 'startTraffic', desc: 'Start traffic accounting', tier: 'privileged', returns: 'void' },
  { channel: 'traffic:stop', api: 'stopTraffic', desc: 'Stop traffic accounting', tier: 'privileged', returns: 'void' },

  // ── kill switch (privileged) ──
  { channel: 'killswitch:enable', api: 'enableKillSwitch', desc: 'Enable network kill switch', tier: 'privileged', returns: 'envelope' },
  { channel: 'killswitch:disable', api: 'disableKillSwitch', desc: 'Disable network kill switch', tier: 'privileged', returns: 'envelope' },

  // ── VPN connect lifecycle (spend / privileged) ──
  { channel: 'node:connect', api: 'connectNode', desc: 'Full connect: session start + tunnel up', tier: 'spend', args: (c) => [{ nodeAddress: c.nodeAddress ?? '', subscriptionType: 'hours', amount: 1 }], returns: 'envelope' },
  { channel: 'node:connectSession', api: 'connectSession', desc: 'Connect using an existing session', tier: 'privileged', args: (c) => [{ nodeAddress: c.nodeAddress ?? '', sessionId: c.sessionId ?? 0 }], returns: 'envelope' },
  { channel: 'node:connectWireguard', api: 'connectWireGuard', desc: 'Bring up WireGuard tunnel', tier: 'privileged', returns: 'envelope' },
  { channel: 'node:connectV2ray', api: 'connectV2Ray', desc: 'Bring up V2Ray tunnel', tier: 'privileged', args: () => [{}], returns: 'envelope' },
  { channel: 'node:retryTunnel', api: 'retryTunnel', desc: 'Retry the last tunnel', tier: 'privileged', args: () => [{}], returns: 'envelope' },
  { channel: 'node:disconnect', api: 'disconnectNode', desc: 'Tear down the active tunnel', tier: 'privileged', returns: 'envelope' },

  // ── network / status (readonly) ──
  { channel: 'network:getPublicIp', api: 'getPublicIp', desc: 'Detect current public IP + geo', tier: 'readonly', returns: 'value' },
  { channel: 'vpn:status', api: 'getVpnStatus', desc: 'Current VPN connection status', tier: 'readonly', returns: 'value' },
]

/** Tier ordering for "run up to tier" gating. */
export const TIER_ORDER: Tier[] = ['ui', 'readonly', 'local', 'privileged', 'spend']

/** Channels at or below the given max tier (by TIER_ORDER position). */
export function channelsUpToTier(maxTier: Tier): ChannelSpec[] {
  const max = TIER_ORDER.indexOf(maxTier)
  return CHANNELS.filter((c) => TIER_ORDER.indexOf(c.tier) <= max)
}
