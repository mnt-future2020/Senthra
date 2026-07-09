# Formal Procurement Flow — Quotation → PRF → Finance → PO → PM → Supplier

**Date:** 2026-07-08
**Status:** Implemented (backend + frontend), 2026-07-08 — pending user testing

## 1. Context & goal

The client's procurement process is currently email-driven: supplier sends a quotation → internal review → a Purchase Request Form (PRF) is prepared → Finance reviews quotation + PRF → Finance generates the official PO → PO is shared with the Project Manager → the PM emails the PO to the supplier → supplier acknowledges (acceptance + delivery schedule) → goods delivered → Goods-In → inventory updated.

The system already covers the back half end-to-end: the `purchase-order` module (draft → pending_approval → approved → sent → partially_received → fully_received → closed, PDF generation via the Document Platform, supplier email with PDF attachment), the `goods-in` module (GRN against a PO, **line-level receipt tracking** via `PurchaseOrderItem.receivedQuantity` + `GoodsReceiptItem.orderedQuantity/previouslyReceived/receivedQuantity`, over-receipt blocked and re-validated in the completion transaction), and inventory (`InventoryBalance` + immutable `InventoryTransaction` ledger). Every PO/GRN transition is audit-logged.

**Missing (this project):** a supplier-quotation record, the PRF entity with finance review, PM routing before send, and supplier acceptance capture.

**Explicitly NOT missing (verified, no work needed):** line-level ordered/received/remaining tracking and over-receipt validation — both already implemented in `goods-in` ([goods-in.service.ts:247-253](../../../backend/src/modules/goods-in/goods-in.service.ts), re-checked in the completion transaction).

## 2. Decision log

| Decision | Choice |
|---|---|
| Pre-PO modelling | One new `purchase-request` (PRF) module; quotation lives ON the PRF (structured fields + file attachments). No standalone quotation register, no Material Request module. |
| PM step | Real PO status `pm_review` between `approved` and `sent`; PM is explicitly assigned and notified; PM sends via the system (existing email+PDF flow), stamped as sender/signatory. `approved → sent` direct path is retained for non-project POs. |
| Project reference | Optional `jobId` relation + free-text `projectRef` on PRF and PO. No schema change to `Job`. PM default suggestion comes from a `resolvePmSuggestion(job)` helper (today: job creator; future PM/planner user fields slot in without redesign). |
| Supplier acknowledgement | Manual recording by PM/staff: one new status `supplier_accepted` + audited `confirmedDeliveryDate` field (recordable at acceptance or later). No tokenized supplier portal. |
| PRF after conversion | Read-only forever: view / linked PO / audit only. One PO per PRF, always. |
| Fast-path approval | PRF-born POs may go `draft → approved` directly ONLY if still commercially identical to the approved PRF (server-side comparison). Divergence forces the normal `pending_approval` review. |
| Price revision | Never edit an approved PRF. Pre-conversion: `approved → draft` reopen transition (mandatory reason). Post-conversion: cancel the PO, duplicate the PRF as a new linked revision (`revisionOfId`). |
| Material Requests | Out of scope. PRF carries optional `sourceType`/`sourceId` provenance fields so any future request module can generate PRFs without schema changes. The empty placeholder dirs (`backend/src/modules/material-request/`, `frontend/src/app/dashboard/material-requests/`) are deleted. |
| Status naming | New internal strings use clear names (`supplier_accepted`, `pm_review`). Existing PO status strings are unchanged (display labels do the clarity work; PRF `approved` displays as "Finance Approved"). |
| Document of record | The exact PDF issued to the supplier is archived at send time as a protected attachment (§4.2); on-demand PDF regeneration keeps reflecting current data. Preferred over freezing supplier address/contact fields on the PRF — the PRF is internal; the sent PO is the document that must stay faithful. |
| Cancellation | Explicit matrix (§4.3); reason mandatory; post-receipt cancellation structurally impossible. |
| Delivery-date revisions | Tracked via audit metadata `{previousDate, newDate, reason}` on every change — no separate history table (the audit ledger IS the history). |
| Item snapshots | PRF lines snapshot `itemName`/`sku`/`baseUnit` — exact parity with PO lines. Manufacturer/category deliberately NOT snapshotted (taxonomy reports want current values; `irmItemId`/SKU are durable identifiers). |

## 3. Data model (Prisma, MongoDB)

All new fields nullable/defaulted — purely additive, no migration of existing data.

