# Goods Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scan-driven, job-scoped Goods Management flow that issues kit stock (IRM + customer) from a warehouse to an engineer, tracks Start/Complete work with declared usage, and receives returns (good/damaged) with reconciliation and a damaged-stock pool.

**Architecture:** A new self-contained backend module `goods-management` (controller → service → repository → validation → routes), reusing the existing inventory + engineer-stock ledger primitives for IRM and adding symmetric models for customer-held stock + a damaged pool. Frontend adds a warehouse "Goods Management" tab (scanner panel), engineer Start/Complete, a Damaged inventory toggle, and a customer-record damaged section.

**Tech Stack:** Express 5 + Prisma (MongoDB), TypeScript ESM/NodeNext, pnpm, vitest (backend). Next.js 16 + React 19 + Tailwind v4, axios via `@/lib/api`, socket.io-client, `@zxing/browser` (NEW dep) for camera + image-file barcode decode.

## Global Constraints

- **Layering:** `route → requireAuth → requirePermission → writeLimiter → validateBody → controller → service → repository → Prisma`. Prisma ONLY in `*.repository.ts`. Controllers hold no business logic. Services return data or `throw` an `HttpError` (`badRequest`/`conflict`/`notFound`/`forbidden` from `../../utils/http-error.js`).
- **ESM/NodeNext:** relative imports end in `.js`; cross-module imports use `#modules/<domain>/<file>.js`; same-module relative `./x.js`; shared dirs `../../lib/x.js`.
- **No Prisma enums:** string columns with `// a | b | c` value comments + `as const` arrays + `z.enum(...)`.
- **Mongo id line (every model):** `id String @id @default(auto()) @map("_id") @db.ObjectId`. FK is `xId String @db.ObjectId` immediately followed by `x Model @relation(fields: [xId], references: [id])`. Named relation label when 2+ relations target the same model.
- **Snapshots:** copy `<rel>Name`/`<rel>Code`/`<rel>Email` onto records (`// snapshot`) for history-safety.
- **Soft-delete:** `deletedAt DateTime?`; write `deletedAt: null` EXPLICITLY on create; reads filter `deletedAt: null`.
- **Codes:** `GM-####` via the atomic `Counter` (prefix `GM`), mirroring `goods-out.repository.createWithCode` (5-attempt loop + `fastForwardCounter`).
- **Atomic writes:** all balance + ledger + header writes happen inside one `withTransaction(async (tx) => {...})` (`../../lib/prisma.js`). Re-read state inside the tx; re-check availability; the `upsertBalanceTx` non-negative guard is the backstop for warehouse decrements. Engineer/customer/damaged balances have NO built-in non-negative guard — add explicit pre-checks before draining.
- **Warehouse scoping:** import `assertWarehouseAccess`, `warehouseScopeFilter` from `../../lib/warehouse-access.js`; filter lists with `warehouseScopeFilter(actor)`; guard single resources with `assertWarehouseAccess(actor, resolvedWarehouseId)` (resolved id, never a raw token); centralize in a `loadOrThrow(id, actor)`.
- **Customer-pricing safety:** customer-stock and damaged-customer responses expose NO cost/value — only item/qty/serial/location/flag.
- **Out of scope (v1):** serial/batch items in issue/return (block with a clear message); pack-unit conversion; damaged recover/dispose (write-off only); reservation at accept; engineer confirm-received; return at a different warehouse than pickup.
- **Spec:** `docs/superpowers/specs/2026-06-25-goods-management-design.md`.

---

## File Structure

**Backend — new module `backend/src/modules/goods-management/`:**
- `goods-management.validation.ts` — zod schemas + `as const` enums + inferred types.
- `goods-management.repository.ts` — all Prisma for the new models + tx-aware writers; reuses inventory + goods-out engineer-balance writers via their repos.
- `goods-management.service.ts` — queue, scan-lookup, issue, return, close/reconcile, overdue/write-off; the transactional movement logic.
- `goods-management.controller.ts` — thin handlers.
- `goods-management.routes.ts` — routes + middleware chain.
- `goods-management.service.test.ts` — vitest unit tests.
- `goods-management.validation.test.ts` — vitest schema tests.

