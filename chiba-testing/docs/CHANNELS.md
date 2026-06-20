# Channel reference

Every IPC channel ChibaTunnel exposes, as captured from the real
`registerIpcHandlers()` and cross-referenced against `src/preload/index.ts`.
The harness's spec map (`src/channels.ts`) is the machine-readable version of this
table; `--mode=map` proves the two agree (zero drift at last run: 53 in spec, 53
captured).

Tiers gate automatic execution — see the [README](../README.md#safety-tiers).

## window / app lifecycle — `ui`

| channel | preload api | what it does |
|---|---|---|
| `window:minimize` | `minimizeWindow` | Minimize the main window. |
| `window:maximize` | `maximizeWindow` | Toggle maximize/restore. |
| `window:close` | `closeWindow` | Close window; guards an active session first. |
| `app:quit` | `quitApp` | Quit the app, optionally ending the active session. |

## RPC config — `readonly` / `local`

| channel | preload api | tier | what it does |
|---|---|---|---|
| `rpc:list` | `getRpcList` | readonly | List configured RPC endpoints. |
| `rpc:get` | `getCurrentRpc` | readonly | Get the current RPC url. |
| `rpc:set` | `setRpc` | local | Set the current RPC url. |

## Settings — `readonly` / `local`

| channel | preload api | tier | what it does |
|---|---|---|---|
| `settings:get` | `getSettings` | readonly | Read app settings. |
| `settings:set` | `saveSettings` | local | Patch app settings. |

## Binaries & helper — `readonly` / `ui` / `privileged`

| channel | preload api | tier | what it does |
|---|---|---|---|
| `binary:check` | `checkBinaries` | readonly | Check for wireguard/v2ray binaries. |
| `binary:browse` | `browseBinary` | ui | Open a file picker for a binary (no-op headless). |
| `binary:install` | `installBinary` | privileged | Run a binary install command. |
| `helper:repair` | `repairHelper` | privileged | Reinstall the privileged helper. |

## Wallet — mixed

| channel | preload api | tier | what it does |
|---|---|---|---|
| `wallet:list` | `listWallets` | readonly | List stored wallets. |
| `wallet:add` | `addWallet` | local | Add a wallet from a mnemonic. |
| `wallet:switch` | `switchWallet` | local | Switch active wallet by index. |
| `wallet:remove` | `removeWallet` | local | Remove a wallet by index. |
| `wallet:rename` | `renameWallet` | local | Rename a wallet. |
| `wallet:hasMnemonic` | `hasMnemonic` | readonly | Whether a mnemonic is stored. |
| `wallet:generateMnemonic` | `generateMnemonic` | readonly | Generate a fresh mnemonic. |
| `wallet:setup` | `setupWallet` | local | Set up a wallet from a mnemonic. |
| `wallet:loadStored` | `loadStoredWallet` | readonly | Load the stored wallet into memory. |
| `wallet:forget` | `forgetWallet` | local | Forget the active wallet. |
| `wallet:getBalances` | `getBalances` | readonly | Fetch balances for given addresses. |
| `wallet:getInfo` | `getWalletInfo` | readonly | Get active wallet info. |

## Bookmarks — `readonly` / `local`

| channel | preload api | tier | what it does |
|---|---|---|---|
| `bookmark:list` | `listBookmarks` | readonly | List bookmarked nodes. |
| `bookmark:toggle` | `toggleBookmark` | local | Toggle a node bookmark. |

## Nodes — `readonly`

| channel | preload api | what it does |
|---|---|---|
| `nodes:fetch` | `fetchNodes` | Fetch the node list (REST API). |
| `node:info` | `fetchNodeInfo` | Fetch live node info via a handshake probe. |

## Plans / subscriptions reads — `readonly`

| channel | preload api | what it does |
|---|---|---|
| `plans:fetch` | `fetchPlans` | Fetch plans from chain. |
| `plan:nodes` | `fetchPlanNodes` | Fetch nodes for a plan. |
| `plans:scanNodes` | `scanPlanNodes` | Batch fetch nodes across many plans. |
| `subscriptions:fetch` | `fetchSubscriptions` | Fetch account subscriptions. |
| `provider:info` | `fetchProviderInfo` | Fetch provider info. |
| `providers:fetchBatch` | `fetchProvidersBatch` | Batch fetch provider info. |

## Sessions — `readonly` read + `spend` cancel

| channel | preload api | tier | what it does |
|---|---|---|---|
| `sessions:fetch` | `fetchSessions` | readonly | Fetch account sessions. |
| `session:cancel` | `cancelSession` | spend | Cancel a session on chain. |

## Plan / subscription mutations — `spend`

| channel | preload api | what it does |
|---|---|---|
| `plan:subscribe` | `subscribeToPlan` | Subscribe to a plan (broadcasts a tx). |
| `subscription:update` | `updateSubscription` | Update subscription renewal policy. |
| `subscription:cancel` | `cancelSubscription` | Cancel a subscription on chain. |
| `subscription:connect` | `connectSubscriptionNode` | Start a session under a subscription. |

## Traffic accounting — `privileged`

| channel | preload api | what it does |
|---|---|---|
| `traffic:start` | `startTraffic` | Start traffic accounting. |
| `traffic:stop` | `stopTraffic` | Stop traffic accounting. |

## Kill switch — `privileged`

| channel | preload api | what it does |
|---|---|---|
| `killswitch:enable` | `enableKillSwitch` | Enable the network kill switch. |
| `killswitch:disable` | `disableKillSwitch` | Disable the network kill switch. |

## VPN connect lifecycle — `spend` / `privileged`

| channel | preload api | tier | what it does |
|---|---|---|---|
| `node:connect` | `connectNode` | spend | Full connect: session start + tunnel up. |
| `node:connectSession` | `connectSession` | privileged | Connect using an existing session. |
| `node:connectWireguard` | `connectWireGuard` | privileged | Bring up the WireGuard tunnel. |
| `node:connectV2ray` | `connectV2Ray` | privileged | Bring up the V2Ray tunnel. |
| `node:retryTunnel` | `retryTunnel` | privileged | Retry the last tunnel. |
| `node:disconnect` | `disconnectNode` | privileged | Tear down the active tunnel. |

## Network / status — `readonly`

| channel | preload api | what it does |
|---|---|---|
| `network:getPublicIp` | `getPublicIp` | Detect current public IP + geo. |
| `vpn:status` | `getVpnStatus` | Current VPN connection status. |

---

### Argument contracts worth remembering

These are the shapes the harness builds in `channels.ts → args(ctx)`, taken from
the preload signatures (the authoritative renderer→main contract):

- `node:connect` → `{ nodeAddress, subscriptionType: 'gigabytes' | 'hours', amount, donate? }`
- `node:connectSession` → `{ nodeAddress, sessionId }`
- `plan:subscribe` → `{ planId, denom, policy }`
- `subscription:connect` → `{ subscriptionId, nodeAddress }`
- `subscription:update` → `{ subscriptionId, policy }`
- `wallet:getBalances` → `(addresses: string[])`

Reads thread discovery context forward: `plans:fetch` populates `planId` for
`plan:nodes`/`plans:scanNodes`; `sessions:fetch` populates `sessionId` and
`nodeAddress`; node/provider reads populate `nodeAddress`/`providerAddress`.
