# Job Additional-Kit Request (FE → PM) — Design

**Date:** 2026-07-06
**Status:** Draft for review
**Owner:** Shahul

## 1. Purpose & Problem

A job's kit is planned up front, then **issued** to the field engineer (FE) from the warehouse (Goods Management). But mid-job the FE often needs **more** — extra units of an item already on the kit, or a brand-new item nobody planned for.

Today the only way to grow a job's kit is **edit-job** (`job.service.ts` `updateJob`), which has two gaps for this scenario:

1. **Only the planner can initiate it.** The FE on-site who discovers they're short has no in-app way to say so — they phone/message the office, who then edits the job. The request itself is never captured.
2. **No traceability of who asked or why.** The `job.updated` audit entry does **not** record the kit-line diff, so afterwards you cannot tell that the FE requested extra and received it. (See §10 — this is a standalone gap worth closing regardless.)

We want an in-app **FE requests → PM approves → fulfil → audit** flow that sits *in front of* the existing kit + issue machinery, reusing it rather than replacing it. Edit-job stays as the planner's top-down tool; this is the bottom-up (FE-initiated) path. Both mutate the same `JobKitLine` via the same merge logic.

Reference scenario: *FE on JOB-2026-0015 has been issued the kit, but needs +3 CAT6 and 1 new item → raises a request on the job → PM reviews (sees who/what/why) → PM approves and picks fulfilment: issue from a warehouse, or pull from another engineer's van → the extra shows on the job's kit tallies and every step is audited.*

## 2. Scope

**In scope**
- FE-initiated request for additional kit **on an existing, in-flight job** (status `accepted` / `in_progress`; goods not yet `reconciled`).
- PM review → approve / decline. On approve: grow the job's `JobKitLine` and open a fulfilment.
- Two fulfilment modes, **both rolling into the job's kit tallies**:
  - **Warehouse issue** — the existing Goods Management `postIssue` path (unchanged).
  - **Engineer→engineer transfer** — the existing `EngineerStockTransfer`, **extended to be job-scoped** so the received qty attributes to the job kit line (§6 — the one genuinely new piece).

**Out of scope / non-goals** (see §12)
- Any change to procurement (Purchase Orders stay supplier→warehouse; never job-linked). If the *warehouse* is short, that's ordinary replenishment (raise a PO to restock the warehouse), decoupled from this flow.
- Notifications system (reuse the existing realtime + inbox pattern, as the engineer-transfer spec did).
- Misc/free-text items as a *transfer* source (same restriction as engineer-transfer today).

## 3. Core Model

One new model pair in a small module `job-kit-request` (or folded into `job/` — see §11), plus a **small extension to the existing `EngineerStockTransfer`**.

```
JobKitRequest {
  id            ObjectId
  code          String   // JKR-#### (atomic Counter, like GM/TRF/ENG)
  status        String   // pending | approved | declined | cancelled

  jobId         ObjectId    // REQUIRED — this is what makes it job-scoped
  job           Job         // relation
  jobNumber     String      // snapshot (JOB-YYYY-####)

  // Requester (the FE)
  requestedByEngineerId/Name/Email   // snapshots, history-safe

  reason        String      // why the extra is needed (captured — the missing signal)
  notes         String?
  attachments   String[]    // optional evidence (Cloudinary), same as engineer-transfer

  // Review (the PM / planner)
  reviewedByUserId/Email     // who approved/declined
  reviewedAt    DateTime?
  decisionNote  String?
  fulfillmentMode String?    // "warehouse_issue" | "engineer_transfer" (set on approve)

  lines         JobKitRequestLine[]
  createdBy     String?
  deletedAt     DateTime?
  createdAt/updatedAt
  @@index([jobId, status]) @@index([requestedByEngineerId, status]) @@index([status]) @@index([createdAt])
}

JobKitRequestLine {
  id            ObjectId
  requestId     ObjectId
  source        String       // irm | customer_stock | misc  (mirrors JobKitLine.lineType)
  irmItemId     ObjectId?    // when irm
  customerStockEntryId ObjectId?  // when customer_stock (loose socket)
  itemName      String       // snapshot
  sku/uom       String?      // snapshot
  qty           Int
  preferredWarehouseId ObjectId?  // optional hint for warehouse-issue fulfilment

  // Wired on approve → links this request line to the kit line it grew:
  jobKitLineId  ObjectId?    // the resulting/updated JobKitLine
}
```

**Extension to `EngineerStockTransfer` (existing model, `schema.prisma:1036`):**
- `jobId` already exists as an "optional reference" tag — now used **meaningfully** when the transfer is job-scoped.
- **New field on `EngineerStockTransferLine`:** `jobKitLineId ObjectId?` — the kit line this transfer line fulfils. Present ⇒ this is a job-scoped transfer and completion must write the attribution movement (§6).

No other model needs new fields — the tally/demand/goodsStatus machinery already keys entirely off `JobStockMovement` (§6).

## 4. State Machine

