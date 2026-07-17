# Van Stock Request — Per-Line Warehouse Sourcing & Split Fulfilment — Design

**Date:** 2026-07-14
**Status:** Draft for review
**Owner:** Shahul
**Builds on:** [2026-07-14-van-stock-request-design.md](2026-07-14-van-stock-request-design.md) (the base VSR module — read it first)

## 1. Problem

The base VSR module (just built, not yet committed) ties a whole restock request to **one** fulfilment warehouse. Field observation that triggered this redesign:

> An engineer selects 3 items and picks a collection warehouse that holds only **1 of the 3** ("1/3 items in stock"). The request is submitted, the manager approves all 3 lines, and the warehouse "Post issue" screen offers all 3 to scan — but 2 have **0 on shelf** there. The manager only discovers this at the moment of posting, as a zero-floor-guard rollback. There is no legitimate way to fulfil that request as a unit.

Two distinct issues surfaced:

1. **No data corruption** — verified. `inventoryService.applyOutbound` → `upsertBalanceTx` throws `conflict` and rolls back the whole posting if any decrement would take on-hand below zero ([inventory.repository.ts:131](../../backend/src/modules/inventory/inventory.repository.ts)). Over-issue is impossible.
2. **A real workflow gap** — an unfulfillable request flows silently through approval and only dead-ends at the final scan. The engineer also has to guess a single warehouse that holds *everything* they need, which rarely exists.

### The chosen model (matches mature FSM products)

Salesforce Field Service, Dynamics 365 FS, and SAP FSM all separate **demand** (the engineer states what they need) from **sourcing** (a planner decides where each item comes from). We adopt the same split, scoped to what this codebase needs:

- The **engineer** states demand + a **preferred** collection warehouse (unchanged).
- The **planner** — here, the primary warehouse's manager at approval — decides, **per line**, which warehouse issues it. Out-of-stock lines get re-sourced to a warehouse that holds them.
- The **system** lets each source warehouse fulfil only its own lines; the request is `fulfilled` only when every line across every warehouse is complete.

## 2. Scope

**In scope (v1)**
- **Per-line source warehouse** on restocks, decided at approval, defaulting to the primary warehouse.
- **Re-sourcing** an out-of-stock line to another warehouse at approval (work-order model — the target warehouse is not asked for consent; it simply receives the line in its queue).
- **Hard-block approve** — a restock can only be approved when every included line's source warehouse holds ≥ its approve-qty at that moment.
- **Dropping a line** (approve-qty `0` = excluded) so a line no warehouse can cover doesn't force declining the whole request.
- **Split fulfilment** — each source warehouse issues only its own lines; the request appears in every involved warehouse's queue simultaneously.
- **Per-warehouse close-short** — a warehouse writes off only the outstanding lines it owns.

**Out of scope / non-goals**
- **Non-warehouse sources** — no van-to-van, no procurement, no "another engineer" as a source. Warehouse-only. (These were explicitly considered and cut for v1.)
- **Line-splitting** — one line = one source warehouse for its whole approved qty. A need for "60 from A, 40 from B" is modelled as two lines or a planner decision *before* approval, never a split line. Keeps audit/fulfilment/reporting simple.
- **Returns & walk-in stay single-warehouse.** An engineer physically drops a return at one warehouse; a walk-in is issued at the counter. Their lines all carry `sourceWarehouseId = req.warehouseId`. No per-line sourcing UI for them.
- **Target-warehouse consent on re-source** — the planner's decision is binding (work order). The zero-floor guard is the integrity backstop.
- **Auto-suggesting a source** — a 0-stock line defaults to the primary (flagged), and the manager actively re-sources it. No automatic warehouse-hopping.

## 3. Model changes

### 3a. `VanStockRequestLine` — new fields