**Backend — modified:**
- `backend/prisma/schema.prisma` — 7 new models + back-relations on `Job`, `Warehouse`, `IrmItem`, `User`, `Customer`, `CustomerStockEntry`.
- `backend/src/routes/index.ts` — register the module.
- `backend/src/modules/role/permissions.ts` — `goods_management` group + `"Goods Management"` category + `engineer.jobs.start/complete`.
- `backend/src/db/seed.ts` — seed/backfill new permission keys.
- `backend/src/modules/job/job.service.ts` — `startJobForEngineer`, `completeJobForEngineer` (status transitions + consume movement) + realtime emits.
- `backend/src/modules/job/job.repository.ts` — tx-aware status stamp helpers.
- `backend/src/modules/engineer/engineer.routes.ts` / `.controller.ts` / `.service.ts` — `/jobs/:id/start`, `/jobs/:id/complete`, `/customer-stock` (engineer's held customer stock).

**Frontend — new:**
- `frontend/src/types/goodsManagement.ts` — types.
- `frontend/src/services/goodsManagement.service.ts` — typed API wrappers.
- `frontend/src/hooks/useBarcodeScanner.ts` — camera + image-file decode via `@zxing/browser`.
- `frontend/src/components/dashboard/goods-management/GoodsManagementTab.tsx` — warehouse-tab queue.
- `frontend/src/components/dashboard/goods-management/JobScanPanel.tsx` — Goods In/Out toggle, scan list, post.
- `frontend/src/components/dashboard/goods-management/ScannerInput.tsx` — hardware/manual/camera/upload input.
- `frontend/src/components/dashboard/goods-management/DamagedStockView.tsx` — damaged pool list (warehouse + customer record).
- `frontend/src/components/dashboard/goods-management/OverdueHoldingsView.tsx` — out > N days + write-off.

**Frontend — modified:**
- `frontend/src/components/dashboard/warehouses/WarehouseDetail.tsx` — add "Goods Management" tab + "Damaged" pool pill.
- `frontend/src/components/dashboard/engineer/EngineerJobDetail.tsx` — Start/Complete + used-qty form.
- `frontend/src/components/dashboard/engineer/EngineerInventory.tsx` — show customer holdings.
- `frontend/src/components/dashboard/customers/CustomerDetail.tsx` — Damaged stock section.
- `frontend/package.json` — add `@zxing/browser`.

---

## PHASE 1 — Data model, permissions, seed

### Task 1: Add the 7 Prisma models + back-relations

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces — Produces (model names + key fields later tasks rely on):**
- `JobStockMovement { id, code, jobId, direction, engineerId, warehouseId, status, postedAt, ... }`
- `JobStockMovementLine { id, movementId, source, irmItemId?, customerStockEntryId?, qty, condition, jobKitLineId?, damagePhotoUrl?, damageReason?, scannedCode?, ...snapshots }`
- `EngineerCustomerStockHolding { id, customerStockEntryId, engineerId, quantityOnHand }` (`@@unique([customerStockEntryId, engineerId])`)
- `EngineerCustomerStockTransaction { id, customerStockEntryId, engineerId, quantityDelta, type, sourceType, sourceId, sourceCode?, balanceAfter, ... }`
- `DamagedStockBalance { id, warehouseId, ownerType, irmItemId?, customerStockEntryId?, customerId?, quantity, ...snapshots }`
- `DamagedStockTransaction { id, warehouseId, ownerType, irmItemId?, customerStockEntryId?, customerId?, quantityDelta, reason, notes?, sourceType, sourceId, sourceCode?, balanceAfter, createdBy?, photoUrl? }`
- `JobStockSummary { id, jobId @unique, goodsStatus, workSummary?, lastMovementAt? }`

- [ ] **Step 1: Add the models to `schema.prisma`** (append after the `EngineerStockTransaction` model block, ~line 990). Paste verbatim:

```prisma
// ── Goods Management (job-scoped issue → work → return → reconcile) ─────────────────────────────
// A scan session that moves stock between a warehouse and the assigned engineer for a Job.
// direction: issue (WM scan-out) | return (WM scan-in) | consume (engineer declaration at Complete).
// Draft (editable) → posted (terminal; balances + ledgers written ONCE). Code GM-####.
model JobStockMovement {
  id   String @id @default(auto()) @map("_id") @db.ObjectId
  code String @unique // auto-allocated, e.g. GM-0001

  jobId String @db.ObjectId
  job   Job    @relation(fields: [jobId], references: [id])

  direction String // issue | return | consume

  engineerId    String @db.ObjectId
  engineer      User   @relation("JobStockMovementEngineer", fields: [engineerId], references: [id])
  engineerName  String // snapshot
  engineerEmail String? // snapshot

  warehouseId   String?    @db.ObjectId // null for consume (engineer-declared, no warehouse)
  warehouse     Warehouse? @relation(fields: [warehouseId], references: [id])
  warehouseName String? // snapshot
  warehouseCode String? // snapshot

  status      String @default("draft") // draft | posted
  notes       String?
  performedBy String? // actor email snapshot
  postedAt    DateTime?

  items JobStockMovementLine[]

  createdBy String?
  deletedAt DateTime? // soft delete — draft-only; history stays intact
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([jobId])
  @@index([direction])
  @@index([status])
  @@index([warehouseId])
  @@index([engineerId])
}

model JobStockMovementLine {
  id         String           @id @default(auto()) @map("_id") @db.ObjectId
  movementId String           @db.ObjectId
  movement   JobStockMovement @relation(fields: [movementId], references: [id])

  source    String // irm | customer
  irmItemId String?  @db.ObjectId
  irmItem   IrmItem? @relation(fields: [irmItemId], references: [id])
  customerStockEntryId String? @db.ObjectId // loose socket (no relation), mirroring JobKitLine

  itemName String // snapshot
  sku      String? // snapshot
  uom      String? // snapshot

  qty       Int
  condition String  @default("good") // good | damaged (only meaningful on returns)
  jobKitLineId String? @db.ObjectId // loose socket: links an issue line to its planned kit line
  scannedCode  String? // the decoded barcode (issue/return only)
  damagePhotoUrl String? // Cloudinary URL (required when condition = damaged)
  damageReason   String? // required when condition = damaged
  notes     String?

  createdAt DateTime @default(now())

  @@index([movementId])
  @@index([irmItemId])
}

// Engineer-held CUSTOMER consignment stock — the customer-side twin of EngineerStockBalance.
model EngineerCustomerStockHolding {
  id                   String @id @default(auto()) @map("_id") @db.ObjectId
  customerStockEntryId String @db.ObjectId
  engineerId           String @db.ObjectId
  engineer             User   @relation("EngineerCustomerStockOwner", fields: [engineerId], references: [id])

  customerId   String? @db.ObjectId // snapshot for filtering by customer
  itemName     String  // snapshot
  quantityOnHand Int   @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([customerStockEntryId, engineerId])
  @@index([engineerId])
  @@index([customerId])
}

// Immutable, append-only engineer customer-stock ledger.
model EngineerCustomerStockTransaction {
  id                   String @id @default(auto()) @map("_id") @db.ObjectId
  customerStockEntryId String @db.ObjectId
  engineerId           String @db.ObjectId

  quantityDelta Int // + issue | − return/consume/lost
  type          String // job_issue | job_return | job_consume | job_lost
  sourceType    String // goods_management
  sourceId      String   @db.ObjectId
  sourceCode    String? // snapshot, e.g. GM-0001
  balanceAfter  Int
  notes         String?
  createdBy     String?
  createdAt     DateTime @default(now())

  @@index([customerStockEntryId, engineerId])
  @@index([sourceType, sourceId])
  @@index([createdAt])
}

// Damaged-stock pool (write-off). Both owner types; never re-enters usable stock in v1.
model DamagedStockBalance {
  id          String    @id @default(auto()) @map("_id") @db.ObjectId
  warehouseId String    @db.ObjectId
  warehouse   Warehouse @relation(fields: [warehouseId], references: [id])

  ownerType String // company | customer
  irmItemId String?  @db.ObjectId
  irmItem   IrmItem? @relation(fields: [irmItemId], references: [id])
  customerStockEntryId String? @db.ObjectId // loose socket
  customerId           String? @db.ObjectId // loose socket (customer-owned damage)

  itemName String // snapshot
  quantity Int    @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([warehouseId])
  @@index([ownerType])
  @@index([customerId])
}

// Immutable, append-only damaged-stock ledger.
model DamagedStockTransaction {
  id          String @id @default(auto()) @map("_id") @db.ObjectId
  warehouseId String @db.ObjectId

  ownerType String // company | customer
  irmItemId String? @db.ObjectId
  customerStockEntryId String? @db.ObjectId
  customerId           String? @db.ObjectId

  quantityDelta Int // + report damaged (write-off only in v1)
  reason        String
  notes         String?
  photoUrl      String?
  sourceType    String // goods_management_return
  sourceId      String   @db.ObjectId
  sourceCode    String? // GM-0001
  balanceAfter  Int
  createdBy     String?
  createdAt     DateTime @default(now())

  @@index([warehouseId])
  @@index([customerId])
  @@index([sourceType, sourceId])
}

// Per-job goods status (one row per Job). Derived tallies are computed from movement lines.
model JobStockSummary {
  id    String @id @default(auto()) @map("_id") @db.ObjectId
  jobId String @unique @db.ObjectId
  job   Job    @relation(fields: [jobId], references: [id])

  goodsStatus    String  @default("not_issued") // not_issued | partially_issued | issued | awaiting_return | reconciled
  workSummary    String?
  lastMovementAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([goodsStatus])
}
```

- [ ] **Step 2: Add back-relations to existing models.** In `schema.prisma`, add these fields (back-relations carry no DB column):
  - On `model Job { ... }` add: `stockMovements JobStockMovement[]` and `stockSummary JobStockSummary?`
  - On `model Warehouse { ... }` add: `jobStockMovements JobStockMovement[]` and `damagedStockBalances DamagedStockBalance[]`
  - On `model IrmItem { ... }` add: `jobStockMovementLines JobStockMovementLine[]` and `damagedStockBalances DamagedStockBalance[]`
  - On `model User { ... }` add: `jobStockMovements JobStockMovement[] @relation("JobStockMovementEngineer")` and `engineerCustomerStockHoldings EngineerCustomerStockHolding[] @relation("EngineerCustomerStockOwner")`

- [ ] **Step 3: Regenerate the Prisma client.** Stop `pnpm dev` first (Windows DLL lock), then:

Run: `cd backend && pnpm prisma:generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Typecheck (no new code yet, just the client).**

Run: `cd backend && pnpm typecheck`
Expected: exits 0 (no `error TS`).

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma
git commit -m "feat(goods-mgmt): add Prisma models for job stock movements, engineer customer holdings, damaged pool, job stock summary"
```

### Task 2: Permissions group + categories + engineer keys

**Files:**
- Modify: `backend/src/modules/role/permissions.ts`

**Interfaces — Produces:** permission keys `goods_management.view|issue|receive_return|reconcile`, `engineer.jobs.start|complete`; category `"Goods Management"`.

- [ ] **Step 1: Add the category.** In `PERMISSION_CATEGORIES` insert `"Goods Management"` immediately after `"Goods Out"`:

```ts
  "Goods Out",
  "Goods Management",
  "Jobs",
```

- [ ] **Step 2: Add the `goods_management` group.** After the `goods_out` group object, add:

```ts
  {
    key: "goods_management",
    label: "Goods Management",
    description: "Job-scoped scan flow — issue kit stock to an engineer, receive returns (good/damaged), and reconcile a job's stock.",
    category: "Goods Management",
    permissions: [
      { key: "goods_management.view", action: "View", description: "View the goods-management queue and a job's stock movements." },
      { key: "goods_management.issue", action: "Issue", description: "Scan stock out to an engineer for a job." },
      { key: "goods_management.receive_return", action: "Receive return", description: "Scan returned stock in (good/damaged) for a job." },
      { key: "goods_management.reconcile", action: "Reconcile", description: "Close & reconcile a job's stock and write off unaccounted (lost) units." },
    ],
  },
```

- [ ] **Step 3: Add engineer start/complete keys.** In the `engineer` group's `permissions` array, after `engineer.jobs.reject`, add:

```ts
      { key: "engineer.jobs.start", action: "Start job", description: "Mark an accepted job in-progress (start work on site)." },
      { key: "engineer.jobs.complete", action: "Complete job", description: "Mark a job completed, declaring used quantities + a work summary." },
```

- [ ] **Step 4: Typecheck.**

Run: `cd backend && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/role/permissions.ts
git commit -m "feat(goods-mgmt): add goods_management permission group + engineer start/complete keys"
```

### Task 3: Seed + idempotent backfill of the new permissions

**Files:**
- Modify: `backend/src/db/seed.ts`

- [ ] **Step 1: Extend the engineer + add an office constant.** After `JOB_OFFICE_PERMISSIONS`, add:

```ts
// Goods Management permissions for warehouse-side roles (issue/receive/reconcile). Seeded on the
// warehouse_manager + backfilled idempotently below.
const GOODS_MANAGEMENT_PERMISSIONS = [
  "goods_management.view",
  "goods_management.issue",
  "goods_management.receive_return",
  "goods_management.reconcile",
];
```

And extend `ENGINEER_PORTAL_PERMISSIONS` by adding two entries:

```ts
  "engineer.jobs.start",
  "engineer.jobs.complete",
```

- [ ] **Step 2: Seed on the warehouse_manager SEED_ROLES entry.** Add `...GOODS_MANAGEMENT_PERMISSIONS` to the `warehouse_manager` role's `permissions: [...]` array.

- [ ] **Step 3: Backfill block (mirror the Engineer Portal backfill).** After the Job office backfill block, add:

```ts
  // Backfill Goods Management permissions onto warehouse-side roles idempotently. Additive; skips "*".
  {
    let granted = 0;
    for (const role of await roleRepo.findMany()) {
      if (role.key !== "warehouse_manager" || role.permissions.includes("*")) continue;
      const missing = GOODS_MANAGEMENT_PERMISSIONS.filter((p) => !role.permissions.includes(p));
      if (missing.length) {
        await roleRepo.update(role.id, { permissions: [...role.permissions, ...missing] });
        granted++;
      }
    }
    if (granted > 0) console.log(`Granted Goods Management permissions to ${granted} role(s).`);
  }
```

- [ ] **Step 4: Add keys to the `system_admin` `wanted` list.** Append to that array:

```ts
      "goods_management.view", "goods_management.issue", "goods_management.receive_return", "goods_management.reconcile",
      "engineer.jobs.start", "engineer.jobs.complete",
```

- [ ] **Step 5: Typecheck + run seed against a dev DB.**

Run: `cd backend && pnpm typecheck`
Expected: exits 0.
Run (optional, against dev DB): `cd backend && pnpm seed` (or the project's seed script) → logs `Granted Goods Management permissions to N role(s).`

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/seed.ts
git commit -m "feat(goods-mgmt): seed + backfill goods_management and engineer start/complete permissions"
```

---

## PHASE 2 — Module scaffold + scan-lookup

### Task 4: Validation schemas

**Files:**
- Create: `backend/src/modules/goods-management/goods-management.validation.ts`
- Test: `backend/src/modules/goods-management/goods-management.validation.test.ts`

**Interfaces — Produces:** `scanLookupSchema`/`ScanLookupInput`, `postMovementSchema`/`PostMovementInput` (with `direction`, `lines[]`), `closeReconcileSchema`/`CloseReconcileInput`, `MOVEMENT_DIRECTIONS`, `LINE_SOURCES`, `LINE_CONDITIONS`.

- [ ] **Step 1: Write the failing validation test.**

```ts
import { describe, expect, it } from "vitest";
import { postMovementSchema, scanLookupSchema } from "./goods-management.validation.js";

const OID = "a".repeat(24);

describe("scanLookupSchema", () => {
  it("accepts a valid issue lookup", () => {
    const r = scanLookupSchema.safeParse({ jobId: OID, direction: "issue", code: "IRM-0004" });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown direction", () => {
    const r = scanLookupSchema.safeParse({ jobId: OID, direction: "consume", code: "X" });
    expect(r.success).toBe(false);
  });
});

describe("postMovementSchema", () => {
  it("requires damagePhotoUrl + damageReason when a return line is damaged", () => {
    const r = postMovementSchema.safeParse({
      direction: "return",
      lines: [{ source: "irm", irmItemId: OID, qty: 1, condition: "damaged" }],
    });
    expect(r.success).toBe(false);
  });
  it("accepts a good return line without a photo", () => {
    const r = postMovementSchema.safeParse({
      direction: "return",
      lines: [{ source: "irm", irmItemId: OID, qty: 1, condition: "good" }],
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the validation file.**

```ts
import { z } from "zod";

// Goods Management validation. Codes/status/snapshots are SYSTEM-owned (never from the client).
// direction issue/return are WM scan posts; consume is engineer-declared (handled in the job module).
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const objectId = (label: string) => z.string({ error: `Select ${label}.` }).regex(OBJECT_ID_RE, `Select ${label}.`);
const optionalObjectId = (label: string) => z.preprocess(emptyToUndef, z.string().regex(OBJECT_ID_RE, `Select ${label}.`).optional());

export const MOVEMENT_DIRECTIONS = ["issue", "return"] as const; // consume is engineer-only (job module)
export const LINE_SOURCES = ["irm", "customer"] as const;
export const LINE_CONDITIONS = ["good", "damaged"] as const;

export const scanLookupSchema = z.object({
  jobId: objectId("a job"),
  direction: z.enum(MOVEMENT_DIRECTIONS, { error: "Pick a direction." }),
  code: z.string({ error: "Scan or enter a code." }).trim().min(1, "Scan or enter a code.").max(120),
});
export type ScanLookupInput = z.infer<typeof scanLookupSchema>;

const movementLineSchema = z
  .object({
    source: z.enum(LINE_SOURCES, { error: "Pick a source." }),
    irmItemId: optionalObjectId("an IRM item"),
    customerStockEntryId: optionalObjectId("a customer stock item"),
    jobKitLineId: optionalObjectId("a kit line"),
    qty: z.coerce.number({ error: "Quantity is required." }).int("Whole number.").min(1, "At least 1.").max(10_000_000),
    condition: z.enum(LINE_CONDITIONS).optional(), // returns only; defaults to "good" server-side
    scannedCode: z.string().trim().max(120).optional(),
    damagePhotoUrl: z.string().trim().max(1000).optional(),
    damageReason: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((l, ctx) => {
    if (l.source === "irm" && !l.irmItemId) ctx.addIssue({ code: "custom", path: ["irmItemId"], message: "Select an IRM item." });
    if (l.source === "customer" && !l.customerStockEntryId) ctx.addIssue({ code: "custom", path: ["customerStockEntryId"], message: "Select a customer stock item." });
    if (l.condition === "damaged") {
      if (!l.damagePhotoUrl) ctx.addIssue({ code: "custom", path: ["damagePhotoUrl"], message: "Attach a photo of the damage." });
      if (!l.damageReason) ctx.addIssue({ code: "custom", path: ["damageReason"], message: "Give a reason for the damage." });
    }
  });
export type MovementLineInput = z.infer<typeof movementLineSchema>;

export const postMovementSchema = z.object({
  direction: z.enum(MOVEMENT_DIRECTIONS, { error: "Pick a direction." }),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(movementLineSchema).min(1, "Scan at least one item.").max(500),
});
export type PostMovementInput = z.infer<typeof postMovementSchema>;

export const closeReconcileSchema = z.object({
  writeOffLost: z.boolean().optional(), // book any unaccounted units as lost on close
});
export type CloseReconcileInput = z.infer<typeof closeReconcileSchema>;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.validation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/goods-management/goods-management.validation.ts backend/src/modules/goods-management/goods-management.validation.test.ts
git commit -m "feat(goods-mgmt): validation schemas (scan-lookup, post-movement, close-reconcile)"
```

### Task 5: Repository — code allocation, movement create, tallies, balance writers

**Files:**
- Create: `backend/src/modules/goods-management/goods-management.repository.ts`

**Interfaces — Produces (signatures later tasks call):**
- `createMovementWithCode(header, lines): Promise<JobStockMovementWithRelations>` — atomic GM-#### allocation + create (mirrors `goods-out.createWithCode`).
- `findMovementsByJob(jobId): Promise<JobStockMovementWithRelations[]>`
- `getSummary(jobId) / upsertSummaryTx(tx, jobId, data)`
- Customer engineer holding: `upsertCustomerHoldingTx(tx, customerStockEntryId, engineerId, delta, snap): Promise<EngineerCustomerStockHolding>`, `findCustomerHoldingTx(tx, customerStockEntryId, engineerId)`, `insertCustomerHoldingTxnTx(tx, data)`, `findCustomerHoldingsByEngineer(engineerId)`.
- Damaged: `upsertDamagedBalanceTx(tx, key, delta, snap)`, `insertDamagedTxnTx(tx, data)`, `findDamagedByWarehouse(warehouseId)`, `findDamagedByCustomer(customerId)`.
- Customer stock entry qty: `adjustCustomerStockEntryQtyTx(tx, entryId, delta): Promise<CustomerStockEntry>` (with non-negative guard).
- `findOverdueHoldings(days)` for the overdue view.

- [ ] **Step 1: Write the repository.** (Mirror `goods-out.repository.ts` for the Counter loop; reuse `withTransaction`, `conflict` from shared libs. Full file:)

```ts
import { Prisma, type JobStockMovement, type EngineerCustomerStockHolding, type EngineerCustomerStockTransaction, type DamagedStockBalance, type DamagedStockTransaction, type CustomerStockEntry, type JobStockSummary } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { conflict } from "../../utils/http-error.js";

const GM_CODE_PREFIX = "GM";

const withRelations = {
  items: { include: { irmItem: { select: { id: true, code: true, name: true, baseUnit: true } } } },
  job: { select: { id: true, jobNumber: true, name: true, customerId: true, customerName: true } },
} satisfies Prisma.JobStockMovementInclude;
export type JobStockMovementWithRelations = Prisma.JobStockMovementGetPayload<{ include: typeof withRelations }>;

export interface MovementLineRow {
  source: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  condition: string;
  jobKitLineId: string | null;
  scannedCode: string | null;
  damagePhotoUrl: string | null;
  damageReason: string | null;
  notes: string | null;
}

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null ? true : String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
async function highestGmNumber(): Promise<number> {
  const head = `${GM_CODE_PREFIX}-`;
  const rows = await prisma.jobStockMovement.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const s = code.slice(head.length);
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}
async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestGmNumber();
  try {
    await prisma.counter.create({ data: { key: GM_CODE_PREFIX, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key: GM_CODE_PREFIX }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}
async function fastForwardCounter(): Promise<void> {
  const start = await highestGmNumber();
  try {
    await prisma.counter.upsert({ where: { key: GM_CODE_PREFIX }, create: { key: GM_CODE_PREFIX, seq: start }, update: { seq: start } });
  } catch { /* best-effort */ }
}

// Create a posted movement + its lines atomically with a unique GM-#### code, running the caller's
// balance/ledger writes inside the SAME transaction via the `apply` callback.
export async function createMovementWithCode(
  header: Omit<Prisma.JobStockMovementUncheckedCreateInput, "code" | "items">,
  lines: MovementLineRow[],
  apply: (tx: Prisma.TransactionClient, movementId: string, code: string) => Promise<void>,
): Promise<JobStockMovementWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const code = `${GM_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const m = await tx.jobStockMovement.create({
          data: { deletedAt: null, ...header, code, items: { create: lines.map((l) => ({ ...l })) } },
        });
        await apply(tx, m.id, code);
        return tx.jobStockMovement.findUniqueOrThrow({ where: { id: m.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique goods-management code.");
}

export function findMovementsByJob(jobId: string): Promise<JobStockMovementWithRelations[]> {
  return prisma.jobStockMovement.findMany({ where: { jobId, deletedAt: null }, include: withRelations, orderBy: { createdAt: "asc" } });
}

// --- per-job summary -------------------------------------------------------------------------
export function getSummary(jobId: string): Promise<JobStockSummary | null> {
  return prisma.jobStockSummary.findUnique({ where: { jobId } });
}
export function upsertSummaryTx(tx: Prisma.TransactionClient, jobId: string, data: Prisma.JobStockSummaryUncheckedUpdateInput & { goodsStatus?: string }): Promise<JobStockSummary> {
  return tx.jobStockSummary.upsert({
    where: { jobId },
    create: { jobId, goodsStatus: (data.goodsStatus as string) ?? "not_issued", workSummary: (data.workSummary as string) ?? null, lastMovementAt: new Date() },
    update: { ...data, lastMovementAt: new Date() },
  });
}

// --- engineer customer-stock holding (tx-aware) ----------------------------------------------
export async function upsertCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string, delta: number, snap: { customerId: string | null; itemName: string }): Promise<EngineerCustomerStockHolding> {
  const bal = await tx.engineerCustomerStockHolding.upsert({
    where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } },
    create: { customerStockEntryId, engineerId, quantityOnHand: delta, customerId: snap.customerId, itemName: snap.itemName },
    update: { quantityOnHand: { increment: delta } },
  });
  if (bal.quantityOnHand < 0) throw conflict("Engineer doesn't hold that much of this customer item. Refresh and try again.");
  return bal;
}
export function findCustomerHoldingTx(tx: Prisma.TransactionClient, customerStockEntryId: string, engineerId: string): Promise<EngineerCustomerStockHolding | null> {
  return tx.engineerCustomerStockHolding.findUnique({ where: { customerStockEntryId_engineerId: { customerStockEntryId, engineerId } } });
}
export function insertCustomerHoldingTxnTx(tx: Prisma.TransactionClient, data: Prisma.EngineerCustomerStockTransactionUncheckedCreateInput): Promise<EngineerCustomerStockTransaction> {
  return tx.engineerCustomerStockTransaction.create({ data });
}
export function findCustomerHoldingsByEngineer(engineerId: string) {
  return prisma.engineerCustomerStockHolding.findMany({ where: { engineerId, quantityOnHand: { gt: 0 } }, orderBy: { updatedAt: "desc" } });
}

// --- customer stock entry quantity (warehouse pool) ------------------------------------------
export async function adjustCustomerStockEntryQtyTx(tx: Prisma.TransactionClient, entryId: string, delta: number): Promise<CustomerStockEntry> {
  const e = await tx.customerStockEntry.update({ where: { id: entryId }, data: { quantity: { increment: delta } } });
  if (e.quantity < 0) throw conflict("Insufficient customer stock for this movement. Refresh and try again.");
  return e;
}
export function findCustomerStockEntryById(entryId: string) {
  return prisma.customerStockEntry.findFirst({ where: { id: entryId, deletedAt: null } });
}

// --- damaged pool (tx-aware) -----------------------------------------------------------------
export interface DamagedKey { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null; customerId: string | null; itemName: string; }
export async function upsertDamagedBalanceTx(tx: Prisma.TransactionClient, key: DamagedKey, delta: number): Promise<DamagedStockBalance> {
  // No compound unique (owner mix) — find-or-create by the natural key, then increment.
  const existing = await tx.damagedStockBalance.findFirst({
    where: { warehouseId: key.warehouseId, ownerType: key.ownerType, irmItemId: key.irmItemId, customerStockEntryId: key.customerStockEntryId },
  });
  if (!existing) {
    return tx.damagedStockBalance.create({ data: { ...key, quantity: delta } });
  }
  return tx.damagedStockBalance.update({ where: { id: existing.id }, data: { quantity: { increment: delta } } });
}
export function insertDamagedTxnTx(tx: Prisma.TransactionClient, data: Prisma.DamagedStockTransactionUncheckedCreateInput): Promise<DamagedStockTransaction> {
  return tx.damagedStockTransaction.create({ data });
}
export function findDamagedByWarehouse(warehouseId: string) {
  return prisma.damagedStockBalance.findMany({ where: { warehouseId, quantity: { gt: 0 } }, orderBy: { updatedAt: "desc" } });
}
export function findDamagedByCustomer(customerId: string) {
  return prisma.damagedStockBalance.findMany({ where: { customerId, quantity: { gt: 0 } }, orderBy: { updatedAt: "desc" } });
}

// --- overdue holdings (jobs whose stock is still out > N days) --------------------------------
export function findRecentMovementsForOverdue(cutoff: Date) {
  return prisma.jobStockMovement.findMany({
    where: { direction: "issue", status: "posted", deletedAt: null, createdAt: { lt: cutoff } },
    include: withRelations,
    orderBy: { createdAt: "asc" },
  });
}
```

- [ ] **Step 2: Typecheck.**

Run: `cd backend && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/goods-management/goods-management.repository.ts
git commit -m "feat(goods-mgmt): repository — GM code allocation, movement create, holdings/damaged/summary writers"
```

### Task 6: Service — scan-lookup (find item by barcode, validate against kit list)

**Files:**
- Create: `backend/src/modules/goods-management/goods-management.service.ts` (start the file)
- Test: `backend/src/modules/goods-management/goods-management.service.test.ts`

**Interfaces — Consumes:** `jobRepo.findById`, `irmService.requireActiveIrmItem`, `goodsManagementRepo.findCustomerStockEntryById`, `inventoryRepo.findBalancePair`. **Produces:** `scanLookup(input: ScanLookupInput, actor?): Promise<ScanMatch>` where `ScanMatch = { source: "irm"|"customer"; irmItemId?; customerStockEntryId?; jobKitLineId?; itemName; uom?; plannedQty; alreadyIssued; remainingIssuable; available }`.

- [ ] **Step 1: Write the failing test.**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), getSummary: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(), findCustomerHoldingsByEngineer: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(), findRecentMovementsForOverdue: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/goods-out/goods-out.repository.js", () => ({ upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as repo from "./goods-management.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import { scanLookup } from "./goods-management.service.js";

const JOB_ID = "a".repeat(24), IRM_ID = "d".repeat(24), WH_ID = "b".repeat(24);
const mockJob = jobRepo.findById as ReturnType<typeof vi.fn>;
const mockIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
const mockBal = inventoryRepo.findBalancePair as ReturnType<typeof vi.fn>;
const mockMoves = repo.findMovementsByJob as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockJob.mockResolvedValue({ id: JOB_ID, status: "accepted", assignedEngineerId: "c".repeat(24),
    kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, warehouseId: WH_ID, itemName: "CAT6", qty: 10 }] });
  mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "CAT6", baseUnit: "Box", barcode: "5012345678900", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
  mockBal.mockResolvedValue({ quantityOnHand: 4, quantityReserved: 0 });
  mockMoves.mockResolvedValue([]);
});

describe("scanLookup (issue)", () => {
  it("resolves an IRM code to its kit line and reports remaining + available", async () => {
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-0004" });
    expect(m).toMatchObject({ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", plannedQty: 10, alreadyIssued: 0, remainingIssuable: 10, available: 4 });
  });
  it("rejects a code that isn't on the kit list", async () => {
    mockIrm.mockResolvedValue({ id: "e".repeat(24), code: "IRM-9999", name: "Other", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-9999" })).rejects.toThrow(/not on this job/i);
  });
  it("rejects a serial-tracked item", async () => {
    mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "SFP", trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-0004" })).rejects.toThrow(/serial|batch/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.service.test.ts -t "scanLookup"`
Expected: FAIL — `scanLookup` not exported.

- [ ] **Step 3: Write the service start + `scanLookup`.**

```ts
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as goodsManagementRepo from "./goods-management.repository.js";
import type { ScanLookupInput } from "./goods-management.validation.js";

const IRM_CODE_RE = /^IRM-/i;

export interface ScanMatch {
  source: "irm" | "customer";
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string;
  itemName: string;
  uom?: string | null;
  plannedQty: number;
  alreadyIssued: number;
  remainingIssuable: number;
  available: number; // current warehouse availability of this item
}

// Sum the qty already issued for a kit line (issue lines minus return lines pointing at it).
function issuedForKitLine(movements: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>>, kitLineId: string): number {
  let n = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "issue") n += l.qty;
      if (m.direction === "return") n -= l.qty; // a return frees the planned allocation back
    }
  }
  return n;
}

export async function scanLookup(input: ScanLookupInput, actor?: AuditActor): Promise<ScanMatch> {
  const job = await jobRepo.findById(input.jobId);
  if (!job) throw notFound("Job not found.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const code = input.code.trim();

  if (IRM_CODE_RE.test(code) || true) {
    // Try IRM first (by code or barcode), then customer (CSE barcode).
    const irm = await irmService.requireActiveIrmItem(undefined as never).catch(() => null);
    void irm; // placeholder — real lookup below
  }

  // 1) IRM lookup by code/barcode.
  const irmItem = await irmService.findActiveByCodeOrBarcode?.(code) ?? null;
  if (irmItem) {
    if (irmItem.trackSerialNumbers || irmItem.trackBatchNumbers) {
      throw conflict(`${irmItem.name} is serial/batch-tracked — those items can't be moved here yet.`);
    }
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === irmItem.id);
    if (!kit) throw badRequest(`${irmItem.name} is not on this job's kit list.`);
    const already = issuedForKitLine(movements, kit.id);
    const bal = await inventoryRepo.findBalancePair(irmItem.id, kit.warehouseId!);
    const available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    if (kit.warehouseId) assertWarehouseAccess(actor, kit.warehouseId);
    return {
      source: "irm", irmItemId: irmItem.id, jobKitLineId: kit.id, itemName: irmItem.name, uom: irmItem.baseUnit,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available,
    };
  }

  // 2) Customer stock entry lookup by barcode.
  const entry = await goodsManagementRepo.findCustomerStockEntryByBarcode?.(code) ?? null;
  if (entry) {
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id);
    if (!kit) throw badRequest(`${entry.itemName} is not on this job's kit list.`);
    const already = issuedForKitLine(movements, kit.id);
    if (entry.warehouseId) assertWarehouseAccess(actor, entry.warehouseId);
    return {
      source: "customer", customerStockEntryId: entry.id, jobKitLineId: kit.id, itemName: entry.itemName, uom: entry.uom,
      plannedQty: kit.qty, alreadyIssued: already, remainingIssuable: kit.qty - already, available: entry.quantity,
    };
  }

  throw notFound(`No item matches "${code}".`);
}

export { warehouseScopeFilter }; // re-export for the queue task
```

> NOTE for the implementer: this task introduces two small lookup helpers the test does not exercise directly but the next steps need. Add them now:
> - In `irm.service.ts`: `export function findActiveByCodeOrBarcode(code: string)` → calls a new `irmRepo.findActiveByCodeOrBarcode(code)` (`prisma.irmItem.findFirst({ where: { status: "active", OR: [{ code }, { barcode: code }, { skuLower: code.toLowerCase() }] } })`). Remove the placeholder `requireActiveIrmItem(undefined…)` block above — it exists only to show where the lookup goes; replace the whole `if (IRM_CODE_RE.test(code) || true) {...}` stub with nothing.
> - In `goods-management.repository.ts`: `export function findCustomerStockEntryByBarcode(code: string)` → `prisma.customerStockEntry.findFirst({ where: { barcode: code, status: "active", deletedAt: null } })`.

- [ ] **Step 4: Remove the placeholder stub, add the two lookup helpers, and re-run the test.**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.service.test.ts -t "scanLookup"`
Expected: PASS (3 tests). Then `pnpm typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/goods-management/ backend/src/modules/irm/
git commit -m "feat(goods-mgmt): scan-lookup service + IRM/customer barcode lookup helpers"
```

### Task 7: Controller + routes + registration (view + scan-lookup endpoints)

**Files:**
- Create: `backend/src/modules/goods-management/goods-management.controller.ts`
- Create: `backend/src/modules/goods-management/goods-management.routes.ts`
- Modify: `backend/src/routes/index.ts`

**Interfaces — Produces routes:** `POST /goods-management/scan-lookup`, plus placeholders wired in later tasks (`GET /goods-management/queue`, `GET /goods-management/jobs/:jobId`, `POST /goods-management/jobs/:jobId/issue`, `.../return`, `.../close`, `GET /goods-management/overdue`).

- [ ] **Step 1: Write the controller** (thin; mirror `job.controller.ts`). Only `scanLookup` for now; the rest are added in their tasks:

```ts
import * as service from "./goods-management.service.js";
import { actorFrom } from "../../utils/actor.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { ScanLookupInput } from "./goods-management.validation.js";

export const scanLookup = asyncHandler(async (req, res) => {
  res.json({ match: await service.scanLookup(req.body as ScanLookupInput, actorFrom(req)) });
});
```

- [ ] **Step 2: Write the routes** (mirror `goods-out.routes.ts`):

```ts
import { Router } from "express";

import * as controller from "./goods-management.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { writeLimiter } from "../../middleware/rateLimit.middleware.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import { scanLookupSchema } from "./goods-management.validation.js";

const router = Router();
router.use(requireAuth);

router.post("/scan-lookup", requirePermission("goods_management.view"), writeLimiter, validateBody(scanLookupSchema), controller.scanLookup);

export default router;
```

- [ ] **Step 3: Register in `backend/src/routes/index.ts`.** Add the import (alphabetical, near `goodsOutRoutes`) and the mount:

```ts
import goodsManagementRoutes from "#modules/goods-management/goods-management.routes.js";
```
```ts
router.use("/goods-management", goodsManagementRoutes);
```

- [ ] **Step 4: Typecheck + lint.**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/goods-management/ backend/src/routes/index.ts
git commit -m "feat(goods-mgmt): controller + routes + registration (scan-lookup endpoint live)"
```

---

## PHASE 3 — Issue flow (scan-out) + queue

### Task 8: Service — `postIssue` (transactional warehouse→engineer for IRM + customer)

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts`
- Modify: `backend/src/modules/goods-management/goods-management.service.test.ts`

**Interfaces — Consumes:** `jobRepo.findById`, `inventoryService.applyOutbound`, `inventoryRepo.findBalancePairTx`, `goodsOutRepo.upsertEngineerBalanceTx`/`insertEngineerTxnTx`, `goodsManagementRepo.*` (createMovementWithCode, adjustCustomerStockEntryQtyTx, upsertCustomerHoldingTx, insertCustomerHoldingTxnTx, upsertSummaryTx). **Produces:** `postIssue(jobId, input: PostMovementInput, actor?): Promise<PublicMovement>`.

- [ ] **Step 1: Write the failing test** (add a `describe("postIssue")` block):

```ts
import { postIssue } from "./goods-management.service.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";

const ENG_ID = "c".repeat(24);
const mockCreateMovement = repo.createMovementWithCode as ReturnType<typeof vi.fn>;
const mockApplyOutbound = inventoryService.applyOutbound as ReturnType<typeof vi.fn>;
const mockUpsertEng = goodsOutRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockBalTx = inventoryRepo.findBalancePairTx as ReturnType<typeof vi.fn>;

describe("postIssue", () => {
  beforeEach(() => {
    mockBalTx.mockResolvedValue({ quantityOnHand: 100, quantityReserved: 0 });
    mockUpsertEng.mockResolvedValue({ quantityOnHand: 10 });
    // createMovementWithCode runs the apply() callback with a fake tx + ids, then returns a row.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m1", "GM-0001");
      return { id: "m1", code: "GM-0001", direction: "issue", items: [], job: { id: JOB_ID } };
    });
  });

  it("decrements the warehouse and increments the engineer holding for an IRM issue", async () => {
    await postIssue(JOB_ID, { direction: "issue", lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 10, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never);
    expect(mockApplyOutbound).toHaveBeenCalledTimes(1);
    expect(mockApplyOutbound.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 10, sourceType: "goods_management", sourceCode: "GM-0001" });
    expect(mockUpsertEng).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, 10);
  });

  it("rejects issuing more than the kit-line remaining", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    await expect(postIssue(JOB_ID, { direction: "issue", lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 6, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never)).rejects.toThrow(/remaining|kit/i);
    expect(mockCreateMovement).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it (fails — `postIssue` not exported).**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.service.test.ts -t "postIssue"`
Expected: FAIL.

- [ ] **Step 3: Implement `postIssue` + a `toPublic` mapper.** Append to the service:

```ts
import { withTransaction } from "../../lib/prisma.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { PostMovementInput } from "./goods-management.validation.js";

export interface PublicMovement {
  id: string; code: string; jobId: string; direction: string; status: string;
  engineerId: string; engineerName: string; warehouseId: string | null;
  lines: { source: string; irmItemId: string | null; customerStockEntryId: string | null; itemName: string; qty: number; condition: string }[];
}
function toPublic(m: goodsManagementRepo.JobStockMovementWithRelations): PublicMovement {
  return {
    id: m.id, code: m.code, jobId: m.jobId, direction: m.direction, status: m.status,
    engineerId: m.engineerId, engineerName: m.engineerName, warehouseId: m.warehouseId,
    lines: m.items.map((l) => ({ source: l.source, irmItemId: l.irmItemId, customerStockEntryId: l.customerStockEntryId, itemName: l.itemName, qty: l.qty, condition: l.condition })),
  };
}

async function loadJobOrThrow(jobId: string) {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");
  if (!job.assignedEngineerId) throw conflict("This job has no assigned engineer.");
  return job;
}

export async function postIssue(jobId: string, input: PostMovementInput, actor?: AuditActor): Promise<PublicMovement> {
  if (input.direction !== "issue") throw badRequest("Wrong direction for issue.");
  const job = await loadJobOrThrow(jobId);
  if (!["accepted", "in_progress"].includes(job.status)) throw conflict("Stock can only be issued for an accepted/in-progress job.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);

  // Resolve + validate every line against the kit list BEFORE opening the tx.
  type Resolved = { line: typeof input.lines[number]; kit: NonNullable<typeof job.kitLines>[number]; itemName: string; uom: string | null; warehouseId: string };
  const resolved: Resolved[] = [];
  for (const line of input.lines) {
    if (!line.jobKitLineId) throw badRequest("Each issued line must reference a kit line.");
    const kit = (job.kitLines ?? []).find((k) => k.id === line.jobKitLineId);
    if (!kit) throw badRequest("Kit line not found on this job.");
    const already = issuedForKitLine(movements, kit.id);
    if (line.qty > kit.qty - already) throw conflict(`${kit.itemName}: only ${kit.qty - already} remaining on the kit list.`);
    if (line.source === "irm") {
      const irm = await irmService.requireActiveIrmItem(line.irmItemId!);
      if (irm.trackSerialNumbers || irm.trackBatchNumbers) throw conflict(`${irm.name} is serial/batch-tracked and can't be moved here.`);
      resolved.push({ line, kit, itemName: irm.name, uom: irm.baseUnit, warehouseId: kit.warehouseId! });
    } else {
      const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId!);
      if (!entry) throw badRequest("Customer stock item not found.");
      resolved.push({ line, kit, itemName: entry.itemName, uom: entry.uom, warehouseId: entry.warehouseId! });
    }
    assertWarehouseAccess(actor, resolved[resolved.length - 1].warehouseId);
  }
  const warehouseId = resolved[0].warehouseId;
  const actorEmail = actor?.email ?? null;

  const lines = resolved.map((r) => ({
    source: r.line.source, irmItemId: r.line.source === "irm" ? r.line.irmItemId! : null,
    customerStockEntryId: r.line.source === "customer" ? r.line.customerStockEntryId! : null,
    itemName: r.itemName, sku: null, uom: r.uom, qty: r.line.qty, condition: "good",
    jobKitLineId: r.kit.id, scannedCode: r.line.scannedCode ?? null, damagePhotoUrl: null, damageReason: null, notes: r.line.notes ?? null,
  }));

  const created = await goodsManagementRepo.createMovementWithCode(
    { jobId: job.id, direction: "issue", engineerId: job.assignedEngineerId!, engineerName: job.assignedEngineerName ?? "", engineerEmail: job.assignedEngineerEmail ?? null, warehouseId, warehouseName: resolved[0].kit.warehouseName ?? null, warehouseCode: resolved[0].kit.warehouseCode ?? null, status: "posted", postedAt: new Date(), performedBy: actorEmail, createdBy: actorEmail },
    lines,
    async (tx, movementId, code) => {
      for (const r of resolved) {
        if (r.line.source === "irm") {
          const live = await inventoryRepo.findBalancePairTx(tx, r.line.irmItemId!, r.warehouseId);
          const available = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
          if (r.line.qty > available) throw conflict(`${r.itemName}: only ${available} available — stock changed.`);
          await inventoryService.applyOutbound(tx, { irmItemId: r.line.irmItemId!, warehouseId: r.warehouseId, quantity: r.line.qty, sourceType: "goods_management", sourceId: movementId, sourceCode: code, createdBy: actorEmail });
          const eng = await goodsOutRepo.upsertEngineerBalanceTx(tx, r.line.irmItemId!, job.assignedEngineerId!, r.line.qty);
          await goodsOutRepo.insertEngineerTxnTx(tx, { irmItemId: r.line.irmItemId!, engineerId: job.assignedEngineerId!, quantityDelta: r.line.qty, type: "job_issue", sourceType: "goods_management", sourceId: movementId, sourceCode: code, balanceAfter: eng.quantityOnHand, createdBy: actorEmail });
        } else {
          const entry = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!, -r.line.qty);
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, r.line.customerStockEntryId!, job.assignedEngineerId!, r.line.qty, { customerId: entry.customerId, itemName: entry.itemName });
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, { customerStockEntryId: r.line.customerStockEntryId!, engineerId: job.assignedEngineerId!, quantityDelta: r.line.qty, type: "job_issue", sourceType: "goods_management", sourceId: movementId, sourceCode: code, balanceAfter: hold.quantityOnHand, createdBy: actorEmail });
        }
      }
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "issued" }); // refined to partially_issued by a later read
    },
  );
  audit.record({ actor, action: "goods_management.issued", targetType: "job", targetId: job.id, targetLabel: created.code });
  return toPublic(created);
}
```

- [ ] **Step 4: Run the test (passes), then typecheck.**

Run: `cd backend && pnpm test src/modules/goods-management/goods-management.service.test.ts -t "postIssue"` → PASS.
Run: `cd backend && pnpm typecheck` → exits 0.

- [ ] **Step 5: Wire the route + controller.** Add to controller:

```ts
import { param } from "../../utils/request.js";
import type { PostMovementInput } from "./goods-management.validation.js";
export const postIssue = asyncHandler(async (req, res) => {
  res.status(201).json({ movement: await service.postIssue(param(req, "jobId"), req.body as PostMovementInput, actorFrom(req)) });
});
```
Add to routes:
```ts
import { postMovementSchema } from "./goods-management.validation.js";
router.post("/jobs/:jobId/issue", requirePermission("goods_management.issue"), writeLimiter, validateBody(postMovementSchema), controller.postIssue);
```

- [ ] **Step 6: Typecheck + lint + commit**

Run: `cd backend && pnpm typecheck && pnpm lint` → both 0.
```bash
git add backend/src/modules/goods-management/
git commit -m "feat(goods-mgmt): issue flow — scan-out decrements warehouse, credits engineer (IRM + customer), atomic + kit-constrained"
```

### Task 9: Service + endpoints — queue (planned vs available) + job goods detail

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts`, `.controller.ts`, `.routes.ts`

