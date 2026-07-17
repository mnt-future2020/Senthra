# Van Stock Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the non-job engineer ↔ warehouse stock flow: an engineer requests van restock (or offers a return), a warehouse reviewer approves/trims/declines, and the warehouse fulfils incrementally by barcode scan — writing the existing inventory/engineer/damaged ledgers with `VSR-####` provenance.

**Architecture:** One new self-contained backend module `van-stock-request` (validation → repository → service → controller → routes) mirroring `job-kit-request` for the request lifecycle and `goods-management` for the scan/posting transaction. No new movement model — the VSR + its `VanStockFulfilment` postings are the source documents; all balance/ledger writes reuse `inventoryService.applyOutbound/applyInbound`, `engineerStockRepo`, and the damaged-pool writers, so Stock Movement History and Inventory Hub pick everything up automatically. Frontend adds an engineer "Van Stock" portal page and a warehouse "Van Requests" review/fulfil page.

**Tech Stack:** Express 5 + Prisma (MongoDB), TypeScript ESM/NodeNext, pnpm, vitest. Next.js 16 + React 19 + Tailwind v4, `@/lib/api`, socket.io-client, existing `ScannerInput`/`useBarcodeScanner`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-14-van-stock-request-design.md` — statuses, ledger types, barcode rules, and decision log live there.
- **Layering:** `route → requireAuth → requirePermission → writeLimiter → validateBody → controller → service → repository → Prisma`. Prisma ONLY in `van-stock-request.repository.ts` (plus the other modules' own repos). Services throw `badRequest/conflict/notFound/forbidden` from `../../utils/http-error.js`.
- **ESM/NodeNext:** relative imports end in `.js`; cross-module imports use `#modules/<domain>/<file>.js`; same-module `./x.js`; shared dirs `../../lib/x.js`.
- **No Prisma enums:** string columns with `// a | b | c` comments; `z.enum([...])` in validation.
- **Mongo id line:** `id String @id @default(auto()) @map("_id") @db.ObjectId`. Snapshots (`<rel>Name` etc.) marked `// snapshot`. Soft delete via `deletedAt DateTime?`, written `deletedAt: null` explicitly on create, filtered on reads.
- **Codes:** `VSR-####` via the atomic `Counter` (prefix `VSR`) — copy the JKR 5-attempt loop verbatim (`job-kit-request.repository.ts:36-104`).
- **Atomic writes:** every posting runs inside ONE `withTransaction(async (tx) => {...})` from `../../lib/prisma.js`; re-read/validate inside the tx. `inventoryRepo.upsertBalanceTx` and `engineerStockRepo.upsertEngineerBalanceTx` both floor-guard at zero (throw `conflict`).
- **Ledger constants:** engineer txn `type`: `van_restock` (+) / `van_return` (−); `sourceType: "van_stock_request"` on engineer + inventory rows; damaged rows `sourceType: "van_stock_return"`. Inventory ledger `type` is fixed by `applyOutbound`/`applyInbound` (`goods_out`/`goods_in`) — do not pass a type.
- **Status strings:** `pending | approved | partially_fulfilled | fulfilled | declined | cancelled`; `type`: `restock | return`; `priority`: `normal | high | urgent`; `createdVia`: `engineer_request | walk_in`; `completionType`: `complete | closed_short | cancelled_remaining`; line `condition`: `good | damaged`.
- **Warehouse scoping:** `pending` requests are visible to every reviewer (the warehouse may not be fixed yet); once `warehouseId` is set, lists filter by `warehouseScopeFilter(actor)` and single-resource actions call `assertWarehouseAccess(actor, warehouseId)` (from `../../lib/warehouse-access.js`).
- **Serial/batch items:** excluded everywhere — item-search filters them out, scan-lookup rejects them, create/fulfil re-validate.
- **No email.** Realtime `van_stock_request:updated` via `emitToUser` + `emitToRoom(OFFICE_JOBS_ROOM, …)`; audit via `audit.record`.
- **Commits:** this repo's owner requires explicit approval before ANY git commit — at each "Checkpoint" step run the verification commands, report, and ASK before committing. Never push.
- **Verification per task:** `cd backend; pnpm typecheck; pnpm lint` (and `pnpm test` where tests exist); `cd frontend; pnpm lint` for frontend tasks.

---

## File Structure

**Backend — new module `backend/src/modules/van-stock-request/`:**
- `van-stock-request.validation.ts` — zod schemas + inferred types.
- `van-stock-request.validation.test.ts` — vitest schema tests.
- `van-stock-request.repository.ts` — Prisma for the 4 new models; code allocation; atomic transitions; the posting transaction; `pendingWorklist()`; open-lines duplicate lookup.
- `van-stock-request.service.ts` — lifecycle, scan-lookup, posting orchestration, DTOs, stale computation (pure helpers exported for tests).
- `van-stock-request.service.test.ts` — vitest tests for the pure helpers.
- `van-stock-request.controller.ts` — thin handlers.
- `van-stock-request.routes.ts` — routes + middleware chain.

**Backend — modified:**
- `backend/prisma/schema.prisma` — 4 new models + back-relations on `User`, `Warehouse`.
- `backend/src/routes/index.ts` — mount `/van-stock-requests`.
- `backend/src/modules/role/permissions.ts` — `engineer.van_stock.request` (Engineer Portal group) + new `van_stock_request` group (Goods Management category).
- `backend/src/db/seed.ts` — seed + idempotent backfill of the two keys.
- `backend/src/modules/dashboard/worklist.ts` — add `review_van_stock_request` kind.
- `backend/src/modules/dashboard/dashboard.service.ts` — wire the queue.

**Frontend — new:**
- `frontend/src/services/vanStockRequest.service.ts` — typed API wrappers.
- `frontend/src/components/dashboard/engineer/EngineerVanStock.tsx` — engineer page card: mine-list + composers.
- `frontend/src/components/dashboard/van-requests/VanRequestsBoard.tsx` — warehouse queue.
- `frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx` — review + fulfil (scan) panel.
- `frontend/src/app/dashboard/engineer/van-stock/page.tsx`
- `frontend/src/app/dashboard/van-requests/page.tsx`

**Frontend — modified:**
- `frontend/src/lib/auth.ts` — add `van_stock_request.review` to `OVERVIEW_PERMS`.
- `frontend/src/components/dashboard/shell/Sidebar.tsx` — engineer nav item "Van Stock"; admin nav item "Van Requests".

---

## PHASE 1 — Data model + permissions

### Task 1: Prisma models + back-relations + generate

**Files:**
- Modify: `backend/prisma/schema.prisma` (append after `JobKitRequestLine`, ~line 1354; back-relations on `User` and `Warehouse`)

**Interfaces — Produces (later tasks rely on):**
- `VanStockRequest { id, code, type, status, priority, createdVia, engineerId, engineerName, engineerEmail?, preferredWarehouseId?, warehouseId?, warehouseName?, warehouseCode?, reason, notes?, attachments[], reviewedByUserId?, reviewedByEmail?, reviewedAt?, decisionNote?, lastFulfilledAt?, completionType?, closedShortBy?, closedShortAt?, closeShortNote?, cancelledAt?, createdBy?, deletedAt?, lines[], fulfilments[] }`
- `VanStockRequestLine { id, requestId, irmItemId, itemName, sku?, uom?, requestedQty, approvedQty?, fulfilledQty }`
- `VanStockFulfilment { id, requestId, sequence, performedBy, postedAt, lines[] }`
- `VanStockFulfilmentLine { id, fulfilmentId, lineId, irmItemId, itemName, qty, condition, damagePhotoUrl?, damageReason?, scannedCode? }`

- [ ] **Step 1: Append the models to `schema.prisma`:**

```prisma
// ── Van Stock Request (engineer ↔ warehouse, NON-job) ──────────────────────────────────────────
// The non-job twin of the JKR/GM pair: restock (warehouse → van, reviewed) and return (van →
// warehouse, no review gate — scan-in IS acceptance). The request is the source document (like
// StockAdjustment); postings write the existing inventory/engineer/damaged ledgers with VSR-####
// provenance. See docs/superpowers/specs/2026-07-14-van-stock-request-design.md
model VanStockRequest {
  id   String @id @default(auto()) @map("_id") @db.ObjectId
  code String @unique // VSR-#### (atomic Counter)

  type       String // restock | return
  status     String @default("pending") // pending | approved | partially_fulfilled | fulfilled | declined | cancelled
  priority   String @default("normal") // normal | high | urgent
  createdVia String @default("engineer_request") // engineer_request | walk_in

  engineerId    String @db.ObjectId
  engineer      User   @relation("VanStockRequestEngineer", fields: [engineerId], references: [id])
  engineerName  String // snapshot
  engineerEmail String? // snapshot

  // Engineer's PREFERENCE (loose socket, hint only); the reviewer sets the FINAL warehouse on
  // approve (restock). Returns carry the final warehouse from create.
  preferredWarehouseId String?    @db.ObjectId
  warehouseId          String?    @db.ObjectId
  warehouse            Warehouse? @relation(fields: [warehouseId], references: [id])
  warehouseName        String? // snapshot (once final)
  warehouseCode        String? // snapshot (once final)

  reason      String
  notes       String?
  attachments String[] // request-level evidence (Cloudinary URLs)

  reviewedByUserId String?   @db.ObjectId
  reviewedByEmail  String?
  reviewedAt       DateTime?
  decisionNote     String?

  lastFulfilledAt DateTime? // stamped on every posting (drives the stale indicator)
  completionType  String? // complete | closed_short | cancelled_remaining — set when status → fulfilled
  closedShortBy   String? // actor email
  closedShortAt   DateTime?
  closeShortNote  String?
  cancelledAt     DateTime?

  lines       VanStockRequestLine[]
  fulfilments VanStockFulfilment[]

  createdBy String?
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([status])
  @@index([engineerId, status])
  @@index([warehouseId, status])
  @@index([createdAt])
}

model VanStockRequestLine {
  id        String          @id @default(auto()) @map("_id") @db.ObjectId
  requestId String          @db.ObjectId
  request   VanStockRequest @relation(fields: [requestId], references: [id])

  irmItemId String @db.ObjectId // loose socket — company IRM only
  itemName  String // snapshot
  sku       String? // snapshot
  uom       String? // snapshot

  requestedQty Int
  approvedQty  Int? // set on approve (reviewer may trim); returns: = requestedQty at create
  fulfilledQty Int  @default(0) // accumulates across postings

  createdAt DateTime @default(now())

  @@index([requestId])
  @@index([irmItemId])
}

// One row per POSTING event (a scan session that was posted). Restock lines are always "good";
// return lines split good/damaged with mandatory photo + reason on damaged (GM rules).
model VanStockFulfilment {
  id        String          @id @default(auto()) @map("_id") @db.ObjectId
  requestId String          @db.ObjectId
  request   VanStockRequest @relation(fields: [requestId], references: [id])

  sequence    Int // 1, 2, 3… per request
  performedBy String // actor email snapshot
  postedAt    DateTime @default(now())

  lines VanStockFulfilmentLine[]

  @@index([requestId])
}

model VanStockFulfilmentLine {
  id           String             @id @default(auto()) @map("_id") @db.ObjectId
  fulfilmentId String             @db.ObjectId
  fulfilment   VanStockFulfilment @relation(fields: [fulfilmentId], references: [id])

  lineId    String @db.ObjectId // the VanStockRequestLine fulfilled (loose socket)
  irmItemId String @db.ObjectId // loose socket
  itemName  String // snapshot

  qty            Int
  condition      String  @default("good") // good | damaged (returns only)
  damagePhotoUrl String? // required when damaged (Cloudinary URL)
  damageReason   String? // required when damaged
  scannedCode    String? // decoded barcode

  createdAt DateTime @default(now())

  @@index([fulfilmentId])
}
```