```prisma
model VanStockRequestLine {
  // ... existing: irmItemId, itemName, sku, uom, requestedQty, approvedQty, fulfilledQty ...

  // Per-line source (restock): the warehouse that ISSUES this line. Set on approve; defaults to the
  // request's warehouseId. Returns/walk-in: = req.warehouseId for every line (no split). Snapshots
  // for lists + the fulfil screen without a join.
  sourceWarehouseId   String? @db.ObjectId
  sourceWarehouseName String?
  sourceWarehouseCode String?

  // Per-warehouse close-short (spec §6): the source warehouse that owns this line may write off its
  // outstanding qty. Recorded ON THE LINE so the audit trail names who wrote off what, how much, why.
  closedShortQty  Int?    // qty written off (remaining at write-off time)
  closedShortBy   String? // actor email
  closedShortNote String?
  closedShortAt   DateTime?

  @@index([requestId])
  @@index([irmItemId])
  @@index([sourceWarehouseId]) // NEW — per-warehouse queue + fulfil lookups
}
```

`approvedQty` semantics extend: **`0` now means "excluded at approval"** (a line no warehouse could cover, or the manager chose to drop). Distinct from `null` (not yet approved) and from a fulfilled line. Excluded lines have `remainingQty = 0`, never appear on the fulfil/scan surface, and never hold the request open.

**Engineer visibility of an excluded line:** in the engineer's request detail (`EngineerVanStock` / the mine-list detail), a line with `approvedQty === 0` renders with an explicit **"Excluded"** tag. It is visually distinct from a fulfilled line (0 fulfilled of 0 approved must not read as "done ✓"). The *reason* is carried by the request-level `decisionNote` — the manager is prompted (soft, not enforced) to explain when they drop any line, so the engineer learns why (e.g. "CAT6 not in stock at any warehouse; re-raise separately"). The note is **request-level, not per-line** (matching how `decisionNote` works today for trims/approvals) — if a manager drops one line and trims another, a single note covers the decision. Per-line reason strings are out of scope (YAGNI; the tag + a request note suffices). This keeps the exclusion honest to the requester rather than silently vanishing.

### 3b. Request-level warehouse fields — meanings UNCHANGED

No renames. `warehouseId` keeps its FK relation and its cross-flow meaning; the per-line `sourceWarehouseId` carries the new truth for restocks. (An external review suggested renaming `warehouseId` → `primaryWarehouseId`; rejected because the field remains the *single true fulfilment warehouse* for returns and walk-in, where "primary" would read wrong, and because it is a Prisma `@relation` FK used by a shared cross-flow convention. Documenting the precise meaning here is the correct fix instead.)

| Field | Meaning |
|---|---|
| `preferredWarehouseId` | Engineer's collection preference (restock). Routes the **pending** request to that manager's queue. Unchanged. |
| `warehouseId` | **Returns / walk-in:** the single fulfilment warehouse (unchanged). **Restock after approve:** the *primary/default* source — confirmed by the reviewer, inherited as `sourceWarehouseId` by every line not explicitly re-sourced. |

## 4. Approval flow & re-sourcing (spec §2 of the conversation)

### 4a. UI — `VanRequestDetail` review zone (pending restock)

Extends the existing review zone (primary-warehouse select + per-line approve-qty) with a **per-line source picker + live shelf counts**:

```
Review — VSR-0005
Primary warehouse:  [ No-Mgr WH 467266 v2 ▾ ]   ← sets each line's default source

ITEM                      REQUESTED   APPROVE QTY   SOURCE WAREHOUSE
LC/UPC Fibre Connector        1          [1]        [ No-Mgr WH ▾ ]   197 on shelf ✓
CAT6 305m box                 2          [2]        [ London Log. ▾ ]  197 on shelf ✓   (re-sourced)
ffffgik…                      1          [0]        —  excluded (no stock anywhere)

[Decline]                                                         [Approve]
```

