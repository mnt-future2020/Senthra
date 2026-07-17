# VSR Per-Line Warehouse Sourcing & Split Fulfilment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a warehouse manager source each restock line from a different warehouse at approval, and let each source warehouse fulfil only its own lines, so a request whose items are spread across warehouses can be completed without dead-ending at the scan.

**Architecture:** Promote the fulfilment warehouse from the request to the **line** (`sourceWarehouseId`), decided at approval (defaulting to the request's primary `warehouseId`). Queue ownership, scan-lookup, fulfil, and close-short all move from request-level to line-level. The request is `fulfilled` only when every line across every warehouse is issued, excluded (`approvedQty 0`), or closed-short. Approve is hard-blocked (UI + authoritative backend re-check) so an approved restock is fully sourced. Reviewer reads gain server-computed `progress`, `myProgress`, and per-line `isMine`.

**Tech Stack:** Backend — Express 5 + Prisma (MongoDB), TypeScript ESM (NodeNext, `.js` import extensions, `#modules/*` alias), Vitest. Frontend — Next.js 16 App Router, React 19, Tailwind v4, axios via `@/lib/api`.

**Spec:** [docs/superpowers/specs/2026-07-14-vsr-per-line-sourcing-design.md](../specs/2026-07-14-vsr-per-line-sourcing-design.md)

## Global Constraints

- **Layering:** `route → middleware → controller → service → repository → Prisma`. Prisma is touched **only** in `*.repository.ts`. Controllers hold no logic; services return data or `throw` an `HttpError` (`badRequest`/`conflict`/`forbidden`/`notFound` from `../../utils/http-error.js`).
- **ESM/NodeNext:** every relative import ends in `.js` (even from `.ts` source). Cross-module imports use `#modules/<domain>/...`; same-module stay `./x.js`; shared dirs stay `../../lib/x.js`.
- **After any `schema.prisma` change:** run `pnpm prisma:generate` before typecheck.
- **Backend verify (no server test runner beyond Vitest units):** `pnpm test` (Vitest), `pnpm typecheck`, `pnpm lint`. Frontend verify: `pnpm typecheck` (in `frontend/`), `pnpm lint`.
- **Scope guard:** per-line sourcing is **restock-only**. Returns & walk-in keep `sourceWarehouseId = req.warehouseId` on every line; no per-line UI for them.
- **`isMine`/`progress` are rendering conveniences — never authority.** `scanLookup`/`fulfil` re-check access independently.
- **Money/pricing:** none of this surfaces cost/value — quantities only (consistent with the module).
- **Commit style:** conventional commits; end the commit body with the `Co-Authored-By` trailer this repo uses. Do **not** push or open PRs (owner tests first).

---

## File Structure

**Backend (`backend/`):**
- `prisma/schema.prisma` — add per-line source + close-short fields to `VanStockRequestLine` (Task 1).
- `src/modules/van-stock-request/van-stock-request.validation.ts` — extend `approveVanStockRequestSchema.lineApprovals` (Task 2).
- `src/modules/van-stock-request/van-stock-request.repository.ts` — line-level `belongsToWarehouses`, per-line approval persistence, per-line-source posting, `closeShortLines` (Tasks 3, 5, 7, 9).
- `src/modules/van-stock-request/van-stock-request.service.ts` — DTO `sourceWarehouse*`/`isMine`/`progress`/`myProgress`, approve availability re-check + per-line source, per-entry fulfil warehouse, per-warehouse close-short (Tasks 4, 6, 8, 9).
- `src/modules/van-stock-request/van-stock-request.routes.ts` — widen `/availability` to reviewers (Task 10).
- Tests: `van-stock-request.validation.test.ts`, `van-stock-request.service.test.ts` (throughout).

**Frontend (`frontend/`):**
- `src/services/vanStockRequest.service.ts` — extend types + `approveVanStockRequest` payload (Task 11).
- `src/components/dashboard/van-requests/VanRequestDetail.tsx` — per-line source picker + hard-block gate (review), `isMine`-scoped fulfil zone, per-warehouse close-short, `myProgress` banner (Tasks 12, 13, 14).

---

### Task 1: Schema — per-line source & close-short fields

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `VanStockRequestLine`)

**Interfaces:**
- Produces: `VanStockRequestLine.sourceWarehouseId/sourceWarehouseName/sourceWarehouseCode` (`String?`), `closedShortQty` (`Int?`), `closedShortBy/closedShortNote` (`String?`), `closedShortAt` (`DateTime?`), and `@@index([sourceWarehouseId])`.

- [ ] **Step 1: Add the fields to `VanStockRequestLine`**

In `backend/prisma/schema.prisma`, find `model VanStockRequestLine { … }`. Immediately after the `fulfilledQty Int @default(0) …` line, add:

```prisma
  // Per-line source (restock): the warehouse that ISSUES this line. Set on approve; defaults to the
  // request's warehouseId. Returns/walk-in: = req.warehouseId for every line (no split).
  sourceWarehouseId   String? @db.ObjectId
  sourceWarehouseName String?
  sourceWarehouseCode String?

  // Per-warehouse close-short: the source warehouse that owns this line writes off its outstanding qty.
  closedShortQty  Int?
  closedShortBy   String?
  closedShortNote String?
  closedShortAt   DateTime?
```

Then add to the same model's index block (next to `@@index([requestId])` and `@@index([irmItemId])`):

```prisma
  @@index([sourceWarehouseId])
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `cd backend && pnpm prisma:generate`
Expected: "Generated Prisma Client" with no errors. (MongoDB has no migration step — the client regen is the whole change.)

- [ ] **Step 3: Typecheck (nothing consumes the fields yet — just confirm the model compiles)**

Run: `cd backend && pnpm typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma
git commit -m "feat(vsr): add per-line source & close-short fields to VanStockRequestLine"
```

---

### Task 2: Validation — per-line source + `approvedQty 0`

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.validation.ts:54-59` (`approveVanStockRequestSchema`)
- Test: `backend/src/modules/van-stock-request/van-stock-request.validation.test.ts`

