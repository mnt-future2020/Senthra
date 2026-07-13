# Dashboard Home — Implementation Plan

**Spec:** [docs/superpowers/specs/2026-07-09-dashboard-home-design.md](../specs/2026-07-09-dashboard-home-design.md)
**Date:** 2026-07-09
**Branch (planned):** `feat/dashboard-home` (create only after user approves — git needs explicit go-ahead)

> **For the agentic worker executing this plan:** Work top to bottom. Each task is bite-sized, test-first, and ends with a verification command and a commit. Do NOT skip a test step. Run the exact commands given. If a command fails, stop and fix before moving on — do not proceed with a red bar. All backend paths are relative to `backend/`, all frontend paths relative to `frontend/`. Backend commands run from `backend/` (pnpm), frontend from `frontend/`.
>
> **The codebase is the source of truth, not this document.** Field names, relation names, route shapes, and helper signatures here were verified against the schema/code at authoring time, but if any execution-time check finds a discrepancy, **follow the existing schema/code and adjust the plan's code to match — never change the schema, a model, or a route to fit this plan.** This is an additive, read-only feature; it must not migrate data or alter any existing contract. If a required field genuinely doesn't exist, stop and surface it rather than inventing one.

## Goal

Replace the empty `/dashboard` redirect with a production-grade, role-aware Overview screen: KPI cards (+ sparklines), a full-width "Awaiting Your Action" worklist, a Spend Trend area chart + PO Pipeline bar panel, and a Recent Activity feed. One aggregated endpoint (`GET /dashboard/summary`) computes only the sections the actor may see, warehouse-scoped. Visual language is adapted from `reference/tabs/OverviewTab.tsx`; all data/content is fresh for Senthra's procurement/jobs/inventory domains.

## Architecture

- **Backend:** new `src/modules/dashboard/` module — `routes` → `controller` (thin) → `service` (permission-gate per section + `Promise.all` orchestration + pure worklist comparator). It owns **no repository and no Prisma** (design principle 5). Every metric is a new function on the **owning** module's repository (purchase-request, purchase-order, job, job-kit-request, inventory, audit).
- **Response contract:** grouped `{ summary: { generatedAt, cards, charts, worklist, activity } }`. A **missing section key = no permission**; an **empty array / zero = permitted-but-empty**.
- **Warehouse scoping:** reuse `warehouseScopeFilter(actor): string[] | undefined` on every warehouse-dimensioned metric (Open POs, Low Stock, receivable worklist rows, pipeline, spend).
- **Frontend:** `dashboard.service.ts` typed wrapper → Overview page composes widget components in `components/dashboard/home/`. `/dashboard` stops redirecting; "Dashboard" becomes the first sidebar item.

## Tech stack & conventions (must follow)

- **Backend ESM/NodeNext:** every relative import ends in `.js`. Cross-module imports use the `#modules/<domain>/...` alias (with `.js`); same-module imports stay relative (`./dashboard.service.js`); shared dirs relative (`../../lib/warehouse-access.js`).
- **Layering:** route → middleware → controller → service → repository → Prisma. Controllers hold no logic. Prisma is touched ONLY in repositories.
- **Backend has vitest** (CLAUDE.md is wrong): `pnpm test` runs real unit tests. Verify every backend task with `pnpm typecheck` + `pnpm test` (+ `pnpm lint` at the end).
- **Frontend:** never call axios/fetch directly — go through `api()` via a `services/*.service.ts` wrapper. CSS-variable theming (`var(--surface)`, `var(--border)`, `var(--muted)`, `var(--faint)`, `var(--accent)`, `var(--pos)`, `var(--neg)`, `var(--warn)`). Reuse existing display helpers (`poStatus.tsx`, `auditDisplay.ts`). Verify with `pnpm lint` + `pnpm build`.
- **No fabricated data.** Sparklines are 8-week created-volume series from `createdAt`, never a fake history of the headline count.

## Global constraints

- Customers never see pricing — this is a **staff-only** surface; spend never reaches a customer principal (every pricing section requires a staff permission). Do not add any customer-portal wiring.
- Git actions (branch/commit/push) require explicit user approval. The commit steps below are the intended checkpoints; **run them only once the user has approved working on the feature branch.** If unsure, pause and ask before the first commit.

---

## Task 1 — Repository aggregations (owning modules)

> **Scope of these functions (binding — guards spec principle 2):** every aggregation added in this task exists **solely to feed the dashboard summary**. They are dashboard read-models, **not** a general-purpose reporting API. Do not grow parameters (date ranges, group-bys, pagination) onto them for other callers; if a real reporting need appears later, it gets its own function/module. Add a one-line comment to that effect above each new block (e.g. `// Dashboard read-model — not a generic reporting API.`) so the intent survives.

All Prisma lives here. Add pure aggregation functions to each owning repository. Do them as sub-steps, typechecking after each file.

**Schema facts — verified against `prisma/schema.prisma`:**

- **Identifier field is `code`** on PurchaseRequest (`PRF-####`), PurchaseOrder (`PO-####`), and JobKitRequest (`JKR-####`) — all `@unique`. **Job's identifier is `jobNumber`** (`JOB-YYYY-####`). There is **no** `prfNumber`/`poNumber` field — using those names will not compile.
- **`priority`** exists on **PurchaseOrder** and **Job** (`low|normal|high|urgent`), but **NOT** on PurchaseRequest and **NOT** on JobKitRequest. PRF also has **no `title`** — label PRF/PO worklist rows with the `supplierName` snapshot.
- Status sets: PO `draft|pending_approval|approved|pm_review|sent|supplier_accepted|partially_received|fully_received|closed|cancelled`; PRF `draft|submitted|approved|converted|cancelled`; Job `draft|assigned|accepted|in_progress|completed|rejected|cancelled`; JobKitRequest `pending|approved|declined|cancelled`.
- `supplierName` is a snapshot column on both PRF and PO (no supplier join needed for a label). `pmUserId`, `purchaseRequestId`, `expectedDeliveryDate`, `orderDate` all exist on PO.
- `InventoryBalance @@unique([irmItemId, warehouseId])` with `quantityOnHand`; IrmItem thresholds `reorderLevel`/`criticalLevel`, `trackInventory` (default true), `status active|inactive`, `deletedAt`.
- Money is `grandTotalPence` (integer pence). Soft-delete: filter `deletedAt: null` everywhere.

### 1a — Shared week/month bucketing helpers (pure, tested first)