- [ ] **Step 2: Add back-relations.** On `model User` (next to the other engineer relations, e.g. after the `EngineerStockTxnOwner` back-relation field): `vanStockRequests VanStockRequest[] @relation("VanStockRequestEngineer")`. On `model Warehouse` (next to its other back-relations): `vanStockRequests VanStockRequest[]`.

- [ ] **Step 3: Regenerate + verify.** Run: `cd backend; pnpm prisma:generate; pnpm typecheck`. Expected: generate succeeds; typecheck passes (no code references the models yet).

- [ ] **Step 4: Checkpoint** — report; ask before committing (`feat(van-stock): add VanStockRequest data model`).

### Task 2: Permissions + seed

**Files:**
- Modify: `backend/src/modules/role/permissions.ts` (after the `goods_management` group, ~line 324; and inside the `engineer` group's permissions array, after `engineer.transfer`, ~line 360)
- Modify: `backend/src/db/seed.ts`

**Interfaces — Produces:** permission keys `engineer.van_stock.request`, `van_stock_request.review` (used by routes, dashboard gating, frontend).

- [ ] **Step 1: Add the engineer key** inside the existing `engineer` group's `permissions` array:

```ts
      { key: "engineer.van_stock.request", action: "Van stock", description: "Request van restock from a warehouse or return excess van stock — non-job. Cancel own pending requests." },
```

- [ ] **Step 2: Add the review group** after the `goods_management` group object:

```ts
  {
    key: "van_stock_request",
    label: "Van Stock Requests",
    description: "Non-job engineer van restock/return requests — review, approve/decline, and fulfil by scan.",
    category: "Goods Management",
    permissions: [
      { key: "van_stock_request.review", action: "Review & fulfil", description: "See the van-request queue, approve/decline restocks, scan-fulfil restocks and returns, close short, and create walk-in requests." },
    ],
  },
```

- [ ] **Step 3: Seed.** In `backend/src/db/seed.ts`: append `"engineer.van_stock.request"` to the `ENGINEER_PORTAL_PERMISSIONS` array (after `"engineer.transfer"`); add a new constant next to `GOODS_MANAGEMENT_PERMISSIONS`:

```ts
// Van stock request review/fulfilment — warehouse-side. Seeded on warehouse_manager + backfilled below.
const VAN_STOCK_REQUEST_PERMISSIONS = ["van_stock_request.review"];
```

Add `...VAN_STOCK_REQUEST_PERMISSIONS` to the `warehouse_manager` role's `permissions` array in the system-roles list. Then copy the existing Goods Management backfill block (seed.ts:292-304) and adapt it — same shape, `VAN_STOCK_REQUEST_PERMISSIONS`, log line `Granted Van Stock Request permissions to N role(s).`. Also confirm the Engineer Portal backfill block already iterates `ENGINEER_PORTAL_PERMISSIONS` (it does — the new key rides along; no new block needed).

- [ ] **Step 4: Verify.** `cd backend; pnpm typecheck; pnpm lint`. Expected: clean.

- [ ] **Step 5: Checkpoint** — report; ask before committing (`feat(van-stock): permissions + seed`).

---

## PHASE 2 — Backend module

### Task 3: Validation schemas (TDD)

**Files:**
- Create: `backend/src/modules/van-stock-request/van-stock-request.validation.ts`
- Create: `backend/src/modules/van-stock-request/van-stock-request.validation.test.ts`

**Interfaces — Produces:** `createVanStockRequestSchema` → `CreateVanStockRequestInput`; `approveVanStockRequestSchema` → `ApproveVanStockRequestInput`; `declineVanStockRequestSchema` → `DeclineVanStockRequestInput`; `fulfilVanStockRequestSchema` → `FulfilVanStockRequestInput`; `closeShortSchema` → `CloseShortInput`; `walkInSchema` → `WalkInInput`; `scanLookupSchema` → `ScanLookupInput`; `uploadImageSchema` → `UploadImageInput`.

- [ ] **Step 1: Write the failing tests** (`van-stock-request.validation.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import {
  approveVanStockRequestSchema,
  closeShortSchema,
  createVanStockRequestSchema,
  fulfilVanStockRequestSchema,
  walkInSchema,
} from "./van-stock-request.validation.js";

const oid = "a".repeat(24);
const line = { irmItemId: oid, itemName: "Cable Ties", qty: 100 };

describe("createVanStockRequestSchema", () => {
  it("accepts a restock with an optional preferred warehouse", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "van low", preferredWarehouseId: oid, lines: [line] });
    expect(r.success).toBe(true);
  });
  it("rejects a restock carrying a final warehouseId", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", warehouseId: oid, lines: [line] });
    expect(r.success).toBe(false);
  });
  it("requires warehouseId on a return and rejects preferredWarehouseId", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", lines: [line] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, lines: [line] }).success).toBe(true);
    expect(createVanStockRequestSchema.safeParse({ type: "return", reason: "excess", warehouseId: oid, preferredWarehouseId: oid, lines: [line] }).success).toBe(false);
  });
  it("rejects duplicate items across lines", () => {
    const r = createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [line, { ...line, qty: 5 }] });
    expect(r.success).toBe(false);
  });
  it("defaults priority to normal and rejects unknown priorities", () => {
    const ok = createVanStockRequestSchema.parse({ type: "restock", reason: "x", lines: [line] });
    expect(ok.priority).toBe("normal");
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", priority: "asap", lines: [line] }).success).toBe(false);
  });
  it("rejects qty < 1 and non-integers", () => {
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [{ ...line, qty: 0 }] }).success).toBe(false);
    expect(createVanStockRequestSchema.safeParse({ type: "restock", reason: "x", lines: [{ ...line, qty: 1.5 }] }).success).toBe(false);
  });
});

describe("approveVanStockRequestSchema", () => {
  it("requires the final warehouse", () => {
    expect(approveVanStockRequestSchema.safeParse({}).success).toBe(false);
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid }).success).toBe(true);
  });
  it("accepts per-line trims with qty ≥ 1", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 60 }] }).success).toBe(true);
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 0 }] }).success).toBe(false);
  });
});

describe("fulfilVanStockRequestSchema", () => {
  it("requires photo + reason on damaged entries", () => {
    const good = { lineId: oid, qty: 5, condition: "good" };
    const damagedBad = { lineId: oid, qty: 5, condition: "damaged" };
    const damagedOk = { ...damagedBad, damagePhotoUrl: "https://res.cloudinary.com/x/d.jpg", damageReason: "crushed" };
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [good] }).success).toBe(true);
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [damagedBad] }).success).toBe(false);
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [damagedOk] }).success).toBe(true);
  });
  it("rejects an empty posting", () => {
    expect(fulfilVanStockRequestSchema.safeParse({ entries: [] }).success).toBe(false);
  });
});

describe("closeShortSchema", () => {
  it("requires a note", () => {
    expect(closeShortSchema.safeParse({}).success).toBe(false);
    expect(closeShortSchema.safeParse({ note: "supplier discontinued" }).success).toBe(true);
  });
});

describe("walkInSchema", () => {
  it("requires engineer + warehouse + lines", () => {
    expect(walkInSchema.safeParse({ engineerId: oid, warehouseId: oid, reason: "counter", lines: [line] }).success).toBe(true);
    expect(walkInSchema.safeParse({ engineerId: oid, reason: "counter", lines: [line] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `cd backend; pnpm test -- van-stock-request.validation`. Expected: FAIL (module not found).

- [ ] **Step 3: Write the schemas** (`van-stock-request.validation.ts`):

```ts
import { z } from "zod";

// Validation for the non-job Van Stock Request flow (engineer ↔ warehouse).
// Restock: engineer may hint a PREFERRED warehouse; the reviewer fixes the final one on approve.
// Return: the engineer picks the FINAL warehouse at create (they drive there); no preference field.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid ObjectId.");

const requestLineSchema = z.object({
  irmItemId: objectId,
  itemName: z.string().trim().min(1, "Item name is required.").max(300),
  qty: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(1_000_000),
});

// Shared line-array rule: no duplicate items on one request — scan-lookup matches a line BY irmItemId,
// so a duplicated item would make its second line unreachable by scan.
const dedupedLines = z
  .array(requestLineSchema)
  .min(1, "Add at least one item.")
  .max(100, "Too many items on one request.")
  .superRefine((lines, ctx) => {
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (seen.has(l.irmItemId)) ctx.addIssue({ code: "custom", path: [i], message: "This item appears twice — combine the quantities into one line." });
      else seen.add(l.irmItemId);
    });
  });

export const createVanStockRequestSchema = z
  .object({
    type: z.enum(["restock", "return"]),
    reason: z.string().trim().min(1, "Tell the warehouse why you need this.").max(2000),
    notes: z.string().trim().max(2000).optional(),
    priority: z.enum(["normal", "high", "urgent"]).default("normal"),
    attachments: z.array(z.string().url("Attachment must be a valid URL.")).max(10).optional(),
    preferredWarehouseId: objectId.optional(), // restock only — a hint
    warehouseId: objectId.optional(), // return only — final
    lines: dedupedLines,
  })
  .superRefine((v, ctx) => {
    if (v.type === "restock" && v.warehouseId) {
      ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Restocks don't fix a warehouse — the reviewer picks it. Use preferredWarehouseId." });
    }
    if (v.type === "return") {
      if (!v.warehouseId) ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "Pick the warehouse you'll return the stock to." });
      if (v.preferredWarehouseId) ctx.addIssue({ code: "custom", path: ["preferredWarehouseId"], message: "Returns fix the warehouse directly — no preference field." });
    }
  });
export type CreateVanStockRequestInput = z.infer<typeof createVanStockRequestSchema>;

export const approveVanStockRequestSchema = z.object({
  warehouseId: objectId, // FINAL fulfilment warehouse (may differ from the engineer's preference)
  lineApprovals: z.array(z.object({ lineId: objectId, approvedQty: z.number().int().min(1).max(1_000_000) })).max(100).optional(),
  decisionNote: z.string().trim().max(2000).optional(),
});
export type ApproveVanStockRequestInput = z.infer<typeof approveVanStockRequestSchema>;

export const declineVanStockRequestSchema = z.object({
  decisionNote: z.string().trim().min(1, "Tell the engineer why this was declined.").max(2000),
});
export type DeclineVanStockRequestInput = z.infer<typeof declineVanStockRequestSchema>;

const fulfilEntrySchema = z
  .object({
    lineId: objectId,
    qty: z.number().int().min(1).max(1_000_000),
    condition: z.enum(["good", "damaged"]).default("good"),
    damagePhotoUrl: z.string().url().max(2000).optional(),
    damageReason: z.string().trim().max(2000).optional(),
    scannedCode: z.string().trim().max(200).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.condition === "damaged") {
      if (!e.damagePhotoUrl) ctx.addIssue({ code: "custom", path: ["damagePhotoUrl"], message: "A photo is required for damaged stock." });
      if (!e.damageReason?.trim()) ctx.addIssue({ code: "custom", path: ["damageReason"], message: "A reason is required for damaged stock." });
    }
  });

export const fulfilVanStockRequestSchema = z.object({
  entries: z.array(fulfilEntrySchema).min(1, "Scan at least one item.").max(200),
});
export type FulfilVanStockRequestInput = z.infer<typeof fulfilVanStockRequestSchema>;

export const closeShortSchema = z.object({
  note: z.string().trim().min(1, "Say why the remaining quantity won't be fulfilled.").max(2000),
});
export type CloseShortInput = z.infer<typeof closeShortSchema>;