```
                 FE creates (on an accepted / in_progress job)
                          │
                          ▼
                      ┌────────┐   PM approves ─► grow JobKitLine ─► open fulfilment ─► ┌──────────┐
    requester cancels ─┤ pending├──────────────────────────────────────────────────────►│ approved │
         │             └────────┘                                                        └──────────┘
         ▼                  │ PM declines (with note)                                          │
   ┌──────────┐             ▼                            fulfilment completes (warehouse issue
   │cancelled │       ┌──────────┐                       OR job-scoped engineer transfer)
   └──────────┘       │ declined │                       → job's Issued tally rises (§6)
                      └──────────┘
```

- **One approval** — the **PM / planner** (`jobs.kit_request.review`). The FE may **cancel** while pending.
- **Approve is two atomic effects, in order:** (1) grow the kit via the existing merge (§5), so a `jobKitLineId` exists to attribute to; (2) open the chosen fulfilment. If fulfilment is a transfer, the transfer's own holder-approval still applies (§6) — so `approved` here means "request accepted & kit grown & fulfilment opened," not "stock delivered."
- **Stock is not reserved while pending.** Availability is re-checked at the fulfilment step (existing behaviour in both `postIssue` and transfer completion).
- **Guard:** a request can only be raised/approved while the job is editable for goods — not `completed`/`cancelled`, goods status not `reconciled` (mirrors the edit-job lock at `job.service.ts:602-608`).

## 5. Growing the kit (reuse edit-job, no new plan logic)

On approve, the request lines feed the **existing** kit-merge path — do **not** reinvent it:

- `job.repository.ts` `mergeKitLines` (`:241`) + the edit-job diff (`diffKitLines`, `job.service.ts:574`) — appends a new `JobKitLine` or **increases** an existing one.
- The **issued-line lock** already enforced by edit-job (`job.service.ts:718-731`; UI `JobForm.tsx`) applies unchanged: an already-issued line can only go **up**, never down/removed. A request that only *adds* or *increases* is always safe.
- The availability cap (`availableForLine`) is re-checked for the increment, exactly as edit-job does.

Net: the request is just a *governed, FE-initiated trigger* for the same mutation the planner does by hand — with a captured requester + reason + approval.

## 6. The one new piece — job-scoped engineer transfer that counts

**Why anything is needed:** a job's **Issued** tally is computed *purely* from `JobStockMovement` rows with `direction: "issue"` carrying a `jobKitLineId` — see `getJobKitTallies` (`goods-management.service.ts:74-124`), `kitLineSplit` (`:49-63`), and `getOpenDemand` (`:156`, issued-sum `:168-173`). Today `completeTransferOnce` (`engineer-transfer.repository.ts:436-550`) moves only van balances (`transfer_out`/`transfer_in`) and **writes no `JobStockMovement`** — so a plain engineer transfer never shows on the job. That's the gap.

**The fix (attribution-only movement):** when a transfer is job-scoped (`jobKitLineId` present on its lines), extend the completion transaction so that — *in the same `withTransaction`* — it also writes a **posted `JobStockMovement`** with `direction: "issue"`, `engineerId` = recipient (the FE), `warehouseId: null` (it came from a van, not a warehouse), `notes: "via ENG-####"`, and one line per transfer line carrying `{ jobKitLineId, source, itemId, qty }`.

**Critical: no double-count.** This movement is **attribution only** — it does **not** credit the engineer balance. The `transfer_in` step already credited the recipient's `EngineerStockBalance` / `EngineerCustomerStockHolding`. So:
- **Issued** rises (the attribution movement) ✔
- **Held / Remaining** is already correct because `getJobKitTallies` caps remaining at the engineer's *actual* on-hand (`:89-120`), which the `transfer_in` set ✔
- **Open demand** for that kit line drops (gross-issued rises) — no double-promising ✔
- **Start-work gate** (`startJobForEngineer`, "collect the kit first") is satisfied for transfer-fulfilled lines ✔
- Later **consume** on job-complete drains the balance and moves the line to `used`, exactly as a warehouse-issued unit would ✔

**Also update `JobStockSummary.goodsStatus`** in the same tx (→ `partially_issued` / `issued`), mirroring what `postIssue` does at `:518-529`.

**Implementation seam:** do the write inside `completeTransferOnce` via a shared movement-writer helper (the same one `postIssue` uses to allocate `GM-####` + insert the movement/lines), guarded by `if (line.jobKitLineId)`. Keep it atomic with the balance moves — never a second transaction.

**Design note to validate in review:** an `issue` movement with `warehouseId: null` is new (today only `consume` is warehouse-less). Confirm no reporting/return path assumes every `issue` has a warehouse; if any does, either tolerate null (attribute to "engineer transfer") or introduce a dedicated `direction` and teach the three tally readers to treat it like `issue`. The null-warehouse route is preferred (zero change to the readers).

**Warehouse-issue fulfilment needs nothing new** — PM approves, request line references the grown `jobKitLineId`, warehouse issues via the existing `postIssue`; it already writes the movement, audits, and rolls into tallies.

## 7. Surfaces