### 3.1 `PurchaseRequest` (new)

```prisma
model PurchaseRequest {
  id   String @id @default(auto()) @map("_id") @db.ObjectId
  code String @unique // PRF-0001 — atomic Counter allocation, never freed

  supplierId   String   @db.ObjectId
  supplier     Supplier @relation(fields: [supplierId], references: [id])
  supplierName String? // snapshot at create

  warehouseId String    @db.ObjectId // delivery warehouse; one warehouse per PRF (matches PO)
  warehouse   Warehouse @relation(fields: [warehouseId], references: [id])

  jobId      String? @db.ObjectId
  job        Job?    @relation(fields: [jobId], references: [id])
  projectRef String? // free-text fallback when no Job

  sourceType String? // future integrations, e.g. "job_kit_request"
  sourceId   String? @db.ObjectId

  status String @default("draft") // draft|submitted|approved|converted|cancelled

  // Supplier quotation (structured) — files go in attachments
  quoteReference  String?
  quoteDate       DateTime?
  quoteValidUntil DateTime?

  justification String? // business justification (client's PRF field)
  notes         String?

  currency        String @default("GBP")
  subtotalPence   Int    @default(0) // server-computed — the "Estimated Cost"
  vatPence        Int    @default(0)
  grandTotalPence Int    @default(0)

  // Actor stamps (email snapshots), PO-module convention
  createdBy       String? // "Requested By"
  submittedBy     String?
  submittedAt     DateTime?
  approvedBy      String? // finance reviewer
  approvedAt      DateTime?
  rejectionReason String? // last reject (submitted → draft)
  reopenReason    String? // last revision reopen (approved → draft)
  cancelledAt     DateTime?
  cancelReason    String?
  convertedAt     DateTime?
  updatedBy       String?

  revisionOfId String? @db.ObjectId // set when duplicated from a converted PRF

  deletedAt DateTime? // soft delete — draft only
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  items         PurchaseRequestItem[]
  attachments   PurchaseRequestAttachment[]
  purchaseOrder PurchaseOrder? // back-relation; one PO per PRF (unique FK on PO side)

  @@index([status])
  @@index([supplierId])
  @@index([warehouseId])
  @@index([jobId])
}
```

### 3.2 `PurchaseRequestItem` (new)

Same shape as `PurchaseOrderItem`: `purchaseRequestId`, `irmItemId` relation, `itemName`/`sku`/`baseUnit` snapshots, `quantity` (> 0), `unitPricePence` (from the quotation), `vatRate`, server-computed `lineTotalPence`, `notes`, `sortOrder`. Unique `[purchaseRequestId, irmItemId]`.

### 3.3 `PurchaseRequestAttachment` (new)

Same shape as `PurchaseOrderAttachment` (Cloudinary: label, fileName, fileType, fileSizeBytes, url, uploadedBy). Holds the supplier quotation file(s) and any supporting docs.

### 3.4 `PurchaseOrder` additions

```prisma
  purchaseRequestId String?          @unique @db.ObjectId // one PO per PRF
  purchaseRequest   PurchaseRequest? @relation(fields: [purchaseRequestId], references: [id])

  jobId      String? @db.ObjectId
  job        Job?    @relation(fields: [jobId], references: [id])
  projectRef String?

  // PM routing
  pmUserId     String?   @db.ObjectId
  pmName       String?   // snapshot
  pmEmail      String?   // snapshot
  pmAssignedAt DateTime?
  pmAssignedBy String?

  // Supplier acceptance
  supplierAcceptedAt    DateTime? // when acceptance was recorded
  supplierAcceptedBy    String?   // who recorded it (staff email snapshot)
  supplierAckReference  String?   // supplier's own order/confirmation ref
  confirmedDeliveryDate DateTime? // updatable later; every change audited
  supplierAcceptNotes   String?
```

`Job` gains back-relations (`purchaseRequests`, `purchaseOrders`); no other Job change.

## 4. Status machines

### 4.1 PRF (forward-only, `ALLOWED_TRANSITIONS` + `assertTransition` pattern, all audited)

```
draft      → submitted | cancelled
submitted  → approved (finance) | draft (reject, reason required) | cancelled
approved   → converted (via convert action) | draft (reopen for revision, reason required) | cancelled
converted  → terminal, READ-ONLY (view / linked PO / audit only)
cancelled  → terminal
```