**Interfaces — Produces:** `listQueue(actor): Promise<QueueRow[]>` (jobs in `accepted`/`in_progress`/awaiting-return whose kit pickup warehouses the actor can access, each kit line annotated `planned`, `issued`, `available`); `getJobGoods(jobId, actor): Promise<{ job; summary; movements; lines: tally[] }>`.

- [ ] **Step 1: Implement `listQueue` + `getJobGoods`.** (Read jobs via `jobRepo` with status in the active set + `warehouseScopeFilter`; for each kit line compute `issued` from movements and `available` from `inventoryRepo.findBalancePair` / `customerStockEntry.quantity`. Customer-pricing rule: never include cost/value.) Add a `jobRepo.findActiveForGoodsManagement(warehouseIds?)` query that returns jobs with `status in [accepted, in_progress, completed]`, `kitLines` included, filtered to lines whose `warehouseId` ∈ the scope. Compute `goodsStatus` from `JobStockSummary` (default `not_issued`).

- [ ] **Step 2: Add a test** asserting a queue row reports `planned: 10, issued: 6, available: 4` given mocked movements + balances. Run it → PASS.

- [ ] **Step 3: Wire `GET /goods-management/queue` and `GET /goods-management/jobs/:jobId`** (both `requirePermission("goods_management.view")`, no body, no `writeLimiter`).

