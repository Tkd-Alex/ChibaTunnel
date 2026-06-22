# Why a plan does not appear in ChibaTunnel

> Chain-verified via RPC against `rpc.sentinel.co` (Sentinel v3). Written after a
> provider created Plan #278, registered as a provider, and was confused that the
> plan never showed up in the Plans tab.

## Short answer

**Registering as a provider and creating a plan is NOT enough for the plan to
appear in ChibaTunnel.** A plan only appears once it has at least one **node
linked to it**. Creating a plan links zero nodes. You must lease and link a node
separately.

ChibaTunnel is a **consumer-only client**. The Plans tab lists plans a user can
*connect through*. A plan with no linked nodes has nothing to connect to, so it is
intentionally hidden (see `src/renderer/src/components/PlansPanel.tsx`, the
empty-plan filter). This is correct behavior — surfacing an unconnectable plan
would be a dead end for the user.

## The chain model (what actually has to be true)

A plan becomes connectable through three independent on-chain facts. All three are
required; none implies the next:

1. **Provider registered** — `MsgRegisterProviderRequest`. Provider status ACTIVE.
2. **Plan created and active** — `MsgCreatePlanRequest` (starts INACTIVE) then
   `MsgUpdatePlanStatusRequest` → status ACTIVE.
3. **A node leased AND linked** — `MsgStartLeaseRequest` **then**
   `MsgLinkNodeRequest`, in that order. **Linking requires an active lease first.**
   The chain rejects a bare link with "No active lease". Bundle them as one TX
   `[lease, link]` so the link sees the lease created by the preceding message.

`nodesForPlan(planId)` returning 0 nodes — for ANY status (UNSPECIFIED, ACTIVE,
INACTIVE) — means step 3 never happened, regardless of how healthy steps 1 and 2 are.

## Worked example — Plan #278 (provider `sentprov1kfe7r70flcnsq2rxn0vf0sx3arjh4s0y2scrzx`)

RPC query results:

| Query | Result |
|-------|--------|
| `plan.plan(278)` | EXISTS, status ACTIVE, public, 5 GB / 80 P2P |
| `provider.provider(sentprov1kfe7…)` | REGISTERED, status ACTIVE ("DIGGO — Digital Freedom") |
| `nodesForPlan(278, UNSPECIFIED)` | **0 nodes** |
| `nodesForPlan(278, ACTIVE)` | **0 nodes** |
| `nodesForPlan(278, INACTIVE)` | **0 nodes** |

Provider ✓, plan ✓, nodes ✗. The plan is correctly hidden in Chiba because there
is no node to connect through.

## How to fix it (operator action — not a code change)

Use the **Plan Manager** (`Desktop/plans`, the operator console), not ChibaTunnel.
ChibaTunnel deliberately exposes no plan-management UI — operator actions live in
the Plan Manager.

1. Open Plan Manager → your plan (#278).
2. **Add / link a node.** This relays a single `[lease, link]` TX:
   `POST /api/plan-manager/link` with `{ planId, nodeAddress, leaseHours }`.
   It auto-leases the node (24 h default) and links it in one atomic TX.
3. Confirm with RPC: `nodesForPlan(278)` should now return ≥ 1 node.
4. The plan now appears in ChibaTunnel's Plans tab after the next scan.

Pick a node that is LIVE and leasable. The Plan Manager's "Add Nodes" browser
hides nodes already linked or already leased and surfaces only candidates you can
lease and link.

## For SDK / app builders

- Message builders: `MessageBuilder.LinkNode` (C# `MessageBuilder.Plan.cs`) and the
  JS `encodeMsgLinkNode`. Both are **operator/utility** functions — consumer apps
  never call them. ChibaTunnel only ships them under `CHIBA_TEST` (dead code in
  production) for the provider E2E harness.
- The consumer view (`queryNodesForPlan` / `nodesForPlan`) is the source of truth
  for "is this plan connectable". If it returns 0, the plan is not shown.