export const walkInSchema = z.object({
  engineerId: objectId,
  warehouseId: objectId,
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  notes: z.string().trim().max(2000).optional(),
  lines: dedupedLines,
});
export type WalkInInput = z.infer<typeof walkInSchema>;

export const scanLookupSchema = z.object({
  requestId: objectId,
  code: z.string().trim().min(1).max(200),
});
export type ScanLookupInput = z.infer<typeof scanLookupSchema>;

// ~2 MB budget (same as kit-request / engineer-transfer uploads).
const MAX_DATA_URI_CHARS = 3 * 1024 * 1024;
export const uploadImageSchema = z.object({
  image: z
    .string()
    .max(MAX_DATA_URI_CHARS, "Attachment is too large (max ~2 MB).")
    .regex(/^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf|application\/octet-stream)/i, "Attachment must be a base64 data URI."),
});
export type UploadImageInput = z.infer<typeof uploadImageSchema>;
```

- [ ] **Step 4: Run tests.** `pnpm test -- van-stock-request.validation`. Expected: PASS.

- [ ] **Step 5: Checkpoint** — `pnpm typecheck; pnpm lint`; report; ask before committing (`feat(van-stock): validation schemas`).

### Task 4: Repository

**Files:**
- Create: `backend/src/modules/van-stock-request/van-stock-request.repository.ts`

**Interfaces:**
- Consumes: Prisma models from Task 1; `withTransaction`, `prisma` from `../../lib/prisma.js`; `escapeRegex` from `../../utils/search.js`.
- Produces (Task 5 relies on): `RequestWithLines`, `createRequest(data, lines)`, `findById(id)`, `listRequests(params)`, `countPending(scope?)`, `claimPendingForApproval(id, patch, lineApprovals)`, `declinePending(id, patch)`, `cancelPending(id, engineerId)`, `finishRemaining(id, patch)` (cancel-remaining/close-short), `postFulfilment(requestId, allowedStatuses, performedBy, entries, apply)`, `findOpenLineItems(engineerId, type)`, `pendingWorklist()`.

- [ ] **Step 1: Write the repository:**

```ts
import { Prisma, type VanStockRequest, type VanStockRequestLine, type VanStockFulfilment, type VanStockFulfilmentLine } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict, notFound } from "../../utils/http-error.js";
import { escapeRegex } from "../../utils/search.js";

// The ONLY place Prisma is touched for the four VanStock* models. Code allocation copies the JKR
// atomic Counter + retry mechanism; the posting transaction mirrors GM's createMovementWithCode.

export type FulfilmentWithLines = VanStockFulfilment & { lines: VanStockFulfilmentLine[] };
export type RequestWithLines = VanStockRequest & { lines: VanStockRequestLine[]; fulfilments: FulfilmentWithLines[] };

const INCLUDE = { lines: true, fulfilments: { include: { lines: true }, orderBy: { sequence: "asc" as const } } };

export interface CreateRequestData {
  code: string;
  type: string;
  status: string;
  priority: string;
  createdVia: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  warehouseCode?: string | null;
  reason: string;
  notes?: string | null;
  attachments: string[];
  reviewedByUserId?: string | null;
  reviewedByEmail?: string | null;
  reviewedAt?: Date | null;
  createdBy?: string | null;
}

export interface CreateRequestLineData {
  irmItemId: string;
  itemName: string;
  sku?: string | null;
  uom?: string | null;
  requestedQty: number;
  approvedQty?: number | null;
}