**Test:** `src/utils/__tests__/time-buckets.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { isoWeekKeysBack, monthKeysBack, bucketByWeek, bucketByMonth } from "../time-buckets.js";

describe("monthKeysBack", () => {
  it("returns N ascending YYYY-MM keys ending at the anchor month", () => {
    const keys = monthKeysBack(12, new Date("2026-07-09T00:00:00Z"));
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-07");
    expect(keys[0]).toBe("2025-08");
  });
  it("crosses year boundaries correctly", () => {
    const keys = monthKeysBack(3, new Date("2026-01-15T00:00:00Z"));
    expect(keys).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("bucketByMonth", () => {
  it("zero-fills empty months and sums values into the right bucket", () => {
    const anchor = new Date("2026-03-31T00:00:00Z");
    const rows = [
      { at: new Date("2026-03-02T10:00:00Z"), value: 100 },
      { at: new Date("2026-03-20T10:00:00Z"), value: 50 },
      { at: new Date("2026-01-10T10:00:00Z"), value: 25 },
    ];
    const out = bucketByMonth(rows, 3, anchor);
    expect(out).toEqual([
      { month: "2026-01", totalPence: 25 },
      { month: "2026-02", totalPence: 0 },
      { month: "2026-03", totalPence: 150 },
    ]);
  });
  it("ignores rows outside the window", () => {
    const anchor = new Date("2026-03-31T00:00:00Z");
    const out = bucketByMonth([{ at: new Date("2025-01-01T00:00:00Z"), value: 999 }], 3, anchor);
    expect(out.every((b) => b.totalPence === 0)).toBe(true);
  });
});

describe("isoWeekKeysBack / bucketByWeek", () => {
  it("returns N weekly counts ending at the anchor week", () => {
    const anchor = new Date("2026-07-09T00:00:00Z"); // Thursday
    const keys = isoWeekKeysBack(8, anchor);
    expect(keys).toHaveLength(8);
    const counts = bucketByWeek(
      [{ at: anchor }, { at: anchor }, { at: new Date("2026-05-01T00:00:00Z") }],
      8,
      anchor,
    );
    expect(counts).toHaveLength(8);
    expect(counts[7]).toBe(2); // two in the anchor week
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2); // the May row is outside the 8-week window
  });
});
```

**Implementation:** `src/utils/time-buckets.ts`

```ts
// Pure date-bucketing helpers for dashboard trend series. UTC throughout so buckets
// are deterministic regardless of server timezone. No Prisma, no I/O.

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** N ascending `YYYY-MM` keys, the last being the anchor's month. */
export function monthKeysBack(n: number, anchor: Date): string[] {
  const keys: string[] = [];
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  for (let i = n - 1; i >= 0; i--) {
    keys.push(ymKey(new Date(Date.UTC(y, m - i, 1))));
  }
  return keys;
}

/** Sum `value` into N monthly buckets ending at the anchor month; empty months → 0. */
export function bucketByMonth(
  rows: Array<{ at: Date; value: number }>,
  n: number,
  anchor: Date,
): Array<{ month: string; totalPence: number }> {
  const keys = monthKeysBack(n, anchor);
  const totals = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = ymKey(r.at);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  return keys.map((month) => ({ month, totalPence: totals.get(month) ?? 0 }));
}

// ISO-week bucketing: label each week by the UTC date of its Monday (`YYYY-MM-DD`).
function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

/** N ascending week keys (Monday dates), the last being the anchor's week. */
export function isoWeekKeysBack(n: number, anchor: Date): string[] {
  const monAnchor = mondayOf(anchor);
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monAnchor);
    d.setUTCDate(d.getUTCDate() - i * 7);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/** Count rows into N weekly buckets ending at the anchor week; empty weeks → 0. */
export function bucketByWeek(rows: Array<{ at: Date }>, n: number, anchor: Date): number[] {
  const keys = isoWeekKeysBack(n, anchor);
  const idx = new Map<string, number>(keys.map((k, i) => [k, i]));
  const counts = new Array<number>(n).fill(0);
  for (const r of rows) {
    const k = mondayOf(r.at).toISOString().slice(0, 10);
    const i = idx.get(k);
    if (i !== undefined) counts[i] += 1;
  }
  return counts;
}
```

**Verify:** `pnpm typecheck && pnpm test -- time-buckets`

**Commit:** `feat(dashboard): pure week/month bucketing helpers for trend series`

### 1b — purchase-request.repository aggregations

Add to `src/modules/purchase-request/purchase-request.repository.ts` (mirror the existing `buildWhere`/`deletedAt: null` patterns in that file).

**Schema-verified field names (checked against `prisma/schema.prisma`):** the PRF code field is **`code`** (`@unique`, e.g. `PRF-0001`) — **not** `prfNumber`. PRF has **no `priority`** and **no `title`** field, so the worklist row uses `supplierName` as its label and leaves `priority` null. (Contrast PO, which *does* have `priority`.)

```ts
// Dashboard read-models — not a generic reporting API. (read-only; warehouse-scoped where applicable)

/** Count of PRFs awaiting Finance review. */
export async function countSubmitted(warehouseIds?: string[]): Promise<number> {
  return prisma.purchaseRequest.count({
    where: { status: "submitted", deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
  });
}

/** createdAt of PRFs created since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date }>> {
  const rows = await prisma.purchaseRequest.findMany({
    where: { createdAt: { gte: since }, deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    select: { createdAt: true },
  });
  return rows.map((r) => ({ at: r.createdAt }));
}

/** Submitted PRFs for the worklist. PRF has no priority/title — label with the supplier snapshot. */
export async function submittedWorklist(warehouseIds?: string[]): Promise<
  Array<{ id: string; code: string; title: string | null; priority: string | null; createdAt: Date }>
> {
  const rows = await prisma.purchaseRequest.findMany({
    where: { status: "submitted", deletedAt: null, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    select: { id: true, code: true, supplierName: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  // Keep the {id, code, title, priority, createdAt} shape stable — the service depends on it;
  // title = supplierName snapshot, priority = null (PRF carries neither field).
  return rows.map((r) => ({ id: r.id, code: r.code, title: r.supplierName, priority: null, createdAt: r.createdAt }));
}
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): PRF repo aggregations (submitted count, created series, worklist)`

### 1c — purchase-order.repository aggregations

Add to `src/modules/purchase-order/purchase-order.repository.ts` (mirror `statusCountsForSupplier`/`spendPenceForSupplier`/`buildWhere`). Define shared status groups once:

