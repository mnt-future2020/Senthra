# Van Stock Request (Engineer ↔ Warehouse, non-job) — Design

**Date:** 2026-07-14
**Status:** Draft for review
**Owner:** Shahul

## 1. Purpose & Problem

Every path stock takes to or from an engineer's van today is either **job-scoped** or **van-to-van**:

| Existing flow | Covers |
|---|---|
| `JobStockMovement` (Goods Management, GM-####) | Issue / return / consume — always requires a `jobId` |
| `JobKitRequest` (JKR-####) | FE asks for *more kit on an existing job* |
| `EngineerStockTransfer` (ENG-####) | Van → van, holder approves — no warehouse leg |

There is **no path** for the everyday non-job case: an engineer whose van consumables are low (cable ties, screws, tape), whose tool broke, or who simply wants to hand excess van stock back to a warehouse. The ledger anticipated this — `EngineerStockTransaction.type` comments say `(future: usage, return, transfer_in, transfer_out)` — but the flow was never built. Industry equivalents: Salesforce FS *Product Request/Transfer + Return Order*, Dynamics 365 FS warehouse→truck *Inventory Transfer + RMA*, SAP FSM *stock request with approval* — i.e. **van/trunk stock replenishment**, where the job link is optional, not mandatory.

Reference scenario: *Engineer Ravi is out of cable ties and his crimping tool broke — no job needs them. He raises VSR-0007 (Cable Ties ×100, Crimping Tool ×1, reason + photo). The Chennai warehouse manager approves (trims to 60 ties — that's what's on the shelf), scans them out; Ravi's van balance rises, warehouse balance falls, both ledgers carry `VSR-0007`. The remaining 40 ties are issued next week (partial fulfilment → fulfilled). Two weeks later Ravi returns 40 excess ties — warehouse scans them in, 35 good back to usable stock, 5 damaged to the damaged pool with photo + reason.*

## 2. Scope

**In scope (v1)**
- **Restock**: engineer requests company IRM items → warehouse reviews (approve with per-line trim / decline) → warehouse fulfils by barcode scan-out, **incrementally** (multiple postings until fulfilled or closed short).
- **Return**: engineer offers items from their on-hand back to a warehouse → warehouse fulfils by scan-in with per-line good/damaged split (photo + reason mandatory for damaged). No approval gate — fulfilling *is* accepting; `declined` exists for refusal.
- **Walk-in**: a warehouse user with the review permission creates-and-approves a VSR for an engineer at the counter in one step (auto-approved, `reviewedBy` = the actor), then fulfils normally. Traceability identical to the request path.
- Worklist integration, priority, duplicate-warning, stale indicators, audit, realtime.

**Out of scope / non-goals** (see §13 decision log)
- **Customer consignment stock** — company IRM only. The customer-side warehouse ledger is a known, deliberately deferred gap; VSR must not touch `CustomerStockEntry`.
- **Serial/batch-tracked items** — rejected at scan, exactly as Goods Management does today.
- **Misc/free-text lines** — every VSR line must decrement real warehouse inventory; misc is meaningless here.
- **Job references of any kind** — if stock is for a job, JKR is the correct path (it grows kit lines and feeds job tallies). A job ref on VSR would bypass reconciliation.
- **Stock reservation on approve** — GM doesn't reserve; availability is enforced at posting time by the `InventoryBalance` zero-floor guard.
- **Auto-expiry status / scheduler** — the backend has no job scheduler and runs serverless; staleness is a *derived* read-time indicator (§9), retired manually via decline / cancel / close-short.
- **Email** — realtime + worklist only, consistent with JKR and GM.

## 3. Core Model

One new model pair in a new module `backend/src/modules/van-stock-request/`. **No new movement model** — the VSR is itself the source document (like `StockAdjustment`); all balance/ledger writes go into the existing ledgers.

```
VanStockRequest {
  id            ObjectId
  code          String    // VSR-#### (atomic Counter pattern, same as JKR/GM/TRF)
  type          String    // restock | return
  status        String    // pending | approved | partially_fulfilled | fulfilled | declined | cancelled
  priority      String    // normal | high | urgent  (default normal)
  createdVia    String    // engineer_request | walk_in  (immutable, set at create — reporting/audit)

  // Requester (the engineer) — snapshots, history-safe
  engineerId    ObjectId   // relation to User
  engineerName  String
  engineerEmail String?

  // Warehouse: engineer states a PREFERENCE; reviewer confirms/overrides on approve.
  preferredWarehouseId ObjectId?   // loose socket — engineer's hint ("I'm near Chennai")
  warehouseId   ObjectId?   // relation — FINAL warehouse, set on approve (restock) or create (return)
  warehouseName/warehouseCode String?  // snapshots once final

  reason        String     // free text (consistent with JKR / EngineerStockTransfer)
  notes         String?
  attachments   String[]   // request-level evidence (Cloudinary URLs, e.g. broken-tool photo)

  // Review
  reviewedByUserId ObjectId?
  reviewedByEmail  String?
  reviewedAt    DateTime?
  decisionNote  String?

  // Fulfilment / closure
  lastFulfilledAt DateTime?  // stamped on every posting (drives the stale indicator)
  completionType String?    // complete | closed_short | cancelled_remaining — set when status → fulfilled
  closedShortBy  String?     // actor email — warehouse closed with qty outstanding
  closedShortAt  DateTime?
  closeShortNote String?
  cancelledAt   DateTime?

  lines         VanStockRequestLine[]
  createdBy     String?
  deletedAt     DateTime?
  createdAt/updatedAt
  @@index([status]) @@index([engineerId, status]) @@index([warehouseId, status]) @@index([createdAt])
}

VanStockRequestLine {
  id            ObjectId
  requestId     ObjectId   // relation
  irmItemId     ObjectId   // loose socket — company IRM only
  itemName      String     // snapshot
  sku/uom       String?    // snapshot
  requestedQty  Int        // what the engineer asked for / offered to return
  approvedQty   Int?       // set on approve (reviewer may trim); returns: set = requestedQty on create
  fulfilledQty  Int        // accumulates across postings, default 0

  // Return fulfilment only — per POSTED line-portion (see §6 return posting):
  //   good/damaged split is captured at scan time; damaged requires photo + reason (GM rules).
}
```

**Return fulfilment lines.** A return posting may split one requested line into good and damaged portions with distinct photos/reasons. To keep per-posting detail without a movement model, each posting appends rows to an embedded/companion collection:

```
VanStockFulfilment {           // one row per POSTING event on a request
  id, requestId, sequence      // 1, 2, 3… per request
  performedBy  String          // actor email
  postedAt     DateTime
  lines: [{
    lineId       ObjectId      // the VanStockRequestLine fulfilled
    qty          Int
    condition    String        // good | damaged   (restock: always good)
    damagePhotoUrl String?     // required when damaged (Cloudinary URL, ≤2000 chars)
    damageReason   String?     // required when damaged
    scannedCode    String?     // decoded barcode
  }]
}
```

This mirrors what `JobStockMovementLine` records for GM, scoped to VSR. It is a separate Prisma model (`@@index([requestId])`); the ledgers remain the analytical source of truth.

## 4. State Machine

```
                engineer creates (restock: preferredWarehouse optional)
                (walk-in: reviewer creates → lands directly in approved)
                         │
                         ▼
   engineer cancels ┌─────────┐  reviewer approves (restock: sets final warehouse,
        │           │ pending │  may trim approvedQty per line; return: auto-approved
        ▼           └─────────┘  concept — see below)
  ┌───────────┐          │ reviewer declines (with note)
  │ cancelled │          ▼                          ┌──────────┐
  └───────────┘    ┌──────────┐                     │ declined │
                   │ approved │◄────────────────────└──────────┘ (terminal)
                   └──────────┘
                         │ first posting < full ────────► ┌─────────────────────┐
                         │                                │ partially_fulfilled │◄─┐
                         │ posting completes all lines    └─────────────────────┘  │ further postings
                         ▼                                   │        │  └─────────┘
                   ┌───────────┐  ◄── final posting ─────────┘        │
                   │ fulfilled │                                      │ close short (warehouse, note)
                   └───────────┘  ◄── cancel remaining (engineer) ────┘
```

- **Returns skip the review step**: created directly with the target warehouse and `approvedQty = requestedQty`, status `pending`; the warehouse either fulfils or declines with a note. **For returns, fulfilment postings are valid from `pending`** — the first scan-in *is* the acceptance event and moves the request straight to `partially_fulfilled`/`fulfilled`; returns never enter `approved`. They appear in the same worklist queue as restocks.
- **Terminal states:** `fulfilled`, `declined`, `cancelled`. `fulfilled` includes closed-short / cancelled-remaining requests — `completionType` (`complete | closed_short | cancelled_remaining`) records how it got there, and the outstanding delta stays visible from `approvedQty − fulfilledQty` plus the `closedShort*` stamps.
- **Concurrency:** approve/decline/cancel use the atomic `claimPending` pattern (JKR): `updateMany` guarded on current status; loser matches 0 rows → `conflict`. Cancel additionally guards `engineerId` = actor.
- **Cancel remaining** (engineer) and **close short** (warehouse, note required) are only valid from `partially_fulfilled`; plain cancel is only valid from `pending`.

## 5. Restock Fulfilment (scan-out)

Warehouse user opens an `approved`/`partially_fulfilled` restock, scans items (same `ScannerInput` + scan-lookup UX as GM issue), builds a posting, posts. Posting runs in **one Mongo transaction** (`withTransaction`), per line:

1. Re-validate qty ≤ `approvedQty − fulfilledQty` (server-side, not just UI).
2. `inventoryService.applyOutbound(tx, { irmItemId, warehouseId, quantity, sourceType: "van_stock_request", sourceId, sourceCode: "VSR-####", createdBy })` — warehouse balance − qty, inventory ledger row. The zero-floor guard throws `conflict` if the shelf can't cover it.
3. `engineerStockRepo.upsertEngineerBalanceTx(tx, irmItemId, engineerId, +qty)` then `insertEngineerTxnTx(tx, { type: "van_restock", quantityDelta: +qty, sourceType: "van_stock_request", sourceId, sourceCode, balanceAfter, createdBy })`.
4. Increment `fulfilledQty`, append the `VanStockFulfilment` row, stamp `lastFulfilledAt`, recompute status (`partially_fulfilled` | `fulfilled`).

Failure anywhere rolls back the whole posting; the request stays `approved`/`partially_fulfilled` and the posting is simply retried — same recovery model as GM. No separate "in fulfilment" state exists or is needed.

## 6. Return Fulfilment (scan-in)

Create-time validation: each offered line qty ≤ the engineer's `EngineerStockBalance.quantityOnHand` (advisory — the binding check is at posting). Posting, per scanned line-portion, in one transaction:

1. Re-check engineer holds ≥ qty (`findEngineerBalanceTx`); drain: `upsertEngineerBalanceTx(tx, irmItemId, engineerId, −qty)` + engineer ledger row `type: "van_return"`, `quantityDelta: −qty`, `sourceType: "van_stock_request"`.
2. `condition = good` → `inventoryService.applyInbound(tx, …)` credits the warehouse back to usable stock (inventory ledger row).
3. `condition = damaged` → damaged pool, never usable stock: `upsertDamagedBalanceTx(tx, { warehouseId, ownerType: "company", irmItemId, itemName }, qty)` + `insertDamagedTxnTx(tx, { quantityDelta: +qty, reason: damageReason, photoUrl: damagePhotoUrl, sourceType: "van_stock_return", sourceId, sourceCode, balanceAfter, createdBy })`. Photo + reason are **mandatory** for damaged portions (GM rules; photo uploaded via the damage-photo endpoint pattern → Cloudinary `senthra/damage-photos`, URL ≤2000 chars).
4. Same accumulation/status mechanics as §5.

Because both flows write only the existing append-only ledgers, **Stock Movement History and the Inventory Hub pick VSR activity up automatically** — new `sourceType` values (`van_stock_request`, `van_stock_return`), zero new aggregation logic.

## 7. Barcode Validation Rules (fulfilment)

Explicit, both directions — mirrors GM `scanLookup`:

1. Decode → `irmService.findActiveByCodeOrBarcode(code)`. Unknown/inactive code → reject with message.
2. Serial- or batch-tracked items → reject (unsupported in v1, same as GM).
3. The item must match an open line on **this** request (`approvedQty − fulfilledQty > 0`); otherwise reject ("not on this request" / "already fully fulfilled").
4. Qty entry capped at `approvedQty − fulfilledQty` per line (UI + server).
5. Restock: shelf availability is *displayed* at scan time but *enforced* at post by the zero-floor guard. Return: engineer's on-hand is enforced at post by the engineer-balance floor guard.
6. Manual entry (type the code) and camera decode both allowed — `ScannerInput` already supports hardware wedge / camera / photo-decode.

## 8. Duplicate-Request Warning (non-blocking)

Pinned semantics: at compose time (and re-checked on submit), if the engineer has any **open** request (`pending`/`approved`/`partially_fulfilled`) of the **same type** containing the **same `irmItemId`**, the UI warns: *"You already have an open request for Cable Ties (VSR-0007). Create anyway?"* — proceed or go back. Never blocks; no merge workflow. Server exposes this via a lightweight `open-lines?irmItemIds=…` check endpoint (or piggybacked on the mine-list already loaded).

Reviewer-side context: the review screen lists the engineer's **other open VSRs**, so a reviewer can spot duplicates the engineer chose to create anyway.

## 9. Stale-Request Indicator (derived, no scheduler)

No `Expired` status, no cron. Staleness is computed at read time from existing timestamps:

- `pending` older than **7 days** → stale (reviewer is sitting on it).
- `approved`/`partially_fulfilled` with no posting activity (`lastFulfilledAt ?? reviewedAt`) for **30 days** → stale (approved but never collected).

Thresholds are module constants (not Settings — YAGNI until someone asks). Surfaces: a "stale" chip in the warehouse queue + engineer's mine-list, and the Overview worklist already ages items (`ageDays`, oldest-first banding) so stale requests naturally rise. Humans retire them with the existing exits: decline, cancel, close short.

## 10. Permissions, Seeding

Two new keys in `backend/src/modules/role/permissions.ts`:

- **`engineer.van_stock.request`** — Engineer Portal group. Create restock/return, cancel own pending, cancel-remaining own partially_fulfilled, view own requests, item search.
- **`van_stock_request.review`** — Goods Management category. Queue, detail, approve/decline, fulfil (scan + post), close short, walk-in create, pending-count.

Seeding (`backend/src/db/seed.ts`): `engineer.van_stock.request` → engineer role backfill alongside its existing perms; `van_stock_request.review` → `warehouse_manager` + `systemAdmin`, idempotent backfill, same pattern as `GOODS_MANAGEMENT_PERMISSIONS`. Frontend: add `van_stock_request.review` to `OVERVIEW_PERMS` in `lib/auth.ts` in lockstep.

## 11. API Surface (base `/van-stock-requests`)

| Method / path | Perm | Notes |
|---|---|---|
| GET `/mine` | `engineer.van_stock.request` | own requests, status filter |
| GET `/item-search?q=` | `engineer.van_stock.request` | active, non-serial/batch IRM catalogue |
| GET `/my-holdings` | `engineer.van_stock.request` | on-hand balances (return composer source) |
| POST `/` | `engineer.van_stock.request` | create restock (preferredWarehouseId?) or return (warehouseId required) |
| POST `/attachments` | `engineer.van_stock.request` | Cloudinary upload → URL |
| POST `/:id/cancel` | `engineer.van_stock.request` | pending only, own only |
| POST `/:id/cancel-remaining` | `engineer.van_stock.request` | partially_fulfilled only, own only |
| GET `/` | `van_stock_request.review` | queue (status/type/warehouse filters) |
| GET `/pending-count` | `van_stock_request.review` | badge |
| GET `/:id` | any of the two perms | service scopes: requester OR reviewer |
| POST `/:id/approve` | `van_stock_request.review` | restock only; final warehouseId + per-line approvedQty trims |
| POST `/:id/decline` | `van_stock_request.review` | note required |
| POST `/scan-lookup` | `van_stock_request.review` | §7 rules, request-scoped |
| POST `/:id/fulfil` | `van_stock_request.review` | posting (§5/§6); damage photo URLs inline per line |
| POST `/:id/close-short` | `van_stock_request.review` | partially_fulfilled only, note required |
| POST `/walk-in` | `van_stock_request.review` | create pre-approved for a chosen engineer |
| POST `/damage-photo` | `van_stock_request.review` | Cloudinary upload → URL |

Standard middleware chain throughout: `writeLimiter → requireAuth → requirePermission → validateBody`.

## 12. Worklist, Realtime, Audit, Frontend

- **Worklist:** new `WorklistKind` `review_van_stock_request` in `dashboard/worklist.ts`; repo `pendingWorklist()` (pending, cap 50, oldest-first) feeding `buildDashboardSummary` behind `can("van_stock_request.review")`; `priority` maps straight into the existing high/urgent band; `href` → the warehouse queue page.
- **Realtime:** `van_stock_request:updated` (payload: id, code, status, type) → `emitToUser(engineerId, …)` + `emitToRoom(OFFICE_JOBS_ROOM, …)` on every transition and posting. No email.
- **Audit:** `van_stock_request.created / .approved / .declined / .cancelled / .fulfilment_posted / .closed_short / .cancelled_remaining / .walk_in_created` via `audit.record`, with code as `targetLabel`.
- **Frontend — engineer:** new `ENGINEER_NAV` item "Van Stock" → `/dashboard/engineer/van-stock`: mine-list with status/stale chips; "Request stock" composer (catalogue search + qty cart, reason, priority, optional preferred warehouse, attachments — the `EngineerKitRequests` `RequestModal` pattern); "Return stock" composer pre-loaded from `/my-holdings` (can only return what they hold); duplicate warning (§8); cancel / cancel-remaining actions.
- **Frontend — warehouse:** "Van Requests" page beside Goods Management (perm-gated by `van_stock_request.review`): queue with type/status/priority/stale filters; review screen (per-line trim, final warehouse, decline-with-note, engineer's other open VSRs shown); fulfil screen reusing `ScannerInput` + GM scan-panel pattern, good/damaged toggle + damage photo capture on returns; close-short; walk-in create. Live updates via `subscribe(["van_stock_request:updated"], …)`.

## 13. Decision Log (external-review triage)

Accepted from review: partial fulfilment (matches GM's incremental issue), cancel-remaining/close-short semantics, warehouse as preference-confirmed-at-review (matches JKR), priority (worklist band already exists), non-blocking duplicate warning (pinned semantics, §8), stale indicator in derived form (§9), explicit barcode rules (§7), `completionType` (disambiguates the three routes into `fulfilled` without qty-diffing), `createdVia` (`engineer_request | walk_in` — precedent: `EngineerStockTransfer.requestedByKind`).

Rejected, with reasons:
- **Optional job reference** — actively harmful: bypasses JKR/kit attribution; job-bound stock must go through JKR.
- **Reason category enum** — YAGNI; no consumer; optional fields rot; free text matches JKR/ENG precedent.
- **`received` intermediate state for returns / separate return acceptance step** — scan-in *is* receipt *is* posting (atomic); `declined` covers refusal; a pre-acceptance click is pure friction.
- **"In Fulfilment" state** — impossible-state insurance: posting is one transaction, retry-from-`approved` is the recovery model (JKR precedent).
- **Extra sourceType/sourceId provenance on the request** — already exists on every ledger row; speculative duplication.
- **Auto-expiring `Expired` status** — requires a scheduler that doesn't exist on a serverless deployment; derived staleness + manual exits instead.
- **Merge-duplicates workflow** — no stated need; warning + reviewer context suffices.
- **Rename to `InventoryRequest`** — collides with the `inventory` module's domain and `PurchaseRequest`; the codebase already committed to "van stock" vocabulary (reserved `van-stock-count` module); the precise name *is* the scope boundary against warehouse↔warehouse / customer-stock creep.

## 14. Amendment (2026-07-14, post-build review)

Revised with the owner after build, on the observation that **super admin does not work this queue — every real reviewer is a warehouse-scoped manager**, so "pending visible to every reviewer" left pending requests with no owner:

- **Preferred (collection) warehouse is REQUIRED on restock create** (§3/§4 "optional hint" is superseded). It ROUTES the pending request: a request *belongs to* its final warehouse once set, else the collection warehouse. Name/code snapshots (`preferredWarehouseName/Code`) are stored for lists and worklist links.
- **All reviewer surfaces scope by that ownership rule**: queue list, pending-count badge, dashboard worklist, `getOne`, and `decline` — a manager only ever sees/acts on requests their warehouses own. Admin (`*`) remains the global backstop.
- **The queue UI lives in the warehouse detail's "Van Requests" tab** (beside Goods Management), with the walk-in warehouse pre-fixed to that warehouse. The top-level `/dashboard/van-requests` page and nav item are REMOVED — one queue surface, no duplication. Worklist rows deep-link to `/dashboard/warehouses/<code>?tab=van`.
- Trade-off accepted: a request routed to a warehouse whose manager is absent is seen by no one else (mitigations: stale chip, admin backstop) — standard for location-routed queues (Salesforce FS / D365 route by the location on the record the same way).

## 15. Testing

Vitest units (backend `pnpm test`) for the pure logic: status-transition guards (incl. atomic-claim conflict paths), trim rules (`approvedQty ≤ requestedQty`, ≥ 1), fulfilment arithmetic (`fulfilledQty` accumulation, status recompute, over-post rejection), return-qty-vs-on-hand validation, damaged-line photo/reason requirement, duplicate-warning matcher, stale-indicator thresholds. Zod validation tests mirror `engineer-transfer.validation.test.ts`. Flow verification: `pnpm typecheck` + `pnpm lint` + manual run of both composers and both fulfilment paths against a dev DB.