- Editable (fields, items, attachments) in `draft` only. Soft-delete `draft` only.
- Display labels: `approved` → "Finance Approved".
- "Internal review" from the client's flow = the draft stage; "Finance Review & Verification" = the `submitted → approved` gate.

### 4.2 PO transitions added (existing ones unchanged)

```
approved         → pm_review           (Route to PM: pick PM, required; PM notified)
pm_review        → sent                (Send to supplier — assigned PM only, see guard)
pm_review        → cancelled
approved         → sent                (retained direct path, permission-gated)
sent             → supplier_accepted   (Record supplier acceptance)
supplier_accepted → partially_received | fully_received | cancelled
sent | supplier_accepted → partially_received | fully_received   (Goods-In driven, as today)
```

- **Fast-path:** `draft → approved` allowed ONLY when `purchaseRequestId` is set AND the PO commercially matches its PRF (see §5). Otherwise `draft → pending_approval` as today.
- **Send guard in `pm_review`:** actor must be the assigned PM (`pmUserId`) — or hold `purchase_orders.assign_pm` (override, e.g. PM on leave). Reassigning the PM while in `pm_review` is allowed for `assign_pm` holders (no status change, audited as `pm_reassigned`).
- **Supplier acceptance:** allowed in `sent` only. Captures acceptance date, optional `confirmedDeliveryDate`, `supplierAckReference`, notes, optional attachment. `confirmedDeliveryDate` may also be set/updated later while in `supplier_accepted` — every change is audited as `delivery_date_updated` with metadata `{previousDate, newDate, reason}` (reason prompted in the dialog, optional), so the full revision trail (Friday → Monday → Wednesday) is visible on the PO's audit history for disputes; no separate history table needed. A "Delivery scheduled" badge derives from the field's presence — it is NOT a status, so receiving is never blocked by a missing date.
- **Goods-In:** `requireReceivablePurchaseOrder` accepts `sent | supplier_accepted | partially_received` (today: `sent | partially_received`). No other goods-in change — line-level tracking and over-receipt validation already exist.
- The PO PDF already prints the sender (`sentBy`) as signatory, so the PM naturally becomes the signer on PM-sent POs. No Document Platform change.
- **Document of record:** on every send (`pm_review → sent` and `approved → sent`), the freshly generated PO PDF is also archived — uploaded server-side via the existing `uploadFileToCloudinary` ([lib/cloudinary.ts](../../../backend/src/lib/cloudinary.ts)) and stored as a system `PurchaseOrderAttachment` labelled "Issued PO — as sent" (not deletable via the attachments API). The on-demand PDF endpoint keeps reflecting current data; the archived copy is exactly what the supplier received, immune to later supplier-detail or branding changes. Archive failure must not fail the send (log + audit note), matching the fire-and-forget email convention.

### 4.3 Cancellation matrix (explicit)

| Entity | Cancellable from | Never cancellable from | Notes |
| --- | --- | --- | --- |
| PRF | `draft`, `submitted`, `approved` | `converted`, `cancelled` | Converted PRFs are read-only forever; re-procurement goes through cancel-the-PO + duplicate-as-revision (§6). |
| PO | `draft`, `pending_approval`, `approved`, `pm_review`, `sent`, `supplier_accepted` | `partially_received`, `fully_received`, `closed`, `cancelled` | Reason mandatory (stored in `cancelReason`, audited). If already `sent`/`supplier_accepted`, the existing `notifySupplierPoCancelled` email fires. The "never after receipt" rule is structurally enforced: the first completed GRN moves status to `partially_received`, which has no cancel transition. |

Cancelling a PRF-born PO leaves its PRF `converted` (read-only); the linked-PO badge on the PRF shows the cancelled state.

## 5. PRF → PO conversion & fast-path approval

**Convert** (finance permission, PRF in `approved`), single transaction:
1. Create PO in `draft` with a fresh PO code: copy supplier, warehouse, jobId/projectRef, currency, all lines (item, qty, quoted unit price, VAT), totals recomputed server-side; `justification` → `internalNotes` (prefixed `PRF <code> justification:`); copy attachment rows (same Cloudinary URLs); set `po.purchaseRequestId`.
2. PRF → `converted` (+ `convertedAt`). Read-only from here, forever.
3. Audit both sides (`purchase_request.converted`, `purchase_order.created` with PRF metadata).

Guards: supplier must be active at convert time (409 otherwise); `@unique` on `po.purchaseRequestId` + status machine make double-conversion impossible.