```ts
// Non-terminal, not-fully-received "open" statuses — same definition as the supplier summary.
const OPEN_PO_STATUSES = ["draft", "pending_approval", "approved", "pm_review", "sent", "supplier_accepted", "partially_received"] as const;
// Statuses that count as "issued spend" (reached the supplier). Cancelled excluded.
const ISSUED_PO_STATUSES = ["sent", "supplier_accepted", "partially_received", "fully_received", "closed"] as const;
// Pipeline = current count per non-terminal status.
const PIPELINE_STATUSES = OPEN_PO_STATUSES;

function whereWarehouse(warehouseIds?: string[]) {
  return warehouseIds ? { warehouseId: { in: warehouseIds } } : {};
}

/** Open PO count + summed value (pence). */
export async function openSummary(warehouseIds?: string[]): Promise<{ count: number; valuePence: number }> {
  const where = { status: { in: [...OPEN_PO_STATUSES] }, deletedAt: null, ...whereWarehouse(warehouseIds) };
  const [count, agg] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.aggregate({ where, _sum: { grandTotalPence: true } }),
  ]);
  return { count, valuePence: agg._sum.grandTotalPence ?? 0 };
}

/** Current count per pipeline status; zero-filled so every bar renders. */
export async function pipelineCounts(warehouseIds?: string[]): Promise<Array<{ status: string; count: number }>> {
  const grouped = await prisma.purchaseOrder.groupBy({
    by: ["status"],
    where: { status: { in: [...PIPELINE_STATUSES] }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
  return PIPELINE_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/** orderDate + grandTotalPence for issued POs since `since`, for the 12-month spend chart. */
export async function issuedSpendSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date; value: number }>> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: { in: [...ISSUED_PO_STATUSES] }, orderDate: { gte: since }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: { orderDate: true, grandTotalPence: true },
  });
  return rows.map((r) => ({ at: r.orderDate ?? r.createdAt, value: r.grandTotalPence ?? 0 }));
}

/** createdAt of POs since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date, warehouseIds?: string[]): Promise<Array<{ at: Date }>> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { createdAt: { gte: since }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: { createdAt: true },
  });
  return rows.map((r) => ({ at: r.createdAt }));
}

type PoWorklistRow = { id: string; code: string; supplierName: string | null; priority: string | null; status: string; expectedDeliveryDate: Date | null; createdAt: Date };

// Schema-verified: PO code field is `code` (@unique, e.g. PO-0001) — NOT poNumber. `priority`,
// `status`, `pmUserId`, `purchaseRequestId`, `expectedDeliveryDate`, `orderDate` all confirmed.
// `supplierName` is snapshotted on the row, so no supplier join is needed for the label.
function selectPoWorklist() {
  return { id: true, code: true, priority: true, status: true, expectedDeliveryDate: true, createdAt: true, supplierName: true } as const;
}
function mapPoWorklist(r: { id: string; code: string; priority: string | null; status: string; expectedDeliveryDate: Date | null; createdAt: Date; supplierName: string | null }): PoWorklistRow {
  return { id: r.id, code: r.code, supplierName: r.supplierName, priority: r.priority, status: r.status, expectedDeliveryDate: r.expectedDeliveryDate, createdAt: r.createdAt };
}

/** Draft POs converted from a PRF (fast-path approval queue). */
export async function fastPathDraftWorklist(warehouseIds?: string[]): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: "draft", purchaseRequestId: { not: null }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: selectPoWorklist(), orderBy: { createdAt: "asc" },
  });
  return rows.map(mapPoWorklist);
}

/** POs in a given status (optionally restricted to a PM) for the worklist. */
export async function statusWorklist(status: string, opts: { pmUserId?: string; warehouseIds?: string[] } = {}): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status, deletedAt: null, ...(opts.pmUserId ? { pmUserId: opts.pmUserId } : {}), ...whereWarehouse(opts.warehouseIds) },
    select: selectPoWorklist(), orderBy: { createdAt: "asc" },
  });
  return rows.map(mapPoWorklist);
}

/** POs that can still receive goods (warehouse-scoped receive queue). */
export async function receivableWorklist(warehouseIds?: string[]): Promise<PoWorklistRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["sent", "supplier_accepted", "partially_received"] }, deletedAt: null, ...whereWarehouse(warehouseIds) },
    select: selectPoWorklist(), orderBy: { expectedDeliveryDate: "asc" },
  });
  return rows.map(mapPoWorklist);
}
```

> **Already schema-verified** (no re-check needed): `code`, `priority`, `status`, `pmUserId`, `purchaseRequestId`, `expectedDeliveryDate`, `orderDate`, `grandTotalPence`, `supplierName`, `deletedAt` all exist on PurchaseOrder as used above. Keep the exported signatures and `PoWorklistRow` shape unchanged. Only re-confirm the exact `_count`/`groupBy` return typing against the installed Prisma client if `pipelineCounts` doesn't compile first try.

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): PO repo aggregations (open summary, pipeline, spend, worklists)`

### 1d — job.repository + job-kit-request.repository aggregations

`src/modules/job/job.repository.ts`:

```ts
const ACTIVE_JOB_STATUSES = ["assigned", "accepted", "in_progress"] as const;

/** Count of jobs currently in flight. */
export async function countActive(): Promise<number> {
  return prisma.job.count({ where: { status: { in: [...ACTIVE_JOB_STATUSES] }, deletedAt: null } });
}

/** createdAt of jobs since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date): Promise<Array<{ at: Date }>> {
  const rows = await prisma.job.findMany({ where: { createdAt: { gte: since }, deletedAt: null }, select: { createdAt: true } });
  return rows.map((r) => ({ at: r.createdAt }));
}
```

`src/modules/job-kit-request/job-kit-request.repository.ts` (a `countPending`/`countPendingByJobs` already exist here — add the worklist fetch).

**Schema-verified:** JobKitRequest has its **own `code`** (`@unique`, `JKR-####`) — that's the row identifier. `jobNumber` (`JOB-2026-####`) is a **non-nullable snapshot** and is the human context/link target. Both are selected; the row exposes `code` (the JKR) and `jobNumber` (the job) distinctly.

```ts
/** Dashboard read-model — not a generic reporting API. Pending kit requests for the PM-review worklist. */
export async function pendingWorklist(): Promise<Array<{ id: string; code: string; jobNumber: string; createdAt: Date }>> {
  const rows = await prisma.jobKitRequest.findMany({
    where: { status: "pending", deletedAt: null },
    select: { id: true, code: true, jobNumber: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, code: r.code, jobNumber: r.jobNumber, createdAt: r.createdAt }));
}
```

> **Verified against schema:** JobKitRequest.`code`/`jobNumber`/`status`/`createdAt`/`deletedAt` all confirmed; Job active statuses (`assigned|accepted|in_progress`) confirmed against the Job model's status comment. Jobs/kit-requests carry no warehouse dimension here → unscoped (correct).

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): job + kit-request repo aggregations (active count, created series, pending worklist)`

### 1e — inventory.repository low-stock counts (warehouse-scoped)

**Confirmed:** `inventory.repository.ts` **already** accesses both `prisma.inventoryBalance` and `prisma.irmItem` and already references `reorderLevel`/`criticalLevel` — so `lowStockCounts` belongs here and the module already owns exactly this join. The canonical low-stock rule is already codified in `src/modules/inventory/stock-position.ts` as **`positionStatus(onHand, reorderLevel)`**:

```ts
// existing helper — DO NOT re-invent the comparison; reuse it.
export function positionStatus(onHand, reorderLevel): "in_stock" | "low_stock" | "out_of_stock" {
  if (onHand <= 0) return "out_of_stock";
  if (reorderLevel != null && onHand <= reorderLevel) return "low_stock";
  return "in_stock";
}
```

**Definitional decision (make it explicit):** the dashboard "Low Stock" KPI counts an item as low when it is **`low_stock` OR `out_of_stock`** (i.e. `onHand <= reorderLevel`, including zero) — out-of-stock is the most urgent kind of low and belongs on the attention card. The "N critical" sub-stat is the same on-hand tested against `criticalLevel`. On-hand is the **sum of `InventoryBalance.quantityOnHand`** across the actor's accessible warehouses (raw on-hand, matching `positionStatus`, not availability). Keep the whole computation inside the repository (two-step fetch is fine and clearest on Mongo):

