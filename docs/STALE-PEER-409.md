# Stale-peer 409 on reconnect — why ChibaTunnel does NOT auto-mint a new session

## Symptom

You have a valid, paid-for session on a node. You try to (re)connect to it and the
node's remote API answers the handshake with **HTTP 409 "already exists"**, and the
409 body carries **no WireGuard config** (it just echoes the request). Retrying the
handshake on the **same** session 409s forever.

## Root cause — this is a NODE-side bug

The dVPN node keys its WireGuard/V2Ray peer record by **session ID**. When a client
process exits without a clean disconnect (crash, kill, network drop), the node is left
holding a **stale peer** for that session. When the same account re-handshakes the
**same** session, the node should evict the stale peer and accept the new handshake —
but it does not. It returns a config-less 409 instead, and never self-heals.

So the session on-chain is fine and fully paid; the node's local peer table is what's
wedged. The client cannot fix the node's local state from the chain.

## Why we do NOT "recover" by minting a fresh session

A fresh session has a new session ID, which side-steps the node's stale peer — so it
"works". But minting one means broadcasting a **new `MsgStartSession`**, which:

1. **Charges the user again** for bandwidth/time they already bought, and
2. Leaves the **old session still billing** on-chain until it expires.

That turns a node-side bug into a **silent, repeated charge** on the user's wallet
every time a node gets wedged. A consumer client must never spend the user's funds to
paper over an upstream defect. A prior iteration of this code did exactly that
(`mintFreshNodeSession` + `sessionCancel` + re-`StartSession` on every config-less 409);
it has been removed.

## What ChibaTunnel does instead

- **Reuse the existing session for free.** `findReusableSession()` looks up an active
  on-chain session for the node and handshakes THAT instead of creating a duplicate.
  No spend.
- **Recover a 409 that actually carries config.** `recoverHandshake409()`: if the 409
  body includes the peer config under `result.data`, the node already holds our peer
  and handed the same config back — the handshake effectively succeeded, so we use it.
  No spend.
- **Surface a config-less stale-peer 409 honestly.** `isStalePeer409()` detects the
  no-config case; the connect handlers return `stalePeerFailure(...)` — a failure
  envelope with `stalePeer: true` and an actionable message ("the node is holding a
  stale connection… try again shortly or pick another node"). **No on-chain spend.**

The failure envelope shape:

```ts
{ success: false, error: <message>, stalePeer: true, sessionId: '<id>' }
```

Renderers can branch on `stalePeer` to offer "try another node" without implying the
user must pay again.

## The real fix (node-side, tracked separately)

The dVPN node software (`SentinelVpnClient.Connect.cs` and the node's peer-management
path) should, on receiving a handshake for an **existing session from the same
account**, evict the stale peer and re-accept — i.e. make re-handshake idempotent
rather than returning a config-less 409. Until that lands on the node, the honest
client behavior is to surface the error, not to spend around it.