**Fast-path `draft → approved`** (approve permission): server loads the source PRF and compares commercial fields — `supplierId`, `warehouseId`, `currency`, and the line multiset `{irmItemId, quantity, unitPricePence, vatRate}`. Match → approve directly (finance already reviewed these numbers on the PRF; only delivery address/terms/payment terms/notes were completed on the PO). Mismatch → 409 with a clear message; the PO must go `draft → pending_approval → approved` (normal finance review). This is stateless — no new status, no field-level edit rules, no accidental bypass.

**Invariant:** the comparison must cover **every input that feeds `computeTotals`**. Today that is exactly the fields above (no discount/delivery-charge/surcharge fields exist anywhere in the system). If a commercial field is ever added to PO/PRF lines or headers (discount, delivery charge, etc.), it MUST be added to this comparison in the same change — otherwise it becomes a silent fast-path bypass.

## 6. Price revision workflow (never edit an approved PRF)

- **Before conversion:** "Reopen for revision" (`approved → draft`, finance permission, mandatory reason stored in `reopenReason`, approval stamps cleared, audited `purchase_request.reopened`). Edit → resubmit → finance re-approves.
- **After conversion:** the PRF stays read-only and one-PO-per-PRF holds. Flow: cancel the PO (existing cancel flow) → "Duplicate as new PRF" action on the converted PRF → prefilled copy created in `draft` with `revisionOfId` pointing at the original → full review cycle again → new PO. The detail pages surface the chain (original PRF ↔ cancelled PO, revision PRF ↔ new PO).

## 7. Permissions & roles

New group in `PERMISSION_GROUPS` ([permissions.ts](../../../backend/src/modules/role/permissions.ts)):

- `purchase_requests`: `view`, `create`, `edit`, `submit`, `approve` (covers approve/reject/reopen), `convert`, `cancel`, `delete`
- `purchase_orders` additions: `assign_pm`, `acknowledge` (record supplier acceptance)

Escalation-guard and manage-implies-view logic extended for the new keys.

Seed updates ([db/seed.ts](../../../backend/src/db/seed.ts)) — role split follows the client flow (PRF is "prepared by ... typically Finance or an authorized business user"; the PM enters AFTER the PO exists):
- `finance_director` **owns the PRF end-to-end**: `purchase_requests.view/create/edit/submit/approve/convert/cancel`, `purchase_orders.view/create/edit/approve/assign_pm/cancel/close`, plus `suppliers.view`/`warehouse.view`/`irm.view` (form pickers) and `audit.view`.
- `project_manager` is **PO-side only** — no PRF authoring: `purchase_requests.view` (to see the source PRF behind a routed PO), `purchase_orders.view/send/acknowledge`, plus the same read keys + `audit.view`. A one-time seed REVOKE strips `purchase_requests.create/edit/submit` from any project_manager role an earlier build had granted them to (surgical: that role key only, those three keys only).

`resolvePmSuggestion(job)`: single helper returning the suggested PM for the Route-to-PM picker — today the job's `createdByUserId` when that user's role holds `purchase_orders.send`; encapsulated so future `Job` planner/PM user fields change only this function.

## 8. Emails & notifications

New `EmailTemplate` defaults (admin-editable, `emailTemplate.defaults.ts`), all fire-and-forget with `EmailLog`, following `notifyApproversPoSubmitted`'s pattern:

| Key | To | When |
|---|---|---|
| `prf.submitted` | active users whose role holds `purchase_requests.approve` (or `*`) | PRF submitted |
| `prf.approved` | requester (`createdBy`) | finance approves |
| `prf.rejected` | requester, includes reason | finance rejects |
| `po.pm_assigned` | assigned PM | PO routed to PM |

`po.sent` (supplier + PDF attachment) reused unchanged.

## 9. Frontend