```ts
import { positionStatus } from "./stock-position.js";

/**
 * Dashboard read-model — not a generic reporting API.
 * Low-stock + critical counts for the Overview KPI. An item is "low" when it tracks
 * inventory, has a reorderLevel set, and its total on-hand across the scoped warehouses
 * is ≤ reorderLevel (this INCLUDES out-of-stock — the most severe low). "Critical" is the
 * same on-hand tested against criticalLevel. Reuses positionStatus so the low-stock rule
 * stays defined in exactly one place. Warehouse-scoped: undefined = all warehouses.
 */
export async function lowStockCounts(warehouseIds?: string[]): Promise<{ count: number; criticalCount: number }> {
  const items = await prisma.irmItem.findMany({
    where: { trackInventory: true, status: "active", deletedAt: null },
    select: { id: true, reorderLevel: true, criticalLevel: true },
  });
  if (items.length === 0) return { count: 0, criticalCount: 0 };

  const balances = await prisma.inventoryBalance.findMany({
    where: { irmItemId: { in: items.map((i) => i.id) }, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    select: { irmItemId: true, quantityOnHand: true },
  });
  const onHand = new Map<string, number>();
  for (const b of balances) onHand.set(b.irmItemId, (onHand.get(b.irmItemId) ?? 0) + b.quantityOnHand);

  let count = 0;
  let criticalCount = 0;
  for (const it of items) {
    const qty = onHand.get(it.id) ?? 0;
    // low = low_stock OR out_of_stock (reuse the canonical rule for the reorderLevel test)
    if (it.reorderLevel != null && positionStatus(qty, it.reorderLevel) !== "in_stock") count += 1;
    if (it.criticalLevel != null && positionStatus(qty, it.criticalLevel) !== "in_stock") criticalCount += 1;
  }
  return { count, criticalCount };
}
```

> **Field check:** confirm `trackInventory`, `status`, `reorderLevel`, `criticalLevel` on IrmItem and that `inventory.repository.ts` already imports `prisma` (it does — it accesses both models). If this repo already has a private warehouse-scope helper for balances, use it instead of the inline `warehouseId: { in }`.

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): inventory repo low-stock + critical counts (warehouse-scoped)`

### 1f — audit.repository recent activity

`audit.repository.ts` already has `findMany(filters, skip, take)` newest-first. No new function needed unless a convenience wrapper reads cleaner:

```ts
/** Most recent audit events for the dashboard activity feed. */
export async function recent(limit = 10) {
  return findMany({}, 0, limit);
}
```

> If `findMany`'s signature differs, call it directly from the service with the right args instead of adding this — either is fine. Confirm the returned row shape (`actorEmail`, `action`, `targetType`, `targetId`, `targetLabel`, `createdAt`).

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): audit recent-activity accessor for dashboard feed`

---

## Task 2 — Worklist comparator + shapes (pure, TDD)

The comparator is the one piece of dashboard-owned logic that must be unit-tested. It lives in the dashboard module as a **pure exported function**, independent of Prisma.

**Test:** `src/modules/dashboard/__tests__/worklist.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { compareWorklist, type WorklistItem } from "../worklist.js";

const base = (over: Partial<WorklistItem>): WorklistItem => ({
  kind: "review_prf", id: "x", code: "PRF-1", title: null, priority: null,
  dueDate: null, ageDays: 0, href: "/x", ...over,
});

describe("compareWorklist", () => {
  const NOW = new Date("2026-07-09T12:00:00Z");

  it("orders overdue before due-today before high-priority before oldest", () => {
    const overdue = base({ id: "overdue", dueDate: "2026-07-01T00:00:00Z", ageDays: 8 });
    const dueToday = base({ id: "today", dueDate: "2026-07-09T18:00:00Z", ageDays: 1 });
    const high = base({ id: "high", priority: "high", ageDays: 2 });
    const old = base({ id: "old", ageDays: 5 });
    const sorted = [old, high, dueToday, overdue].sort((a, b) => compareWorklist(a, b, NOW));
    expect(sorted.map((r) => r.id)).toEqual(["overdue", "today", "high", "old"]);
  });

  it("within the oldest band, older (higher ageDays) comes first", () => {
    const a = base({ id: "a", ageDays: 3 });
    const b = base({ id: "b", ageDays: 9 });
    const sorted = [a, b].sort((x, y) => compareWorklist(x, y, NOW));
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("treats urgent like high in the priority band", () => {
    const urgent = base({ id: "u", priority: "urgent", ageDays: 1 });
    const plain = base({ id: "p", ageDays: 1 });
    const sorted = [plain, urgent].sort((x, y) => compareWorklist(x, y, NOW));
    expect(sorted[0].id).toBe("u");
  });
});
```

**Implementation:** `src/modules/dashboard/worklist.ts`

```ts
// Worklist item shape + priority comparator for "Awaiting Your Action".
// Pure and Prisma-free so it is unit-testable. Ordering (spec):
//   1. overdue  2. due today  3. high/urgent priority  4. oldest first.

export type WorklistKind =
  | "review_prf" | "approve_po_fastpath" | "review_po" | "send_po" | "acknowledge_po"
  | "receive_goods" | "review_kit_request";

export interface WorklistItem {
  kind: WorklistKind;
  id: string;
  code: string;
  title: string | null;
  priority: string | null;
  dueDate: string | null; // ISO
  ageDays: number;
  href: string;
}

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Lower band = higher up the list. 0 overdue, 1 due-today, 2 high/urgent, 3 rest. */
function band(item: WorklistItem, now: Date): number {
  const today = startOfUTCDay(now);
  if (item.dueDate) {
    const due = startOfUTCDay(new Date(item.dueDate));
    if (due < today) return 0;
    if (due === today) return 1;
  }
  if (item.priority === "high" || item.priority === "urgent") return 2;
  return 3;
}

/** Comparator for Array.sort; pass `now` for determinism in tests. */
export function compareWorklist(a: WorklistItem, b: WorklistItem, now: Date): number {
  const ba = band(a, now);
  const bb = band(b, now);
  if (ba !== bb) return ba - bb;
  return b.ageDays - a.ageDays; // older first within a band
}
```

**Verify:** `pnpm typecheck && pnpm test -- worklist`
**Commit:** `feat(dashboard): worklist item shape + priority comparator (tested)`

---

## Task 3a — Dashboard DTO types (shared shape)

Before the service, define the response contract as **real interfaces** (no `Record<string, unknown>`). These are the single source of truth the frontend mirrors in Task 5.

**`src/modules/dashboard/dashboard.types.ts`**