- **Primary-warehouse select** stays; changing it re-defaults every line not manually re-sourced.
- **Per-line SOURCE select** defaults to primary; options annotated with that warehouse's shelf count for the item, best-coverage first. Reuses the existing `availability(irmItemIds)` service (already returns per-warehouse per-item on-hand).
- **Shelf hint** per line: green "✓ N on shelf" when source ≥ approve-qty, amber when partial, red "⚠ 0 here / no stock" when empty — same colour logic as the composer's `CartTable`.
- **Approve-qty `0`** collapses the line to an **excluded** state (struck/greyed, "excluded" tag), removing its source requirement.

### 4b. Hard-block Approve gate

The gate is enforced in **two places** — the UI for immediate feedback, and the **backend approve API as the authority** (never trust client availability):

- **UI:** **Approve** is disabled until, for every line, `approvedQty === 0` **OR** `sourceShelf(line) ≥ approvedQty` (against the live `availability` snapshot the composer already loads). Immediate feedback; a manager can't even click Approve on a visibly under-stocked line.
- **Backend (authoritative):** `approve` **re-reads live on-hand** for each included line's chosen `sourceWarehouseId` inside the service and **rejects the whole approval** (`badRequest`, no partial approve) if any line has `sourceShelf < approvedQty`. This closes the TOCTOU window the UI can't: between the manager loading availability and clicking Approve, another warehouse could issue the same stock — the stale UI would pass, the backend catches it. See §4c for the exact check.