- **New nav section "Purchase Requests"** beside Purchase Orders: list page (status/supplier/warehouse/job filters), create/edit form (supplier, warehouse, job picker + projectRef, quote ref/date/validity, IRM line items with quoted prices — same item picker as PO form, attachments, justification), detail page (status timeline, per-status actions: Submit / Approve / Reject-with-reason / Reopen-for-revision / Generate PO / Duplicate-as-revision / Cancel, audit history tab) — mirroring the `PurchaseOrderForm`/`PurchaseOrderDetail` structure. New `purchase-request.service.ts`.
- **PO screens:** source-PRF banner + link, job/projectRef display, "Route to PM" dialog (user picker, default from `resolvePmSuggestion`), "Record supplier acceptance" dialog (date, confirmed delivery date, supplier ref, notes, attachment), "Update delivery date" action in `supplier_accepted`, new statuses in `poStatus.tsx` (`pm_review` → "PM Review", `supplier_accepted` → "Supplier Accepted", "Delivery scheduled" badge), an "Awaiting my action" filter for PMs (pm_review + pmUserId = me).
- **Procurement chain strip:** PRF and PO detail pages render the lineage as a navigable strip — Quote (ref/attachments on the PRF) → PRF → PO → GRN(s) — each element linked, with status badges. The data links all exist by construction (PRF ↔ PO unique two-way relation, PO ↔ GRN existing relation, GRN → `InventoryTransaction.sourceType/sourceId/sourceCode`); this makes the chain visible from any screen.
- **Supplier detail — new "Procurement" tab:** PRFs and POs for the supplier (status filters), outstanding-orders count (`sent`/`supplier_accepted`/`partially_received`), open and cancelled order counts, total spend (sum of `fully_received`/`closed` PO grand totals). No placeholder metrics: average lead time / on-time % / late deliveries are intentionally not shown yet — they are fully computable later from timestamps that already exist (`sentAt`, `confirmedDeliveryDate`, GRN received/completed dates), so adding them is a pure read-side feature requiring no schema change or redesign.

## 10. Audit

New actions via `audit.record(...)` (fire-and-forget, as today):
`purchase_request.created / updated / submitted / approved / rejected / reopened / converted / cancelled / deleted / attachment_added / attachment_removed`, `purchase_order.pm_assigned / pm_reassigned / supplier_accepted / delivery_date_updated`. Frontend detail pages render history via the existing `auditDisplay`.

## 11. Out of current scope

These are deliberate boundary decisions, not phases of an unfinished build — each can be added later without reworking this design:

Standalone quotation register / multi-quote comparison; Material Request module (PRF provenance fields future-proof it); PRF PDF document (browser print of the detail page suffices; a Document Platform sibling `generatePurchaseRequestPdf` slots in without redesign); tokenized supplier-acknowledgement portal; multi-warehouse PRFs (one PRF per warehouse, matching the one-warehouse-per-PO rule; the PO `/split` endpoint remains for standalone POs); dispatch-tracking entity (GRN already captures carrier/delivery-note/vehicle); `projectManagerId` on `Job` (encapsulated behind `resolvePmSuggestion`); supplier delivery-performance metrics (computable from existing timestamps, see §9).

## 12. Testing & verification

- **Vitest (backend):** PRF transition matrix (valid + rejected transitions); totals computation; conversion field mapping + transactionality + double-convert rejection; converted read-only enforcement; fast-path commercial-equality check (exact match passes; each divergence — price, qty, line added/removed, supplier, warehouse — refuses); cancellation matrix (each allowed/forbidden state for PRF and PO); `pm_review` send guard (assigned PM passes, other PM refused, `assign_pm` override passes); supplier-acceptance validation; delivery-date update writes audit metadata `{previousDate, newDate, reason}`; issued-PDF archive attached on send and send survives archive failure; goods-in receivable-status change.
- `pnpm typecheck` + `pnpm lint` in both apps; frontend `pnpm build`.
- **Manual E2E:** upload quote → create PRF → submit → finance reject → fix → approve → reopen-revision path → re-approve → convert → complete PO draft → fast-path approve → route to PM → PM send (supplier email w/ PDF) → record acceptance + delivery date → GRN partial → GRN final → inventory balance + ledger check → supplier Procurement tab totals.

## 13. Rollout / backward compatibility

- Status fields are strings in MongoDB — no enum migration; all new model fields nullable/defaulted; existing POs are untouched and continue on existing paths (`approved → sent` stays valid).
- New permissions must be seeded onto `finance_director` / `project_manager`; verify the seed's role-upsert behaviour updates existing role documents (and does not clobber admin-customized permission sets — follow whatever convention the seed already uses for permission changes).
- Delete the empty placeholder dirs `backend/src/modules/material-request/` and `frontend/src/app/dashboard/material-requests/`.
- Follows all repo invariants: repositories are the only Prisma access, zod validation per route, `#modules/*` import alias with `.js` extensions, integer-pence money, snapshot-on-write denormalization, Counter-allocated codes.