```ts
// The GET /dashboard/summary contract as typed interfaces (design principle: no stringly-typed
// payloads). Every section key is optional — an ABSENT key means "actor lacks permission" or
// "section failed" (see `errors`); an empty array / zero means "permitted but no data".

export interface StatCard { count: number; weeklyCreated: number[]; }
export interface OpenPosCard extends StatCard { valuePence: number; }
export interface LowStockCard { count: number; criticalCount: number; }
export interface SpendPoint { month: string; totalPence: number; }
export interface PipelinePoint { status: string; count: number; }

export interface WorklistItemDTO {
  kind: string;
  id: string;
  code: string;
  title: string | null;
  priority: string | null;
  dueDate: string | null; // ISO
  ageDays: number;
  href: string;
}

export interface ActivityDTO {
  id: string;
  at: string; // ISO
  actorName: string;
  action: string;
  entity: { type: string; code: string; id: string };
}

export interface DashboardCards {
  pendingPrfs?: StatCard;
  openPos?: OpenPosCard;
  activeJobs?: StatCard;
  lowStock?: LowStockCard;
}
export interface DashboardCharts {
  spendTrend?: SpendPoint[];
  poPipeline?: PipelinePoint[];
}

export interface DashboardSummary {
  generatedAt: string; // server UTC ISO — never generated on the client
  cards: DashboardCards;
  charts: DashboardCharts;
  worklist?: { items: WorklistItemDTO[]; total: number };
  activity?: ActivityDTO[];
  /** Section keys that were permitted but failed to compute (partial-failure signal for the FE).
   *  A no-permission section is simply absent and is NOT listed here. Absent/empty when all good. */
  errors?: string[];
}
```

**Verify:** `pnpm typecheck`
**Commit:** `feat(dashboard): typed summary DTO contract (no Record<string,unknown>)`

## Task 3 — Dashboard service (permission-gated orchestration, TDD)

The service permission-gates each section, computes each permitted section **independently with `Promise.allSettled`** (one failing section must never 500 the whole dashboard), builds the worklist, sorts it with `compareWorklist`, caps at `WORKLIST_CAP`, and stamps a server-UTC `generatedAt`. Gate with `principalGrants(principal, key)` (admin always true). Scope with `warehouseScopeFilter(actor)`.

**Partial-failure contract:** a permitted section that throws is **omitted from its group AND its name is pushed to `summary.errors`** — so the FE can show "Couldn't load spend" for a failure while a no-permission section stays cleanly absent (and is never in `errors`). This keeps the missing-key-vs-empty contract intact and makes failures observable instead of silent.

**Test first** — `src/modules/dashboard/__tests__/dashboard.service.test.ts`. Mock every owning repository with `vi.mock` (module-boundary mocks; the service must not hit Prisma). Assert: (1) a section is **omitted** when its permission is absent; (2) present with permission; (3) `warehouseScopeFilter` result is threaded into scoped repo calls; (4) worklist capped at `WORKLIST_CAP` with correct `total`; (5) `generatedAt` is an ISO string; (6) **a section whose repo rejects is omitted and listed in `errors`, and the rest of the summary still returns**.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({
  countSubmitted: vi.fn(async () => 4),
  createdSince: vi.fn(async () => []),
  submittedWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  openSummary: vi.fn(async () => ({ count: 2, valuePence: 1000 })),
  pipelineCounts: vi.fn(async () => []),
  issuedSpendSince: vi.fn(async () => []),
  createdSince: vi.fn(async () => []),
  fastPathDraftWorklist: vi.fn(async () => []),
  statusWorklist: vi.fn(async () => []),
  receivableWorklist: vi.fn(async () => []),
}));
vi.mock("#modules/job/job.repository.js", () => ({ countActive: vi.fn(async () => 7), createdSince: vi.fn(async () => []) }));
vi.mock("#modules/job-kit-request/job-kit-request.repository.js", () => ({ pendingWorklist: vi.fn(async () => []) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ lowStockCounts: vi.fn(async () => ({ count: 5, criticalCount: 2 })) }));
vi.mock("#modules/audit/audit.repository.js", () => ({ findMany: vi.fn(async () => []) }));

// warehouseScopeFilter → undefined (unscoped) for a plain admin.
vi.mock("../../../lib/warehouse-access.js", () => ({ warehouseScopeFilter: vi.fn(() => undefined) }));

import * as invRepo from "#modules/inventory/inventory.repository.js";
import { buildDashboardSummary } from "../dashboard.service.js";

const admin = { id: "a1", permissions: ["*"], assignedWarehouseIds: null } as any;
const finance = { id: "f1", permissions: ["purchase_requests.view", "purchase_requests.approve"], assignedWarehouseIds: null } as any;

describe("buildDashboardSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes every card section for an admin", async () => {
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.cards.pendingPrfs?.count).toBe(4);
    expect(summary.cards.openPos?.count).toBe(2);
    expect(summary.cards.activeJobs?.count).toBe(7);
    expect(summary.cards.lowStock?.count).toBe(5);
    expect(typeof summary.generatedAt).toBe("string");
    expect(summary.errors ?? []).toEqual([]); // nothing failed
  });

  it("omits sections the actor lacks permission for (and does not flag them as errors)", async () => {
    const { summary } = await buildDashboardSummary(finance);
    expect(summary.cards.pendingPrfs).toBeDefined();     // has purchase_requests.view
    expect(summary.cards.openPos).toBeUndefined();        // no purchase_orders.view
    expect(summary.cards.activeJobs).toBeUndefined();
    expect(summary.charts.spendTrend).toBeUndefined();
    expect(summary.activity).toBeUndefined();             // no audit.view
    expect(summary.errors ?? []).toEqual([]);             // absent ≠ errored
  });

  it("degrades gracefully when one permitted section throws", async () => {
    vi.mocked(invRepo.lowStockCounts).mockRejectedValueOnce(new Error("mongo down"));
    const { summary } = await buildDashboardSummary(admin);
    expect(summary.cards.lowStock).toBeUndefined();       // failed section dropped
    expect(summary.errors).toContain("lowStock");         // …but surfaced
    expect(summary.cards.pendingPrfs?.count).toBe(4);     // the rest still returns
    expect(summary.charts.poPipeline).toBeDefined();
  });
});
```

**Implementation:** `src/modules/dashboard/dashboard.service.ts`

Each permitted section is wrapped so a rejection is caught, recorded in `errors`, and yields `undefined` instead of bubbling. `settle()` runs the section thunks with `Promise.allSettled` and collects failures by key.

```ts
import { principalGrants } from "../../types/principal.js";
import { warehouseScopeFilter } from "../../lib/warehouse-access.js";
import type { Principal } from "../../types/principal.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as kitRepo from "#modules/job-kit-request/job-kit-request.repository.js";
import * as invRepo from "#modules/inventory/inventory.repository.js";
import * as auditRepo from "#modules/audit/audit.repository.js";
import { bucketByWeek, bucketByMonth } from "../../utils/time-buckets.js";
import { compareWorklist, type WorklistItem } from "./worklist.js";
import type { DashboardSummary, DashboardCards, DashboardCharts } from "./dashboard.types.js";