- [ ] **Step 4: Typecheck + lint + commit**

```bash
git commit -am "feat(goods-mgmt): queue (planned vs available) + per-job goods detail endpoints"
```

---

## PHASE 4 — Engineer Start / Complete (consume) + holdings

### Task 10: Job service — `startJobForEngineer` + `completeJobForEngineer` (consume movement)

**Files:**
- Modify: `backend/src/modules/job/job.service.ts`, `backend/src/modules/job/job.repository.ts`, `backend/src/modules/job/job.validation.ts`
- Test: `backend/src/modules/job/job.service.test.ts` (add cases)

**Interfaces — Produces:** `startJobForEngineer(jobId, engineerId, actor): Promise<PublicJob>` (`accepted → in_progress`); `completeJobForEngineer(jobId, engineerId, input: CompleteJobInput, actor): Promise<PublicJob>` (`in_progress → completed` + a `consume` JobStockMovement that drains the engineer holdings by declared used qty + stores `workSummary` on `JobStockSummary`). `CompleteJobInput = { workSummary?: string; usedLines: { source; irmItemId?; customerStockEntryId?; qty }[] }`.

- [ ] **Step 1: Add validation** to `job.validation.ts`:

```ts
export const completeJobSchema = z.object({
  workSummary: z.string().trim().max(4000).optional(),
  usedLines: z.array(z.object({
    source: z.enum(["irm", "customer"]),
    irmItemId: optionalObjectId("an IRM item"),
    customerStockEntryId: optionalObjectId("a customer stock item"),
    qty: z.coerce.number().int().min(0).max(10_000_000),
  })).max(500).default([]),
});
export type CompleteJobInput = z.infer<typeof completeJobSchema>;
```