// ---- Code allocation (VSR-####) — identical mechanism to JKR ----------------------------------
const VSR_CODE_PREFIX = "VSR";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestVsrNumber(): Promise<number> {
  const head = `${VSR_CODE_PREFIX}-`;
  const rows = await prisma.vanStockRequest.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextVsrSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: VSR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestVsrNumber();
  try {
    await prisma.counter.create({ data: { key: VSR_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: VSR_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardVsrCounter(): Promise<void> {
  const start = await highestVsrNumber();
  try {
    await prisma.counter.upsert({ where: { key: VSR_CODE_PREFIX }, create: { key: VSR_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort */
  }
}

export async function createRequest(data: CreateRequestData, lines: CreateRequestLineData[]): Promise<RequestWithLines> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextVsrSequence();
    const code = `${VSR_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const req = await tx.vanStockRequest.create({ data: { deletedAt: null, ...data, code, lines: { create: lines } } });
        return tx.vanStockRequest.findUniqueOrThrow({ where: { id: req.id }, include: INCLUDE });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardVsrCounter();
    }
  }
  throw new Error("Could not allocate a unique van-stock-request code.");
}

// ---- Reads -----------------------------------------------------------------------------------
export function findById(id: string): Promise<RequestWithLines | null> {
  if (!id) return Promise.resolve(null);
  return prisma.vanStockRequest.findFirst({ where: { id, deletedAt: null }, include: INCLUDE });
}

function searchOr(s: string): Prisma.VanStockRequestWhereInput[] {
  const term = escapeRegex(s);
  return [
    { code: { contains: term, mode: "insensitive" } },
    { reason: { contains: term, mode: "insensitive" } },
    { engineerName: { contains: term, mode: "insensitive" } },
    { warehouseName: { contains: term, mode: "insensitive" } },
  ];
}

export interface ListParams {
  status?: string;
  type?: string;
  engineerId?: string;
  priority?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  // Warehouse scoping: pending requests may have NO final warehouse yet, so a scoped reviewer sees
  // (warehouseId ∈ scope) OR (status pending). undefined ⇒ unrestricted.
  warehouseScope?: string[];
}

export async function listRequests(params: ListParams = {}): Promise<{ requests: RequestWithLines[]; total: number }> {
  const { status, type, engineerId, priority, search, sort, page = 1, pageSize = 20, warehouseScope } = params;
  const and: Prisma.VanStockRequestWhereInput[] = [{ deletedAt: null }];
  if (status) and.push({ status });
  if (type) and.push({ type });
  if (engineerId) and.push({ engineerId });
  if (priority) and.push({ priority });
  if (search?.trim()) and.push({ OR: searchOr(search.trim()) });
  if (warehouseScope) and.push({ OR: [{ warehouseId: { in: warehouseScope } }, { status: "pending" }] });
  const where: Prisma.VanStockRequestWhereInput = { AND: and };
  const skip = (page - 1) * pageSize;
  const [requests, total] = await Promise.all([
    prisma.vanStockRequest.findMany({ where, include: INCLUDE, orderBy: sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" }, skip, take: pageSize }),
    prisma.vanStockRequest.count({ where }),
  ]);
  return { requests, total };
}

export function countPending(): Promise<number> {
  return prisma.vanStockRequest.count({ where: { status: "pending", deletedAt: null } });
}

// Open (pending/approved/partially_fulfilled) line items for one engineer + type — powers the
// non-blocking duplicate warning in the composer.
export async function findOpenLineItems(engineerId: string, type: string): Promise<Array<{ irmItemId: string; code: string }>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { engineerId, type, deletedAt: null, status: { in: ["pending", "approved", "partially_fulfilled"] } },
    select: { code: true, lines: { select: { irmItemId: true } } },
  });
  return rows.flatMap((r) => r.lines.map((l) => ({ irmItemId: l.irmItemId, code: r.code })));
}

// ---- Atomic transitions ------------------------------------------------------------------------

export interface ApprovalPatch {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  decisionNote: string | null;
}

// Approve (restock): flip pending → approved atomically, then stamp the warehouse + per-line
// approvedQty in the SAME transaction. Loser of a concurrent approve matches 0 rows → conflict.
export async function claimPendingForApproval(id: string, patch: ApprovalPatch, lineApprovals: Array<{ lineId: string; approvedQty: number }>): Promise<RequestWithLines> {
  return withTransaction(async (tx) => {
    const res = await tx.vanStockRequest.updateMany({
      where: { id, status: "pending", deletedAt: null },
      data: {
        status: "approved",
        warehouseId: patch.warehouseId,
        warehouseName: patch.warehouseName,
        warehouseCode: patch.warehouseCode,
        reviewedByUserId: patch.reviewedByUserId,
        reviewedByEmail: patch.reviewedByEmail,
        reviewedAt: new Date(),
        decisionNote: patch.decisionNote,
      },
    });
    if (res.count === 0) throw conflict("This request was just handled by someone else.");
    for (const la of lineApprovals) {
      await tx.vanStockRequestLine.update({ where: { id: la.lineId }, data: { approvedQty: la.approvedQty } });
    }
    return tx.vanStockRequest.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  });
}

export interface DeclinePatch {
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  decisionNote: string;
}

export async function declinePending(id: string, patch: DeclinePatch): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "pending", deletedAt: null },
    data: { status: "declined", reviewedByUserId: patch.reviewedByUserId, reviewedByEmail: patch.reviewedByEmail, reviewedAt: new Date(), decisionNote: patch.decisionNote },
  });
  return res.count;
}

export async function cancelPending(id: string, engineerId: string): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "pending", deletedAt: null, engineerId },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return res.count;
}

export interface FinishRemainingPatch {
  completionType: string; // closed_short | cancelled_remaining
  closedShortBy?: string | null;
  closeShortNote?: string | null;
  engineerId?: string; // guard: only the owner may cancel-remaining
}

// Close short (warehouse) / cancel remaining (engineer): partially_fulfilled → fulfilled.
export async function finishRemaining(id: string, patch: FinishRemainingPatch): Promise<number> {
  const res = await prisma.vanStockRequest.updateMany({
    where: { id, status: "partially_fulfilled", deletedAt: null, ...(patch.engineerId ? { engineerId: patch.engineerId } : {}) },
    data: {
      status: "fulfilled",
      completionType: patch.completionType,
      ...(patch.completionType === "closed_short" ? { closedShortBy: patch.closedShortBy ?? null, closedShortAt: new Date(), closeShortNote: patch.closeShortNote ?? null } : { cancelledAt: new Date() }),
    },
  });
  return res.count;
}

// ---- The posting transaction --------------------------------------------------------------------

export interface FulfilEntry {
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: string; // good | damaged
  damagePhotoUrl?: string | null;
  damageReason?: string | null;
  scannedCode?: string | null;
}

// One atomic posting: re-read + guard inside the tx, run the caller's ledger writes (apply), append
// the VanStockFulfilment document, accumulate fulfilledQty, recompute status. Mirrors GM's
// createMovementWithCode(header, lines, apply) shape — everything commits or nothing does.
export async function postFulfilment(
  requestId: string,
  allowedStatuses: string[],
  performedBy: string,
  entries: FulfilEntry[],
  apply: (tx: Prisma.TransactionClient, req: RequestWithLines) => Promise<void>,
): Promise<RequestWithLines> {
  return withTransaction(async (tx) => {
    const req = await tx.vanStockRequest.findFirst({ where: { id: requestId, deletedAt: null }, include: INCLUDE });
    if (!req) throw notFound("Van stock request not found.");
    if (!allowedStatuses.includes(req.status)) throw conflict(`This request is ${req.status} — it can't be fulfilled.`);

    // Server-side remaining-qty guard, per request line, INSIDE the tx (concurrent postings abort).
    const byLine = new Map(req.lines.map((l) => [l.id, l]));
    const postedByLine = new Map<string, number>();
    for (const e of entries) {
      const line = byLine.get(e.lineId);
      if (!line) throw conflict("A scanned entry doesn't belong to this request — refresh and try again.");
      postedByLine.set(e.lineId, (postedByLine.get(e.lineId) ?? 0) + e.qty);
    }
    for (const [lineId, qty] of postedByLine) {
      const line = byLine.get(lineId)!;
      const cap = (line.approvedQty ?? line.requestedQty) - line.fulfilledQty;
      if (qty > cap) throw conflict(`"${line.itemName}": only ${cap} left to fulfil on this request.`);
    }

    await apply(tx, req);

    const seq = req.fulfilments.length + 1;
    await tx.vanStockFulfilment.create({
      data: {
        requestId,
        sequence: seq,
        performedBy,
        lines: {
          create: entries.map((e) => ({
            lineId: e.lineId,
            irmItemId: e.irmItemId,
            itemName: e.itemName,
            qty: e.qty,
            condition: e.condition,
            damagePhotoUrl: e.damagePhotoUrl ?? null,
            damageReason: e.damageReason ?? null,
            scannedCode: e.scannedCode ?? null,
          })),
        },
      },
    });

    for (const [lineId, qty] of postedByLine) {
      await tx.vanStockRequestLine.update({ where: { id: lineId }, data: { fulfilledQty: { increment: qty } } });
    }

    // Recompute status from the post-increment lines.
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId } });
    const done = fresh.every((l) => l.fulfilledQty >= (l.approvedQty ?? l.requestedQty));
    await tx.vanStockRequest.update({
      where: { id: requestId },
      data: { status: done ? "fulfilled" : "partially_fulfilled", lastFulfilledAt: new Date(), ...(done ? { completionType: "complete" } : {}) },
    });

    return tx.vanStockRequest.findUniqueOrThrow({ where: { id: requestId }, include: INCLUDE });
  });
}

// --- Dashboard read-model ---
/** Pending VSRs for the warehouse worklist. Oldest-first, capped 50 (service re-caps the merge). */
export async function pendingWorklist(): Promise<Array<{ id: string; code: string; type: string; engineerName: string; priority: string; createdAt: Date }>> {
  const rows = await prisma.vanStockRequest.findMany({
    where: { status: "pending", deletedAt: null },
    select: { id: true, code: true, type: true, engineerName: true, priority: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows;
}
```

- [ ] **Step 2: Verify.** `cd backend; pnpm typecheck; pnpm lint`. Expected: clean.

- [ ] **Step 3: Checkpoint** — report; ask before committing (`feat(van-stock): repository`).

### Task 5: Service (pure helpers TDD, then orchestration)

**Files:**
- Create: `backend/src/modules/van-stock-request/van-stock-request.service.ts`
- Create: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts`

**Interfaces:**
- Consumes: repository (Task 4); `inventoryService.applyOutbound/applyInbound` (`#modules/inventory/inventory.service.js`, `ApplyMovementInput`); `engineerStockRepo.upsertEngineerBalanceTx/insertEngineerTxnTx/findEngineerBalances/findEngineerBalance` (`#modules/engineer-stock/engineer-stock.repository.js`); `goodsManagementRepo.upsertDamagedBalanceTx/insertDamagedTxnTx` + `DamagedKey` (`#modules/goods-management/goods-management.repository.js`); `irmService.findActiveByCodeOrBarcode`, `irmRepo.findById/findMany`; `warehouseRepo.findById/findMany`; `userRepo.findById`; `inventoryRepo.findBalancePair`; `audit.record`; `emitToUser/emitToRoom/OFFICE_JOBS_ROOM`; `getCloudinaryCreds` + `uploadToCloudinary`; `assertWarehouseAccess/warehouseScopeFilter`.
- Produces (Tasks 6-7 + frontend rely on): `PublicVanStockRequest` DTO (adds `stale: boolean`, `remainingByLine`), `create`, `walkIn`, `approve`, `decline`, `cancel`, `cancelRemaining`, `closeShort`, `fulfil`, `scanLookup`, `listMine`, `listAll`, `getOne`, `countPending`, `myHoldings`, `searchItems`, `listWarehousesLite`, `openLineItems`, `uploadImage`. Pure exports for tests: `isStale(req, now)`, `STALE_PENDING_DAYS`, `STALE_ACTIVE_DAYS`.

- [ ] **Step 1: Write the failing pure-helper tests** (`van-stock-request.service.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import { isStale, STALE_ACTIVE_DAYS, STALE_PENDING_DAYS } from "./van-stock-request.service.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-14T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

function req(over: Partial<{ status: string; createdAt: Date; reviewedAt: Date | null; lastFulfilledAt: Date | null }>) {
  return { status: "pending", createdAt: ago(0), reviewedAt: null, lastFulfilledAt: null, ...over };
}

describe("isStale", () => {
  it("flags pending older than the pending threshold", () => {
    expect(isStale(req({ createdAt: ago(STALE_PENDING_DAYS + 1) }), now)).toBe(true);
    expect(isStale(req({ createdAt: ago(STALE_PENDING_DAYS - 1) }), now)).toBe(false);
  });
  it("flags approved with no posting activity past the active threshold", () => {
    expect(isStale(req({ status: "approved", reviewedAt: ago(STALE_ACTIVE_DAYS + 1) }), now)).toBe(true);
    expect(isStale(req({ status: "approved", reviewedAt: ago(STALE_ACTIVE_DAYS - 1) }), now)).toBe(false);
  });
  it("measures partially_fulfilled from the LAST posting, not the review", () => {
    expect(isStale(req({ status: "partially_fulfilled", reviewedAt: ago(90), lastFulfilledAt: ago(STALE_ACTIVE_DAYS - 2) }), now)).toBe(false);
    expect(isStale(req({ status: "partially_fulfilled", reviewedAt: ago(90), lastFulfilledAt: ago(STALE_ACTIVE_DAYS + 2) }), now)).toBe(true);
  });
  it("never flags terminal states", () => {
    for (const status of ["fulfilled", "declined", "cancelled"]) {
      expect(isStale(req({ status, createdAt: ago(400) }), now)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm test -- van-stock-request.service`. Expected: FAIL (module not found).

- [ ] **Step 3: Write the service.** Key content (complete file):

```ts
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { emitToRoom, emitToUser, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as vsrRepo from "./van-stock-request.repository.js";
import type { CreateRequestData, CreateRequestLineData, FulfilEntry, RequestWithLines } from "./van-stock-request.repository.js";
import type {
  ApproveVanStockRequestInput,
  CloseShortInput,
  CreateVanStockRequestInput,
  DeclineVanStockRequestInput,
  FulfilVanStockRequestInput,
  ScanLookupInput,
  WalkInInput,
} from "./van-stock-request.validation.js";

// Non-job engineer ↔ warehouse stock flow. Restock: pending → approved (reviewer fixes warehouse,
// may trim) → scan-out postings. Return: pending → scan-in postings directly (scan IS acceptance).
// All ledger writes ride the existing primitives inside ONE transaction per posting.

const SOURCE_TYPE = "van_stock_request";
const DAMAGED_SOURCE_TYPE = "van_stock_return";

// ── Stale indicator (derived; no scheduler — spec §9) ─────────────────────────────────────────
export const STALE_PENDING_DAYS = 7;
export const STALE_ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(req: { status: string; createdAt: Date; reviewedAt: Date | null; lastFulfilledAt: Date | null }, now: Date): boolean {
  if (req.status === "pending") return now.getTime() - req.createdAt.getTime() > STALE_PENDING_DAYS * DAY_MS;
  if (req.status === "approved" || req.status === "partially_fulfilled") {
    const anchor = req.lastFulfilledAt ?? req.reviewedAt ?? req.createdAt;
    return now.getTime() - anchor.getTime() > STALE_ACTIVE_DAYS * DAY_MS;
  }
  return false;
}

// ── DTOs ───────────────────────────────────────────────────────────────────────────────────────

export interface PublicVanStockLine {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  uom: string | null;
  requestedQty: number;
  approvedQty: number | null;
  fulfilledQty: number;
  remainingQty: number; // (approvedQty ?? requestedQty) − fulfilledQty
}

export interface PublicVanStockFulfilmentLine {
  id: string;
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: string;
  damagePhotoUrl: string | null;
  damageReason: string | null;
  scannedCode: string | null;
}

export interface PublicVanStockFulfilment {
  id: string;
  sequence: number;
  performedBy: string;
  postedAt: string;
  lines: PublicVanStockFulfilmentLine[];
}

export interface PublicVanStockRequest {
  id: string;
  code: string;
  type: string;
  status: string;
  priority: string;
  createdVia: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  lastFulfilledAt: string | null;
  completionType: string | null;
  closedShortBy: string | null;
  closedShortAt: string | null;
  closeShortNote: string | null;
  cancelledAt: string | null;
  stale: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PublicVanStockLine[];
  fulfilments: PublicVanStockFulfilment[];
}

export interface PagedVanStockRequests {
  requests: PublicVanStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function toPublic(r: RequestWithLines, now = new Date()): PublicVanStockRequest {
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    status: r.status,
    priority: r.priority,
    createdVia: r.createdVia,
    engineerId: r.engineerId,
    engineerName: r.engineerName,
    engineerEmail: r.engineerEmail,
    preferredWarehouseId: r.preferredWarehouseId,
    warehouseId: r.warehouseId,
    warehouseName: r.warehouseName,
    warehouseCode: r.warehouseCode,
    reason: r.reason,
    notes: r.notes,
    attachments: r.attachments,
    reviewedByUserId: r.reviewedByUserId,
    reviewedByEmail: r.reviewedByEmail,
    reviewedAt: iso(r.reviewedAt),
    decisionNote: r.decisionNote,
    lastFulfilledAt: iso(r.lastFulfilledAt),
    completionType: r.completionType,
    closedShortBy: r.closedShortBy,
    closedShortAt: iso(r.closedShortAt),
    closeShortNote: r.closeShortNote,
    cancelledAt: iso(r.cancelledAt),
    stale: isStale(r, now),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: r.lines.map((l) => ({
      id: l.id,
      irmItemId: l.irmItemId,
      itemName: l.itemName,
      sku: l.sku,
      uom: l.uom,
      requestedQty: l.requestedQty,
      approvedQty: l.approvedQty,
      fulfilledQty: l.fulfilledQty,
      remainingQty: (l.approvedQty ?? l.requestedQty) - l.fulfilledQty,
    })),
    fulfilments: r.fulfilments.map((f) => ({
      id: f.id,
      sequence: f.sequence,
      performedBy: f.performedBy,
      postedAt: f.postedAt.toISOString(),
      lines: f.lines.map((fl) => ({
        id: fl.id,
        lineId: fl.lineId,
        irmItemId: fl.irmItemId,
        itemName: fl.itemName,
        qty: fl.qty,
        condition: fl.condition,
        damagePhotoUrl: fl.damagePhotoUrl,
        damageReason: fl.damageReason,
        scannedCode: fl.scannedCode,
      })),
    })),
  };
}

function emitUpdate(engineerId: string, data: { id: string; code: string; status: string; type: string }): void {
  emitToUser(engineerId, "van_stock_request:updated", data);
  emitToRoom(OFFICE_JOBS_ROOM, "van_stock_request:updated", data);
}

function isReviewer(actor: AuditActor): boolean {
  const perms = actor.permissions ?? [];
  return actor.type === "admin" || perms.includes("*") || perms.includes("van_stock_request.review");
}

// Resolve + validate the request's IRM lines against the live catalogue (active, non-serial/batch).
async function resolveLines(lines: Array<{ irmItemId: string; itemName: string; qty: number }>): Promise<CreateRequestLineData[]> {
  return Promise.all(
    lines.map(async (l): Promise<CreateRequestLineData> => {
      const item = await irmRepo.findById(l.irmItemId);
      if (!item) throw badRequest(`The IRM item for "${l.itemName}" no longer exists.`);
      if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
      if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported on van stock requests.`);
      return { irmItemId: item.id, itemName: item.name, sku: item.sku ?? null, uom: item.baseUnit ?? null, requestedQty: l.qty };
    }),
  );
}

// ── create (engineer) ───────────────────────────────────────────────────────────────────────────

export async function create(input: CreateVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const engineerId = actor.id ?? "";
  const engineer = await userRepo.findById(engineerId);
  if (!engineer) throw forbidden("Could not determine engineer identity.");

  const lines = await resolveLines(input.lines);

  let warehouseId: string | null = null;
  let warehouseName: string | null = null;
  let warehouseCode: string | null = null;
  if (input.type === "return") {
    const wh = await warehouseRepo.findById(input.warehouseId!);
    if (!wh) throw badRequest("The selected warehouse no longer exists.");
    warehouseId = wh.id;
    warehouseName = wh.name;
    warehouseCode = wh.code ?? null;
    // Advisory on-hand check — the binding guard runs at posting time inside the tx.
    for (const l of lines) {
      const bal = await engineerStockRepo.findEngineerBalance(l.irmItemId, engineerId);
      if ((bal?.quantityOnHand ?? 0) < l.requestedQty) {
        throw badRequest(`You only hold ${bal?.quantityOnHand ?? 0} of "${l.itemName}" — you can't offer ${l.requestedQty} back.`);
      }
    }
  } else if (input.preferredWarehouseId) {
    const wh = await warehouseRepo.findById(input.preferredWarehouseId);
    if (!wh) throw badRequest("The preferred warehouse no longer exists.");
  }

  const data: CreateRequestData = {
    code: "",
    type: input.type,
    status: "pending",
    priority: input.priority,
    createdVia: "engineer_request",
    engineerId,
    engineerName: engineer.name ?? engineer.email ?? "",
    engineerEmail: engineer.email ?? null,
    preferredWarehouseId: input.type === "restock" ? input.preferredWarehouseId ?? null : null,
    warehouseId,
    warehouseName,
    warehouseCode,
    reason: input.reason,
    notes: input.notes ?? null,
    attachments: input.attachments ?? [],
    createdBy: actor.email ?? null,
  };
  // Returns are auto-approved conceptually: approvedQty = requestedQty at create (spec §4).
  const withApproved = input.type === "return" ? lines.map((l) => ({ ...l, approvedQty: l.requestedQty })) : lines;

  const req = await vsrRepo.createRequest(data, withApproved);
  audit.record({ actor, action: "van_stock_request.created", targetType: "van_stock_request", targetId: req.id, targetLabel: req.code, metadata: { type: req.type, lineCount: lines.length, priority: req.priority } });
  emitUpdate(engineerId, { id: req.id, code: req.code, status: req.status, type: req.type });
  return toPublic(req);
}

// ── walk-in (reviewer creates pre-approved for an engineer at the counter) ──────────────────────

export async function walkIn(input: WalkInInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const engineer = await userRepo.findById(input.engineerId);
  if (!engineer) throw notFound("Engineer not found.");
  const wh = await warehouseRepo.findById(input.warehouseId);
  if (!wh) throw notFound("Warehouse not found.");
  assertWarehouseAccess(actor, wh.id);

  const lines = await resolveLines(input.lines);
  const data: CreateRequestData = {
    code: "",
    type: "restock",
    status: "approved",
    priority: input.priority,
    createdVia: "walk_in",
    engineerId: engineer.id,
    engineerName: engineer.name ?? engineer.email ?? "",
    engineerEmail: engineer.email ?? null,
    warehouseId: wh.id,
    warehouseName: wh.name,
    warehouseCode: wh.code ?? null,
    reason: input.reason,
    notes: input.notes ?? null,
    attachments: [],
    reviewedByUserId: actor.id ?? null,
    reviewedByEmail: actor.email ?? null,
    reviewedAt: new Date(),
    createdBy: actor.email ?? null,
  };
  const req = await vsrRepo.createRequest(data, lines.map((l) => ({ ...l, approvedQty: l.requestedQty })));
  audit.record({ actor, action: "van_stock_request.walk_in_created", targetType: "van_stock_request", targetId: req.id, targetLabel: req.code, metadata: { engineerId: engineer.id, warehouseId: wh.id } });
  emitUpdate(engineer.id, { id: req.id, code: req.code, status: req.status, type: req.type });
  return toPublic(req);
}

// ── approve / decline (reviewer; restock only) ─────────────────────────────────────────────────

export async function approve(id: string, input: ApproveVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.type !== "restock") throw conflict("Returns don't need approval — scan them in to accept.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const wh = await warehouseRepo.findById(input.warehouseId);
  if (!wh) throw badRequest("The chosen warehouse no longer exists.");
  assertWarehouseAccess(actor, wh.id);

  // Per-line trims: default = requestedQty; a trim may only reduce, never grow.
  const trims = new Map((input.lineApprovals ?? []).map((a) => [a.lineId, a.approvedQty]));
  const lineApprovals = req.lines.map((l) => {
    const trimmed = trims.get(l.id) ?? l.requestedQty;
    if (trimmed > l.requestedQty) throw badRequest(`"${l.itemName}": approved quantity can't exceed the requested ${l.requestedQty}.`);
    return { lineId: l.id, approvedQty: trimmed };
  });

  const updated = await vsrRepo.claimPendingForApproval(
    id,
    { warehouseId: wh.id, warehouseName: wh.name, warehouseCode: wh.code ?? null, reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null },
    lineApprovals,
  );

  audit.record({ actor, action: "van_stock_request.approved", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { warehouseId: wh.id, trims: input.lineApprovals ?? [] } });
  emitUpdate(req.engineerId, { id, code: req.code, status: "approved", type: req.type });
  return toPublic(updated);
}

export async function decline(id: string, input: DeclineVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);
  if (req.warehouseId) assertWarehouseAccess(actor, req.warehouseId);

  const count = await vsrRepo.declinePending(id, { reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote });
  if (count === 0) throw conflict("This request was just handled by someone else.");
  const updated = await vsrRepo.findById(id);

  audit.record({ actor, action: "van_stock_request.declined", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { decisionNote: input.decisionNote } });
  emitUpdate(req.engineerId, { id, code: req.code, status: "declined", type: req.type });
  return toPublic(updated!);
}