// Dashboard tuning knobs — all magic numbers live here, none inline.
const SPARK_WEEKS = 8;
const SPEND_MONTHS = 12;
const WORKLIST_CAP = 10;
const ACTIVITY_LIMIT = 10;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// A named unit of work: only run when `enabled` (permission holds); on rejection its `key`
// is recorded and the value becomes undefined so the dashboard degrades section-by-section.
interface Section<T> { key: string; enabled: boolean; run: () => Promise<T>; }
function section<T>(key: string, enabled: boolean, run: () => Promise<T>): Section<T> {
  return { key, enabled, run };
}

/**
 * Run named sections concurrently, isolating failures. Returns a map of key → value for
 * sections that succeeded, plus the keys that were enabled-but-threw. Permission-disabled
 * sections are simply absent from both (never counted as errors).
 */
async function settle(
  sections: Array<Section<unknown>>,
): Promise<{ values: Record<string, unknown>; errors: string[] }> {
  const enabled = sections.filter((s) => s.enabled);
  const settled = await Promise.allSettled(enabled.map((s) => s.run()));
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  settled.forEach((r, i) => {
    const key = enabled[i].key;
    if (r.status === "fulfilled") values[key] = r.value;
    else {
      errors.push(key);
      console.error(`[dashboard] section "${key}" failed:`, r.reason); // 5xx-worthy detail, logged not thrown
    }
  });
  return { values, errors };
}

// `actor` is the broad Principal (admin | user | customer) — that's what req.principal is.
// principalGrants short-circuits admin → true; warehouseScopeFilter reads assignedWarehouseIds
// structurally (absent on admin/customer → unrestricted). Do NOT narrow to UserPrincipal: an
// admin principal has no assignedWarehouseIds/firstName and would fail to typecheck.
export async function buildDashboardSummary(
  actor: Principal,
  now: Date = new Date(),
): Promise<{ summary: DashboardSummary }> {
  const scope = warehouseScopeFilter(actor); // string[] | undefined
  const sparkSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - SPARK_WEEKS * 7));
  const spendSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (SPEND_MONTHS - 1), 1));

  const can = (key: string) => principalGrants(actor, key);
  const canPrf = can("purchase_requests.view");
  const canPo = can("purchase_orders.view");
  const canJobs = can("jobs.view");
  const canInv = can("inventory.view");
  const canAudit = can("audit.view");

  // Worklist queue permissions.
  const qReviewPrf = can("purchase_requests.approve");
  const qApprovePo = can("purchase_orders.approve");
  const qSendPo = can("purchase_orders.send");
  const qAckPo = can("purchase_orders.acknowledge");
  const qReceive = can("goods_in.create");
  const qKit = can("jobs.kit_request.review");

  // Each section is keyed by its response field so a failure maps back to what the FE renders.
  // Worklist queues share the "worklist" key: if any queue fails the worklist degrades as a unit.
  const { values, errors } = await settle([
    section("pendingPrfs", canPrf, async () => ({
      count: await prfRepo.countSubmitted(scope),
      weeklyCreated: bucketByWeek(await prfRepo.createdSince(sparkSince, scope), SPARK_WEEKS, now),
    })),
    section("openPos", canPo, async () => {
      const [open, created] = await Promise.all([poRepo.openSummary(scope), poRepo.createdSince(sparkSince, scope)]);
      return { count: open.count, valuePence: open.valuePence, weeklyCreated: bucketByWeek(created, SPARK_WEEKS, now) };
    }),
    section("activeJobs", canJobs, async () => ({
      count: await jobRepo.countActive(),
      weeklyCreated: bucketByWeek(await jobRepo.createdSince(sparkSince), SPARK_WEEKS, now),
    })),
    section("lowStock", canInv, async () => invRepo.lowStockCounts(scope)),
    section("poPipeline", canPo, async () => poRepo.pipelineCounts(scope)),
    section("spendTrend", canPo, async () => bucketByMonth(await poRepo.issuedSpendSince(spendSince, scope), SPEND_MONTHS, now)),
    section("activity", canAudit, async () => {
      const rows = await auditRepo.findMany({}, 0, ACTIVITY_LIMIT);
      return rows.map((a: any) => ({
        id: a.id, at: a.createdAt, actorName: a.actorEmail, action: a.action,
        entity: { type: a.targetType, code: a.targetLabel ?? a.targetId, id: a.targetId },
      }));
    }),
    section("worklist", qReviewPrf || qApprovePo || qSendPo || qAckPo || qReceive || qKit, async () => {
      const [wlPrf, wlFastPath, wlPending, wlPmReview, wlSent, wlReceive, wlKit] = await Promise.all([
        qReviewPrf ? prfRepo.submittedWorklist(scope) : Promise.resolve([]),
        qApprovePo ? poRepo.fastPathDraftWorklist(scope) : Promise.resolve([]),
        qApprovePo ? poRepo.statusWorklist("pending_approval", { warehouseIds: scope }) : Promise.resolve([]),
        qSendPo ? poRepo.statusWorklist("pm_review", { pmUserId: actor.id, warehouseIds: scope }) : Promise.resolve([]),
        qAckPo ? poRepo.statusWorklist("sent", { pmUserId: actor.id, warehouseIds: scope }) : Promise.resolve([]),
        qReceive ? poRepo.receivableWorklist(scope) : Promise.resolve([]),
        qKit ? kitRepo.pendingWorklist() : Promise.resolve([]),
      ]);
      const items: WorklistItem[] = [];
      const push = (row: WorklistItem) => items.push(row);
      // Detail routes are /dashboard/<module>/[id] where [id] accepts the DB id OR the code — and the
      // app-wide convention is that LIST ROWS LINK BY CODE (confirmed in the PRF/PO/job detail pages).
      // So hrefs use r.code (PRF-####, PO-####) / jobNumber, matching every other list in the app.
      for (const r of wlPrf) push({ kind: "review_prf", id: r.id, code: r.code, title: r.title, priority: r.priority, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-requests/${r.code}` });
      for (const r of wlFastPath) push({ kind: "approve_po_fastpath", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
      for (const r of wlPending) push({ kind: "review_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
      for (const r of wlPmReview) push({ kind: "send_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
      for (const r of wlSent) push({ kind: "acknowledge_po", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
      for (const r of wlReceive) push({ kind: "receive_goods", id: r.id, code: r.code, title: r.supplierName, priority: r.priority, dueDate: r.expectedDeliveryDate?.toISOString() ?? null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/purchase-orders/${r.code}` });
      // Kit request: code = the JKR (JKR-####); title/link target = its job (JOB-YYYY-####), where the PM acts.
      for (const r of wlKit) push({ kind: "review_kit_request", id: r.id, code: r.code, title: r.jobNumber, priority: null, dueDate: null, ageDays: daysBetween(r.createdAt, now), href: `/dashboard/jobs/${r.jobNumber}` });
      items.sort((a, b) => compareWorklist(a, b, now));
      return { items: items.slice(0, WORKLIST_CAP), total: items.length };
    }),
  ]);

  const cards: DashboardCards = {};
  if (values.pendingPrfs) cards.pendingPrfs = values.pendingPrfs as DashboardCards["pendingPrfs"];
  if (values.openPos) cards.openPos = values.openPos as DashboardCards["openPos"];
  if (values.activeJobs) cards.activeJobs = values.activeJobs as DashboardCards["activeJobs"];
  if (values.lowStock) cards.lowStock = values.lowStock as DashboardCards["lowStock"];

  const charts: DashboardCharts = {};
  if (values.poPipeline) charts.poPipeline = values.poPipeline as DashboardCharts["poPipeline"];
  if (values.spendTrend) charts.spendTrend = values.spendTrend as DashboardCharts["spendTrend"];

  const summary: DashboardSummary = { generatedAt: now.toISOString(), cards, charts };
  if (values.worklist) summary.worklist = values.worklist as DashboardSummary["worklist"];
  if (values.activity) summary.activity = values.activity as DashboardSummary["activity"];
  if (errors.length > 0) summary.errors = errors;
  return { summary };
}
```

> **Import-path check:** confirm the real module accessor names in the `vi.mock` paths (`#modules/inventory/inventory.repository.js` — verify the inventory module folder name; it may be `inventory` or similar). If the audit repo exposes `recent()` (Task 1f), call that instead of `findMany`. Confirm `principalGrants` is exported from `types/principal.ts` and `warehouseScopeFilter` from `lib/warehouse-access.ts`; fix the relative depth of the mock path (`../../../lib/...`) to match the test file location.
>
> **Casts:** the `as DashboardCards[...]` casts bridge `settle()`'s `Record<string, unknown>` back to the typed sections. They're safe because each key's producer returns exactly that shape; keep them narrow (per-field), not a blanket `as DashboardSummary`. If you prefer zero casts, make `settle` generic over a key→type map — optional polish, not required.

