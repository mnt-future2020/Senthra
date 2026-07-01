# Engineer-to-Engineer Stock Transfer — Design

**Date:** 2026-06-29
**Status:** Draft for review
**Owner:** Shahul

## 1. Purpose & Problem

Field engineers carry stock on their vans (company/IRM items and customer consignment). Today there is **no way to move stock from one engineer to another** — if Engineer B needs an item Engineer A is carrying, it has to go back to a warehouse and out again. We want an in-app **request → approve** transfer so B can request stock, A approves, and it moves directly between them with a full audit trail.

Reference flow (from `docs/diagrams/Eng to Eng Stock Transfer.png`): *Engineer B needs stock → initiates a transfer in the app → Engineer A (has extra) approves → both dashboards update automatically → audit-trail entry.* (The PM-notification box in the diagram is deferred — see §11.)

## 2. Scope

**Transferable:** positive on-hand holdings only —
- **Company / IRM** stock (`EngineerStockBalance`), and
- **Customer consignment** (`EngineerCustomerStockHolding`).

**Never transferable:** misc / free-text items, and consumed / lost / damaged units (these aren't positive holdings).

**Ownership is preserved end-to-end:** company stays company; customer-owned stays customer-owned (carrying `customerStockEntryId` / `customerId`). A single transfer may contain multiple item lines of mixed ownership.

## 3. Core Model

Two new Prisma models in a new module `engineer-transfer`.

```
EngineerStockTransfer {
  id            ObjectId
  code          String   // ENG-#### (atomic Counter, like TRF/GM)
  status        String   // pending | completed | declined | cancelled

  // Parties (snapshots, history-safe)
  fromEngineerId/Name/Email   // HOLDER / source — the approver (gives up stock)
  toEngineerId/Name/Email     // RECIPIENT — needs the stock
  requestedById/Email/Kind    // who created it: engineer (the recipient) OR admin (Kind = "engineer" | "admin")

  // Content
  reason        String
  notes         String?
  jobId         ObjectId?    // optional reference
  customerId    ObjectId?    // optional reference (when consignment-related)
  attachments   String[]     // evidence image URLs (Cloudinary)

  // Approval / lifecycle
  approvedBy    String?      // actor email who approved (holder, or admin on override)
  approvedAt    DateTime?
  overrideByAdmin Boolean @default(false) // true when an admin force-completed a pending request
  declinedBy    String?
  declinedAt    DateTime?
  declineReason String?
  cancelledAt   DateTime?
  completedAt   DateTime?

  // Receiver acknowledgment (configurable — see §7)
  requireSignature  Boolean  // snapshot of the Settings flag at create time
  receiverSignatureUrl String?
  acknowledgedAt   DateTime?

  lines         EngineerStockTransferLine[]
  createdBy     String?
  deletedAt     DateTime?    // soft delete (drafts/cancelled only)
  createdAt/updatedAt
  @@index([status]) @@index([fromEngineerId, status]) @@index([toEngineerId, status]) @@index([createdAt])
}

EngineerStockTransferLine {
  id            ObjectId
  transferId    ObjectId
  ownership     String       // company | customer
  irmItemId     ObjectId?    // when company
  customerStockEntryId ObjectId? // when customer (loose socket, mirrors JobStockMovementLine)
  itemName      String       // snapshot
  sku           String?      // snapshot
  uom           String?      // snapshot
  quantity      Int
}
```

## 4. State Machine

```
                 create (recipient engineer OR admin)
                          │
                          ▼
                      ┌────────┐   holder approves ──► move stock (atomic) ──► ┌───────────┐
   requester cancels ─┤ pending├──► admin OVERRIDE-approve (audited) ─────────►│ completed │
        │             └────────┘                                                └───────────┘
        ▼                  │ holder declines / admin declines                        │
   ┌──────────┐            ▼                                          (if requireSignature) recipient signs → acknowledgedAt
   │cancelled │       ┌──────────┐
   └──────────┘       │ declined │
                      └──────────┘
```

- **One approval only** — the **holder** (`fromEngineer`), because they give up the stock. No high-value second gate.
- **Admin override:** a user with `engineer_stock.transfer` may complete (or decline) any pending request without the holder's action; recorded with `overrideByAdmin = true` + an audit entry.
- **Stock moves only on `completed`** (not reserved while pending). Approval **re-validates** the holder still has the quantity inside the transaction; if not, completion fails with a clear error and the request stays pending (holder/admin can decline).
- **Pending never auto-expires** (no SLA). Lists expose **request age** and **sort/filter by oldest pending** so admins can chase stale ones (§6).

## 5. The Atomic Move (on completion)

One `withTransaction`, mirroring `inventory.repository.createTransferWithCode`:

1. Re-read & **guard** each line: holder's current on-hand ≥ line.quantity (concurrency-safe).
2. **Company lines:** `upsertEngineerBalanceTx(tx, irmItemId, fromEngineerId, −qty)` then `(+qty)` for `toEngineerId`; append two `EngineerStockTransaction` rows with `type: "transfer_out"` / `"transfer_in"` (the ledger already reserves these), `sourceType: "engineer_transfer"`, `sourceCode: ENG-####`, `balanceAfter`.
3. **Customer lines:** decrement the holder's `EngineerCustomerStockHolding` and upsert/increment the recipient's (same `customerStockEntryId`, copying `customerId`/`customerName`/`itemName`); append two `EngineerCustomerStockTransaction` rows `type: "transfer_out"`/`"transfer_in"`.
4. Set transfer `status=completed`, `completedAt`, `approvedBy/At`.
5. **Audit** + **realtime** emit (§8) after commit.

The `ENG-####` code is allocated with the same atomic Counter + retry pattern as TRF/GM/ADJ.

## 6. Surfaces

### 6a. Item discovery (privacy-preserving)
Engineers **cannot** browse each other's full inventory. They **search an item** they need; the system returns the engineers who currently hold it with **available quantity**:
- `GET /engineer-transfers/holders?ownership=company&irmItemId=…` → `[{ engineerId, name, available }]` from `EngineerStockBalance` (qty>0), excluding the requester.
- `GET /engineer-transfers/holders?ownership=customer&customerStockEntryId=…` → from `EngineerCustomerStockHolding` (qty>0).
Admins retain full inventory visibility (the existing Inventory → Engineer lens).

### 6b. Engineer portal (self-service)
A new write capability in the otherwise read-only portal:
- **Request stock:** search item → pick a holder + quantity (+ reason, optional notes, optional attachments) → creates a pending request.
- **Incoming inbox:** requests where I'm the holder → **Approve** / **Decline** (with reason).
- **My requests:** outgoing requests with live status; **Cancel** while pending.
- **Acknowledge receipt:** when `requireSignature`, sign on completion.

### 6c. Admin — Inventory → Engineer tab
- A **Transfer** action that opens the request modal (admin creates a request on the same flow).
- A **transfer board / oversight**: all requests with filters (status, engineer, ownership) and **sort by oldest pending**, showing request age; **override-approve / decline / cancel** with audit.

## 7. Settings — receiver signature

A new Settings flag `engineerTransfer.requireReceiverSignature` (in the `settings` module), **default `false` (optional)**. When an admin turns it **on**, every new transfer snapshots `requireSignature=true` and the recipient must capture a signature (reusing the existing signature capability — `User` already has signature fields/components) to acknowledge receipt; the transfer shows "awaiting acknowledgment" until signed. Stock still moves on completion regardless; the signature is receipt evidence.

## 8. Cross-cutting

- **Attachments:** evidence images via the existing Cloudinary data-URI upload (same as goods-management damage photos) → stored as URLs on the transfer.
- **Realtime:** on every state change, `emitToUser(fromEngineerId, …)` and `emitToUser(toEngineerId, …)` with a `goods:transfer_*` event so both dashboards + inboxes refresh live via `useGoodsSocket` (extended to listen for the new events). Admin board refreshes the same way.
- **Audit:** an `audit.record` entry at create / approve / decline / cancel / complete / override — the complete audit log.
- **Codes:** `ENG-####` via the shared Counter allocator.

## 9. Permissions

New permission group `engineer_stock` (admin/manage side) + one engineer-portal permission:
- `engineer_stock.view` — view the admin transfer board.
- `engineer_stock.transfer` — admin create / override-approve / decline / cancel.
- `engineer.transfer` — engineer self-service: create a request, approve/decline incoming, cancel own outgoing, sign on receipt.

Seeded into the relevant default roles (super_admin, operations, warehouse_manager as appropriate; `field_engineer` gets `engineer.transfer`).

## 10. Module layout (reuse, no duplicate logic)

- **Backend (new):** `modules/engineer-transfer/` — `*.controller/.service/.repository/.validation/.routes.ts`. Reuses the engineer-balance tx helpers (`upsertEngineerBalanceTx`, `insertEngineerTxnTx` and the customer-holding equivalents) — promoted to a shared location if currently private to `goods-out`/`goods-management`. Reuses `audit`, `realtime`, the Cloudinary upload, and the Counter allocator.
- **Frontend (new):** engineer-portal request/inbox components; admin transfer board + modal under the Inventory → Engineer lens; a `engineerTransfer.service.ts` wrapper.
- **Settings:** one new flag in the settings module + its UI control.

## 11. Deferred / non-goals (v1)

- **PM / notification alerts** — no notification system is built in v1 (decision: build notifications last, separately). Awareness is covered by the request **inbox** + **realtime** refresh; the diagram's "PM gets notification" lands when notifications exist.
- **No high-value second approval**, no auto-expiry/SLA, no warehouse involvement (this is van-to-van only).

## 12. Testing

- Pure/unit (vitest): state-machine transition guards; the holders-discovery filter; line validation (ownership ↔ id presence; positive qty; reject misc/consumed).
- Service-level: atomic move preserves totals (sum before == sum after across both engineers) for company and customer lines; re-validation rejects over-quantity on approval; admin override path sets the audit flag.