**Honest framing — this is defense-in-depth, not a hard guarantee.** Even the backend re-check is a point-in-time read: stock can still drop between a successful approve and the first scan (nothing reserves it — the base module deliberately doesn't reserve on approve). The **true integrity backstop remains the zero-floor guard at post** ([inventory.repository.ts:131](../../backend/src/modules/inventory/inventory.repository.ts)), which makes over-issue impossible regardless. The value of the backend approve-check is that it stops an *approval* from silently recreating the original dead-end (approved-but-unfulfillable) — matching the whole point of this redesign — rather than pretending approve can lock stock it doesn't reserve.

### 4c. API & persistence

`approveVanStockRequestSchema.lineApprovals` gains an optional per-line source, and relaxes the qty floor to `0`:
```ts
lineApprovals: {
  lineId: objectId,
  approvedQty: z.number().int().min(0).max(1_000_000),   // 0 = exclude (was min(1))
  sourceWarehouseId: objectId.optional(),                 // omitted ⇒ primary warehouseId
}[]
```
- `claimPendingForApproval` (repository) sets each line's `approvedQty` **and** `sourceWarehouseId/Name/Code` inside its existing atomic transaction. Unspecified source ⇒ request `warehouseId`.
- Source warehouse snapshots resolved **server-side** from the warehouse record (never trusted from the client); each must be an **active** warehouse or the approve is rejected.
- **Availability re-check (authoritative hard-block, §4b):** before claiming, the service reads live on-hand for each **included** line (`approvedQty > 0`) at its resolved `sourceWarehouseId` — `inventoryRepo.findBalancePair(irmItemId, sourceWarehouseId)` (or a batched `findBalancesByItemsAndWarehouses` over the distinct (item, source) pairs). If any line has `on-hand < approvedQty`, reject the **entire** approval with `badRequest` naming the offending line(s) (`"CAT6 305m box: only 0 in stock at London — refresh and adjust."`). No partial approve. This runs in the service just before `claimPendingForApproval`; a check-then-claim gap is acceptable because the zero-floor guard at post is the final backstop (the re-check exists to stop stale-UI approvals, not to reserve stock).
- **Access:** the approver must hold access to the **primary** warehouse (they own the request). They do **not** need access to a re-sourced warehouse — re-sourcing is a binding work order. The re-sourced warehouse's own team needs their normal access to see/scan it (§5).
- **`availability` endpoint** must be reachable by reviewers: today `GET /van-stock-requests/availability` is gated `engineer.van_stock.request` only. Widen it to also accept `van_stock_request.review` (the approval UI needs it).

## 5. Split fulfilment (spec §3 of the conversation)

### 5a. Queue ownership → line-level for approved restocks

`belongsToWarehouses(ids)` gains a line-level arm:

```
A request belongs in warehouse X's queue when:
  • status pending            → preferredWarehouseId ∈ ids          (unchanged — routing)
  • return / walk-in          → warehouseId ∈ ids                   (unchanged — single WH)
  • approved/partial restock  → lines: { some: { sourceWarehouseId ∈ ids } }   (NEW)
```

A split request legitimately appears in **multiple queues at once** — each warehouse that owns ≥ 1 line sees it. The frontend `VanRequestsBoard` already passes `warehouseId` to `listVanStockRequests`; no frontend query change — the new `some` arm lands entirely in the repository's `belongsToWarehouses`.

### 5b. Fulfil screen shows only *my* lines

When a warehouse opens a split request, the fulfil zone lists **only lines whose `sourceWarehouseId` the actor can access**. Other warehouses' lines render read-only as context ("CAT6 ×2 — sourced from London") so the whole picture is visible but only owned lines are actionable.

**`isMine` per line drives this split — computed server-side, not on the client.** Each `PublicVanStockLine` on a reviewer read carries:

```ts
sourceWarehouseId:   string | null;   // (from §3a — the issuing warehouse for this line)
sourceWarehouseName: string | null;
sourceWarehouseCode: string | null;
isMine:              boolean;         // sourceWarehouseId ∈ the actor's accessible warehouse scope
```

`isMine` is the **actionable-vs-read-only contract**: the fulfil UI enables scan/qty/post **only** for `isMine` lines and renders the rest as greyed context. It reuses the exact actor-scope set already threaded into `toPublic` for `myProgress` (§5c) — same set-membership test, same pass, no extra query and no shipping the actor's warehouse-id list to the browser (which would force the client to duplicate the scope logic). Rules: `isMine` is **`false` for the engineer's own read** (no warehouse role — nothing is theirs to fulfil), and for returns/walk-in it is simply "actor holds `req.warehouseId`" (their lines all carry `sourceWarehouseId = req.warehouseId`, so the same rule applies unchanged). The backend still enforces the boundary independently (`scanLookup` + per-entry access check below) — `isMine` is a rendering convenience, **never** the authority.

- **`scanLookup`**: currently matches the scanned item against `req.warehouseId` and reads that shelf. New: match the item to a line whose `sourceWarehouseId` the actor can access; read **that line's source** shelf. Reject if the item's line is sourced to a warehouse the actor can't access ("this line is fulfilled by <warehouse>").
- **`fulfil` / `postFulfilment`**: each entry decrements **its line's `sourceWarehouseId`** (not one request-level warehouse). `applyOutbound` is called with `line.sourceWarehouseId`. Access checked **per entry** — the actor must hold the line's source warehouse. The existing per-line remaining-qty guard inside the posting transaction is unchanged (only the warehouse each line points at changes).
- Damaged condition still rejected for restocks (returns only).

### 5c. Status — per-warehouse "done" + overall "fulfilled"

- **Overall recompute** (in `postFulfilment`, and after close-short/cancel) — the request is DONE (`→ fulfilled`) when **every** line satisfies one of:
  - `fulfilledQty >= approvedQty` (fully issued), OR
  - `approvedQty === 0` (excluded), OR
  - `closedShortQty` covers the remaining gap (written off by its source warehouse).
- **Per-warehouse progress is SERVER-COMPUTED and returned in the DTO** — not left for the client to derive. The client (the `VanRequestsBoard` tab, `VanRequestDetail`) does not know the actor's full warehouse scope; only the server does (via `warehouseScopeFilter(actor)`), so it must compute this. On the reviewer-facing reads (`getOne`, `listAll`), `toPublic` is passed the actor's accessible warehouse-id set and adds two derived blocks to `PublicVanStockRequest`:

  ```ts
  progress: {                       // OVERALL — every line, all warehouses
    lines: number;                  // total non-excluded lines
    linesDone: number;              // fulfilled or closed-short lines
    qty: number; qtyFulfilled: number;
  };
  myProgress: {                     // MINE — only lines whose sourceWarehouseId ∈ actor scope
    warehouseIds: string[];         // which of the actor's warehouses have lines here
    lines: number; linesDone: number;
    qty: number; qtyFulfilled: number;
    allMineDone: boolean;           // true ⇒ show "your part is complete" even while overall is partial
  } | null;                          // null for the engineer's own reads (no warehouse role)
  ```

  This directly answers "why is this still pending? I already finished" — the manager sees **`myProgress.allMineDone`** true while `status` is still `partially_fulfilled`. It is pure read-model math over the lines already loaded — no new stored status, no extra query.
- `completionType` (`complete | closed_short | cancelled_remaining`) stays the request-level summary; `closed_short` means ≥ 1 line was written off.

## 6. Closure & cancellation edge cases (spec §4 of the conversation)

### 6a. Close-short → per-warehouse portion

Today `finishRemaining` finalises the whole request (`updateMany` on `status`), and any accessor can call it — which under split would let one warehouse kill another's outstanding line. New rule:

- A warehouse's **close-short** writes off only **its own outstanding lines** (`sourceWarehouseId` the actor holds, `remainingQty > 0`), stamping `closedShortQty/By/Note/At` on each. A note is required (unchanged).
- The request flips to `fulfilled` only when **no** line anywhere has live remaining qty (the §5c predicate). Otherwise it stays `partially_fulfilled` with the other warehouses' lines still open.
- New repository method (e.g. `closeShortLines(requestId, warehouseIds, note, actorEmail)`) replacing the whole-request `finishRemaining` for the close-short path; it recomputes overall status in the same transaction. `cancel-remaining` keeps using the whole-request path.

### 6b. Cancel-remaining (engineer) — stays whole-request

The engineer's "I don't need the rest" is inherently about the whole request. Unchanged: cancels **all** outstanding lines across all warehouses at once, `completionType = cancelled_remaining`. No split.

### 6c. Decline — stays whole-request (pending only)

Decline happens at `pending`, before any sourcing exists. Unchanged: the collection/primary warehouse's manager declines the whole request with a note.

## 7. Realtime, worklist, audit

- **Realtime** `van_stock_request:updated` — unchanged payload (id, code, status, type) to the engineer + `OFFICE_JOBS_ROOM` on every transition/posting/close-short. The engineer sees one coherent status regardless of how many warehouses touched it.
- **Worklist / pending-count** — **no change needed.** The worklist surfaces only **pending** VSRs, which have no per-line source yet (sourcing happens at approval), so `pendingWorklist`'s existing `targetWarehouseCode = warehouseCode ?? preferredWarehouseCode` deep-link stays correct. Pending-count likewise counts pending requests by collection warehouse. (Only the *approved/partial* queue in `VanRequestsBoard` goes line-level, via §5a.)
- **Audit** — extend metadata, not the action set:
  - `van_stock_request.approved` metadata carries per-line `{ lineId, approvedQty, sourceWarehouseId }[]` (so the sourcing decision is auditable).
  - `van_stock_request.fulfilment_posted` already records item/qty/condition; add the source warehouse per entry.
  - `van_stock_request.closed_short` metadata carries the specific lines/qtys written off + the acting warehouse.

## 8. Testing (Vitest — backend `pnpm test`)

Pure-logic units, extending the existing suite:
- **Approve gate predicate**: enabled iff every line is `approvedQty === 0` or `sourceShelf ≥ approvedQty`; excluded (`0`) lines don't block.
- **Backend approve availability re-check (§4c)**: approve is rejected (`badRequest`, no partial) when an included line's live source on-hand `< approvedQty`, even if the (stale) client would have allowed it; excluded lines are skipped; a line exactly at `on-hand === approvedQty` passes.
- **Server-computed progress (§5c)**: `progress` counts all non-excluded lines; `myProgress` counts only lines whose `sourceWarehouseId` is in the actor's scope; `myProgress.allMineDone` is true when every owned line is fulfilled/closed-short while the request is still `partially_fulfilled`; `myProgress` is `null` for the engineer's own read.
- **`isMine` per line (§5b)**: true only for lines whose `sourceWarehouseId` is in the actor's scope; false for other warehouses' lines; false for **every** line on the engineer's own read; for returns/walk-in, true iff the actor holds `req.warehouseId`. `isMine` never widens backend authority — `scanLookup`/`fulfil` still reject an unowned line even if a forged payload set `isMine`.
- **Per-line source persistence**: unspecified source ⇒ primary; explicit source overrides; inactive warehouse rejected; `approvedQty` `min(0)` accepted, negative rejected.
- **Excluded-line mechanics**: `approvedQty 0` ⇒ `remainingQty 0`, absent from scan/fulfil, trivially "done" in the status predicate.
- **Split fulfilment**: an entry decrements *its line's* source warehouse; posting a line whose source the actor can't access is rejected; the two-warehouse request reaches `fulfilled` only after both lines post.
- **`belongsToWarehouses`**: an approved split request matches BOTH source warehouses' queues; a pending request still matches only its collection warehouse.
- **Per-warehouse close-short**: writing off warehouse A's lines leaves warehouse B's line open (`partially_fulfilled`); once B fulfils/closes, the request is `fulfilled` with `completionType closed_short`; A cannot write off B's line.
- **Status recompute** across the three "done" routes (fulfilled / excluded / closed-short) mixed on one request.
- Zod validation tests for the extended `approveVanStockRequestSchema` (per-line source, qty 0).

Flow verification: `pnpm typecheck` + `pnpm lint`, `pnpm prisma:generate` after the schema change, and a manual run of the approval-with-re-source + split-fulfilment path against a dev DB (the two-warehouse "1/3 in stock" scenario from §1, end to end).

## 9. Decision log

Accepted:
- Per-line `sourceWarehouseId` on the line, request `warehouseId` = default/primary source (not renamed).
- Warehouse-only sourcing; no van-to-van/procurement/line-splitting in v1.
- Returns & walk-in stay single-warehouse.
- Work-order re-sourcing (no target consent); zero-floor guard is the integrity backstop.
- Hard-block approve (every included line fully sourced) + approve-qty `0` = excluded as the escape hatch.
- **Hard-block enforced on the backend, not only the UI** (§4b/§4c) — approve re-reads live source on-hand and rejects stale-UI approvals; framed as defense-in-depth over the zero-floor guard, not stock reservation. (Added on external review — correct: the spec had described the gate as "a UX guarantee, not a lock," which would let a stale client recreate the approved-but-unfulfillable dead-end.)
- **Server-computed `progress` + `myProgress`** on reviewer reads (§5c) — "your part done" vs "overall" so a manager isn't confused by a still-`partially_fulfilled` request they've finished. (Added on external review — correct: the client can't derive it, as it doesn't know the actor's warehouse scope.)
- Split fulfilment with multi-queue visibility; per-warehouse close-short with per-line audit fields.

Rejected:
- **Rename `warehouseId` → `primaryWarehouseId`** — keeps its true single-warehouse meaning for returns/walk-in and is an FK relation; precise documentation is the right fix (§3b).
- **Non-blocking approve** (allow approving under-stocked lines) — the whole point of the redesign is to kill the silent post-time dead-end; hard-block + drop-line is the owner's choice.
- **Auto-suggest a source warehouse** — manager stays explicitly in control; 0-stock defaults to primary (flagged), re-sourced by hand.
- **Per-line source for returns** — an engineer drops stock at one physical warehouse; splitting is meaningless.