**Verify:** `pnpm typecheck && pnpm test -- dashboard.service`
**Commit:** `feat(dashboard): summary service — allSettled section isolation + typed DTO (tested)`

---

## Task 4 — Controller + route + mount

**`src/modules/dashboard/dashboard.controller.ts`** (thin — no logic; use `asyncHandler` like every other read controller, e.g. `audit.controller.ts`, so rejections reach the error middleware):

```ts
import { asyncHandler } from "../../utils/async-handler.js";
import { buildDashboardSummary } from "./dashboard.service.js";

// GET /dashboard/summary (protected: requireAuth; per-section gating inside the service).
export const getSummary = asyncHandler(async (req, res) => {
  res.json(await buildDashboardSummary(req.principal!));
});
```

> **Check:** confirm `req.principal` is the augmented request field (it is — `requireAuth` attaches it, typed as `Principal`). `asyncHandler` lives at `src/utils/async-handler.js`.

**`src/modules/dashboard/dashboard.routes.ts`** — mirror `audit.routes.ts` **exactly**: read routes here apply auth via `router.use(requireAuth)` at the top and **no rate limiter** (there is no bare `rateLimit` export — the middleware only exports named limiters like `exportLimiter`; read routes don't use one). Per-section gating happens inside the service, so **no `requirePermission` on the route** (that's the whole point of the aggregated endpoint — a Finance user still gets a 200 with only their sections):

```ts
import { Router } from "express";

import * as dashboardController from "./dashboard.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

// GET /dashboard/summary — the aggregated, per-section permission-gated Overview payload.
// Auth-only at the route; each section is gated inside the service (missing key = no permission).
router.get("/summary", dashboardController.getSummary);

export default router;
```