// ── cancel / cancel-remaining (engineer) + close-short (reviewer) ───────────────────────────────

export async function cancel(id: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);
  const count = await vsrRepo.cancelPending(id, actor.id ?? "");
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel it, and only while it's pending.");
  const updated = await vsrRepo.findById(id);
  audit.record({ actor, action: "van_stock_request.cancelled", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: {} });
  emitUpdate(req.engineerId, { id, code: req.code, status: "cancelled", type: req.type });
  return toPublic(updated!);
}

export async function cancelRemaining(id: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request has a remainder to cancel.");
  const count = await vsrRepo.finishRemaining(id, { completionType: "cancelled_remaining", engineerId: actor.id ?? "" });
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel its remainder.");
  const updated = await vsrRepo.findById(id);
  audit.record({ actor, action: "van_stock_request.cancelled_remaining", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: {} });
  emitUpdate(req.engineerId, { id, code: req.code, status: "fulfilled", type: req.type });
  return toPublic(updated!);
}

export async function closeShort(id: string, input: CloseShortInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request can be closed short.");
  if (req.warehouseId) assertWarehouseAccess(actor, req.warehouseId);
  const count = await vsrRepo.finishRemaining(id, { completionType: "closed_short", closedShortBy: actor.email ?? null, closeShortNote: input.note });
  if (count === 0) throw conflict("This request was just handled by someone else.");
  const updated = await vsrRepo.findById(id);
  audit.record({ actor, action: "van_stock_request.closed_short", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { note: input.note } });
  emitUpdate(req.engineerId, { id, code: req.code, status: "fulfilled", type: req.type });
  return toPublic(updated!);
}

// ── scan-lookup (reviewer; §7 barcode rules) ───────────────────────────────────────────────────

export interface ScanLookupResult {
  irmItemId: string;
  lineId: string;
  itemName: string;
  uom: string | null;
  remainingQty: number;
  available: number | null; // restock: warehouse on-hand; return: engineer on-hand
}

export async function scanLookup(input: ScanLookupInput, actor: AuditActor): Promise<ScanLookupResult> {
  const req = await vsrRepo.findById(input.requestId);
  if (!req) throw notFound("Van stock request not found.");
  if (req.warehouseId) assertWarehouseAccess(actor, req.warehouseId);

  const item = await irmService.findActiveByCodeOrBarcode(input.code);
  if (!item) throw badRequest("No active catalogue item matches that code.");
  if (item.trackSerialNumbers || item.trackBatchNumbers) throw badRequest(`"${item.name}" is serial/batch-tracked — not supported here.`);

  const line = req.lines.find((l) => l.irmItemId === item.id);
  if (!line) throw badRequest(`"${item.name}" isn't on this request.`);
  const remainingQty = (line.approvedQty ?? line.requestedQty) - line.fulfilledQty;
  if (remainingQty <= 0) throw badRequest(`"${item.name}" is already fully fulfilled on this request.`);

  let available: number | null = null;
  if (req.type === "restock" && req.warehouseId) {
    const bal = await inventoryRepo.findBalancePair(item.id, req.warehouseId);
    available = bal?.quantityOnHand ?? 0;
  } else if (req.type === "return") {
    const bal = await engineerStockRepo.findEngineerBalance(item.id, req.engineerId);
    available = bal?.quantityOnHand ?? 0;
  }
  return { irmItemId: item.id, lineId: line.id, itemName: item.name, uom: item.baseUnit ?? null, remainingQty, available };
}

// ── fulfil (reviewer; one atomic posting — spec §5/§6) ─────────────────────────────────────────

