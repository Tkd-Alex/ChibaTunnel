# UI Coverage Audit

Goal: prove that **every function reachable from the ChibaTunnel UI** — every page,
panel, button, toggle, and form — is exercised end-to-end by the harness, and surface
the handful of user-facing paths the harness structurally cannot reach.

Method: the renderer talks to main ONLY through the `window.api` bridge defined in
`src/preload/index.ts`. Every bridge method is either an `ipcRenderer.invoke('<channel>')`
(request/response — what the harness drives via `ipcMain.handle`) or an event/`send`
(one-way push — not an invoke channel). We enumerated all 19 renderer components, mapped
every interactive element to its bridge method and channel, then diffed the UI's invoke
set against the harness's 53-channel map.

## Result: zero drift

- **53 invoke channels exposed by the UI** (preload) == **53 channels in the harness map**.
- `comm` diff both directions is empty: the UI can invoke nothing the harness doesn't map,
  and the harness maps nothing the UI can't invoke.
- **No dead preload methods** — all 54 bridge surfaces (53 invoke + 1 send) are wired to a
  real UI element. Confirmed even the non-obvious ones: `connectSubscriptionNode`,
  `connectSession`, `getVpnStatus` (polled), `repairHelper`, `retryTunnel`, `getBalances`,
  `updateSubscription`, `approveDnsRetry`.

Therefore: running the harness across all tiers exercises **every request/response function
a user can trigger from any page**. The privileged + spend runs proved the real handlers
execute their real code paths (real `safeStorage` decrypt, live RPC reads, a real on-chain
`plan:subscribe` broadcast, real `schtasks` helper registration).

## Page → channel map (condensed)

| Page / panel | Channels exercised |
|---|---|
| TitleBar / RpcSelector | window:minimize/maximize/close, network:getPublicIp, rpc:list/get/set |
| WalletSetup | wallet:generateMnemonic, wallet:setup |
| WalletManager | wallet:list/getInfo/getBalances/generateMnemonic/add/switch/rename/remove |
| WalletBar | wallet:getInfo (+ onWalletChanged listener) |
| Nodes (NodeTable/FiltersBar/Globe) | nodes:fetch, node:info, bookmark:toggle (filters/globe local-only) |
| PlansPanel | plans:fetch, plans:scanNodes, providers:fetchBatch, **plan:subscribe** |
| SubscriptionsPanel | provider:info, plan:nodes, **subscription:update/cancel/connect** |
| SessionPanel | sessions:fetch, **session:cancel**, node:info |
| NodeConnectModal | binary:check, settings:get, wallet:getInfo, **node:connect / node:connectSession / node:connectWireguard / node:connectV2ray / node:retryTunnel / node:disconnect**, vpn:status, helper:repair, bookmark:toggle |
| SettingsPanel | settings:get/set, killswitch:enable/disable |
| BinarySetup | binary:check/browse/install |
| App shell (boot/lifecycle) | rpc:get, binary:check, bookmark:list, wallet:hasMnemonic/loadStored, nodes:fetch, plans:fetch, subscriptions:fetch, sessions:fetch, providers:fetchBatch, plans:scanNodes, network:getPublicIp, traffic:start/stop, app:quit |

## Coverage gaps — paths the harness CANNOT reach

These are NOT invoke channels, so the harness (which drives `ipcMain.handle`) does not
touch them. They are real user-facing flows and are candidates for a renderer/event-level
test pass:

**8 main→renderer event pushes** (`webContents.send` in main → `ipcRenderer.on` in preload):
- `vpn:status` — live connection step updates (App + NodeConnectModal both listen)
- `traffic:update` — the live RX/TX traffic meter (TrafficStats)
- `vpn:disconnected` — disconnect handling, reconnect message, IP refresh (App)
- `vpn:reconnect` — auto-reconnect progress/attempt/delay banner (App)
- `vpn:warning` — transient warning toast (App, 8s)
- `wallet-changed` — wallet bar + sessions refresh (WalletBar, SessionPanel)
- `vpn:dns-retry-ask` — opens the DNS retry confirm modal (App)
- `app:close-request` — opens the quit-confirm modal (App)

**1 renderer→main send** (one-way, not request/response):
- `vpn:dns-retry-approved` (`approveDnsRetry()`) — user approves the DNS retry prompt.

To cover these end-to-end you need either (a) a real renderer driven by Spectron/Playwright,
or (b) harness assertions that the main process EMITS these events at the right moments
(e.g. assert `vpn:disconnected` fires after `node:disconnect`, `traffic:update` fires while a
session is live). Option (b) is the lighter add and fits the existing IPC-reuse model.

## Reproduce the drift check

```bash
# UI invoke channels:
grep -oE "ipcRenderer\.invoke\('[^']+'" src/preload/index.ts | grep -oE "'[^']+'" | tr -d "'" | sort -u
# harness map channels:
grep -oE "channel: '[^']+'" chiba-testing/src/channels.ts | grep -oE "'[^']+'" | tr -d "'" | sort -u
# diff → must be empty both directions
```