**Mount** in `src/routes/index.ts`: add the import near the other `#modules/*` imports (keep the file's rough alphabetical order — after the `customer` imports, before `department`):

```ts
import dashboardRoutes from "#modules/dashboard/dashboard.routes.js";
```

and add the mount alongside the other `router.use(...)` lines (placement is free-form; near the top with the other cross-cutting reads reads fine):

```ts
router.use("/dashboard", dashboardRoutes);
```

**Verify:** `pnpm typecheck && pnpm lint && pnpm test`
**Commit:** `feat(dashboard): mount GET /dashboard/summary (route + thin controller)`

---

## Task 5 — Frontend service wrapper + types

**`src/services/dashboard.service.ts`** — typed wrapper over `api()` (never call axios directly). The two apps don't share a package, so these interfaces are a **hand-maintained mirror of the backend's `dashboard.types.ts` (Task 3a)** — keep them structurally identical, including the `errors?` partial-failure field. Every section optional to mirror the permission-gated contract:

```ts
import { api } from "@/lib/api";

export interface StatCardData { count: number; weeklyCreated: number[]; }
export interface OpenPosCard extends StatCardData { valuePence: number; }
export interface LowStockCard { count: number; criticalCount: number; }
export interface SpendPoint { month: string; totalPence: number; }
export interface PipelinePoint { status: string; count: number; }
export interface WorklistItemDTO {
  kind: string; id: string; code: string; title: string | null;
  priority: string | null; dueDate: string | null; ageDays: number; href: string;
}
export interface ActivityDTO {
  id: string; at: string; actorName: string; action: string;
  entity: { type: string; code: string; id: string };
}
export interface DashboardSummary {
  generatedAt: string;
  cards: { pendingPrfs?: StatCardData; openPos?: OpenPosCard; activeJobs?: StatCardData; lowStock?: LowStockCard };
  charts: { spendTrend?: SpendPoint[]; poPipeline?: PipelinePoint[] };
  worklist?: { items: WorklistItemDTO[]; total: number };
  activity?: ActivityDTO[];
  /** Section keys that were permitted but failed server-side. Absent when all sections succeeded.
   *  A no-permission section is simply absent from cards/charts and is NOT listed here. */
  errors?: string[];
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const { summary } = await api<{ summary: DashboardSummary }>("/dashboard/summary");
  return summary;
}
```

> **api() shape check:** confirm how `api()` is called elsewhere (e.g. `user.service.ts`) — method/URL/generic order — and match it exactly (it may be `api.get(...)` or `api("/path", { method })`). Keep the returned `DashboardSummary` type as-is.

**Verify:** `pnpm lint`
**Commit:** `feat(dashboard): frontend dashboard.service typed summary wrapper`

---

## Task 6 — Widget components (visual language from reference)

Create in `src/components/dashboard/home/`. Adapt visuals **only** from `reference/tabs/OverviewTab.tsx` (card className `card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs`, `computeSpline`/`getSparklinePath`, hover crosshair+tooltip, ResizeObserver width, badge classes). Reuse `formatMoney` (POUNDS — divide pence by 100), `PO_STATUS_LABELS`/`PoStatusBadge` from `purchase-orders/poStatus.tsx`, and `actionLabel`/`actionTone`/`TONE_CLASSES`/`relativeTime` from `audit/auditDisplay.ts`.

Build these, each a focused file:

1. **`StatCard.tsx`** — title, big count, optional secondary (`valuePence`→`formatMoney(v/100)` or "N critical" chip), optional sparkline via a small `Sparkline.tsx` (port `getSparklinePath`). Whole card is a `<Link>` to the owning list. Props: `{ title, count, secondary?, spark?, href }`.
2. **`Sparkline.tsx`** — pure SVG from a `number[]`, theme-aware stroke `var(--accent)`, no axes. Empty/flat series renders a flat baseline.
3. **`SpendTrendChart.tsx`** — port the reference area chart: `computeSpline`, gradient fill, hover crosshair + tooltip, ResizeObserver width. Input `SpendPoint[]`; format tooltip £ with `formatMoney(totalPence/100)`; x-labels = month short names.
4. **`PipelineBars.tsx`** — the reference bar panel over `PipelinePoint[]`; each bar labeled via `PO_STATUS_LABELS`, links to `/dashboard/purchase-orders?status=<status>`; bar color can reuse the status hue or a single accent.
5. **`WorklistPanel.tsx`** — full-width table/list over `worklist.items`: kind badge (small label map for the 7 kinds), `code` linking to `href`, `title`, age (`{ageDays} d`), a primary-action label per kind. Header shows `total` + "view all". Empty → "All clear ✓ — nothing needs your action." Overdue rows (dueDate in past) get a subtle `var(--neg)` accent.
6. **`ActivityFeed.tsx`** — list over `activity`: tone dot via `actionTone(action)`→`TONE_CLASSES`, `actionLabel(action)` phrasing, entity `code` link (PO/PRF/job → its detail route), `relativeTime(at)` with `absoluteTime` title. Empty → "No recent activity."
7. **`QuickActions.tsx`** — desktop: individual permission-gated `<Link>` buttons (+ New PRF / + New PO / + New Job / Goods In) to the confirmed `/new` routes; narrow viewport: collapse into one "+ New" dropdown. Gate each with `useAuth()` permissions.

> **No new fetching in components** — they take data via props from the page. Keep each file small and theme-variable-driven. Do not hardcode colors that break dark mode; use the CSS vars the reference uses.

**Verify:** `pnpm lint` (components compile in Task 7's build)
**Commit:** `feat(dashboard): home widget components (cards, charts, worklist, activity, quick actions)`

---

## Task 7 — Overview page + sidebar entry (wire it up)

**`src/app/dashboard/page.tsx`** — remove the `firstDashboardPath` redirect; make it the Overview screen:

- Client component. Fetch once via `getDashboardSummary()` (in `useEffect`/loader consistent with sibling pages) with loading + error states.
- **Loading:** skeleton cards + chart placeholders matching the grid (no full-page spinner).
- Render, in spec order: `QuickActions` (top-right of an "Overview" header) → KPI card grid (only the cards present in `summary.cards`, grid reflows) → `WorklistPanel` (full width, only if `summary.worklist`) → `SpendTrendChart` + `PipelineBars` row (each only if its chart key present) → `ActivityFeed` (only if `summary.activity`).
- Header shows "Updated {relativeTime(generatedAt)}".
- **Partial failure:** if `summary.errors?.length`, show a single dismissible inline notice above the grid — "Some sections couldn't load: {errors.join(', ')}" (muted/`var(--warn)` styling, not a blocking error). The rest of the dashboard still renders. Distinct from no-permission sections, which are silently absent.
- **No visible sections at all** (empty `cards`/`charts` and no worklist/activity) → render existing `NoAccessHome`. (An all-failed load — everything permitted but every section in `errors` — shows the error notice with empty groups, **not** `NoAccessHome`; don't confuse "no permission" with "everything errored".)
- Responsive per spec: 4→2→1 cards; chart row stacks on tablet; single-column mobile.

**`src/components/dashboard/shell/Sidebar.tsx`** — add as the FIRST `NAV` item: `{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, perms: [] }` (`LayoutDashboard` already imported; `perms: []` = always visible for staff). Confirm the nav-render logic treats `perms: []` as "always show" (if it needs at least one matching perm, use the sentinel the file already uses for always-visible items, or adjust the predicate).

**`src/lib/auth.ts`** — `firstDashboardPath()` stays for deep-link fallbacks; ensure login/home lands on `/dashboard` (`homeFor()` already returns `/dashboard`). No behavior change needed beyond the page no longer redirecting.

**Verify:** `pnpm lint && pnpm build`
**Commit:** `feat(dashboard): Overview page + Dashboard sidebar entry (redirect removed)`

---

## Task 8 — Full verification pass

Backend (`cd backend`): `pnpm typecheck && pnpm lint && pnpm test` — all green.
Frontend (`cd frontend`): `pnpm lint && pnpm build` — clean build.

Manual role walkthrough (dev servers running, both apps up):

- **Super-admin** — all cards, both charts, full worklist, activity; every number links correctly.
- **Finance** (`purchase_requests.*`, `purchase_orders.*`) — PRF/PO cards + queues; no inventory card if lacking `inventory.view`.
- **PM** — send/acknowledge/kit queues populate; PM-scoped rows only show that PM's POs.
- **Warehouse manager** — Open POs / Low Stock / receive queue reflect only assigned warehouses; spend/pipeline scoped.
- **No-permission user** — `NoAccessHome` renders; no empty module-shaped cards leak.
- **Partial failure** — temporarily make one repo throw (or point it at a bad collection) and confirm the dashboard still renders, the failed section is absent, and the "Some sections couldn't load" notice names it. Revert the sabotage after.
- Sparklines show real created-volume; empty states read friendly; "Updated X ago" present.

**Performance check (first-screen budget):** with realistically seeded data (hundreds–low-thousands of POs/PRFs/jobs), hit `GET /dashboard/summary` as a super-admin (widest fan-out) and confirm a warm p50 **< 500 ms**. Measure once — this is the screen every user lands on. Quick options: browser Network tab timing, or `curl -w "%{time_total}\n" -o /dev/null -s --cookie <auth> http://localhost:8000/dashboard/summary` a handful of times and read the median. If it's over budget, the likely culprit is `lowStockCounts` fetching all balances — note it and consider a Mongo aggregation there before shipping; don't add the rejected server-side cache.

**Commit (docs, if anything adjusted):** `docs(dashboard): note verification results` (optional).

---

## Done criteria

- `GET /dashboard/summary` returns grouped, permission-gated, warehouse-scoped data; missing key = no permission, empty = permitted-but-empty; `generatedAt` present (server-UTC ISO).
- Response is a **typed DTO** (`dashboard.types.ts`) end to end — no `Record<string, unknown>` in the shipped contract.
- **Partial failure is isolated:** one section throwing never 500s the endpoint; the failed section is omitted and named in `errors[]`; no-permission sections stay absent and out of `errors`.
- All Prisma access is in owning repositories (dashboard-specific read-models, not a generic reporting API); dashboard module owns no Prisma and no persistence.
- Worklist comparator + bucketing helpers + service gating **and the allSettled degradation path** are unit-tested and green.
- `/dashboard` renders the Overview (no redirect); "Dashboard" is the first sidebar item; login lands there.
- Reference visual language reused; no fabricated data; customers unaffected.
- First-screen `GET /dashboard/summary` measured once under seeded data (p50 < 500 ms budget).
- `pnpm typecheck`/`lint`/`test` (backend) and `lint`/`build` (frontend) all pass.