export async function fulfil(id: string, input: FulfilVanStockRequestInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  const allowed = req.type === "restock" ? ["approved", "partially_fulfilled"] : ["pending", "partially_fulfilled"];
  if (!allowed.includes(req.status)) throw conflict(`This request is ${req.status} — it can't be fulfilled.`);
  if (!req.warehouseId) throw conflict("This request has no fulfilment warehouse yet.");
  assertWarehouseAccess(actor, req.warehouseId);
  if (req.type === "restock" && input.entries.some((e) => e.condition === "damaged")) {
    throw badRequest("Damaged condition only applies to returns.");
  }

  const byLine = new Map(req.lines.map((l) => [l.id, l]));
  const entries: FulfilEntry[] = input.entries.map((e) => {
    const line = byLine.get(e.lineId);
    if (!line) throw badRequest("An entry doesn't belong to this request.");
    return { lineId: e.lineId, irmItemId: line.irmItemId, itemName: line.itemName, qty: e.qty, condition: e.condition, damagePhotoUrl: e.damagePhotoUrl ?? null, damageReason: e.damageReason ?? null, scannedCode: e.scannedCode ?? null };
  });

  const warehouseId = req.warehouseId;
  const createdBy = actor.email ?? null;

  const updated = await vsrRepo.postFulfilment(id, allowed, actor.email ?? "", entries, async (tx, fresh) => {
    for (const e of entries) {
      if (fresh.type === "restock") {
        // Warehouse − (zero-floor guarded) → van + → engineer ledger row.
        await inventoryService.applyOutbound(tx, { irmItemId: e.irmItemId, warehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, e.irmItemId, fresh.engineerId, e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId: e.irmItemId, engineerId: fresh.engineerId, quantityDelta: e.qty, type: "van_restock", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
      } else {
        // Van − (floor guarded) → good: warehouse + | damaged: damaged pool.
        const bal = await engineerStockRepo.upsertEngineerBalanceTx(tx, e.irmItemId, fresh.engineerId, -e.qty);
        await engineerStockRepo.insertEngineerTxnTx(tx, { irmItemId: e.irmItemId, engineerId: fresh.engineerId, quantityDelta: -e.qty, type: "van_return", sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: bal.quantityOnHand, createdBy });
        if (e.condition === "good") {
          await inventoryService.applyInbound(tx, { irmItemId: e.irmItemId, warehouseId, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
        } else {
          const key: goodsManagementRepo.DamagedKey = { warehouseId, ownerType: "company", irmItemId: e.irmItemId, customerStockEntryId: null, customerId: null, itemName: e.itemName };
          const dmg = await goodsManagementRepo.upsertDamagedBalanceTx(tx, key, e.qty);
          await goodsManagementRepo.insertDamagedTxnTx(tx, { warehouseId, ownerType: "company", irmItemId: e.irmItemId, customerStockEntryId: null, customerId: null, quantityDelta: e.qty, reason: e.damageReason ?? "Damaged on van return", notes: null, photoUrl: e.damagePhotoUrl ?? null, sourceType: DAMAGED_SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, balanceAfter: dmg.quantity, createdBy });
        }
      }
    }
  });

  audit.record({ actor, action: "van_stock_request.fulfilment_posted", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { entries: entries.map((e) => ({ item: e.itemName, qty: e.qty, condition: e.condition })) } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  return toPublic(updated);
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

function paged(result: { requests: RequestWithLines[]; total: number }, page: number, pageSize: number): PagedVanStockRequests {
  const now = new Date();
  return { requests: result.requests.map((r) => toPublic(r, now)), total: result.total, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) };
}

export async function listMine(engineerId: string, params: { status?: string; type?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedVanStockRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  return paged(await vsrRepo.listRequests({ ...params, engineerId, page, pageSize }), page, pageSize);
}

export async function listAll(actor: AuditActor, params: { status?: string; type?: string; priority?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedVanStockRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  return paged(await vsrRepo.listRequests({ ...params, warehouseScope: warehouseScopeFilter(actor), page, pageSize }), page, pageSize);
}

export function countPending(): Promise<number> {
  return vsrRepo.countPending();
}

export async function getOne(id: string, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  const isOwner = (actor.id ?? "") === req.engineerId;
  if (!isReviewer(actor) && !isOwner) throw forbidden("You don't have access to this request.");
  // Warehouse-scoped reviewers may only open requests in their scope once the warehouse is fixed —
  // mirrors the list filter (pending/unfixed stays visible to every reviewer). The requester always
  // sees their own request.
  if (!isOwner && req.warehouseId) assertWarehouseAccess(actor, req.warehouseId);
  return toPublic(req);
}

// Other open requests by the same engineer — reviewer-side duplicate context (spec §8).
export async function openLineItems(engineerId: string, type: string): Promise<Array<{ irmItemId: string; code: string }>> {
  return vsrRepo.findOpenLineItems(engineerId, type);
}

// Engineer's on-hand (return composer source). Serial/batch never reach the van via supported flows,
// but filter defensively.
export interface HoldingOption {
  irmItemId: string;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
}
export async function myHoldings(engineerId: string): Promise<HoldingOption[]> {
  const rows = await engineerStockRepo.findEngineerBalances(engineerId);
  return rows
    .filter((b) => !b.irmItem.trackSerialNumbers && !b.irmItem.trackBatchNumbers)
    .map((b) => ({ irmItemId: b.irmItemId, code: b.irmItem.code, name: b.irmItem.name, uom: b.irmItem.baseUnit ?? null, quantityOnHand: b.quantityOnHand }));
}

// IRM catalogue search for the restock composer (active, non-serial/batch; capped; blank ⇒ empty).
export interface VanStockItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}
export async function searchItems(q: string): Promise<VanStockItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];
  const rows = await irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name");
  return rows
    .filter((r) => !r.trackSerialNumbers && !r.trackBatchNumbers)
    .map((r) => ({ irmItemId: r.id, code: r.code, name: r.name, sku: r.sku ?? null, uom: r.baseUnit ?? null }));
}

// Active warehouses for the composer's preference picker (engineers hold no warehouse.view).
export interface WarehouseLite {
  id: string;
  name: string;
  code: string | null;
}
export async function listWarehousesLite(): Promise<WarehouseLite[]> {
  const rows = await warehouseRepo.findMany({ status: "active" }, 0, 200);
  return rows.map((w) => ({ id: w.id, name: w.name, code: w.code ?? null }));
}

export async function uploadImage(image: string, kind: "attachment" | "damage"): Promise<{ url: string }> {
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary is not configured. Contact an administrator.");
  const folder = kind === "damage" ? "senthra/damage-photos" : "senthra/van-stock-requests";
  const url = await uploadToCloudinary(image, `vsr-${kind}-${Date.now()}`, creds, folder);
  return { url };
}
```

**NOTE for implementer:** verify `warehouseRepo.findMany` / `irmRepo.findMany` signatures before use — `warehouseRepo.findMany({ status: "active" }, 0, 1)` and `irmRepo.findMany({ search, status: "active" }, 0, 20, "name")` are the shapes used by `job-kit-request.service.ts:205,444`; also confirm `WarehouseWithRelations` exposes `.code` and `UserWithRole` exposes `.name`.

- [ ] **Step 4: Run tests.** `pnpm test -- van-stock-request`. Expected: PASS (validation + service tests).

- [ ] **Step 5: Verify.** `pnpm typecheck; pnpm lint`. Expected: clean.

- [ ] **Step 6: Checkpoint** — report; ask before committing (`feat(van-stock): service`).

### Task 6: Controller + routes + mount

**Files:**
- Create: `backend/src/modules/van-stock-request/van-stock-request.controller.ts`
- Create: `backend/src/modules/van-stock-request/van-stock-request.routes.ts`
- Modify: `backend/src/routes/index.ts`

**Interfaces:**
- Consumes: service (Task 5); `actorFrom`, `asyncHandler`, `param`, `queryInt`, `queryStr` from `../../utils/*`; middleware from `../../middleware/*`.
- Produces: HTTP surface `/van-stock-requests` exactly per spec §11.

- [ ] **Step 1: Controller** (`van-stock-request.controller.ts`):

```ts
import * as vsrService from "./van-stock-request.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { forbidden } from "../../utils/http-error.js";
import { param, queryInt, queryStr } from "../../utils/request.js";
import type {
  ApproveVanStockRequestInput,
  CloseShortInput,
  CreateVanStockRequestInput,
  DeclineVanStockRequestInput,
  FulfilVanStockRequestInput,
  ScanLookupInput,
  UploadImageInput,
  WalkInInput,
} from "./van-stock-request.validation.js";

export const create = asyncHandler(async (req, res) => {
  res.status(201).json({ request: await vsrService.create(req.body as CreateVanStockRequestInput, actorFrom(req)) });
});

export const listMine = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  const { status, type, search, sort, page, pageSize } = req.query;
  res.json(await vsrService.listMine(actor.id, { status: queryStr(status), type: queryStr(type), search: queryStr(search), sort: queryStr(sort), page: queryInt(page), pageSize: queryInt(pageSize) }));
});

export const openLines = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  res.json({ items: await vsrService.openLineItems(actor.id, queryStr(req.query.type) ?? "restock") });
});

export const myHoldings = asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  if (!actor.id) throw forbidden("Could not determine engineer identity.");
  res.json({ holdings: await vsrService.myHoldings(actor.id) });
});

export const itemSearch = asyncHandler(async (req, res) => {
  res.json({ items: await vsrService.searchItems(queryStr(req.query.q) ?? "") });
});

export const warehousesLite = asyncHandler(async (_req, res) => {
  res.json({ warehouses: await vsrService.listWarehousesLite() });
});

export const listAll = asyncHandler(async (req, res) => {
  const { status, type, priority, search, sort, page, pageSize } = req.query;
  res.json(await vsrService.listAll(actorFrom(req), { status: queryStr(status), type: queryStr(type), priority: queryStr(priority), search: queryStr(search), sort: queryStr(sort), page: queryInt(page), pageSize: queryInt(pageSize) }));
});

export const pendingCount = asyncHandler(async (_req, res) => {
  res.json({ count: await vsrService.countPending() });
});

export const getOne = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.getOne(param(req, "id"), actorFrom(req)) });
});

export const approve = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.approve(param(req, "id"), req.body as ApproveVanStockRequestInput, actorFrom(req)) });
});

export const decline = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.decline(param(req, "id"), req.body as DeclineVanStockRequestInput, actorFrom(req)) });
});

export const cancel = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.cancel(param(req, "id"), actorFrom(req)) });
});

export const cancelRemaining = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.cancelRemaining(param(req, "id"), actorFrom(req)) });
});

export const closeShort = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.closeShort(param(req, "id"), req.body as CloseShortInput, actorFrom(req)) });
});

export const fulfil = asyncHandler(async (req, res) => {
  res.json({ request: await vsrService.fulfil(param(req, "id"), req.body as FulfilVanStockRequestInput, actorFrom(req)) });
});

export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ result: await vsrService.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});

export const walkIn = asyncHandler(async (req, res) => {
  res.status(201).json({ request: await vsrService.walkIn(req.body as WalkInInput, actorFrom(req)) });
});

export const uploadAttachment = asyncHandler(async (req, res) => {
  res.json(await vsrService.uploadImage((req.body as UploadImageInput).image, "attachment"));
});

export const uploadDamagePhoto = asyncHandler(async (req, res) => {
  res.json(await vsrService.uploadImage((req.body as UploadImageInput).image, "damage"));
});
```

- [ ] **Step 2: Routes** (`van-stock-request.routes.ts`):

```ts
import { Router } from "express";

import * as ctrl from "./van-stock-request.controller.js";
import { requireAuth, requirePermission, requireAnyPermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import {
  approveVanStockRequestSchema,
  closeShortSchema,
  createVanStockRequestSchema,
  declineVanStockRequestSchema,
  fulfilVanStockRequestSchema,
  scanLookupSchema,
  uploadImageSchema,
  walkInSchema,
} from "./van-stock-request.validation.js";

// Non-job engineer ↔ warehouse van stock. Engineers (engineer.van_stock.request) raise restocks /
// returns and cancel their own; warehouse reviewers (van_stock_request.review) approve/decline,
// scan-fulfil, close short, and create walk-ins.
const router = Router();

router.use(requireAuth);

const ENGINEER = "engineer.van_stock.request";
const REVIEW = "van_stock_request.review";

// ---- Engineer self-service (static paths BEFORE /:id) ------------------------------------------
router.get("/mine", requirePermission(ENGINEER), ctrl.listMine);
router.get("/mine/open-lines", requirePermission(ENGINEER), ctrl.openLines);
router.get("/my-holdings", requirePermission(ENGINEER), ctrl.myHoldings);
router.get("/item-search", requirePermission(ENGINEER), ctrl.itemSearch);
router.get("/warehouses-lite", requirePermission(ENGINEER), ctrl.warehousesLite);
router.post("/", requirePermission(ENGINEER), writeLimiter, validateBody(createVanStockRequestSchema), ctrl.create);
router.post("/attachments", requirePermission(ENGINEER), writeLimiter, validateBody(uploadImageSchema), ctrl.uploadAttachment);

// ---- Reviewer queue -----------------------------------------------------------------------------
router.get("/pending-count", requirePermission(REVIEW), ctrl.pendingCount);
router.get("/", requirePermission(REVIEW), ctrl.listAll);
router.post("/scan-lookup", requirePermission(REVIEW), writeLimiter, validateBody(scanLookupSchema), ctrl.scanLookup);
router.post("/walk-in", requirePermission(REVIEW), writeLimiter, validateBody(walkInSchema), ctrl.walkIn);
router.post("/damage-photo", requirePermission(REVIEW), writeLimiter, validateBody(uploadImageSchema), ctrl.uploadDamagePhoto);

// ---- Single request (requester OR reviewer — service scopes) ------------------------------------
router.get("/:id", requireAnyPermission(ENGINEER, REVIEW), ctrl.getOne);

// ---- Transitions ---------------------------------------------------------------------------------
router.post("/:id/approve", requirePermission(REVIEW), writeLimiter, validateBody(approveVanStockRequestSchema), ctrl.approve);
router.post("/:id/decline", requirePermission(REVIEW), writeLimiter, validateBody(declineVanStockRequestSchema), ctrl.decline);
router.post("/:id/fulfil", requirePermission(REVIEW), writeLimiter, validateBody(fulfilVanStockRequestSchema), ctrl.fulfil);
router.post("/:id/close-short", requirePermission(REVIEW), writeLimiter, validateBody(closeShortSchema), ctrl.closeShort);
router.post("/:id/cancel", requirePermission(ENGINEER), writeLimiter, ctrl.cancel);
router.post("/:id/cancel-remaining", requirePermission(ENGINEER), writeLimiter, ctrl.cancelRemaining);

export default router;
```

- [ ] **Step 3: Mount.** In `backend/src/routes/index.ts`: add `import vanStockRequestRoutes from "#modules/van-stock-request/van-stock-request.routes.js";` (alphabetical with the others) and, after the job-kit-requests mount:

```ts
// Non-job engineer van restock/return requests (raise / review / scan-fulfil).
router.use("/van-stock-requests", vanStockRequestRoutes);
```

- [ ] **Step 4: Verify.** `pnpm typecheck; pnpm lint; pnpm test`. Expected: all clean/green.

- [ ] **Step 5: Checkpoint** — report; ask before committing (`feat(van-stock): controller + routes`).

---

## PHASE 3 — Worklist + dashboard

### Task 7: Worklist kind + dashboard wiring + frontend OVERVIEW_PERMS

**Files:**
- Modify: `backend/src/modules/dashboard/worklist.ts` (kind union)
- Modify: `backend/src/modules/dashboard/dashboard.service.ts` (queue)
- Modify: `backend/src/modules/inventory/movement.ts` (`TYPE_LABELS`)
- Modify: `frontend/src/lib/auth.ts` (`OVERVIEW_PERMS`)
- Modify: `frontend/src/components/dashboard/home/WorklistPanel.tsx` (`KIND_LABELS` / `KIND_TONE`)
- Modify: `frontend/src/components/dashboard/inventory/MovementFeed.tsx` (`TYPE_OPTIONS`)

- [ ] **Step 1: Add the kind.** In `worklist.ts`, extend the union:

```ts
export type WorklistKind =
  | "review_prf"
  | "approve_po_fastpath"
  | "review_po"
  | "send_po"
  | "acknowledge_po"
  | "receive_goods"
  | "review_kit_request"
  | "review_van_stock_request";
```

- [ ] **Step 2: Wire the queue** in `dashboard.service.ts`, mirroring the kit-request queue exactly:
  - Import: `import * as vsrRepo from "#modules/van-stock-request/van-stock-request.repository.js";`
  - Permission flag next to `qKit`: `const qVsr = can("van_stock_request.review");`
  - Add `|| qVsr` to the `section("worklist", …)` enable expression.
  - Add to the `Promise.all` array: `qVsr ? vsrRepo.pendingWorklist() : Promise.resolve([]),` (destructure as `wlVsr`).
  - Push rows (VSR priority feeds the existing high/urgent band; link target = the review queue):

```ts
        // Van stock request: code = VSR-####; title = who's asking; priority feeds the urgency band.
        for (const r of wlVsr)
          push({ kind: "review_van_stock_request", id: r.id, code: r.code, title: `${r.engineerName} — ${r.type === "return" ? "van return" : "van restock"}`, priority: r.priority === "normal" ? null : r.priority, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: "/dashboard/van-requests" });
```

  - Add `wlVsr` to the `truncated` cap-check array.

- [ ] **Step 3: Frontend gating.** In `frontend/src/lib/auth.ts`, append `"van_stock_request.review",` to `OVERVIEW_PERMS` (after `"jobs.kit_request.review"`).

- [ ] **Step 4: Worklist chip maps.** `frontend/src/components/dashboard/home/WorklistPanel.tsx` keys chips off hard maps (`KIND_LABELS` / `KIND_TONE`, lines 11-29) — without entries the new kind renders as raw `review_van_stock_request`. Add to both:

```ts
  review_van_stock_request: "Review van stock",        // in KIND_LABELS
  review_van_stock_request: "bg-orange-500/12 text-orange-600", // in KIND_TONE
```

- [ ] **Step 5: Movement-history labels.** The unified ledger feed humanises `type` via `TYPE_LABELS` in `backend/src/modules/inventory/movement.ts:49-64` (unknown types fall back to title-case, so rows won't break, but be explicit) and the frontend filter dropdown `TYPE_OPTIONS` in `frontend/src/components/dashboard/inventory/MovementFeed.tsx:26-40` (without entries the new types can't be FILTERED at all). Add to both:

```ts
  van_restock: "Van Restock",   // movement.ts TYPE_LABELS
  van_return: "Van Return",
```

```ts
  { value: "van_restock", label: "Van Restock" },   // MovementFeed.tsx TYPE_OPTIONS
  { value: "van_return", label: "Van Return" },
```

- [ ] **Step 6: Verify.** Backend `pnpm typecheck; pnpm lint`; frontend `pnpm lint`.

- [ ] **Step 7: Checkpoint** — report; ask before committing (`feat(van-stock): worklist + movement-history integration`).

---

## PHASE 4 — Frontend

### Task 8: Types + API service

**Files:**
- Create: `frontend/src/services/vanStockRequest.service.ts`

**Interfaces — Produces (Tasks 9-10 rely on):** all types + functions below, mirroring `jobKitRequest.service.ts` conventions.

- [ ] **Step 1: Write the service** (complete file):

```ts
import { api } from "@/lib/api";

// Typed wrapper around the non-job Van Stock Request API. Engineers raise restocks/returns and
// cancel their own; warehouse reviewers approve/decline, scan-fulfil, close short, create walk-ins.

export type VanStockRequestType = "restock" | "return";
export type VanStockRequestStatus = "pending" | "approved" | "partially_fulfilled" | "fulfilled" | "declined" | "cancelled";
export type VanStockPriority = "normal" | "high" | "urgent";

export interface VanStockLine {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  uom: string | null;
  requestedQty: number;
  approvedQty: number | null;
  fulfilledQty: number;
  remainingQty: number;
}

export interface VanStockFulfilmentLine {
  id: string;
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: "good" | "damaged";
  damagePhotoUrl: string | null;
  damageReason: string | null;
  scannedCode: string | null;
}

export interface VanStockFulfilment {
  id: string;
  sequence: number;
  performedBy: string;
  postedAt: string;
  lines: VanStockFulfilmentLine[];
}

export interface VanStockRequest {
  id: string;
  code: string;
  type: VanStockRequestType;
  status: VanStockRequestStatus;
  priority: VanStockPriority;
  createdVia: "engineer_request" | "walk_in";
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  lastFulfilledAt: string | null;
  completionType: "complete" | "closed_short" | "cancelled_remaining" | null;
  closedShortBy: string | null;
  closedShortAt: string | null;
  closeShortNote: string | null;
  cancelledAt: string | null;
  stale: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: VanStockLine[];
  fulfilments: VanStockFulfilment[];
}

export interface PagedVanStockRequests {
  requests: VanStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VanStockLinePayload {
  irmItemId: string;
  itemName: string;
  qty: number;
}

export interface CreateVanStockRequestPayload {
  type: VanStockRequestType;
  reason: string;
  notes?: string;
  priority?: VanStockPriority;
  attachments?: string[];
  preferredWarehouseId?: string; // restock
  warehouseId?: string; // return
  lines: VanStockLinePayload[];
}

export interface FulfilEntryPayload {
  lineId: string;
  qty: number;
  condition: "good" | "damaged";
  damagePhotoUrl?: string;
  damageReason?: string;
  scannedCode?: string;
}

export interface ScanLookupResult {
  irmItemId: string;
  lineId: string;
  itemName: string;
  uom: string | null;
  remainingQty: number;
  available: number | null;
}

export interface VanStockItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}

export interface HoldingOption {
  irmItemId: string;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
}

export interface WarehouseLite {
  id: string;
  name: string;
  code: string | null;
}

export interface ListParams {
  status?: string;
  type?: string;
  priority?: string;
  search?: string;
  sort?: "oldest" | "newest";
  page?: number;
  pageSize?: number;
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ── Engineer self-service ─────────────────────────────────────────────────────
export function createVanStockRequest(payload: CreateVanStockRequestPayload): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests", { method: "POST", body: payload }).then((r) => r.request);
}
export function listMyVanStockRequests(params: ListParams = {}): Promise<PagedVanStockRequests> {
  return api<PagedVanStockRequests>(`/van-stock-requests/mine${qs(params as Record<string, unknown>)}`);
}
export function myOpenLineItems(type: VanStockRequestType): Promise<Array<{ irmItemId: string; code: string }>> {
  return api<{ items: Array<{ irmItemId: string; code: string }> }>(`/van-stock-requests/mine/open-lines${qs({ type })}`).then((r) => r.items);
}
export function myHoldings(): Promise<HoldingOption[]> {
  return api<{ holdings: HoldingOption[] }>("/van-stock-requests/my-holdings").then((r) => r.holdings);
}
export function searchVanStockItems(q: string): Promise<VanStockItemOption[]> {
  return api<{ items: VanStockItemOption[] }>(`/van-stock-requests/item-search?q=${encodeURIComponent(q)}`).then((r) => r.items);
}
export function listWarehousesLite(): Promise<WarehouseLite[]> {
  return api<{ warehouses: WarehouseLite[] }>("/van-stock-requests/warehouses-lite").then((r) => r.warehouses);
}
export function uploadVanStockAttachment(image: string): Promise<string> {
  return api<{ url: string }>("/van-stock-requests/attachments", { method: "POST", body: { image } }).then((r) => r.url);
}
export function cancelVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel`, { method: "POST" }).then((r) => r.request);
}
export function cancelVanStockRemaining(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel-remaining`, { method: "POST" }).then((r) => r.request);
}

// ── Reviewer ──────────────────────────────────────────────────────────────────
export function listVanStockRequests(params: ListParams = {}): Promise<PagedVanStockRequests> {
  return api<PagedVanStockRequests>(`/van-stock-requests${qs(params as Record<string, unknown>)}`);
}
export function getVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}`).then((r) => r.request);
}
export function pendingVanStockCount(): Promise<number> {
  return api<{ count: number }>("/van-stock-requests/pending-count").then((r) => r.count);
}
export function approveVanStockRequest(id: string, payload: { warehouseId: string; lineApprovals?: Array<{ lineId: string; approvedQty: number }>; decisionNote?: string }): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/approve`, { method: "POST", body: payload }).then((r) => r.request);
}
export function declineVanStockRequest(id: string, decisionNote: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/decline`, { method: "POST", body: { decisionNote } }).then((r) => r.request);
}
export function vanStockScanLookup(requestId: string, code: string): Promise<ScanLookupResult> {
  return api<{ result: ScanLookupResult }>("/van-stock-requests/scan-lookup", { method: "POST", body: { requestId, code } }).then((r) => r.result);
}
export function fulfilVanStockRequest(id: string, entries: FulfilEntryPayload[]): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/fulfil`, { method: "POST", body: { entries } }).then((r) => r.request);
}
export function closeVanStockShort(id: string, note: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/close-short`, { method: "POST", body: { note } }).then((r) => r.request);
}
export function createVanStockWalkIn(payload: { engineerId: string; warehouseId: string; reason: string; priority?: VanStockPriority; notes?: string; lines: VanStockLinePayload[] }): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests/walk-in", { method: "POST", body: payload }).then((r) => r.request);
}
export function uploadVanStockDamagePhoto(image: string): Promise<string> {
  return api<{ url: string }>("/van-stock-requests/damage-photo", { method: "POST", body: { image } }).then((r) => r.url);
}
```

- [ ] **Step 2: Verify.** `cd frontend; pnpm lint`. Expected: clean.

- [ ] **Step 3: Checkpoint** — report; ask before committing (`feat(van-stock): frontend service`).

### Task 9: Engineer page + nav

**Files:**
- Create: `frontend/src/components/dashboard/engineer/EngineerVanStock.tsx`
- Create: `frontend/src/app/dashboard/engineer/van-stock/page.tsx`
- Modify: `frontend/src/components/dashboard/shell/Sidebar.tsx` (`ENGINEER_NAV`)

**Interfaces:**
- Consumes: everything from `vanStockRequest.service.ts` (Task 8); `Modal`, `Notice`, `inputCls/labelCls/primaryBtn` from `@/components/ui/*`; `subscribe` from `@/lib/socket`.
- Produces: route `/dashboard/engineer/van-stock`.

**Reference pattern:** `EngineerKitRequests.tsx` — copy its list-card + status-chip + controlled-modal idioms; check `EngineerTransfers.tsx` for a full-page (non-job-scoped) layout, and the `KitItemSearch` debounced search-select inside `EngineerKitRequests.tsx` for the item picker. Match exact class strings from those files.

- [ ] **Step 1: Page route** (`frontend/src/app/dashboard/engineer/van-stock/page.tsx`) — mirror `engineer/transfers/page.tsx` exactly (same guard/wrapper components, e.g. `EngineerGuard`), rendering `<EngineerVanStock />`.

- [ ] **Step 2: Build `EngineerVanStock.tsx`.** One client component with:
  - **Status chips** — extend the `KIT_STATUS` pattern with the two extra statuses:

```tsx
const VSR_STATUS: Record<VanStockRequest["status"], { cls: string; label: string }> = {
  pending: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", label: "Pending" },
  approved: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", label: "Approved" },
  partially_fulfilled: { cls: "border-sky-500/30 bg-sky-500/10 text-sky-600", label: "Partially fulfilled" },
  fulfilled: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", label: "Fulfilled" },
  declined: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", label: "Declined" },
  cancelled: { cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]", label: "Cancelled" },
};
```

  - **Mine-list**: load via `listMyVanStockRequests({ pageSize: 50 })`; live-refresh with `React.useEffect(() => subscribe(["van_stock_request:updated"], load), [load])`. Each row: code (mono), type badge (Restock/Return), status chip, `stale && <span …>Stale</span>` chip (amber), created date, line summary (`lines.map(l => \`${l.itemName} ×${l.requestedQty}\`).join(", ")`), per-line progress on open requests (`fulfilledQty`/`approvedQty ?? requestedQty`), decline note when declined, close-short note when closed short. Actions: **Cancel** on `pending` (→ `cancelVanStockRequest`), **Cancel remaining** on `partially_fulfilled` (→ `cancelVanStockRemaining`, with a `confirm()` guard).
  - **Restock composer** (modal): debounced item search via `searchVanStockItems` (copy the `KitItemSearch` component shape from `EngineerKitRequests.tsx`); qty cart with dedupe; reason (required textarea); priority select (`normal | high | urgent`); optional preferred-warehouse select loaded from `listWarehousesLite()`; optional attachments via `uploadVanStockAttachment` (file → data-URI → URL, same as the kit-request modal). **Duplicate warning (spec §8):** on opening the modal fetch `myOpenLineItems("restock")` into a `Map<irmItemId, code>`; when the cart contains a matching item, render a non-blocking amber `Notice`: `You already have an open request for {name} ({code}). You can still send this one.` Submit → `createVanStockRequest({ type: "restock", … })`.
  - **Return composer** (modal): lines picked from `myHoldings()` (name + held qty; qty input capped at `quantityOnHand`); warehouse select (required) from `listWarehousesLite()`; reason; same duplicate warning with `myOpenLineItems("return")`. Submit → `createVanStockRequest({ type: "return", warehouseId, … })`.
  - Header card copy: title "Van stock", subtitle "Request a top-up from a warehouse, or return excess van stock — no job needed." Two trigger buttons: "Request stock" (`primaryBtn`, `PackagePlus` icon) and "Return stock" (secondary style, `Undo2` icon).

- [ ] **Step 3: Nav.** In `Sidebar.tsx` `ENGINEER_NAV`, after the Transfers item:

```ts
  { href: "/dashboard/engineer/van-stock", label: "Van Stock", icon: Truck, perms: ["engineer.van_stock.request"] },
```

Add `Truck` to the existing `lucide-react` import.

- [ ] **Step 4: Verify.** `cd frontend; pnpm lint; pnpm build` (build catches type errors). Expected: clean.

- [ ] **Step 5: Checkpoint** — report; ask before committing (`feat(van-stock): engineer portal page`).

### Task 10: Warehouse queue + review + fulfil + nav

**Files:**
- Create: `frontend/src/components/dashboard/van-requests/VanRequestsBoard.tsx`
- Create: `frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx`
- Create: `frontend/src/app/dashboard/van-requests/page.tsx`
- Modify: `frontend/src/components/dashboard/shell/Sidebar.tsx` (admin `NAV`)

**Interfaces:**
- Consumes: Task 8 service; `ScannerInput` from `@/components/dashboard/goods-management/ScannerInput` (`{ onCode: (code: string) => void; disabled?; placeholder? }`); `Modal`, `Notice`, ui styles; `subscribe`; `useAuth` for `can()`.
- Produces: route `/dashboard/van-requests`.

**Reference pattern:** `JobScanPanel.tsx` (scan flow, damaged toggle + photo capture via the damage-photo endpoint), the PRF/PO board pages for the queue table + filter idioms, `JobKitRequestsReview.tsx` for approve/decline modals.

- [ ] **Step 1: Page route** (`frontend/src/app/dashboard/van-requests/page.tsx`) — mirror an existing admin page (e.g. the purchase-requests page): shell wrapper + `PermissionGate` on `van_stock_request.review`, rendering `<VanRequestsBoard />`.

- [ ] **Step 2: `VanRequestsBoard.tsx`** — queue with filters + a slide-in/modal detail:
  - Filters: status (default open: `pending`/`approved`/`partially_fulfilled` — implement as a status select with an "Open" pseudo-option that omits terminal states client-side or issues three queries; simplest: select with All/Pending/Approved/Partially fulfilled/Fulfilled/Declined/Cancelled), type (all/restock/return), priority, search box. Data via `listVanStockRequests(params)`; re-fetch on filter change; live refresh via `subscribe(["van_stock_request:updated"], load)`.
  - Row: code, type badge, engineer name, warehouse (or `— (pending)` + preferred hint `Prefers: {name}` when only `preferredWarehouseId` is set — resolve name from `listWarehousesLite()`), priority chip (hide `normal`), status chip (reuse the `VSR_STATUS` map — export it from `EngineerVanStock.tsx` or duplicate the 6-entry map), stale chip, age, line count. Click → opens `VanRequestDetail` for that id.
  - Header actions: **Walk-in issue** button → modal with engineer select (reuse whatever engineer-picker exists for transfers admin board — check `components/dashboard/transfers/` for the pattern; else a simple search-select over `engineer.service` users), warehouse select, reason, item cart (same `searchVanStockItems` picker) → `createVanStockWalkIn`.

- [ ] **Step 3: `VanRequestDetail.tsx`** — one component, three zones by status:
  - **Info zone** (always): code, chips, engineer, reason/notes/attachments (thumbnails), fulfilment history table (`fulfilments` → sequence, postedAt, performedBy, lines with condition + damage photo link).
  - **Review zone** (`status === "pending" && type === "restock"`): warehouse select (default = `preferredWarehouseId`), per-line approvedQty inputs (default `requestedQty`, max `requestedQty`, min 1), decision note, **duplicate context** — fetch `listVanStockRequests({ status: "pending", pageSize: 100 })`, filter client-side to rows with the same `engineerId` (excluding this request), and render "Other open requests from {engineerName}: VSR-0007, VSR-0009" when non-empty. Buttons: Approve → `approveVanStockRequest`; Decline (note required) → `declineVanStockRequest`. Pending **returns** show only Decline + the fulfil zone (scan-in is acceptance).
  - **Fulfil zone** (`restock: approved|partially_fulfilled`; `return: pending|partially_fulfilled`): `ScannerInput` → `vanStockScanLookup(requestId, code)` → append/merge an entry row `{ itemName, remainingQty, available, qty (input, capped at remainingQty), condition toggle (returns only), damage photo + reason when damaged (photo file → data URI → uploadVanStockDamagePhoto → URL) }`; manual add row per open line (button "Add without scan" listing open lines). Post button → `fulfilVanStockRequest(id, entries)`; on success reload + toast. **Close short** button (on `partially_fulfilled`, note-required modal) → `closeVanStockShort`.

- [ ] **Step 4: Admin nav.** In `Sidebar.tsx` admin `NAV`, add next to the Goods Management / warehouse entries:

```ts
  { href: "/dashboard/van-requests", label: "Van Requests", icon: Truck, perms: ["van_stock_request.review"] },
```

- [ ] **Step 5: Verify.** `cd frontend; pnpm lint; pnpm build`. Expected: clean.

- [ ] **Step 6: Checkpoint** — report; ask before committing (`feat(van-stock): warehouse van-requests page`).

---

## PHASE 5 — End-to-end verification

### Task 11: Full-flow manual verification

**Files:** none (verification only).

- [ ] **Step 1: Static gates.** `cd backend; pnpm typecheck; pnpm lint; pnpm test` → all green. `cd frontend; pnpm lint; pnpm build` → clean.

- [ ] **Step 2: Boot both apps** (`pnpm dev` in each; frontend `.env` → `NEXT_PUBLIC_API_URL=http://localhost:8000`). Confirm seed ran (startup logs show the permission backfill lines on first boot).

- [ ] **Step 3: Restock happy path.** As a field engineer: Van Stock page visible in nav → raise a restock (2 items, priority high, preferred warehouse) → request appears pending. As warehouse manager: Overview worklist shows the VSR (high band); Van Requests queue shows it with the preferred hint → approve with a per-line trim (100 → 60) → fulfil: scan item 1, post its 60 (line 1 done, line 2 untouched → status `partially_fulfilled`) → second posting for line 2 → `fulfilled`, `completionType: complete`. Verify: warehouse `InventoryBalance` fell; engineer's Stock page rose; Stock Movement History shows rows with `VSR-####`; engineer got the realtime update.

- [ ] **Step 4: Guards.** Try approving the same pending request from two tabs → second gets "just handled by someone else". Try fulfilling more than remaining → server rejects. Try a restock for more than the shelf holds → posting fails with the zero-floor conflict and the request stays approved (retryable).

- [ ] **Step 5: Return path.** As engineer: return composer only offers held items, qty capped → raise return (pick warehouse). As warehouse: return appears in queue as pending → scan-in with a good/damaged split (damaged requires photo + reason) → good qty back in warehouse balance, damaged qty in the damaged pool with the photo, engineer's van balance drained, status `fulfilled`.

- [ ] **Step 6: Edge flows.** Cancel a pending request as its engineer (works; another engineer's request 403s). Close-short a partially fulfilled restock (note required; `completionType: closed_short`; engineer sees the note). Cancel-remaining as the engineer. Walk-in create → lands approved with `createdVia: walk_in` → fulfil normally. Duplicate warning fires in the composer for an item already on an open request. Decline a return with a note.

- [ ] **Step 7: Report** all outcomes to the user with any deviations; ask about final commit/PR.