### 7a. Engineer portal (new write on the job)
- `EngineerJobDetail.tsx` gains a **"Request more items"** action (today there's no such button — actions are only accept/reject/start/complete). Opens a small form: pick item(s) (from the job's existing kit for "more of", or search IRM/customer for new), qty, reason, optional notes/attachments.
- `POST /engineer/jobs/:id/kit-requests` → creates a `pending` `JobKitRequest`, engineer-scoped (requester = session principal, like every other `engineer.*` route).
- A **"My kit requests"** view (or a section on the job) showing status; **Cancel** while pending. Live-refreshed via the existing `useGoodsSocket`.

### 7b. PM / planner review queue
- A **review list** (natural home: alongside the Goods Management / Demand board, since that's where the warehouse/planner already works) filtered to `pending`, showing FE, job, items, reason, age.
- **Approve** (choose fulfilment mode; for transfer, pick source engineer via the existing holders-discovery search) / **Decline** (with note).
- Gated by `jobs.kit_request.review`.

## 8. Cross-cutting

- **Audit** — `audit.record` at every transition: `job_kit_request.created` (FE), `job_kit_request.approved` / `job_kit_request.declined` / `job_kit_request.cancelled` (PM/FE), with `targetType: "job"`, `targetId: jobId`, `targetLabel: jobNumber`, and metadata `{ requestCode, requesterEmail, reviewerEmail, lines }`. The downstream fulfilment keeps its own existing audit (`goods_management.issued` for warehouse; `engineer_transfer.*` for transfer). **Net: the full story is traceable** — who asked, why, who approved, how it was fulfilled.
- **Realtime** — emit to the requester FE, the source engineer (if transfer), and the office room on each state change, reusing the `goods:*` socket events the portal already listens to.
- **Codes** — `JKR-####` via the shared atomic Counter allocator (same as GM/TRF/ENG/ADJ).
- **Attachments** — optional evidence via the existing Cloudinary data-URI upload.

## 9. Permissions

- `engineer.jobs.request_kit` — FE self-service: raise a kit request on an assigned job, cancel own pending. Seeded into `field_engineer`.
- `jobs.kit_request.review` — PM/planner: view the queue, approve (+ pick fulfilment), decline. Seeded into the ops/planner default roles.
- Fulfilment reuses existing perms: warehouse issue → `goods_management.*`; engineer transfer → `engineer_stock.transfer` / holder's `engineer.transfer`.

## 10. Also close the edit-job audit gap (independent, cheap)

Regardless of this feature, `job.updated` (`job.service.ts:745`) should record the **kit-line diff** in its metadata (added / increased / removed lines with before→after qty), or emit dedicated `job.kit_line_added` / `job.kit_line_increased` events. Right now a manual planner edit that grows a kit is auditable only as an opaque "job updated." Small change; makes both the manual and the request-driven paths tell the same story.

## 11. Module layout (reuse, no duplicate logic)

- **Backend:** new `modules/job-kit-request/` (`*.controller/.service/.repository/.validation/.routes.ts`), or fold the endpoints into `job/` + `engineer/` if we prefer no new module. It **calls into** existing services — it owns no stock logic:
  - grow kit → `job` service/repo (`mergeKitLines`, edit-job diff + locks),
  - warehouse fulfilment → `goods-management` `postIssue`,
  - transfer fulfilment → `engineer-transfer` `createTransfer` (job-scoped) + the extended `completeTransferOnce`,
  - `audit`, `realtime`, Cloudinary, Counter — all reused.
- **Prisma:** two new models + one new field (`EngineerStockTransferLine.jobKitLineId`) + optional `JobStockMovement` note usage. Run `pnpm prisma:generate` after.
- **Frontend:** the FE portal request form + "my requests" view; the PM review queue (under Goods Management); a `jobKitRequest.service.ts` wrapper. The transfer composer already exists — reuse it for the transfer-fulfilment path with `jobId` + `jobKitLineId` wired.

## 12. Deferred / non-goals (v1)

- **Purchase Orders stay out of jobs.** Warehouse shortfall is handled by ordinary PO→GRN replenishment of the *warehouse*, then a normal issue — never a job-linked PO.
- **No notifications system** (inbox + realtime cover awareness, as in the engineer-transfer spec).
- **No auto-expiry / SLA** on pending requests; expose age + sort-by-oldest instead.
- **Misc items** can be requested and added to the kit, but not sourced via an engineer transfer (they aren't tracked holdings).

## 13. Testing

- **Pure/unit:** request state-machine guards (create only on accepted/in_progress & not reconciled; cancel only while pending; approve only by reviewer); line validation (source ↔ id presence; positive qty).
- **Service-level (the important ones):**
  - Approve → kit grows via `mergeKitLines`; an already-issued line can only increase (reuses the edit-job lock).
  - **Warehouse-issue fulfilment** rolls into the Issued tally (existing `postIssue` behaviour, now reached from a request).
  - **Job-scoped transfer fulfilment:** after completion, `getJobKitTallies` shows Issued +qty on the target `jobKitLineId`, **balances are not double-credited** (sum-before == sum-after across both engineers), `remaining` == qty (capped at real holding), open demand drops, and `goodsStatus` advances.
  - Consume-on-complete drains a transfer-fulfilled line the same as a warehouse-issued one.