- [ ] **Step 2: Write failing tests** in `job.service.test.ts`: (a) start transitions accepted→in_progress and 403s if the caller isn't the assigned engineer; (b) complete transitions in_progress→completed, writes a `consume` movement draining engineer holdings by `usedLines`, sets `goodsStatus = awaiting_return`, and rejects a used qty greater than the held amount. Mock `goodsManagementRepo` + `goodsOutRepo` engineer-balance readers. Run → FAIL.

- [ ] **Step 3: Implement.** In `job.service.ts` add (mirror `acceptJobForEngineer`'s ownership + atomic guard):

```ts
export async function startJobForEngineer(jobId: string, engineerId: string, actor?: AuditActor): Promise<PublicJob> {
  const job = await jobRepo.findById(jobId);
  if (!job || job.deletedAt) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("This job isn't assigned to you.");
  assertTransition(job.status, "in_progress");
  const updated = await jobRepo.startIfAccepted(jobId, engineerId);
  if (!updated) throw conflict("This job can't be started right now. Refresh and try again.");
  const pub = toPublic(updated);
  emitToUser(engineerId, "job:updated", pub);
  emitToRoom(OFFICE_JOBS_ROOM, "job:updated", pub);
  audit.record({ actor, action: "job.started", targetType: "job", targetId: jobId, targetLabel: job.jobNumber });
  return pub;
}

export async function completeJobForEngineer(jobId: string, engineerId: string, input: CompleteJobInput, actor?: AuditActor): Promise<PublicJob> {
  const job = await jobRepo.findById(jobId);
  if (!job || job.deletedAt) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("This job isn't assigned to you.");
  assertTransition(job.status, "completed");
  const actorEmail = actor?.email ?? null;
  const used = input.usedLines.filter((l) => l.qty > 0);

  await goodsManagementService.recordConsumeAndComplete(job, engineerId, input.workSummary ?? null, used, actorEmail);
  const updated = await jobRepo.findById(jobId);
  const pub = toPublic(updated!);
  emitToUser(engineerId, "job:updated", pub);
  emitToRoom(OFFICE_JOBS_ROOM, "job:updated", pub);
  audit.record({ actor, action: "job.completed", targetType: "job", targetId: jobId, targetLabel: job.jobNumber });
  return pub;
}
```

> Implementer note: to avoid a circular import, put the transactional consume logic in `goods-management.service.ts` as `recordConsumeAndComplete(job, engineerId, workSummary, used, actorEmail)` — it opens `withTransaction`, for each used line drains the engineer holding (`goodsOutRepo.upsertEngineerBalanceTx(tx, irmItemId, engineerId, -qty)` for IRM after a held-amount pre-check via `findEngineerBalanceTx`; `goodsManagementRepo.upsertCustomerHoldingTx(tx, …, -qty)` for customer), appends ledger rows with `type: "job_consume"`, creates a `consume` `JobStockMovement` (warehouseId null), stamps the job `completed` via `jobRepo.completeIfInProgressTx(tx, jobId, engineerId)`, and `upsertSummaryTx(tx, jobId, { goodsStatus: "awaiting_return", workSummary })`. `job.service` imports `goodsManagementService`; `goods-management.service` must NOT import back from `job.service` (it takes the loaded `job` as a param) — this keeps the dependency one-way.

- [ ] **Step 4: Add repo helpers** to `job.repository.ts`:

```ts
export function startIfAccepted(id: string, engineerId: string) {
  return prisma.job.updateMany({ where: { id, assignedEngineerId: engineerId, status: "accepted", deletedAt: null }, data: { status: "in_progress" } })
    .then((r) => (r.count === 1 ? findById(id) : null));
}
export function completeIfInProgressTx(tx: Prisma.TransactionClient, id: string, engineerId: string) {
  return tx.job.updateMany({ where: { id, assignedEngineerId: engineerId, status: "in_progress", deletedAt: null }, data: { status: "completed" } });
}
```

- [ ] **Step 5: Run the new tests + typecheck.**

Run: `cd backend && pnpm test src/modules/job/job.service.test.ts -t "start|complete"` → PASS.
Run: `cd backend && pnpm typecheck` → 0.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(goods-mgmt): engineer start/complete job — consume movement drains holdings, books work summary"
```

### Task 11: Engineer routes — start/complete + held customer stock

**Files:**
- Modify: `backend/src/modules/engineer/engineer.routes.ts`, `.controller.ts`, `.service.ts`

- [ ] **Step 1: Add service delegations** in `engineer.service.ts` (resolve engineer id from the principal, then call `jobService.startJobForEngineer` / `completeJobForEngineer`; add `getOwnCustomerStock()` → `goodsManagementRepo.findCustomerHoldingsByEngineer(engineerId)` mapped to a public shape with NO pricing).

- [ ] **Step 2: Add controller handlers** `startOwnJob`, `completeOwnJob`, `getOwnCustomerStock` (mirror `acceptOwnJob`).

- [ ] **Step 3: Add routes:**

```ts
router.post("/jobs/:id/start", requirePermission("engineer.jobs.start"), writeLimiter, jobController.startOwnJob);
router.post("/jobs/:id/complete", requirePermission("engineer.jobs.complete"), writeLimiter, validateBody(completeJobSchema), engineerController.completeOwnJob);
router.get("/customer-stock", requirePermission("engineer.inventory.view"), engineerController.getOwnCustomerStock);
```

- [ ] **Step 4: Typecheck + lint + commit**

```bash
git commit -am "feat(goods-mgmt): engineer endpoints — start/complete job + held customer stock"
```

---

## PHASE 5 — Return (good/damaged) + Close & reconcile + overdue

### Task 12: Service — `postReturn` (good → warehouse, damaged → damaged pool)

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts`, `.controller.ts`, `.routes.ts`, `.service.test.ts`

**Interfaces — Produces:** `postReturn(jobId, input: PostMovementInput, actor): Promise<PublicMovement>` — for each line: drain the engineer holding (IRM/customer) by qty (pre-check held amount); if `condition: "good"` credit the warehouse pool back (IRM `applyInbound`; customer `adjustCustomerStockEntryQtyTx(+qty)`); if `condition: "damaged"` credit the Damaged pool (`upsertDamagedBalanceTx` + `insertDamagedTxnTx` with `photoUrl`, `reason`). Returned qty can't exceed `issued − returned − consumed` for that item. Update summary to `awaiting_return` (still out) or stays until close.

- [ ] **Step 1: Write failing tests:** (a) a good IRM return calls `applyInbound` to the warehouse + drains the engineer; (b) a damaged customer return calls `upsertDamagedBalanceTx` with `ownerType: "customer"` + the photo, and does NOT credit the customer pool; (c) returning more than held throws. Run → FAIL.

- [ ] **Step 2: Implement `postReturn`** (mirror `postIssue`'s resolve-then-tx structure; reverse the movements; require `damagePhotoUrl` + `damageReason` already guaranteed by validation for damaged lines). The engineer holding pre-check uses `goodsOutRepo.findEngineerBalanceTx` (IRM) / `goodsManagementRepo.findCustomerHoldingTx` (customer); the warehouse return uses `inventoryService.applyInbound`. Damaged writes carry `sourceType: "goods_management_return"`.

- [ ] **Step 3: Run tests → PASS; typecheck → 0.**

- [ ] **Step 4: Wire `POST /goods-management/jobs/:jobId/return`** (`requirePermission("goods_management.receive_return")`, `validateBody(postMovementSchema)`).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(goods-mgmt): return flow — good→warehouse, damaged→damaged pool (photo+reason), drains engineer holding"
```

### Task 13: Service — `closeReconcile` (verify, write off unaccounted, lock)

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts`, `.controller.ts`, `.routes.ts`, `.service.test.ts`

**Interfaces — Produces:** `closeReconcile(jobId, input: CloseReconcileInput, actor): Promise<{ summary; unaccounted: { itemName; qty }[] }>` — compute per item `issued − used − returnedGood − returnedDamaged`; if all zero → `goodsStatus = reconciled` (locked: further issue/return rejected when reconciled); if any positive and `writeOffLost` → drain the remaining engineer holding with `type: "job_lost"` + a `consume`-style movement reason `lost`, then reconcile; if positive and not `writeOffLost` → return the `unaccounted` list and leave open.

- [ ] **Step 1: Write failing tests:** balanced job reconciles to `reconciled`; an unbalanced job returns `unaccounted` and stays open unless `writeOffLost: true` (which drains the holding and reconciles). Run → FAIL.

- [ ] **Step 2: Implement.** Guard: only from `awaiting_return` (or `issued`); reject if already `reconciled`. After reconcile, `postIssue`/`postReturn` must reject when `summary.goodsStatus === "reconciled"` (add that check at the top of both — write a small test for it).

- [ ] **Step 3: Run tests → PASS; typecheck → 0.**

- [ ] **Step 4: Wire `POST /goods-management/jobs/:jobId/close`** (`requirePermission("goods_management.reconcile")`, `validateBody(closeReconcileSchema)`).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(goods-mgmt): close & reconcile — verify issued=used+returned, write off lost, lock the job"
```

### Task 14: Damaged + overdue read endpoints

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts`, `.controller.ts`, `.routes.ts`

**Interfaces — Produces:** `listDamaged({ warehouseId?, customerId? }, actor)` (no pricing); `listOverdue(actor, days = 14)` → issue movements older than `days` whose job's engineer still holds stock (`goodsStatus !== "reconciled"`), with a `writeOffLost(jobId, actor)` reconcile shortcut.

- [ ] **Step 1: Implement the three reads** (damaged-by-warehouse uses `warehouseScopeFilter`; damaged-by-customer is read on the customer page; overdue uses `findRecentMovementsForOverdue(cutoff)` joined to the summary). Add `GET /goods-management/damaged?warehouseId=&customerId=`, `GET /goods-management/overdue?days=`.

- [ ] **Step 2: Typecheck + lint + run the full backend test suite.**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`
Expected: 0 / 0 / all tests pass (existing 1053 + the new goods-management/job tests).

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(goods-mgmt): damaged + overdue read endpoints"
```

---

## PHASE 6 — Frontend

### Task 15: Add scanning dependency + the scanner hook

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/hooks/useBarcodeScanner.ts`
- Create: `frontend/src/components/dashboard/goods-management/ScannerInput.tsx`

**Interfaces — Produces:** `useBarcodeScanner()` → `{ startCamera(videoEl), stop(), decodeImageFile(file): Promise<string> }`; `<ScannerInput onCode={(code: string) => void} disabled?>` rendering: a focused text input (hardware/manual + Enter), a "Scan with camera" toggle (live `<video>`), and an "Upload photo" button.

- [ ] **Step 1: Add the dependency.**

Run: `cd frontend && pnpm add @zxing/browser`
Expected: adds `@zxing/browser` (+ peer `@zxing/library`) to `package.json`.

- [ ] **Step 2: Write `useBarcodeScanner.ts`** using `BrowserMultiFormatReader` from `@zxing/browser`: `decodeImageFile(file)` → `readFileAsDataUrl(file)` (reuse `@/lib/image`) then `reader.decodeFromImageUrl(dataUrl)` → `.getText()`; `startCamera(videoEl, onCode)` → `reader.decodeFromVideoDevice(undefined, videoEl, (res) => res && onCode(res.getText()))`; `stop()` → `reader.reset()`. Wrap decode errors into a thrown `Error("Couldn't read a barcode from that image.")`.

- [ ] **Step 3: Write `ScannerInput.tsx`** — text input (`onKeyDown` Enter → `onCode(value)` + clear), a camera toggle that mounts a `<video>` and calls `startCamera`, and a hidden file input wired to `decodeImageFile` → `onCode`. Use `useDashboard().pushToast` for decode errors. Mirror `DocPicker` for the hidden-input pattern.

- [ ] **Step 4: Lint + build.**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 0 errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml frontend/src/hooks/useBarcodeScanner.ts frontend/src/components/dashboard/goods-management/ScannerInput.tsx
git commit -m "feat(goods-mgmt): add @zxing/browser + barcode scanner hook/input (hardware, camera, photo upload)"
```

### Task 16: Types + service wrapper

**Files:**
- Create: `frontend/src/types/goodsManagement.ts`
- Create: `frontend/src/services/goodsManagement.service.ts`

**Interfaces — Produces (mirror `job.service.ts`):** `scanLookup(jobId, direction, code)`, `getQueue()`, `getJobGoods(jobId)`, `postIssue(jobId, lines)`, `postReturn(jobId, lines)`, `closeReconcile(jobId, writeOffLost?)`, `listDamaged(params)`, `listOverdue(days?)`; engineer additions in `engineer.service.ts`: `startOwnJob(id)`, `completeOwnJob(id, { workSummary, usedLines })`, `getOwnCustomerStock()`.

- [ ] **Step 1: Write the types** matching the backend public shapes (`ScanMatch`, `QueueRow`, `PublicMovement`, `DamagedRow`, `OverdueRow`, `CustomerHolding`). No price/cost fields on customer/damaged types.

- [ ] **Step 2: Write the service** calling `api()` (POST for scan-lookup/issue/return/close; GET for queue/job/damaged/overdue). Add the engineer-service functions.

- [ ] **Step 3: Lint + build → 0 errors. Commit.**

```bash
git commit -am "feat(goods-mgmt): frontend types + service wrappers"
```

### Task 17: Warehouse "Goods Management" tab — queue + scan panel

**Files:**
- Modify: `frontend/src/components/dashboard/warehouses/WarehouseDetail.tsx`
- Create: `frontend/src/components/dashboard/goods-management/GoodsManagementTab.tsx`
- Create: `frontend/src/components/dashboard/goods-management/JobScanPanel.tsx`

- [ ] **Step 1: Add the tab.** In `WarehouseDetail.tsx`, extend `type Tab` with `"goods"`, add to `TABS` after `inventory`: `{ key: "goods", label: "Goods Management", perms: ["goods_management.view"] }`, and add the body dispatch `{tab === "goods" && <GoodsManagementTab warehouseId={w.id} warehouseCode={w.code} router={router} />}`.

- [ ] **Step 2: Build `GoodsManagementTab.tsx`** — load `getQueue()` filtered to this warehouse; render a table (job no., engineer, goods status, per-line **planned / issued / available** with shortfalls in `var(--neg)`); clicking a row opens `JobScanPanel` for that job.

- [ ] **Step 3: Build `JobScanPanel.tsx`** — a **Goods In / Goods Out toggle** (return/issue), a `<ScannerInput onCode>` that calls `scanLookup(jobId, direction, code)` and appends the match to a running list (scan once → editable qty input, capped at `remainingIssuable` for issue / held for return), per-line **good/damaged** selector on returns (damaged ⇒ require a photo via the upload→`/goods-management` attachment endpoint or the existing data-URI→backend pattern, + reason), a **Post** button (`postIssue`/`postReturn`), and a **Close & reconcile** button (`closeReconcile`) that surfaces any `unaccounted` list with a "write off as lost" confirm.

- [ ] **Step 4: Lint + build → 0 errors. Commit.**

```bash
git commit -am "feat(goods-mgmt): warehouse Goods Management tab — queue + scan panel (issue/return/reconcile)"
```

### Task 18: Engineer portal — Start/Complete + customer holdings

**Files:**
- Modify: `frontend/src/components/dashboard/engineer/EngineerJobDetail.tsx`, `frontend/src/components/dashboard/engineer/EngineerInventory.tsx`

- [ ] **Step 1: Add Start/Complete to `EngineerJobDetail.tsx`** (mirror the accept/reject handlers): a **Start work** button when `job.status === "accepted"` → `startOwnJob(id)`; a **Complete work** button when `job.status === "in_progress"` → opens a form listing the engineer's held items for this job with a **used qty** input each + a **work summary** textarea → `completeOwnJob(id, { workSummary, usedLines })`. Replace local state with the server's returned job.

- [ ] **Step 2: Show customer holdings in `EngineerInventory.tsx`** — call `getOwnCustomerStock()` and render a second section ("Customer stock you're holding") with item/qty/customer (no pricing).

- [ ] **Step 3: Lint + build → 0 errors. Commit.**

```bash
git commit -am "feat(goods-mgmt): engineer portal start/complete + customer holdings view"
```

### Task 19: Damaged pool toggle + customer-record damaged section

**Files:**
- Modify: `frontend/src/components/dashboard/warehouses/WarehouseDetail.tsx` (the `StockTab` pool pills)
- Modify: `frontend/src/components/dashboard/customers/CustomerDetail.tsx`
- Create: `frontend/src/components/dashboard/goods-management/DamagedStockView.tsx`
- Create: `frontend/src/components/dashboard/goods-management/OverdueHoldingsView.tsx`

- [ ] **Step 1: Add the "Damaged" pill** to `StockTab` (third option after Company (IRM) / Customer), gated by `inventory.view`; when active render `<DamagedStockView warehouseId={...} />` (`listDamaged({ warehouseId })` → item, owner, qty, reason, photo thumbnail; no pricing).

- [ ] **Step 2: Add a "Damaged stock" section** to `CustomerDetail.tsx` rendering `<DamagedStockView customerId={...} />` (`listDamaged({ customerId })`; no pricing).

- [ ] **Step 3: Add `OverdueHoldingsView`** surfaced inside `GoodsManagementTab` (a tab/section): `listOverdue(14)` → rows with a **Write off (lost)** button → `closeReconcile(jobId, true)`.

- [ ] **Step 4: Lint + build → 0 errors. Commit.**

```bash
git commit -am "feat(goods-mgmt): damaged pool toggle, customer-record damaged section, overdue holdings + write-off"
```

---

## PHASE 7 — Realtime + final verification

### Task 20: Realtime emits + final full verification

**Files:**
- Modify: `backend/src/modules/goods-management/goods-management.service.ts` (emit on issue/return/reconcile)
- Modify: relevant frontend views to refetch on the new socket events (reuse `useJobSocket` pattern)

- [ ] **Step 1: Emit events** from the service after each commit: `emitToUser(engineerId, "goods:issued"|"goods:returned", payload)` and `emitToRoom(OFFICE_JOBS_ROOM, "goods:updated", payload)` (import `emitToUser`, `emitToRoom`, `OFFICE_JOBS_ROOM` from `../../lib/realtime.js`).

- [ ] **Step 2: Subscribe on the frontend** — in `GoodsManagementTab` and the engineer "My stock" view, listen for `goods:*` events (extend the existing `useJobSocket` event list or add a small `useGoodsSocket`) and refetch.

- [ ] **Step 3: Full backend verification.**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`
Expected: 0 / 0 / all tests pass.

- [ ] **Step 4: Full frontend verification.**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 0 errors; build succeeds (all pages).

- [ ] **Step 5: Manual smoke (dev).** Start backend + frontend; as a WM: warehouse → Goods Management → pick an accepted job → Goods Out → scan (or type) an IRM code → qty → Post → confirm warehouse inventory dropped + engineer holding rose. As the engineer: Start work → Complete work (declare used + summary). As the WM: Goods In → scan return (1 good, 1 damaged + photo) → Post → Close & reconcile → confirm warehouse credited, damaged pool shows the damaged unit, customer record shows damaged customer stock, balances reconcile.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(goods-mgmt): realtime emits + live refresh; final verification green"
```

---

## Self-Review (completed against the spec)

- **Spec coverage:** scan-driven issue (Task 8, 17), customer + IRM holdings (Task 8, 10, 12), Start/Complete with declared usage (Task 10, 18), return good/damaged + photo (Task 12, 17), damaged pool both owner types + write-off (Task 1, 12, 14, 19), Close & reconcile + unaccounted/lost (Task 13), scan once + enter qty (Task 8 validation + Task 17 UI), three scan inputs (Task 15), planned-vs-available (Task 9, 17), overdue view + write-off (Task 14, 19), damaged on customer record (Task 14, 19), permissions + warehouse scoping (Task 2, 3, throughout), no pricing to customers (Task 9, 14, 16 types), realtime (Task 20). ✔ all spec sections map to a task.
- **Type consistency:** movement `direction` = `issue|return|consume`; line `source` = `irm|customer`; `condition` = `good|damaged`; goods status = `not_issued|partially_issued|issued|awaiting_return|reconciled`; engineer-ledger `type` strings = `job_issue|job_return|job_consume|job_lost`; code prefix `GM`. These names are used identically across Tasks 1, 4, 5, 8, 10, 12, 13.
- **Dependency direction:** `job.service` → `goods-management.service` (one-way); `goods-management.service` takes the loaded job as a param and never imports `job.service` (Task 10 note) — avoids a cycle.
- **Reused primitives:** IRM warehouse moves via `inventoryService.applyOutbound/applyInbound`; IRM engineer balance via `goodsOutRepo.upsertEngineerBalanceTx/insertEngineerTxnTx`; transaction via `withTransaction`; codes via the `Counter` loop — all verbatim-matched to existing signatures.
- **Known follow-ups (not v1):** serial/batch issue, pack conversion, damaged recover/dispose, engineer confirm-received, cross-warehouse returns — explicitly deferred per spec §2.