**Interfaces:**
- Consumes: `objectId` regex (already defined at top of the validation file).
- Produces: `approveVanStockRequestSchema` whose `lineApprovals[]` items are `{ lineId: string; approvedQty: number(min 0); sourceWarehouseId?: string }`. `ApproveVanStockRequestInput` type updates automatically via `z.infer`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/van-stock-request/van-stock-request.validation.test.ts`, add inside the existing `describe` for approve (near the other `approveVanStockRequestSchema` tests around line 50):

```ts
  it("accepts approvedQty 0 (exclude a line)", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 0 }] }).success).toBe(true);
  });
  it("rejects a negative approvedQty", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: -1 }] }).success).toBe(false);
  });
  it("accepts an optional per-line sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: oid }] }).success).toBe(true);
  });
  it("rejects a malformed sourceWarehouseId", () => {
    expect(approveVanStockRequestSchema.safeParse({ warehouseId: oid, lineApprovals: [{ lineId: oid, approvedQty: 2, sourceWarehouseId: "nope" }] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && pnpm test -- van-stock-request.validation`
Expected: the four new tests FAIL (min is currently 1; `sourceWarehouseId` unknown key is stripped so "malformed" passes today).

- [ ] **Step 3: Extend the schema**

In `van-stock-request.validation.ts`, replace the `lineApprovals` line inside `approveVanStockRequestSchema` (currently `lineApprovals: z.array(z.object({ lineId: objectId, approvedQty: z.number().int().min(1).max(1_000_000) })).max(100).optional(),`) with:

```ts
  lineApprovals: z
    .array(
      z.object({
        lineId: objectId,
        approvedQty: z.number().int().min(0).max(1_000_000), // 0 = exclude the line
        sourceWarehouseId: objectId.optional(), // omitted ⇒ primary warehouseId
      }),
    )
    .max(100)
    .optional(),
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && pnpm test -- van-stock-request.validation`
Expected: PASS (all, including the four new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.validation.ts backend/src/modules/van-stock-request/van-stock-request.validation.test.ts
git commit -m "feat(vsr): approve validation accepts per-line source & approvedQty 0"
```

---

### Task 3: Repository — line-level queue ownership

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.repository.ts:138-140` (`belongsToWarehouses`)
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts` (a pure unit on the where-builder is awkward; instead assert the shape — see Step 1)

**Interfaces:**
- Consumes: nothing new.
- Produces: `belongsToWarehouses(ids)` now also matches `approved`/`partially_fulfilled` restocks that have any line sourced to `ids`.

- [ ] **Step 1: Write the failing test**

`belongsToWarehouses` is a non-exported helper returning a Prisma `where`. Export it for testing and assert its structure. In `van-stock-request.service.test.ts`, add a new `describe`:

```ts
import { belongsToWarehouses } from "./van-stock-request.repository.js";

describe("belongsToWarehouses (line-level ownership)", () => {
  it("matches by request warehouseId, pending preferredWarehouseId, OR any line source", () => {
    const w = belongsToWarehouses(["W1"]);
    const json = JSON.stringify(w);
    expect(json).toContain("warehouseId"); // final-warehouse arm (returns/walk-in)
    expect(json).toContain("preferredWarehouseId"); // pending routing arm
    expect(json).toContain("sourceWarehouseId"); // NEW per-line arm
    expect(json).toContain("some"); // line-level relation filter
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: FAIL — `belongsToWarehouses` is not exported / output has no `sourceWarehouseId`/`some`.

- [ ] **Step 3: Implement the line-level arm**

In `van-stock-request.repository.ts`, replace the `belongsToWarehouses` function (lines ~138-140) with (note the added `export`):

```ts
// A request "belongs to" warehouse X when: (returns/walk-in) its final warehouseId is X; (pending
// restock) the engineer's collection warehouse is X; (approved/partial restock) ANY line is sourced
// to X. The last arm makes a split request appear in every involved warehouse's queue.
export function belongsToWarehouses(ids: string[]): Prisma.VanStockRequestWhereInput {
  return {
    OR: [
      { warehouseId: { in: ids } },
      { AND: [{ status: "pending" }, { preferredWarehouseId: { in: ids } }] },
      { lines: { some: { sourceWarehouseId: { in: ids } } } },
    ],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.repository.ts backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "feat(vsr): queue ownership includes any line's source warehouse"
```

---

### Task 4: DTO — expose `sourceWarehouse*`, `isMine`, `progress`, `myProgress`

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — `PublicVanStockLine` (L51-61), `PublicVanStockRequest` (L83-118), `toPublic` (L132-195), and the read callers `getOne`/`listAll`/`paged` (L495-528).
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts`

**Interfaces:**
- Consumes: `warehouseScopeFilter(actor): string[] | undefined` from `../../lib/warehouse-access.js` (undefined ⇒ admin/unrestricted — treat as "all mine").
- Produces:
  - `PublicVanStockLine` gains `sourceWarehouseId/Name/Code: string | null` and `isMine: boolean`.
  - `PublicVanStockRequest` gains `progress: { lines; linesDone; qty; qtyFulfilled }` and `myProgress: { warehouseIds: string[]; lines; linesDone; qty; qtyFulfilled; allMineDone } | null`.
  - `toPublic(r, now?, scope?)` — new optional `scope?: string[] | undefined` param (the actor's accessible warehouse ids; `undefined` = unrestricted = everything is mine; omitted entirely = engineer read = `myProgress` null and `isMine` false).
  - Exported pure helper `computeProgress(lines, scope)` for direct unit testing.

- [ ] **Step 1: Write the failing test**

In `van-stock-request.service.test.ts`, add:

```ts
import { computeProgress } from "./van-stock-request.service.js";

describe("computeProgress", () => {
  const line = (over = {}) => ({ approvedQty: 2, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W1", ...over });

  it("overall: counts non-excluded lines and their fulfil state", () => {
    const p = computeProgress([line({ fulfilledQty: 2 }), line({ approvedQty: 0 })], undefined);
    expect(p.progress.lines).toBe(1);        // excluded (approvedQty 0) not counted
    expect(p.progress.linesDone).toBe(1);    // the fulfilled one
    expect(p.progress.qty).toBe(2);
    expect(p.progress.qtyFulfilled).toBe(2);
  });

  it("myProgress: only lines whose source is in scope; allMineDone true when my lines complete", () => {
    const lines = [line({ sourceWarehouseId: "W1", fulfilledQty: 2 }), line({ sourceWarehouseId: "W2", fulfilledQty: 0 })];
    const p = computeProgress(lines, ["W1"]);
    expect(p.myProgress).not.toBeNull();
    expect(p.myProgress!.lines).toBe(1);
    expect(p.myProgress!.linesDone).toBe(1);
    expect(p.myProgress!.allMineDone).toBe(true); // my only line (W1) is done, even though W2 isn't
    expect(p.myProgress!.warehouseIds).toEqual(["W1"]);
  });

  it("closed-short line counts as done", () => {
    const p = computeProgress([line({ fulfilledQty: 0, closedShortQty: 2 })], ["W1"]);
    expect(p.progress.linesDone).toBe(1);
    expect(p.myProgress!.allMineDone).toBe(true);
  });

  it("engineer read (scope omitted → undefined-as-engineer): myProgress null", () => {
    const p = computeProgress([line()], null); // null sentinel = engineer, no warehouse role
    expect(p.myProgress).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: FAIL — `computeProgress` not exported.

- [ ] **Step 3: Implement `computeProgress` + wire `toPublic`**

In `van-stock-request.service.ts`:

(a) Add the two DTO field groups. In `PublicVanStockLine` (after `remainingQty`):

```ts
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  isMine: boolean;
```

In `PublicVanStockRequest` (after `stale: boolean;`):

```ts
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: { warehouseIds: string[]; lines: number; linesDone: number; qty: number; qtyFulfilled: number; allMineDone: boolean } | null;
```

(b) Add the pure helper (place it just above `toPublic`). The `scope` param has three modes: `undefined` = unrestricted reviewer (everything is mine); a `string[]` = that reviewer's warehouse ids; `null` = engineer read (nothing is mine, `myProgress` null).

```ts
type LineForProgress = { approvedQty: number | null; fulfilledQty: number; closedShortQty: number | null; sourceWarehouseId: string | null };

function lineIsDone(l: LineForProgress): boolean {
  const approved = l.approvedQty ?? 0;
  if (approved === 0) return true; // excluded
  return l.fulfilledQty + (l.closedShortQty ?? 0) >= approved;
}
function lineIsExcluded(l: LineForProgress): boolean {
  return (l.approvedQty ?? 0) === 0 && l.approvedQty !== null; // approved==0 explicitly (not "not yet approved")
}
function lineIsMine(l: LineForProgress, scope: string[] | undefined | null): boolean {
  if (scope === null) return false;       // engineer read
  if (scope === undefined) return true;   // unrestricted reviewer (admin)
  return l.sourceWarehouseId !== null && scope.includes(l.sourceWarehouseId);
}

export function computeProgress(lines: LineForProgress[], scope: string[] | undefined | null) {
  const counted = lines.filter((l) => !lineIsExcluded(l)); // exclude approvedQty===0 from overall counts
  const progress = counted.reduce(
    (acc, l) => ({ lines: acc.lines + 1, linesDone: acc.linesDone + (lineIsDone(l) ? 1 : 0), qty: acc.qty + (l.approvedQty ?? 0), qtyFulfilled: acc.qtyFulfilled + l.fulfilledQty }),
    { lines: 0, linesDone: 0, qty: 0, qtyFulfilled: 0 },
  );
  if (scope === null) return { progress, myProgress: null };
  const mine = counted.filter((l) => lineIsMine(l, scope));
  const warehouseIds = [...new Set(mine.map((l) => l.sourceWarehouseId).filter((x): x is string => x !== null))];
  const myAgg = mine.reduce(
    (acc, l) => ({ lines: acc.lines + 1, linesDone: acc.linesDone + (lineIsDone(l) ? 1 : 0), qty: acc.qty + (l.approvedQty ?? 0), qtyFulfilled: acc.qtyFulfilled + l.fulfilledQty }),
    { lines: 0, linesDone: 0, qty: 0, qtyFulfilled: 0 },
  );
  return { progress, myProgress: { warehouseIds, ...myAgg, allMineDone: mine.length > 0 && mine.every(lineIsDone) } };
}
```

(c) Change `toPublic`'s signature and body. Replace `function toPublic(r: RequestWithLines, now = new Date()): PublicVanStockRequest {` with:

```ts
function toPublic(r: RequestWithLines, now = new Date(), scope: string[] | undefined | null = null): PublicVanStockRequest {
```

Inside `toPublic`, in the `lines: r.lines.map((l) => ({ … }))` block, add after `remainingQty: …,`:

```ts
      sourceWarehouseId: l.sourceWarehouseId,
      sourceWarehouseName: l.sourceWarehouseName,
      sourceWarehouseCode: l.sourceWarehouseCode,
      isMine: lineIsMine(l, scope),
```

And just before `return {` at the top of `toPublic`, compute:

```ts
  const prog = computeProgress(r.lines, scope);
```

Then add to the returned object (next to `stale: isStale(r, now),`):

```ts
    progress: prog.progress,
    myProgress: prog.myProgress,
```

(d) Thread scope through the reviewer reads. In `getOne` (ends `return toPublic(req);`), change to:

```ts
  return toPublic(req, new Date(), warehouseScopeFilter(actor));
```

In `paged` (used by `listAll` and `listMine`), it currently maps `toPublic(r, now)`. Split so `listAll` passes scope but `listMine` (engineer) passes `null`. Change `paged` signature to accept scope and forward it:

```ts
function paged(result: { requests: RequestWithLines[]; total: number }, page: number, pageSize: number, scope: string[] | undefined | null = null): PagedVanStockRequests {
  const now = new Date();
  return { requests: result.requests.map((r) => toPublic(r, now, scope)), total: result.total, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) };
}
```

In `listAll`, change the final `return paged(await vsrRepo.listRequests({ … }), page, pageSize);` to pass scope:

```ts
  return paged(await vsrRepo.listRequests({ ...params, warehouseScope: warehouseScopeFilter(actor), page, pageSize }), page, pageSize, warehouseScopeFilter(actor));
```

`listMine` keeps calling `paged(..., page, pageSize)` (scope defaults to `null` → engineer, `isMine` false, `myProgress` null). Confirm `warehouseScopeFilter` is already imported at the top of the file (it is — used by `listAll`/`countPending`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS (the four `computeProgress` cases).

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.service.ts backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "feat(vsr): DTO exposes per-line source, isMine, progress & myProgress"
```

---

### Task 5: Repository — persist per-line source on approve

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.repository.ts` — `ApprovalPatch` (L194-201) + `claimPendingForApproval` (L205-226)
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts` (structural — see note)

**Interfaces:**
- Consumes: nothing new.
- Produces: `claimPendingForApproval(id, patch, lineApprovals)` where each `lineApprovals[]` item is `{ lineId: string; approvedQty: number; sourceWarehouseId: string | null; sourceWarehouseName: string | null; sourceWarehouseCode: string | null }` and is written to the line.

- [ ] **Step 1: Update the `lineApprovals` type + persistence**

In `van-stock-request.repository.ts`, change the third parameter type of `claimPendingForApproval`. Replace its signature line:

```ts
export async function claimPendingForApproval(id: string, patch: ApprovalPatch, lineApprovals: Array<{ lineId: string; approvedQty: number }>): Promise<RequestWithLines> {
```

with:

```ts
export async function claimPendingForApproval(
  id: string,
  patch: ApprovalPatch,
  lineApprovals: Array<{ lineId: string; approvedQty: number; sourceWarehouseId: string | null; sourceWarehouseName: string | null; sourceWarehouseCode: string | null }>,
): Promise<RequestWithLines> {
```

Inside its transaction, replace the per-line update loop:

```ts
    for (const la of lineApprovals) {
      await tx.vanStockRequestLine.update({ where: { id: la.lineId }, data: { approvedQty: la.approvedQty } });
    }
```

with:

```ts
    for (const la of lineApprovals) {
      await tx.vanStockRequestLine.update({
        where: { id: la.lineId },
        data: {
          approvedQty: la.approvedQty,
          sourceWarehouseId: la.sourceWarehouseId,
          sourceWarehouseName: la.sourceWarehouseName,
          sourceWarehouseCode: la.sourceWarehouseCode,
        },
      });
    }
```

- [ ] **Step 2: Typecheck (service still passes the OLD shape — expect a compile error, which proves the contract changed)**

Run: `cd backend && pnpm typecheck`
Expected: FAIL in `van-stock-request.service.ts` at the `approve` call — `lineApprovals` missing `sourceWarehouse*`. This is expected; Task 6 fixes the service.

- [ ] **Step 3: Commit (WIP — the service task immediately follows)**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.repository.ts
git commit -m "feat(vsr): claimPendingForApproval persists per-line source warehouse"
```

---

### Task 6: Service — approve resolves source, re-checks availability, hard-blocks

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — `approve` (L321-348)
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts`

**Interfaces:**
- Consumes: `warehouseRepo.findById`, `inventoryRepo.findBalancesByItemsAndWarehouses(irmItemIds, warehouseIds): Promise<InventoryBalance[]>` (each has `irmItemId`, `warehouseId`, `quantityOnHand`), `vsrRepo.claimPendingForApproval` (Task 5 shape).
- Produces: `approve` that (1) resolves each line's source (explicit `sourceWarehouseId` or the request's primary `warehouseId`), (2) validates each source warehouse is active, (3) hard-blocks — rejects the whole approval if any included line (`approvedQty > 0`) has live source on-hand `< approvedQty`, (4) persists per-line source, (5) allows `approvedQty 0` (excluded) lines to skip source + availability checks.

- [ ] **Step 1: Write the failing tests**

The `approve` service function calls repositories that hit Prisma, so unit-test the **pure sub-logic** by extracting it. Add an exported helper `resolveLineApprovals` that Task 6 will implement, and test it directly. In `van-stock-request.service.test.ts`:

```ts
import { resolveLineApprovals } from "./van-stock-request.service.js";

describe("resolveLineApprovals (approve sourcing + hard-block)", () => {
  const reqLines = [
    { id: "L1", irmItemId: "I1", itemName: "Cable Ties", requestedQty: 2 },
    { id: "L2", irmItemId: "I2", itemName: "CAT6", requestedQty: 2 },
  ];
  const wh = { id: "PRIMARY", name: "Primary WH", code: "WH-1" };
  const activeWarehouse = async (id: string) => (id === "PRIMARY" ? wh : id === "LONDON" ? { id: "LONDON", name: "London", code: "WH-2" } : null);

  it("defaults each line's source to the primary warehouse", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 5 }];
    const out = await resolveLineApprovals(reqLines, [], wh, activeWarehouse, async () => balances);
    expect(out.every((l) => l.sourceWarehouseId === "PRIMARY")).toBe(true);
    expect(out.map((l) => l.approvedQty)).toEqual([2, 2]);
  });

  it("uses an explicit per-line source when provided", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "LONDON", quantityOnHand: 5 }];
    const out = await resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 2, sourceWarehouseId: "LONDON" }], wh, activeWarehouse, async () => balances);
    expect(out.find((l) => l.lineId === "L2")!.sourceWarehouseId).toBe("LONDON");
  });

  it("hard-blocks: throws when a line's source has less than approvedQty", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 0 }];
    await expect(resolveLineApprovals(reqLines, [], wh, activeWarehouse, async () => balances)).rejects.toThrow(/CAT6/);
  });

  it("excluded line (approvedQty 0) skips source + availability", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }]; // I2 has NO stock anywhere
    const out = await resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 0 }], wh, activeWarehouse, async () => balances);
    const l2 = out.find((l) => l.lineId === "L2")!;
    expect(l2.approvedQty).toBe(0);
    expect(l2.sourceWarehouseId).toBeNull(); // excluded ⇒ no source
  });

  it("rejects an inactive/unknown source warehouse", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 5 }];
    await expect(resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 2, sourceWarehouseId: "GONE" }], wh, activeWarehouse, async () => balances)).rejects.toThrow(/no longer exists|not active|warehouse/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: FAIL — `resolveLineApprovals` not exported.

- [ ] **Step 3: Implement `resolveLineApprovals` and use it in `approve`**

In `van-stock-request.service.ts`, add the exported pure-ish helper (dependency-injected repos so it's unit-testable) above `approve`:

```ts
// Resolve each line's approved qty + source warehouse for approval, enforcing the hard-block
// (every INCLUDED line's source must currently hold ≥ approvedQty). Excluded lines (approvedQty 0)
// carry no source and skip availability. Warehouse lookups + balance reads are injected so this is
// unit-testable without a DB.
export interface ResolvedLineApproval {
  lineId: string;
  approvedQty: number;
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
}
export async function resolveLineApprovals(
  reqLines: Array<{ id: string; irmItemId: string; itemName: string; requestedQty: number }>,
  lineApprovals: Array<{ lineId: string; approvedQty: number; sourceWarehouseId?: string }>,
  primary: { id: string; name: string; code: string | null },
  findWarehouse: (id: string) => Promise<{ id: string; name: string; code: string | null } | null>,
  findBalances: (irmItemIds: string[], warehouseIds: string[]) => Promise<Array<{ irmItemId: string; warehouseId: string; quantityOnHand: number }>>,
): Promise<ResolvedLineApproval[]> {
  const byLine = new Map(lineApprovals.map((a) => [a.lineId, a]));

  // First pass: resolve qty + chosen source id per line, validating trim + active warehouse.
  const resolved = await Promise.all(
    reqLines.map(async (l): Promise<ResolvedLineApproval & { irmItemId: string; itemName: string }> => {
      const a = byLine.get(l.id);
      const approvedQty = a?.approvedQty ?? l.requestedQty;
      if (approvedQty > l.requestedQty) throw badRequest(`"${l.itemName}": approved quantity can't exceed the requested ${l.requestedQty}.`);
      if (approvedQty === 0) {
        return { lineId: l.id, approvedQty: 0, sourceWarehouseId: null, sourceWarehouseName: null, sourceWarehouseCode: null, irmItemId: l.irmItemId, itemName: l.itemName };
      }
      const sourceId = a?.sourceWarehouseId ?? primary.id;
      const sw = sourceId === primary.id ? primary : await findWarehouse(sourceId);
      if (!sw) throw badRequest(`"${l.itemName}": the chosen source warehouse no longer exists.`);
      return { lineId: l.id, approvedQty, sourceWarehouseId: sw.id, sourceWarehouseName: sw.name, sourceWarehouseCode: sw.code, irmItemId: l.irmItemId, itemName: l.itemName };
    }),
  );

  // Second pass: batched availability re-check over the distinct (item, source) pairs of INCLUDED lines.
  const included = resolved.filter((r) => r.approvedQty > 0 && r.sourceWarehouseId);
  const itemIds = [...new Set(included.map((r) => r.irmItemId))];
  const whIds = [...new Set(included.map((r) => r.sourceWarehouseId!))];
  const balances = await findBalances(itemIds, whIds);
  const onHand = new Map(balances.map((b) => [`${b.warehouseId}:${b.irmItemId}`, b.quantityOnHand]));
  for (const r of included) {
    const have = onHand.get(`${r.sourceWarehouseId}:${r.irmItemId}`) ?? 0;
    if (have < r.approvedQty) {
      throw badRequest(`"${r.itemName}": only ${have} in stock at ${r.sourceWarehouseName ?? "the chosen warehouse"} — refresh and adjust.`);
    }
  }

  return resolved.map(({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }) => ({ lineId, approvedQty, sourceWarehouseId, sourceWarehouseName, sourceWarehouseCode }));
}
```

Now rewrite `approve` to use it. Replace the body between the `assertWarehouseAccess(actor, wh.id);` line and the `const updated = await vsrRepo.claimPendingForApproval(` call. Specifically, remove the old trim block:

```ts
  // Per-line trims: default = requestedQty; a trim may only reduce, never grow.
  const trims = new Map((input.lineApprovals ?? []).map((a) => [a.lineId, a.approvedQty]));
  const lineApprovals = req.lines.map((l) => {
    const trimmed = trims.get(l.id) ?? l.requestedQty;
    if (trimmed > l.requestedQty) throw badRequest(`"${l.itemName}": approved quantity can't exceed the requested ${l.requestedQty}.`);
    return { lineId: l.id, approvedQty: trimmed };
  });
```

and replace it with:

```ts
  const lineApprovals = await resolveLineApprovals(
    req.lines,
    input.lineApprovals ?? [],
    { id: wh.id, name: wh.name, code: wh.code ?? null },
    async (id) => {
      const w = await warehouseRepo.findById(id);
      return w && w.status === "active" ? { id: w.id, name: w.name, code: w.code ?? null } : null;
    },
    (itemIds, whIds) => inventoryRepo.findBalancesByItemsAndWarehouses(itemIds, whIds),
  );
```

(`claimPendingForApproval(id, { … }, lineApprovals)` now receives the correct shape from Task 5.)

- [ ] **Step 4: Run to verify tests pass**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS (all `resolveLineApprovals` cases).

- [ ] **Step 5: Typecheck (Task 5's compile error is now resolved)**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.service.ts backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "feat(vsr): approve resolves per-line source & hard-blocks under-stocked lines"
```

---

### Task 7: Repository + Service — fulfil decrements each line's own source warehouse

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — `fulfil` (L445-491) and `scanLookup` (L418-441)
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts`

**Interfaces:**
- Consumes: `RequestWithLines` lines now carry `sourceWarehouseId`. `warehouseScopeFilter(actor)`, `assertWarehouseAccess`.
- Produces: `fulfil` posts each entry against **its line's `sourceWarehouseId`** (not `req.warehouseId`), checking actor access per entry; `scanLookup` matches the scanned item to a line whose source the actor can access and reads that source's shelf.

- [ ] **Step 1: Write the failing test (pure entry→warehouse mapping)**

Extract the per-entry warehouse resolution into a testable helper. In `van-stock-request.service.test.ts`:

```ts
import { resolveFulfilWarehouses } from "./van-stock-request.service.js";

describe("resolveFulfilWarehouses (split fulfil)", () => {
  const lines = [
    { id: "L1", irmItemId: "I1", itemName: "Ties", sourceWarehouseId: "W1" },
    { id: "L2", irmItemId: "I2", itemName: "CAT6", sourceWarehouseId: "W2" },
  ];
  it("maps each entry to its line's source warehouse", () => {
    const out = resolveFulfilWarehouses(lines, [{ lineId: "L1", qty: 1 }, { lineId: "L2", qty: 1 }], undefined);
    expect(out.find((e) => e.lineId === "L1")!.warehouseId).toBe("W1");
    expect(out.find((e) => e.lineId === "L2")!.warehouseId).toBe("W2");
  });
  it("rejects an entry whose line source is outside the actor's scope", () => {
    expect(() => resolveFulfilWarehouses(lines, [{ lineId: "L2", qty: 1 }], ["W1"])).toThrow(/W2|London|access|fulfilled by/i);
  });
  it("rejects an entry whose line has no source (unapproved/excluded)", () => {
    const bad = [{ id: "L3", irmItemId: "I3", itemName: "X", sourceWarehouseId: null }];
    expect(() => resolveFulfilWarehouses(bad, [{ lineId: "L3", qty: 1 }], undefined)).toThrow(/not been sourced|no source|can't be fulfilled/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: FAIL — `resolveFulfilWarehouses` not exported.

- [ ] **Step 3: Implement `resolveFulfilWarehouses` + rewire `fulfil`/`scanLookup`**

In `van-stock-request.service.ts`, add above `fulfil`:

```ts
// Map each fulfil entry to the warehouse that must issue it — its LINE's sourceWarehouseId — and
// enforce that the actor may act for that warehouse. scope: undefined = unrestricted (admin);
// string[] = the actor's warehouse ids. Throws on an entry whose line is unsourced or out of scope.
export function resolveFulfilWarehouses(
  reqLines: Array<{ id: string; irmItemId: string; itemName: string; sourceWarehouseId: string | null }>,
  entries: Array<{ lineId: string; qty: number }>,
  scope: string[] | undefined,
): Array<{ lineId: string; warehouseId: string }> {
  const byLine = new Map(reqLines.map((l) => [l.id, l]));
  return entries.map((e) => {
    const line = byLine.get(e.lineId);
    if (!line) throw badRequest("An entry doesn't belong to this request.");
    if (!line.sourceWarehouseId) throw conflict(`"${line.itemName}" has not been sourced to a warehouse yet — it can't be fulfilled.`);
    if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
      throw forbidden(`"${line.itemName}" is fulfilled by ${line.sourceWarehouseName ?? "another warehouse"} — you don't have access to that warehouse.`);
    }
    return { lineId: e.lineId, warehouseId: line.sourceWarehouseId };
  });
}
```

(Note: `line.sourceWarehouseName` isn't in the param type above; drop it from the message or widen the type. To keep it simple, change the forbidden message to `` `"${line.itemName}" is sourced to another warehouse you don't have access to.` ``.)

Now rewrite `fulfil`. Replace the block that computes `const warehouseId = req.warehouseId;` and the `applyOutbound({ …, warehouseId, … })` calls. The current `fulfil` builds `entries` then calls `postFulfilment` with a closure using one `warehouseId`. Change so each entry knows its own warehouse:

(a) After the existing `if (!req.warehouseId) throw conflict("This request has no fulfilment warehouse yet.");` line — this request-level guard is now wrong for restocks. Replace it with a per-entry resolution using the new helper. Remove:

```ts
  if (!req.warehouseId) throw conflict("This request has no fulfilment warehouse yet.");
  assertWarehouseAccess(actor, req.warehouseId);
```

and replace with:

```ts
  const scope = warehouseScopeFilter(actor);
  const entryWarehouses = new Map(resolveFulfilWarehouses(req.lines, input.entries, scope).map((r) => [r.lineId, r.warehouseId]));
```

(b) In the `entries` mapping (`const entries: FulfilEntry[] = input.entries.map((e) => { … })`), that mapping is fine as-is (it builds line metadata). Keep it.

(c) Remove `const warehouseId = req.warehouseId;`. In the `postFulfilment` apply-closure, replace every use of the single `warehouseId` with the per-entry one. Specifically, inside `for (const e of entries) { if (fresh.type === "restock") { … } }`, change the restock branch's `applyOutbound`:

```ts
        await inventoryService.applyOutbound(tx, { irmItemId: e.irmItemId, warehouseId: entryWarehouses.get(e.lineId)!, quantity: e.qty, sourceType: SOURCE_TYPE, sourceId: fresh.id, sourceCode: fresh.code, createdBy });
```

For the **return** branch (the `else`), returns are single-warehouse — keep using `fresh.warehouseId`. Introduce a local at the top of the closure for clarity:

```ts
      const returnWarehouseId = fresh.warehouseId!; // returns/walk-in single warehouse
```

and in the return branch replace the three `warehouseId` uses (`applyInbound`, the `DamagedKey`, and `insertDamagedTxnTx`) with `returnWarehouseId`.

(d) Rewrite `scanLookup` to resolve the line's source. Replace its availability block:

```ts
  let available: number | null = null;
  if (req.type === "restock" && req.warehouseId) {
    const bal = await inventoryRepo.findBalancePair(item.id, req.warehouseId);
    available = bal?.quantityOnHand ?? 0;
  } else if (req.type === "return") {
    const bal = await engineerStockRepo.findEngineerBalance(item.id, req.engineerId);
    available = bal?.quantityOnHand ?? 0;
  }
  return { irmItemId: item.id, lineId: line.id, itemName: item.name, uom: item.baseUnit ?? null, remainingQty, available };
```

with:

```ts
  let available: number | null = null;
  if (req.type === "restock") {
    if (!line.sourceWarehouseId) throw conflict(`"${item.name}" has not been sourced to a warehouse yet.`);
    const scope = warehouseScopeFilter(actor);
    if (scope !== undefined && !scope.includes(line.sourceWarehouseId)) {
      throw forbidden(`"${item.name}" is sourced to a warehouse you don't have access to.`);
    }
    const bal = await inventoryRepo.findBalancePair(item.id, line.sourceWarehouseId);
    available = bal?.quantityOnHand ?? 0;
  } else if (req.type === "return") {
    const bal = await engineerStockRepo.findEngineerBalance(item.id, req.engineerId);
    available = bal?.quantityOnHand ?? 0;
  }
  return { irmItemId: item.id, lineId: line.id, itemName: item.name, uom: item.baseUnit ?? null, remainingQty, available };
```

Also in `scanLookup`, the early guard `if (req.warehouseId) assertWarehouseAccess(actor, req.warehouseId);` is now too coarse for split restocks (the actor may legitimately own only a re-sourced line, not the primary). Remove that line — access is enforced per-line above and per-entry in `fulfil`.

- [ ] **Step 4: Run to verify tests pass**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS. (If TS complains that `req.lines` items lack `sourceWarehouseName` in the `resolveFulfilWarehouses` message, you already simplified that message in Step 3.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.service.ts backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "feat(vsr): split fulfil & scan-lookup decrement each line's source warehouse"
```

---

### Task 8: Fulfil access guard for the whole posting (defense-in-depth)

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — `fulfil` (the `allowed` status guard region, ~L448-455)
- Test: covered by Task 7's `resolveFulfilWarehouses` scope test; add one guard test.

**Interfaces:**
- Consumes: `resolveFulfilWarehouses` (Task 7).
- Produces: `fulfil` rejects a posting containing any entry outside the actor's scope **before** opening the transaction (already true via Task 7's `resolveFulfilWarehouses` call, which throws). This task just verifies the ordering and that the `req.type === "restock" && damaged` guard still runs.

- [ ] **Step 1: Confirm ordering test**

Add to `van-stock-request.service.test.ts` a note-test asserting `resolveFulfilWarehouses` throws `forbidden` (HttpError status 403) for an out-of-scope entry (already added in Task 7 Step 1 as a `.toThrow`). Extend it to assert the error is a 403:

```ts
  it("out-of-scope entry throws a 403 (forbidden), not a generic error", () => {
    try {
      resolveFulfilWarehouses(lines, [{ lineId: "L2", qty: 1 }], ["W1"]);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect((e as { status?: number }).status).toBe(403);
    }
  });
```

- [ ] **Step 2: Run to verify (should already pass from Task 7's impl)**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS. If it fails because `forbidden()` doesn't set `.status`, check `../../utils/http-error.js` — `forbidden` returns an `HttpError` with `status: 403`; adjust the assertion to match the actual property name (`status`).

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "test(vsr): fulfil rejects out-of-scope entries with 403"
```

---

### Task 9: Per-warehouse close-short

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.repository.ts` — add `closeShortLines`; keep `finishRemaining` for cancel-remaining.
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — `closeShort` (L394-405)
- Test: `backend/src/modules/van-stock-request/van-stock-request.service.test.ts`

**Interfaces:**
- Consumes: `warehouseScopeFilter(actor)`.
- Produces:
  - `vsrRepo.closeShortLines(requestId, warehouseIds: string[] | undefined, note: string, actorEmail: string): Promise<{ affected: number; request: RequestWithLines }>` — stamps `closedShortQty/By/Note/At` on the actor's own outstanding lines, recomputes overall status in the same transaction, returns the fresh request.
  - `closeShort` service scopes the write to the actor's warehouses and flips the request to `fulfilled` only when no line has live remaining qty.

- [ ] **Step 1: Write the failing test (pure "which lines get written off + is the request done" logic)**

Extract the decision into a pure helper. In `van-stock-request.service.test.ts`:

```ts
import { pickCloseShortLines, requestDoneAfter } from "./van-stock-request.service.js";

describe("per-warehouse close-short", () => {
  const lines = [
    { id: "L1", approvedQty: 2, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W1", itemName: "Ties" },
    { id: "L2", approvedQty: 2, fulfilledQty: 2, closedShortQty: null, sourceWarehouseId: "W2", itemName: "CAT6" },
  ];
  it("picks only the actor's own outstanding lines", () => {
    const picked = pickCloseShortLines(lines, ["W1"]);
    expect(picked.map((l) => l.id)).toEqual(["L1"]); // L2 is W2 + already fulfilled
  });
  it("unrestricted actor (admin) picks all outstanding lines", () => {
    const picked = pickCloseShortLines(lines, undefined);
    expect(picked.map((l) => l.id)).toEqual(["L1"]); // L2 already fully fulfilled ⇒ not outstanding
  });
  it("request NOT done while another warehouse's line is still open", () => {
    // After writing off L1 (W1), L2 done, so all done here:
    const after = lines.map((l) => (l.id === "L1" ? { ...l, closedShortQty: 2 } : l));
    expect(requestDoneAfter(after)).toBe(true);
  });
  it("request still open when a non-actor line remains unfulfilled", () => {
    const three = [...lines, { id: "L3", approvedQty: 5, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W3", itemName: "Screws" }];
    const after = three.map((l) => (l.id === "L1" ? { ...l, closedShortQty: 2 } : l));
    expect(requestDoneAfter(after)).toBe(false); // L3 (W3) still open
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers + repo method + service**

In `van-stock-request.service.ts`, add (near `computeProgress`, reusing `lineIsDone`):

```ts
// Lines the acting warehouse may write off: its own source, still outstanding (not done).
export function pickCloseShortLines<T extends LineForProgress & { id: string }>(lines: T[], scope: string[] | undefined): T[] {
  return lines.filter((l) => {
    if (lineIsDone(l)) return false; // already fulfilled/excluded/closed
    if (l.sourceWarehouseId === null) return false;
    return scope === undefined || scope.includes(l.sourceWarehouseId);
  });
}
// The whole request is done once every line is fulfilled / excluded / closed-short.
export function requestDoneAfter(lines: LineForProgress[]): boolean {
  return lines.every(lineIsDone);
}
```

(Ensure `LineForProgress` includes `sourceWarehouseId` — it does from Task 4. The test lines also carry `id`/`itemName`; that's fine, `pickCloseShortLines` is generic over `T`.)

In `van-stock-request.repository.ts`, add:

```ts
export interface CloseShortLinesResult {
  affected: number;
  request: RequestWithLines;
}
// Per-warehouse close-short: write off the given lines' remaining qty, then recompute overall status
// in the SAME transaction. lineIds are pre-filtered by the service to the actor's own outstanding lines.
export async function closeShortLines(requestId: string, lineIds: string[], note: string, actorEmail: string): Promise<CloseShortLinesResult> {
  return withTransaction(async (tx) => {
    const req = await tx.vanStockRequest.findFirst({ where: { id: requestId, deletedAt: null }, include: INCLUDE });
    if (!req) throw notFound("Van stock request not found.");
    if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request can be closed short.");

    let affected = 0;
    for (const id of lineIds) {
      const line = req.lines.find((l) => l.id === id);
      if (!line) continue;
      const remaining = (line.approvedQty ?? line.requestedQty) - line.fulfilledQty - (line.closedShortQty ?? 0);
      if (remaining <= 0) continue;
      await tx.vanStockRequestLine.update({
        where: { id },
        data: { closedShortQty: (line.closedShortQty ?? 0) + remaining, closedShortBy: actorEmail, closedShortNote: note, closedShortAt: new Date() },
      });
      affected++;
    }

    // Recompute overall status from post-write lines.
    const fresh = await tx.vanStockRequestLine.findMany({ where: { requestId } });
    const done = fresh.every((l) => {
      const approved = l.approvedQty ?? l.requestedQty;
      if ((l.approvedQty ?? 0) === 0 && l.approvedQty !== null) return true; // excluded
      return l.fulfilledQty + (l.closedShortQty ?? 0) >= approved;
    });
    await tx.vanStockRequest.update({
      where: { id: requestId },
      data: done ? { status: "fulfilled", completionType: "closed_short", closedShortBy: actorEmail, closedShortAt: new Date(), closeShortNote: note } : {},
    });
    const request = await tx.vanStockRequest.findUniqueOrThrow({ where: { id: requestId }, include: INCLUDE });
    return { affected, request };
  });
}
```

In `van-stock-request.service.ts`, rewrite `closeShort`:

```ts
export async function closeShort(id: string, input: CloseShortInput, actor: AuditActor): Promise<PublicVanStockRequest> {
  const req = await vsrRepo.findById(id);
  if (!req) throw notFound("Van stock request not found.");
  if (req.status !== "partially_fulfilled") throw conflict("Only a partially fulfilled request can be closed short.");
  const scope = warehouseScopeFilter(actor);
  const targets = pickCloseShortLines(req.lines, scope);
  if (targets.length === 0) throw conflict("You have no outstanding lines to close short on this request.");

  const { request: updated } = await vsrRepo.closeShortLines(id, targets.map((l) => l.id), input.note, actor.email ?? "");
  audit.record({ actor, action: "van_stock_request.closed_short", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { note: input.note, lineIds: targets.map((l) => l.id), warehouseIds: [...new Set(targets.map((l) => l.sourceWarehouseId))] } });
  emitUpdate(req.engineerId, { id, code: req.code, status: updated.status, type: req.type });
  return toPublic(updated, new Date(), scope);
}
```

- [ ] **Step 4: Run to verify tests pass**

Run: `cd backend && pnpm test -- van-stock-request.service`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS. (`finishRemaining` is still used by `cancelRemaining` — leave it; only close-short migrated.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.repository.ts backend/src/modules/van-stock-request/van-stock-request.service.ts backend/src/modules/van-stock-request/van-stock-request.service.test.ts
git commit -m "feat(vsr): per-warehouse close-short writes off only owned lines"
```

---

### Task 10: Route — widen `/availability` to reviewers + backend full check

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.routes.ts:35`
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` — audit metadata on approve/fulfil (L345, L488)

**Interfaces:**
- Produces: `GET /availability` reachable with either `engineer.van_stock.request` or `van_stock_request.review`. Approve/fulfil audit metadata carries per-line source.

- [ ] **Step 1: Widen the availability route**

In `van-stock-request.routes.ts`, change:

```ts
router.get("/availability", requirePermission(ENGINEER), ctrl.availability);
```

to:

```ts
router.get("/availability", requireAnyPermission(ENGINEER, REVIEW), ctrl.availability);
```

(`requireAnyPermission` is already imported — used by `/item-search`.)

- [ ] **Step 2: Enrich approve audit metadata**

In `van-stock-request.service.ts` `approve`, the audit call currently logs `trims: input.lineApprovals ?? []`. Replace that metadata with the resolved sourcing (so the decision is auditable):

```ts
  audit.record({ actor, action: "van_stock_request.approved", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { warehouseId: wh.id, lineApprovals: lineApprovals.map((l) => ({ lineId: l.lineId, approvedQty: l.approvedQty, sourceWarehouseId: l.sourceWarehouseId })) } });
```

- [ ] **Step 3: Enrich fulfilment audit metadata**

In `fulfil`, the audit `metadata.entries` maps `{ item, qty, condition }`. Add the source warehouse per entry by looking it up from `entryWarehouses`:

```ts
  audit.record({ actor, action: "van_stock_request.fulfilment_posted", targetType: "van_stock_request", targetId: id, targetLabel: req.code, metadata: { entries: entries.map((e) => ({ item: e.itemName, qty: e.qty, condition: e.condition, sourceWarehouseId: entryWarehouses.get(e.lineId) ?? null })) } });
```

- [ ] **Step 4: Typecheck + full backend test**

Run: `cd backend && pnpm typecheck && pnpm test && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/van-stock-request/van-stock-request.routes.ts backend/src/modules/van-stock-request/van-stock-request.service.ts
git commit -m "feat(vsr): reviewers can read availability; audit logs per-line source"
```

---

### Task 11: Frontend service — types + approve payload

**Files:**
- Modify: `frontend/src/services/vanStockRequest.service.ts` — `VanStockLine` (L10-20), `VanStockRequest` (L42-77), `approveVanStockRequest` (L229-231)

**Interfaces:**
- Produces: `VanStockLine` gains `sourceWarehouseId/Name/Code: string | null` and `isMine: boolean`; `VanStockRequest` gains `progress` and `myProgress`; `approveVanStockRequest` payload's `lineApprovals[]` gains `sourceWarehouseId?: string` and allows `approvedQty` 0.

- [ ] **Step 1: Extend `VanStockLine`**

Add after `remainingQty: number;`:

```ts
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  isMine: boolean;
```

- [ ] **Step 2: Extend `VanStockRequest`**

Add after `stale: boolean;`:

```ts
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: { warehouseIds: string[]; lines: number; linesDone: number; qty: number; qtyFulfilled: number; allMineDone: boolean } | null;
```

- [ ] **Step 3: Extend the approve payload type**

Replace `approveVanStockRequest`'s signature:

```ts
export function approveVanStockRequest(id: string, payload: { warehouseId: string; lineApprovals?: Array<{ lineId: string; approvedQty: number }>; decisionNote?: string }): Promise<VanStockRequest> {
```

with:

```ts
export function approveVanStockRequest(
  id: string,
  payload: { warehouseId: string; lineApprovals?: Array<{ lineId: string; approvedQty: number; sourceWarehouseId?: string }>; decisionNote?: string },
): Promise<VanStockRequest> {
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: FAIL only inside `VanRequestDetail.tsx` (it builds `lineApprovals` without the new field / doesn't read new fields yet) — that's fixed in Tasks 12-14. If it fails elsewhere, investigate. The service file itself must compile.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/vanStockRequest.service.ts
git commit -m "feat(vsr): frontend types for per-line source, isMine & progress"
```

---

### Task 12: Frontend — per-line source picker + hard-block gate (review zone)

**Files:**
- Modify: `frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx` — review-zone state (L34-40), `onApprove` (L92-110), the lines table (L266-306), the review zone (L308-340)

**Interfaces:**
- Consumes: `getVanStockAvailability(irmItemIds)` from the service (already imported? — it is exported from the same service; add the import), `VanStockLine.sourceWarehouse*`.
- Produces: a review UI where each line has an approve-qty input + a source-warehouse `<Select>` with shelf counts, the Approve button disabled unless every line is `approvedQty 0` or `sourceShelf ≥ approvedQty`, and `onApprove` sends `{ approvedQty, sourceWarehouseId }` per changed line.

- [ ] **Step 1: Add availability + per-line source state**

At the top of `VanRequestDetail`, near the other review state, add:

```tsx
  const [sources, setSources] = React.useState<Record<string, string>>({}); // lineId → sourceWarehouseId
  const [availability, setAvailability] = React.useState<import("@/services/vanStockRequest.service").WarehouseAvailability[]>([]);
```

Add the import at the top of the file:

```tsx
import { getVanStockAvailability } from "@/services/vanStockRequest.service";
```

- [ ] **Step 2: Load availability for the request's items when entering the review zone**

Add an effect after the existing `load` effect:

```tsx
  React.useEffect(() => {
    if (!req || req.status !== "pending" || req.type !== "restock") return;
    const ids = req.lines.map((l) => l.irmItemId);
    getVanStockAvailability(ids).then(setAvailability).catch(() => setAvailability([]));
    // Default each line's source to the primary (the review warehouse select).
    setSources(Object.fromEntries(req.lines.map((l) => [l.id, warehouseId || req.preferredWarehouseId || ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
```

Add a helper (inside the component) to read a warehouse's shelf for an item:

```tsx
  const shelfOf = React.useCallback(
    (irmItemId: string, whId: string): number | null => {
      const w = availability.find((a) => a.warehouseId === whId);
      if (!w) return null;
      return w.items.find((i) => i.irmItemId === irmItemId)?.quantityOnHand ?? 0;
    },
    [availability],
  );
```

- [ ] **Step 3: When the primary-warehouse select changes, re-default un-touched line sources**

Wrap the existing `setWarehouseId` usage for the review `<Select>` so changing it updates defaults. Replace the review `<Select … onChange={setWarehouseId} …>` with:

```tsx
                  <Select
                    ariaLabel="Primary warehouse"
                    value={warehouseId}
                    onChange={(v) => {
                      setWarehouseId(v);
                      setSources((prev) => Object.fromEntries(req.lines.map((l) => [l.id, prev[l.id] && prev[l.id] !== warehouseId ? prev[l.id] : v])));
                    }}
                    options={[{ value: "", label: "Pick a warehouse…" }, ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }))]}
                  />
```

(Keep the "Engineer is collecting from" hint below it.)

- [ ] **Step 4: Add a SOURCE column + shelf hint to the lines table (review only)**

In the lines `<table>`, add a header cell after the "Approve qty" `<th>` (only meaningful in the review zone; render a placeholder otherwise):

```tsx
                  {isReviewZone && <th className="w-56 px-3 py-2 text-right">Source warehouse</th>}
```

In the row body, after the approve-qty `<td>`, add:

```tsx
                    {isReviewZone && (
                      <td className="px-3 py-2">
                        {(trims[l.id] ?? l.requestedQty) === 0 ? (
                          <span className="text-[11px] font-bold uppercase text-[var(--faint)]">Excluded</span>
                        ) : (
                          <div className="space-y-1">
                            <Select
                              size="sm"
                              ariaLabel={`Source warehouse for ${l.itemName}`}
                              value={sources[l.id] ?? warehouseId}
                              onChange={(v) => setSources((s) => ({ ...s, [l.id]: v }))}
                              options={warehouses.map((w) => {
                                const shelf = shelfOf(l.irmItemId, w.id);
                                return { value: w.id, label: `${w.code ? `${w.name} (${w.code})` : w.name}${shelf !== null ? ` — ${shelf} on shelf` : ""}` };
                              })}
                            />
                            {(() => {
                              const src = sources[l.id] ?? warehouseId;
                              const shelf = src ? shelfOf(l.irmItemId, src) : null;
                              const need = trims[l.id] ?? l.requestedQty;
                              if (shelf === null) return null;
                              const cls = shelf >= need ? "text-[var(--pos)]" : shelf > 0 ? "text-amber-600" : "text-[var(--neg)]";
                              return <div className={`text-[10px] font-semibold ${cls}`}>{shelf >= need ? `✓ ${shelf} on shelf` : shelf > 0 ? `⚠ only ${shelf} here` : "⚠ 0 here — pick another"}</div>;
                            })()}
                          </div>
                        )}
                      </td>
                    )}
```

Also change the approve-qty input's `min` from `1` to `0` so a line can be excluded (find the `<input type="number" min={1} … value={trims[l.id] ?? l.requestedQty}` in the review branch and set `min={0}`; also update its `onChange` clamp `Math.max(1, …)` → `Math.max(0, …)`).

- [ ] **Step 5: Add the hard-block gate to the Approve button**

Add a computed gate near the render (after `shelfOf`):

```tsx
  const approveBlocked = React.useMemo(() => {
    if (!req || !isReviewZone) return false;
    if (!warehouseId) return true;
    return req.lines.some((l) => {
      const need = trims[l.id] ?? l.requestedQty;
      if (need === 0) return false; // excluded — fine
      const src = sources[l.id] ?? warehouseId;
      const shelf = src ? shelfOf(l.irmItemId, src) : null;
      return shelf === null || shelf < need;
    });
  }, [req, isReviewZone, warehouseId, trims, sources, shelfOf]);
```

Change the Approve button to `disabled={busy || approveBlocked}` and add a hint below it when blocked:

```tsx
                <button type="button" onClick={onApprove} disabled={busy || approveBlocked} className={primaryBtn}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
                </button>
```

Directly under the approve/decline button row, add:

```tsx
              {approveBlocked && <p className="text-right text-[11px] font-semibold text-[var(--neg)]">Every line needs a source warehouse holding enough stock (or set its qty to 0 to exclude it).</p>}
```

- [ ] **Step 6: Send per-line source in `onApprove`**

Replace the `lineApprovals` construction in `onApprove`:

```tsx
      const lineApprovals = req.lines
        .filter((l) => trims[l.id] !== undefined && trims[l.id] !== l.requestedQty)
        .map((l) => ({ lineId: l.id, approvedQty: trims[l.id] }));
```

with (send a line if its qty was changed OR its source differs from primary):

```tsx
      const lineApprovals = req.lines
        .map((l) => {
          const approvedQty = trims[l.id] ?? l.requestedQty;
          const src = sources[l.id] ?? warehouseId;
          const changed = approvedQty !== l.requestedQty || src !== warehouseId;
          return changed ? { lineId: l.id, approvedQty, ...(approvedQty > 0 && src ? { sourceWarehouseId: src } : {}) } : null;
        })
        .filter((x): x is { lineId: string; approvedQty: number; sourceWarehouseId?: string } => x !== null);
```

- [ ] **Step 7: Typecheck + lint**

Run: `cd frontend && pnpm typecheck && pnpm lint`
Expected: PASS (the review-zone half of `VanRequestDetail` now compiles; fulfil-zone still uses old fields but they still exist).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx
git commit -m "feat(vsr): approval UI — per-line source picker & hard-block gate"
```

---

### Task 13: Frontend — `isMine`-scoped fulfil zone + read-only context

**Files:**
- Modify: `frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx` — `openLines` (L234), the fulfil-zone line chips (L348-362), the lines table source column for non-review states

**Interfaces:**
- Consumes: `VanStockLine.isMine`, `sourceWarehouseName`.
- Produces: the fulfil zone offers scan/add only for `isMine` lines; other lines show as read-only context with their source warehouse; the scan handler ignores a scanned line that isn't mine.

- [ ] **Step 1: Restrict fulfilment to owned, open lines**

Change `openLines` (currently `const openLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0);`) to also require ownership on restocks (returns are single-warehouse and always "mine" to the tab's warehouse — but the backend already scopes; `isMine` will be true for them):

```tsx
  const openLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && l.isMine);
  const otherLines = (req?.lines ?? []).filter((l) => l.remainingQty > 0 && !l.isMine);
```

- [ ] **Step 2: Guard the scan handler against non-owned lines**

In `onScan`, after `const line = req.lines.find((l) => l.id === result.lineId);` add:

```tsx
      if (!line || !line.isMine) { setMsg({ type: "error", text: "That item is fulfilled by another warehouse." }); return; }
```

(Replace the existing `if (!line) return;`.)

- [ ] **Step 3: Show a read-only "sourced elsewhere" list in the fulfil zone**

Inside the fulfil zone, after the `openLines`-driven chip row, add a context block for other warehouses' lines:

```tsx
              {otherLines.length > 0 && (
                <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Other warehouses</p>
                  <div className="mt-1 space-y-0.5">
                    {otherLines.map((l) => (
                      <p key={l.id} className="text-[11px] text-[var(--muted)]">
                        {l.itemName} ×{l.remainingQty} — <span className="font-semibold">{l.sourceWarehouseName ?? "another warehouse"}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
```

- [ ] **Step 4: Show the source column in non-review states too (so the full picture is visible)**

The table header source cell is currently `{isReviewZone && <th>…}`. Add a matching read-only header + cell for approved/partial restocks. Change the header to:

```tsx
                  {isReviewZone ? <th className="w-56 px-3 py-2 text-right">Source warehouse</th> : req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") ? <th className="w-40 px-3 py-2 text-right">Source</th> : null}
```

And add, in the row, after the review-zone source `<td>` block, an `else` read-only cell:

```tsx
                    {!isReviewZone && req.type === "restock" && (req.status === "approved" || req.status === "partially_fulfilled") && (
                      <td className="px-3 py-2 text-right text-[11px] text-[var(--muted)]">
                        {l.approvedQty === 0 ? <span className="font-bold uppercase text-[var(--faint)]">Excluded</span> : (l.sourceWarehouseCode ?? l.sourceWarehouseName ?? "—")}
                        {l.isMine && l.approvedQty !== 0 && <span className="ml-1 rounded bg-[var(--accent)]/10 px-1 text-[9px] font-bold uppercase text-[var(--accent)]">Yours</span>}
                      </td>
                    )}
```

- [ ] **Step 5: Typecheck + lint**

Run: `cd frontend && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx
git commit -m "feat(vsr): fulfil zone scopes to owned lines, shows others as context"
```

---

### Task 14: Frontend — `myProgress` banner + excluded-line visibility (engineer)

**Files:**
- Modify: `frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx` — info zone (after the status chips, ~L243-249)
- Modify: `frontend/src/components/dashboard/engineer/EngineerVanStock.tsx` — the engineer's line rendering (excluded tag)

**Interfaces:**
- Consumes: `VanStockRequest.myProgress`, `VanStockLine.approvedQty === 0`.
- Produces: a "your part is complete / X of Y of your lines done" banner for reviewers; an "Excluded" tag on the engineer's own excluded lines.

- [ ] **Step 1: Add the `myProgress` banner (reviewer detail)**

In `VanRequestDetail`, right after the status-chip flex row (the `<div className="flex flex-wrap items-center gap-2">…</div>` containing `VanStockStatusChip`), add:

```tsx
          {req.myProgress && req.myProgress.lines > 0 && (
            <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${req.myProgress.allMineDone ? "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"}`}>
              {req.myProgress.allMineDone ? "✓ Your part is complete" : `Your lines: ${req.myProgress.linesDone}/${req.myProgress.lines} done`}
              {req.progress.lines > req.myProgress.lines && <span className="ml-2 font-normal text-[var(--faint)]">· Overall {req.progress.linesDone}/{req.progress.lines}</span>}
            </div>
          )}
```

- [ ] **Step 2: Show excluded lines on the engineer's own view**

Open `frontend/src/components/dashboard/engineer/EngineerVanStock.tsx`. It renders each request's lines as a single **joined string** at line 131 (not per-line JSX), currently:

```tsx
                      {r.lines.map((l) => `${l.itemName} ×${l.requestedQty}${open && l.fulfilledQty > 0 ? ` (${l.fulfilledQty}/${l.approvedQty ?? l.requestedQty} done)` : ""}`).join(", ")}
```

Replace that single `.map(...).join(", ")` expression with one that marks excluded lines (`approvedQty === 0`) inline:

```tsx
                      {r.lines
                        .map((l) => {
                          if (l.approvedQty === 0) return `${l.itemName} ×${l.requestedQty} — excluded`;
                          const doneNote = open && l.fulfilledQty > 0 ? ` (${l.fulfilledQty}/${l.approvedQty ?? l.requestedQty} done)` : "";
                          return `${l.itemName} ×${l.requestedQty}${doneNote}`;
                        })
                        .join(", ")}
```

(`open` is the existing boolean in that map's scope — leave its declaration untouched. Note `approvedQty` is only `0` after a manager drops the line; `null` = not yet approved, which keeps the old formatting.)

- [ ] **Step 3: Typecheck + lint**

Run: `cd frontend && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/van-requests/VanRequestDetail.tsx frontend/src/components/dashboard/engineer/EngineerVanStock.tsx
git commit -m "feat(vsr): myProgress banner + excluded-line visibility"
```

---

### Task 15: Full verification & manual end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Backend full suite**

Run: `cd backend && pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 2: Frontend full check**

Run: `cd frontend && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 3: Manual end-to-end (the §1 scenario)**

With `backend` and `frontend` dev servers running and a dev DB seeded with ≥ 2 warehouses where one item is stocked only in warehouse A and another only in warehouse B:

1. As an engineer, raise a restock for 3 items picking a primary warehouse that holds only 1 of them. Submit.
2. As a warehouse manager for that primary warehouse, open the request. Confirm each line shows a source picker + shelf counts; the 2 out-of-stock lines show red "⚠ 0 here"; **Approve is disabled**.
3. Re-source the 2 flagged lines to warehouses that hold them (shelf hint turns green). Approve now enables. Approve.
4. Confirm the request now appears in **both** involved warehouses' Field Stock Requests tabs.
5. In warehouse A's tab, open it: only A's line(s) are scan-able; others show as "Other warehouses" context. Post-issue A's line. Confirm the `myProgress` banner reads "Your part is complete" while overall status is `partially_fulfilled`.
6. In warehouse B's tab, fulfil B's line. Confirm the request flips to `fulfilled`.
7. Repeat but this time **close short** one warehouse's line — confirm only that warehouse's line is written off, the other stays open, and the request becomes `fulfilled` only once every line is done/closed, with `completionType = closed_short`.
8. Try to approve a request where an item is out of stock everywhere: set that line's qty to 0 (Excluded), approve the rest; confirm the engineer sees the "Excluded" tag.

- [ ] **Step 4: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "chore(vsr): finalise per-line sourcing after end-to-end verification"
```
