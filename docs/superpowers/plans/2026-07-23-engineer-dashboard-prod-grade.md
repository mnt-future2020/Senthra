# Engineer Dashboard — Production-Grade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Engineer Portal dashboard production-grade — surface every module's actionable signal (jobs, field stock, transfers, kit), live-update over sockets, deep-link every card, and match the admin dashboard's refresh/skeleton/error polish.

**Architecture:** Extend the existing server-side `getOwnOverview` aggregation with three new read-only counts (van-stock to collect, kit pending, transfers to sign) via two thin `count` repository helpers + one reuse. On the frontend, migrate the `EngineerOverview` type, extract the card/attention logic into a pure, unit-tested view-model module, add a data+realtime hook, split the view into focused components, and rewrite `EngineerDashboard.tsx` as a thin orchestrator.

**Tech Stack:** Express 5 + Prisma (Mongo) + vitest (backend, pnpm); Next.js 16 + React 19 + Tailwind v4 + lucide-react + vitest (frontend, pnpm).

## Global Constraints

- **ESM / NodeNext (backend):** every relative import MUST end in `.js` (source is `.ts`). Cross-module imports use the `#modules/<domain>/...` alias, also with `.js`. Same-module imports stay relative (`./x.js`); shared dirs relative (`../../lib/x.js`).
- **Repositories are the ONLY place Prisma is touched.** New counts are `prisma.count` in the owning module's repository, exposed by a one-line service wrapper.
- **No `schema.prisma` change → do NOT run `npx prisma db push`.** All three new reads are aggregations over existing collections.
- **No new permissions.** Reuse the 6 existing strings: `engineer.dashboard.view`, `engineer.jobs.view`, `engineer.inventory.view`, `engineer.transfer`, `engineer.van_stock.request`, `engineer.jobs.request_kit`.
- **Frontend never calls axios/fetch directly** — always through `@/services/*`.
- **Verified deep-link params (2026-07-23):** jobs `?status=` ([EngineerJobs.tsx:32-38]), van-stock `?status=` ([EngineerVanStock.tsx:90]), transfers `?view=` ([EngineerTransfers.tsx:712]), inventory `?section=` ([EngineerInventory.tsx:40]).
- **Git is gated on explicit user approval** (project rule). The working tree already holds unrelated WIP, so every commit step uses explicit `git add <paths>` (never `git add -A`) to scope the commit to this plan's files only. Pause for the user's go-ahead before the first commit.

---

## Task 1: Van-stock "to collect" count (backend)

**Files:**
- Modify: `backend/src/modules/van-stock-request/van-stock-request.repository.ts` (add one function)
- Modify: `backend/src/modules/van-stock-request/van-stock-request.service.ts` (add one wrapper; imports repo as `vsrRepo`)

**Interfaces:**
- Produces: `vanStockRequestService.countCollectible(engineerId: string): Promise<number>` — restocks the engineer still has to collect (`approved` + `partially_fulfilled`).

- [ ] **Step 1: Add the repository count.** Append to `van-stock-request.repository.ts` (uses `prisma` already imported at the top, mirrors the existing open-of-type query at line ~247):

```ts
// Restocks the engineer still has to physically collect: approved or partially fulfilled.
// Returns are excluded — the warehouse scans those in; only restocks are collected by the engineer.
export function countCollectibleRestocks(engineerId: string): Promise<number> {
  return prisma.vanStockRequest.count({
    where: { engineerId, type: "restock", deletedAt: null, status: { in: ["approved", "partially_fulfilled"] } },
  });
}
```

- [ ] **Step 2: Add the service wrapper.** Append to `van-stock-request.service.ts` (repo is imported as `vsrRepo` at line 16):

```ts
// Count of the engineer's restocks awaiting collection — for the Engineer dashboard "Field stock to collect" card.
export function countCollectible(engineerId: string): Promise<number> {
  return vsrRepo.countCollectibleRestocks(engineerId);
}
```

- [ ] **Step 3: Typecheck + lint.**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: PASS (no errors). No unit test here — the repo layer is a thin Prisma wrapper (consistent with every other repo method; the filter is locked by Task 3's aggregation test + manual verification in §8 of the spec).

- [ ] **Step 4: Commit** (after user approval):

```bash
git add backend/src/modules/van-stock-request/van-stock-request.repository.ts backend/src/modules/van-stock-request/van-stock-request.service.ts
git commit -m "feat(van-stock): countCollectible — engineer restocks awaiting collection"
```

---

## Task 2: Transfers "to sign" count (backend)

**Files:**
- Modify: `backend/src/modules/engineer-transfer/engineer-transfer.repository.ts` (add one function; has private `engineerWhere` at line 211, `prisma` imported)
- Modify: `backend/src/modules/engineer-transfer/engineer-transfer.service.ts` (add one wrapper; imports repo as `transferRepo` at line 12)

**Interfaces:**
- Produces: `engineerTransferService.countAwaitingSignature(engineerId: string): Promise<number>` — delivered (`completed`) outgoing transfers the engineer received that still need their signature.

- [ ] **Step 1: Add the repository count.** Append to `engineer-transfer.repository.ts`. `engineerWhere(engineerId, "outgoing")` scopes to transfers the engineer received (they are the recipient/requester); combine it with the completed-but-unsigned filter:

```ts
// Delivered transfers the engineer received that still require their signature:
// outgoing (engineer is the recipient) + completed + requireSignature + not yet acknowledged.
export function countAwaitingSignature(engineerId: string): Promise<number> {
  return prisma.engineerStockTransfer.count({
    where: { AND: [engineerWhere(engineerId, "outgoing", "completed"), { requireSignature: true, acknowledgedAt: null }] },
  });
}
```

- [ ] **Step 2: Add the service wrapper.** Append to `engineer-transfer.service.ts` (repo imported as `transferRepo`):

```ts
// Count of completed transfers awaiting the engineer's receipt signature — Engineer dashboard attention row.
export function countAwaitingSignature(engineerId: string): Promise<number> {
  return transferRepo.countAwaitingSignature(engineerId);
}
```

- [ ] **Step 3: Typecheck + lint.**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit** (after user approval):

```bash
git add backend/src/modules/engineer-transfer/engineer-transfer.repository.ts backend/src/modules/engineer-transfer/engineer-transfer.service.ts
git commit -m "feat(engineer-transfer): countAwaitingSignature — delivered transfers needing a signature"
```

---

## Task 3: Extend `getOwnOverview` + `EngineerOverview` (backend, TDD)

**Files:**
- Modify: `backend/src/modules/engineer/engineer.service.ts` (interface + `getOwnOverview` + 2 imports)
- Test: `backend/src/modules/engineer/engineer.service.test.ts` (update zeros case, add new-counts case, add mocks)

**Interfaces:**
- Consumes: `vanStockRequestService.countCollectible` (Task 1), `engineerTransferService.countAwaitingSignature` (Task 2), `kitRequestService.listMine(engineerId, { status: "pending", pageSize: 1 })` (existing, returns `{ total: number; ... }`).
- Produces: `EngineerOverview` new shape — `transfers: { incomingPending: number; toSign: number }`, `vanStock: { toCollect: number }`, `kitRequests: { pending: number }` (replaces top-level `pendingTransfers`).

- [ ] **Step 1: Write the failing tests.** In `engineer.service.test.ts`, (a) add the two new service mocks after the existing `vi.mock` calls, (b) extend the engineer-transfer mock with `countAwaitingSignature`, (c) add mock handles + `beforeEach` defaults, (d) update the "clean zeros" assertion to the new shape, (e) add a new counts test.

Add/replace the mock block near the top:

```ts
vi.mock("#modules/job/job.service.js", () => ({ listJobsForEngineer: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({ listMine: vi.fn(), countAwaitingSignature: vi.fn() }));
vi.mock("#modules/van-stock-request/van-stock-request.service.js", () => ({ countCollectible: vi.fn() }));
vi.mock("#modules/job-kit-request/job-kit-request.service.js", () => ({ listMine: vi.fn() }));
```

Add imports + handles (next to the existing `mockListMine`):

```ts
import * as vanStockRequestService from "#modules/van-stock-request/van-stock-request.service.js";
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";

const mockCountCollectible = vanStockRequestService.countCollectible as ReturnType<typeof vi.fn>;
const mockKitListMine = kitRequestService.listMine as ReturnType<typeof vi.fn>;
const mockCountAwaitingSignature = engineerTransferService.countAwaitingSignature as ReturnType<typeof vi.fn>;
```

Extend `beforeEach` with defaults:

```ts
  mockCountCollectible.mockResolvedValue(0);
  mockKitListMine.mockResolvedValue({ requests: [], total: 0, page: 1, pageSize: 1, totalPages: 0 });
  mockCountAwaitingSignature.mockResolvedValue(0);
```

Replace the "clean zeros" expectation with the new shape:

```ts
    expect(ov).toEqual({
      stock: { lines: 0, totalQuantity: 0 },
      jobs: { toAccept: 0, accepted: 0, inProgress: 0, overdue: 0, dueThisWeek: 0, next: [] },
      transfers: { incomingPending: 0, toSign: 0 },
      vanStock: { toCollect: 0 },
      kitRequests: { pending: 0 },
      recentActivity: [],
    });
```

Add a new test inside `describe("getOwnOverview", ...)`:

```ts
  it("surfaces the new module counts (van-stock to collect, kit pending, transfers to sign)", async () => {
    mockBalances.mockResolvedValue([]);
    mockTxns.mockResolvedValue([]);
    mockCountCollectible.mockResolvedValue(2);
    mockKitListMine.mockResolvedValue({ requests: [], total: 3, page: 1, pageSize: 1, totalPages: 3 });
    mockCountAwaitingSignature.mockResolvedValue(1);
    mockListMine.mockResolvedValue({ transfers: [], total: 4, page: 1, pageSize: 1, totalPages: 4 });

    const ov = await getOwnOverview(ENG);

    expect(ov.vanStock).toEqual({ toCollect: 2 });
    expect(ov.kitRequests).toEqual({ pending: 3 });
    expect(ov.transfers).toEqual({ incomingPending: 4, toSign: 1 });
    expect(mockCountCollectible).toHaveBeenCalledWith(ENG);
    expect(mockCountAwaitingSignature).toHaveBeenCalledWith(ENG);
    expect(mockKitListMine).toHaveBeenCalledWith(ENG, { status: "pending", pageSize: 1 });
  });
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd backend && pnpm test engineer.service`
Expected: FAIL — the zeros case fails on `transfers`/`vanStock`/`kitRequests` shape and the new case fails (`ov.vanStock` undefined), because the implementation still returns the old shape.

- [ ] **Step 3: Implement.** In `engineer.service.ts`: add the two imports at the top (with the other `#modules/*` imports):

```ts
import * as vanStockRequestService from "#modules/van-stock-request/van-stock-request.service.js";
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";
```

Replace the `EngineerOverview` interface's `pendingTransfers` field with the three new fields:

```ts
export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  jobs: {
    toAccept: number;
    accepted: number;
    inProgress: number;
    overdue: number;
    dueThisWeek: number;
    next: EngineerOverviewJob[];
  };
  // Incoming = transfers awaiting this engineer's acceptance; toSign = delivered transfers awaiting their signature.
  transfers: { incomingPending: number; toSign: number };
  // Restocks approved/partially-fulfilled and waiting to be collected from a warehouse.
  vanStock: { toCollect: number };
  // The engineer's own kit requests still awaiting a planner decision (across all jobs).
  kitRequests: { pending: number };
  recentActivity: EngineerActivity[];
}
```

In `getOwnOverview`, extend the `Promise.all` (append three entries) and rebuild the return object:

```ts
  const [stock, recentActivity, assigned, accepted, inProgress, pendingIncoming, toCollect, kitPending, toSign] = await Promise.all([
    getOwnStock(engineerId),
    getOwnActivity(engineerId, 8),
    jobService.listJobsForEngineer(engineerId, { status: "assigned", pageSize: ACTIVE_JOB_FETCH_CAP }),
    jobService.listJobsForEngineer(engineerId, { status: "accepted", pageSize: ACTIVE_JOB_FETCH_CAP }),
    jobService.listJobsForEngineer(engineerId, { status: "in_progress", pageSize: ACTIVE_JOB_FETCH_CAP }),
    engineerTransferService.listMine(engineerId, { role: "incoming", status: "pending", pageSize: 1 }),
    vanStockRequestService.countCollectible(engineerId),
    kitRequestService.listMine(engineerId, { status: "pending", pageSize: 1 }),
    engineerTransferService.countAwaitingSignature(engineerId),
  ]);
```

(Leave the `active` / `overdue` / `dueThisWeek` / `next` block unchanged.) Replace the returned object's tail:

```ts
  return {
    stock: { lines: stock.length, totalQuantity: stock.reduce((sum, i) => sum + i.quantityOnHand, 0) },
    jobs: { toAccept: assigned.total, accepted: accepted.total, inProgress: inProgress.total, overdue, dueThisWeek, next },
    transfers: { incomingPending: pendingIncoming.total, toSign },
    vanStock: { toCollect },
    kitRequests: { pending: kitPending.total },
    recentActivity,
  };
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd backend && pnpm test engineer.service`
Expected: PASS (all `getOwnStock` / `getOwnActivity` / `getOwnOverview` tests green).

- [ ] **Step 5: Full backend gate.**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. (Confirms the two new service functions resolve and nothing else regressed.)

- [ ] **Step 6: Commit** (after user approval):

```bash
git add backend/src/modules/engineer/engineer.service.ts backend/src/modules/engineer/engineer.service.test.ts
git commit -m "feat(engineer): overview surfaces van-stock, kit and transfer-signature counts"
```

---

## Task 4: Frontend `EngineerOverview` type migration

**Files:**
- Modify: `frontend/src/types/engineer.ts`

**Interfaces:**
- Produces: the frontend `EngineerOverview` mirroring Task 3's backend shape.

- [ ] **Step 1: Replace the interface.** In `frontend/src/types/engineer.ts`, replace the `EngineerOverview` interface (keep `EngineerStockItem`, `EngineerActivity`, `EngineerOverviewJob` unchanged):

```ts
export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  jobs: {
    toAccept: number;
    accepted: number;
    inProgress: number;
    overdue: number;
    dueThisWeek: number;
    next: EngineerOverviewJob[];
  };
  transfers: { incomingPending: number; toSign: number };
  vanStock: { toCollect: number };
  kitRequests: { pending: number };
  recentActivity: EngineerActivity[];
}
```

- [ ] **Step 2: Confirm nothing else read the old field.**

Run: `cd frontend && grep -rn "pendingTransfers" src`
Expected: **no matches** (the dashboard rewrite in Task 8 is the only consumer and does not exist yet). If any match appears outside `EngineerDashboard.tsx`, stop and reconcile.

- [ ] **Step 3: Typecheck.**

Run: `cd frontend && npx tsc --noEmit`
Expected: FAIL only inside `EngineerDashboard.tsx` (it still reads `overview.pendingTransfers` / old `stock` usage). That file is fully replaced in Task 8; this is expected. No other file may error.

- [ ] **Step 4: Commit** (after user approval):

```bash
git add frontend/src/types/engineer.ts
git commit -m "feat(engineer-ui): migrate EngineerOverview type to the new overview shape"
```

---

## Task 5: Dashboard view-model (pure, TDD)

**Files:**
- Create: `frontend/src/components/dashboard/engineer/dashboard/engineerDashboardModel.ts`
- Test: `frontend/src/components/dashboard/engineer/dashboard/engineerDashboardModel.test.ts`

**Interfaces:**
- Consumes: `EngineerOverview` (Task 4), a `can: (perm: string) => boolean` predicate.
- Produces: `buildStatCards(o, can): StatCardModel[]`, `buildAttentionRows(o, can): AttentionRowModel[]`, and the exported types `StatCardModel`, `AttentionRowModel`.

- [ ] **Step 1: Write the failing test.** Create `engineerDashboardModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import type { EngineerOverview } from "@/types/engineer";
import { buildStatCards, buildAttentionRows } from "./engineerDashboardModel";

const base: EngineerOverview = {
  stock: { lines: 3, totalQuantity: 29 },
  jobs: { toAccept: 2, accepted: 1, inProgress: 4, overdue: 1, dueThisWeek: 0, next: [] },
  transfers: { incomingPending: 1, toSign: 2 },
  vanStock: { toCollect: 3 },
  kitRequests: { pending: 1 },
  recentActivity: [],
};
const allow = () => true;
const deny = () => false;

describe("buildStatCards", () => {
  it("gates cards by permission and deep-links each to its filtered list", () => {
    const byKey = Object.fromEntries(buildStatCards(base, allow).map((c) => [c.key, c]));
    expect(byKey.toAccept.href).toBe("/dashboard/engineer/jobs?status=assigned");
    expect(byKey.inProgress.href).toBe("/dashboard/engineer/jobs?status=in_progress");
    expect(byKey.vanStock.href).toBe("/dashboard/engineer/van-stock?status=approved");
    expect(byKey.transfers.href).toBe("/dashboard/engineer/transfers?view=incoming");
    expect(byKey.stock.value).toBe(29);
  });

  it("hides job/transfer/van cards without permission; the stock card always shows", () => {
    expect(buildStatCards(base, deny).map((c) => c.key)).toEqual(["stock"]);
  });

  it("flags overdue in the in-progress hint", () => {
    const inProg = buildStatCards(base, allow).find((c) => c.key === "inProgress")!;
    expect(inProg.hint).toBe("1 overdue");
    expect(inProg.hintTone).toBe("red");
  });
});

describe("buildAttentionRows", () => {
  it("includes only rows whose count > 0 and whose permission holds, in priority order", () => {
    expect(buildAttentionRows(base, allow).map((r) => r.key)).toEqual(["accept", "overdue", "vanStock", "incoming", "toSign", "kit"]);
  });

  it("returns nothing when everything is clear", () => {
    const clear: EngineerOverview = {
      ...base,
      jobs: { ...base.jobs, toAccept: 0, overdue: 0 },
      transfers: { incomingPending: 0, toSign: 0 },
      vanStock: { toCollect: 0 },
      kitRequests: { pending: 0 },
    };
    expect(buildAttentionRows(clear, allow)).toEqual([]);
  });

  it("drops both transfer rows without engineer.transfer", () => {
    const can = (p: string) => p !== "engineer.transfer";
    const keys = buildAttentionRows(base, can).map((r) => r.key);
    expect(keys).not.toContain("incoming");
    expect(keys).not.toContain("toSign");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd frontend && pnpm test engineerDashboardModel`
Expected: FAIL — "Failed to resolve import ./engineerDashboardModel" (module not created yet).

- [ ] **Step 3: Implement.** Create `engineerDashboardModel.ts`:

```ts
import type { EngineerOverview } from "@/types/engineer";

// Pure view-model builders: map the overview + the actor's permissions to plain, serialisable card /
// attention-row descriptors. Kept free of React/JSX so the permission, deep-link and copy logic is
// unit-tested in isolation; the components (EngineerStatCards / AttentionStrip) only render these.

export type CardTone = "neutral" | "accent" | "amber";
export type RowTone = "accent" | "amber" | "red" | "muted";
export type CardIcon = "inbox" | "wrench" | "boxes" | "truck" | "arrowRightLeft";
export type RowIcon = "inbox" | "alertTriangle" | "truck" | "arrowRightLeft" | "penLine" | "wrench";

export interface StatCardModel {
  key: string;
  iconKey: CardIcon;
  tone: CardTone;
  value: number;
  label: string;
  hint: string;
  hintTone?: "red";
  href: string;
}

export interface AttentionRowModel {
  key: string;
  iconKey: RowIcon;
  tone: RowTone;
  text: string;
  href: string;
}

const s = (n: number) => (n === 1 ? "" : "s");

export function buildStatCards(o: EngineerOverview, can: (p: string) => boolean): StatCardModel[] {
  const canJobs = can("engineer.jobs.view");
  const canTransfer = can("engineer.transfer");
  const canVanStock = can("engineer.van_stock.request");
  const cards: StatCardModel[] = [];

  if (canJobs) {
    cards.push({
      key: "toAccept",
      iconKey: "inbox",
      tone: o.jobs.toAccept > 0 ? "amber" : "neutral",
      value: o.jobs.toAccept,
      label: "Jobs to accept",
      hint: o.jobs.toAccept > 0 ? "awaiting your response" : "nothing waiting",
      href: "/dashboard/engineer/jobs?status=assigned",
    });
    cards.push({
      key: "inProgress",
      iconKey: "wrench",
      tone: "accent",
      value: o.jobs.inProgress,
      label: "In progress",
      hint:
        o.jobs.overdue > 0
          ? `${o.jobs.overdue} overdue`
          : o.jobs.accepted > 0
            ? `${o.jobs.accepted} accepted, not started`
            : o.jobs.dueThisWeek > 0
              ? `${o.jobs.dueThisWeek} due this week`
              : "nothing due this week",
      hintTone: o.jobs.overdue > 0 ? "red" : undefined,
      href: "/dashboard/engineer/jobs?status=in_progress",
    });
  }

  if (canVanStock) {
    cards.push({
      key: "vanStock",
      iconKey: "truck",
      tone: o.vanStock.toCollect > 0 ? "accent" : "neutral",
      value: o.vanStock.toCollect,
      label: "Field stock to collect",
      hint: o.vanStock.toCollect > 0 ? "ready at the warehouse" : "nothing to collect",
      href: "/dashboard/engineer/van-stock?status=approved",
    });
  }

  if (canTransfer) {
    cards.push({
      key: "transfers",
      iconKey: "arrowRightLeft",
      tone: o.transfers.incomingPending > 0 ? "accent" : "neutral",
      value: o.transfers.incomingPending,
      label: "Transfers pending",
      hint: o.transfers.incomingPending > 0 ? "waiting for your acceptance" : "inbox clear",
      href: "/dashboard/engineer/transfers?view=incoming",
    });
  }

  cards.push({
    key: "stock",
    iconKey: "boxes",
    tone: "neutral",
    value: o.stock.totalQuantity,
    label: "Stock on hand",
    hint: `${o.stock.lines} item${s(o.stock.lines)} held`,
    href: "/dashboard/engineer/inventory",
  });

  return cards;
}

export function buildAttentionRows(o: EngineerOverview, can: (p: string) => boolean): AttentionRowModel[] {
  const canJobs = can("engineer.jobs.view");
  const canTransfer = can("engineer.transfer");
  const canVanStock = can("engineer.van_stock.request");
  const rows: AttentionRowModel[] = [];

  if (canJobs && o.jobs.toAccept > 0)
    rows.push({ key: "accept", iconKey: "inbox", tone: "amber", text: `${o.jobs.toAccept} job${s(o.jobs.toAccept)} waiting for you to accept or reject`, href: "/dashboard/engineer/jobs?status=assigned" });
  if (canJobs && o.jobs.overdue > 0)
    rows.push({ key: "overdue", iconKey: "alertTriangle", tone: "red", text: `${o.jobs.overdue} active job${o.jobs.overdue === 1 ? " is" : "s are"} past the completion date`, href: "/dashboard/engineer/jobs" });
  if (canVanStock && o.vanStock.toCollect > 0)
    rows.push({ key: "vanStock", iconKey: "truck", tone: "accent", text: `${o.vanStock.toCollect} field-stock request${s(o.vanStock.toCollect)} ready to collect`, href: "/dashboard/engineer/van-stock?status=approved" });
  if (canTransfer && o.transfers.incomingPending > 0)
    rows.push({ key: "incoming", iconKey: "arrowRightLeft", tone: "accent", text: `${o.transfers.incomingPending} incoming transfer${s(o.transfers.incomingPending)} to accept`, href: "/dashboard/engineer/transfers?view=incoming" });
  if (canTransfer && o.transfers.toSign > 0)
    rows.push({ key: "toSign", iconKey: "penLine", tone: "accent", text: `${o.transfers.toSign} delivered transfer${s(o.transfers.toSign)} need${o.transfers.toSign === 1 ? "s" : ""} your signature`, href: "/dashboard/engineer/transfers?view=outgoing" });
  if (canJobs && o.kitRequests.pending > 0)
    rows.push({ key: "kit", iconKey: "wrench", tone: "muted", text: `${o.kitRequests.pending} kit request${s(o.kitRequests.pending)} awaiting the planner`, href: "/dashboard/engineer/jobs" });

  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd frontend && pnpm test engineerDashboardModel`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit** (after user approval):

```bash
git add "frontend/src/components/dashboard/engineer/dashboard/engineerDashboardModel.ts" "frontend/src/components/dashboard/engineer/dashboard/engineerDashboardModel.test.ts"
git commit -m "feat(engineer-ui): pure dashboard view-model (cards + attention rows) with tests"
```

---

## Task 6: `useEngineerOverview` data + realtime hook

**Files:**
- Create: `frontend/src/components/dashboard/engineer/dashboard/useEngineerOverview.ts`

**Interfaces:**
- Consumes: `engineerService.getOwnOverview()`, `engineerService.getOwnMovements()`; `useJobSocket`, `useGoodsSocket`, `subscribe`, `useAuth`.
- Produces: `useEngineerOverview(): { overview, recent, loading, refreshing, error, updatedAt, reload }` where `updatedAt: string | null` (ISO), `reload: () => void`.

- [ ] **Step 1: Create the hook.** Create `useEngineerOverview.ts`:

```ts
"use client";

import * as React from "react";

import * as engineerService from "@/services/engineer.service";
import { useAuth } from "@/hooks/useAuth";
import { useJobSocket } from "@/hooks/useJobSocket";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import { subscribe } from "@/lib/socket";
import type { EngineerOverview } from "@/types/engineer";
import type { Movement } from "@/types/stock-position";

// Data source for the Engineer dashboard: the overview aggregation + the last few stock movements.
// First load shows a skeleton; every later load (manual refresh or a socket event) is silent — existing
// data stays on screen until the fresh payload swaps in. A monotonic guard drops a slow older response.
const EMPTY_MOVEMENTS = { movements: [] as Movement[], nextCursor: null, hasMore: false };

export interface EngineerOverviewState {
  overview: EngineerOverview | null;
  recent: Movement[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: string | null;
  reload: () => void;
}

export function useEngineerOverview(): EngineerOverviewState {
  const { principal } = useAuth();
  const [overview, setOverview] = React.useState<EngineerOverview | null>(null);
  const [recent, setRecent] = React.useState<Movement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);

  const seqRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++seqRef.current;
    // Yield one microtask so an effect-triggered load never setStates synchronously inside the effect
    // body (react-hooks/set-state-in-effect).
    await Promise.resolve();
    if (seq !== seqRef.current) return;
    setRefreshing(true);
    try {
      const [ov, mv] = await Promise.all([
        engineerService.getOwnOverview(),
        engineerService.getOwnMovements({ limit: 6 }).catch(() => EMPTY_MOVEMENTS),
      ]);
      if (seq !== seqRef.current) return;
      setOverview(ov);
      setRecent(mv.movements);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load your dashboard.");
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Live-update on the same events the module pages use. All arrive on the engineer's own per-user room,
  // so no permission gate is needed; subscribe() also re-fires on reconnect, recovering missed events.
  useJobSocket(load);
  useGoodsSocket(load);
  React.useEffect(() => {
    if (!principal) return;
    return subscribe(["van_stock_request:updated", "kit_request:updated"], () => void load());
  }, [principal, load]);

  return { overview, recent, loading, refreshing, error, updatedAt, reload: () => void load() };
}
```

- [ ] **Step 2: Typecheck + lint.**

Run: `cd frontend && npx tsc --noEmit && pnpm lint`
Expected: PASS for this file (the only remaining `tsc` error is still `EngineerDashboard.tsx`, replaced in Task 8).

- [ ] **Step 3: Commit** (after user approval):

```bash
git add "frontend/src/components/dashboard/engineer/dashboard/useEngineerOverview.ts"
git commit -m "feat(engineer-ui): useEngineerOverview hook (data + realtime + monotonic refresh)"
```

---

## Task 7: Presentational components

**Files:**
- Create: `frontend/src/components/dashboard/engineer/dashboard/EngineerStatCards.tsx`
- Create: `frontend/src/components/dashboard/engineer/dashboard/AttentionStrip.tsx`
- Create: `frontend/src/components/dashboard/engineer/dashboard/NextUpJobs.tsx`
- Create: `frontend/src/components/dashboard/engineer/dashboard/EngineerQuickActions.tsx`
- Create: `frontend/src/components/dashboard/engineer/dashboard/RecentActivityCard.tsx`
- Create: `frontend/src/components/dashboard/engineer/dashboard/dashboardSkeleton.tsx`

**Interfaces:**
- Consumes: `StatCardModel` / `AttentionRowModel` (Task 5), `EngineerOverviewJob` + `Movement` types, shared `portalUi` / `jobStatus` / `Skeleton` helpers.
- Produces: `EngineerStatCards`, `AttentionStrip`, `NextUpJobs`, `EngineerQuickActions`, `RecentActivityCard`, `DashboardSkeleton`.

- [ ] **Step 1: Create `EngineerStatCards.tsx`** (reference-style card, driven by the model):

```tsx
import Link from "next/link";
import { ArrowRightLeft, Boxes, Inbox, Truck, Wrench, type LucideIcon } from "lucide-react";

import type { CardIcon, StatCardModel } from "./engineerDashboardModel";

const ICONS: Record<CardIcon, LucideIcon> = { inbox: Inbox, wrench: Wrench, boxes: Boxes, truck: Truck, arrowRightLeft: ArrowRightLeft };
const TONES = {
  neutral: "bg-[var(--surface-2)] text-[var(--muted)]",
  accent: "bg-[var(--accent-10)] text-[var(--accent)]",
  amber: "bg-amber-500/15 text-amber-600",
} as const;

export function EngineerStatCards({ cards }: { cards: StatCardModel[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => {
        const Icon = ICONS[c.iconKey];
        return (
          <Link
            key={c.key}
            href={c.href}
            className="group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs transition-all hover:border-[var(--accent)] hover:shadow-md"
          >
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl transition-transform group-hover:scale-105 ${TONES[c.tone]}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">{c.value}</p>
              <p className="mt-0.5 text-xs font-bold text-[var(--ink)]">{c.label}</p>
              <p className={`mt-2 border-t border-[var(--border-2)] pt-2 text-[11px] ${c.hintTone === "red" ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                {c.hint}
              </p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create `AttentionStrip.tsx`:**

```tsx
import Link from "next/link";
import { AlertTriangle, ArrowRightLeft, ChevronRight, Inbox, PenLine, Truck, Wrench, type LucideIcon } from "lucide-react";

import type { AttentionRowModel, RowIcon } from "./engineerDashboardModel";

const ICONS: Record<RowIcon, LucideIcon> = { inbox: Inbox, alertTriangle: AlertTriangle, truck: Truck, arrowRightLeft: ArrowRightLeft, penLine: PenLine, wrench: Wrench };
const TONES = {
  red: "bg-[var(--neg)]/12 text-[var(--neg)]",
  amber: "bg-amber-500/15 text-amber-600",
  accent: "bg-[var(--accent-10)] text-[var(--accent)]",
  muted: "bg-[var(--surface-2)] text-[var(--muted)]",
} as const;

export function AttentionStrip({ rows }: { rows: AttentionRowModel[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-b border-[var(--border)] px-5 py-3">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Needs your attention</h2>
      </div>
      <ul className="divide-y divide-[var(--border-2)]">
        {rows.map((r) => {
          const Icon = ICONS[r.iconKey];
          return (
            <li key={r.key}>
              <Link href={r.href} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--surface-2)]">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONES[r.tone]}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--ink)]">{r.text}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Create `NextUpJobs.tsx`** (ports the existing JobRow but as a `<Link>`, not `<button>`):

```tsx
import Link from "next/link";
import { CheckCircle2, ChevronRight } from "lucide-react";

import { fmtDate } from "@/components/dashboard/portal/portalUi";
import { JobStatusChip } from "@/components/dashboard/jobs/jobStatus";
import type { EngineerOverviewJob } from "@/types/engineer";

const isPast = (iso: string | null): boolean => {
  if (!iso) return false;
  const due = Date.parse(iso);
  return !Number.isNaN(due) && due < new Date().setHours(0, 0, 0, 0);
};

export function NextUpJobs({ jobs, canJobs, className = "" }: { jobs: EngineerOverviewJob[]; canJobs: boolean; className?: string }) {
  return (
    <section className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-extrabold text-[var(--ink)]">Next up</h2>
          <p className="text-[11px] text-[var(--muted)]">Your active jobs, soonest due first.</p>
        </div>
        {canJobs && (
          <Link href="/dashboard/engineer/jobs" className="text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
            All jobs →
          </Link>
        )}
      </div>
      {!canJobs || jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <CheckCircle2 className="h-7 w-7 text-[var(--pos)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No active jobs</p>
          <p className="text-xs text-[var(--muted)]">New assignments will appear here the moment they land.</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job }: { job: EngineerOverviewJob }) {
  const overdue = isPast(job.completionDate);
  const urgent = job.priority === "urgent" || job.priority === "high";
  return (
    <li>
      <Link href={`/dashboard/engineer/jobs/${job.id}`} className="group flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)]/60">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold text-[var(--muted)]">{job.jobNumber}</span>
            <JobStatusChip status={job.status} />
            {urgent && (
              <span className="rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--neg)]">{job.priority}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">{job.name}</p>
          {job.customerName && <p className="truncate text-[11px] text-[var(--faint)]">{job.customerName}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-xs font-bold ${overdue ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
            {job.completionDate ? `${overdue ? "Overdue · " : "Due "}${fmtDate(job.completionDate)}` : "No due date"}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}
```

- [ ] **Step 4: Create `EngineerQuickActions.tsx`** (create actions, permission-gated — JC1):

```tsx
"use client";

import Link from "next/link";
import { ArrowRightLeft, Truck, Undo2, type LucideIcon } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

type Action = { label: string; href: string; perm: string; icon: LucideIcon };

const ACTIONS: Action[] = [
  { label: "Request field stock", href: "/dashboard/engineer/van-stock/new", perm: "engineer.van_stock.request", icon: Truck },
  { label: "Return stock", href: "/dashboard/engineer/van-stock/return", perm: "engineer.van_stock.request", icon: Undo2 },
  { label: "Request transfer", href: "/dashboard/engineer/transfers/new", perm: "engineer.transfer", icon: ArrowRightLeft },
];

export function EngineerQuickActions() {
  const { can } = useAuth();
  const actions = ACTIONS.filter((a) => can(a.perm));
  if (actions.length === 0) return null;
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">Quick actions</h2>
      <div className="grid gap-2">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <a.icon className="h-4 w-4" /> {a.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Create `RecentActivityCard.tsx`** (ports the existing movements feed; "View all" deep-links to the movements tab):

```tsx
import Link from "next/link";
import { Activity } from "lucide-react";

import { EmptyState, fmtDate } from "@/components/dashboard/portal/portalUi";
import type { Movement } from "@/types/stock-position";

export function RecentActivityCard({ movements }: { movements: Movement[] }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent activity</h2>
        <Link href="/dashboard/engineer/inventory?section=movements" className="text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
          View all →
        </Link>
      </div>
      {movements.length === 0 ? (
        <EmptyState icon={Activity} title="No activity yet" hint="When you collect, use or transfer stock, it'll show here." />
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {movements.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--ink)]">{a.label} · {a.itemName}</p>
                <p className="text-[11px] text-[var(--faint)]">
                  {a.itemCode || (a.ownership === "customer" ? "Customer" : "")}
                  {a.reference ? ` · ${a.reference}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`text-sm font-bold ${a.quantityDelta >= 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`}>
                  {a.quantityDelta >= 0 ? "+" : ""}
                  {a.quantityDelta}
                </p>
                <p className="text-[11px] text-[var(--faint)]">{fmtDate(a.date)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Create `dashboardSkeleton.tsx`** (full-layout skeleton):

```tsx
import { Skeleton } from "@/components/ui/Skeleton";
import { StatCardSkeleton } from "@/components/dashboard/portal/portalUi";

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl lg:col-span-2" />
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Typecheck + lint.**

Run: `cd frontend && npx tsc --noEmit && pnpm lint`
Expected: PASS for all six new files (only `EngineerDashboard.tsx` may still error — replaced next).

- [ ] **Step 8: Commit** (after user approval):

```bash
git add "frontend/src/components/dashboard/engineer/dashboard/EngineerStatCards.tsx" "frontend/src/components/dashboard/engineer/dashboard/AttentionStrip.tsx" "frontend/src/components/dashboard/engineer/dashboard/NextUpJobs.tsx" "frontend/src/components/dashboard/engineer/dashboard/EngineerQuickActions.tsx" "frontend/src/components/dashboard/engineer/dashboard/RecentActivityCard.tsx" "frontend/src/components/dashboard/engineer/dashboard/dashboardSkeleton.tsx"
git commit -m "feat(engineer-ui): dashboard presentational components"
```

---

## Task 8: Orchestrator rewrite + final verification

**Files:**
- Modify (full replace): `frontend/src/components/dashboard/engineer/EngineerDashboard.tsx`

**Interfaces:**
- Consumes: `useEngineerOverview` (Task 6), `buildStatCards` / `buildAttentionRows` (Task 5), all six components (Task 7), `PortalHeader`, `relativeTime`, `useAuth`, `Notice`.

- [ ] **Step 1: Replace `EngineerDashboard.tsx` entirely** with the thin orchestrator:

```tsx
"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { PortalHeader } from "@/components/dashboard/portal/portalUi";
import { relativeTime } from "@/components/dashboard/audit/auditDisplay";
import { useEngineerOverview } from "./dashboard/useEngineerOverview";
import { buildStatCards, buildAttentionRows } from "./dashboard/engineerDashboardModel";
import { EngineerStatCards } from "./dashboard/EngineerStatCards";
import { AttentionStrip } from "./dashboard/AttentionStrip";
import { NextUpJobs } from "./dashboard/NextUpJobs";
import { EngineerQuickActions } from "./dashboard/EngineerQuickActions";
import { RecentActivityCard } from "./dashboard/RecentActivityCard";
import { DashboardSkeleton } from "./dashboard/dashboardSkeleton";

// Engineer Portal dashboard — the field engineer's day at a glance: workload cards, an actionable
// "Needs your attention" strip, the next jobs by due date, quick actions and the recent stock feed.
// Live-updates over the shared socket; card style mirrors the admin dashboard / reference design.
const SUBTITLE = "Your jobs, stock and activity at a glance.";
const CAPTION_TICK_MS = 30_000;

export function EngineerDashboard() {
  const { can } = useAuth();
  const { overview, recent, loading, refreshing, error, updatedAt, reload } = useEngineerOverview();

  // Re-render the "Updated X ago" caption without refetching.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), CAPTION_TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (loading && !overview) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Dashboard" subtitle={SUBTITLE} />
        <DashboardSkeleton />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Dashboard" subtitle={SUBTITLE} />
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--neg)]">
          <p>{error}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] transition-colors hover:border-[var(--accent)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (!overview) return null;

  const cards = buildStatCards(overview, can);
  const attention = buildAttentionRows(overview, can);

  return (
    <div className="space-y-6">
      <PortalHeader
        title="Dashboard"
        subtitle={SUBTITLE}
        action={
          <div className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span>Updated {relativeTime(updatedAt ?? new Date().toISOString())}</span>
            <button
              type="button"
              onClick={reload}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              title="Refresh"
              className="rounded p-0.5 text-[var(--faint)] transition-colors hover:text-[var(--accent)] disabled:cursor-default"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        }
      />

      <EngineerStatCards cards={cards} />
      <AttentionStrip rows={attention} />

      <div className="grid gap-6 lg:grid-cols-3">
        <NextUpJobs jobs={overview.jobs.next} canJobs={can("engineer.jobs.view")} className="lg:col-span-2" />
        <div className="space-y-6">
          <EngineerQuickActions />
          <RecentActivityCard movements={recent} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint (whole frontend now clean).**

Run: `cd frontend && npx tsc --noEmit && pnpm lint`
Expected: PASS with **zero** errors (no remaining `pendingTransfers` reader; `EngineerDashboard.tsx` compiles).

- [ ] **Step 3: Authoritative build.**

Run: `cd frontend && pnpm build`
Expected: build succeeds (type-checks under the real Next 16 toolchain).

- [ ] **Step 4: Full frontend test run.**

Run: `cd frontend && pnpm test`
Expected: PASS (the model test plus the 7 pre-existing suites).

- [ ] **Step 5: Manual verification** (running app, log in as a field engineer — `pnpm dev` in both `backend/` and `frontend/`):
  - Each card's number matches its module page (open Jobs / Field Stock / Transfers and compare).
  - Clicking **Jobs to accept** lands on `jobs?status=assigned` (pre-filtered); **In progress** → `?status=in_progress`; **Field stock to collect** → `van-stock?status=approved`; **Transfers pending** → `transfers?view=incoming`.
  - Attention rows appear only when their count > 0; "delivered transfers need your signature" links to `transfers?view=outgoing`.
  - Trigger a socket event (from an office/admin session: assign the engineer a job, or approve one of their restocks) and confirm the dashboard updates **without a reload** and the "Updated … ago" caption resets.
  - A restricted engineer (no `engineer.transfer`) sees neither the Transfers card, its two attention rows, nor the "Request transfer" quick action.

- [ ] **Step 6: Commit** (after user approval):

```bash
git add frontend/src/components/dashboard/engineer/EngineerDashboard.tsx
git commit -m "feat(engineer-ui): prod-grade dashboard — deep links, realtime, refresh, error, a11y"
```

---

## Self-Review

**1. Spec coverage** (each spec §5/§6 requirement → task):
- New `EngineerOverview` shape → Task 3 (backend) + Task 4 (frontend). ✅
- `vanStock.toCollect` count → Task 1 + wired in Task 3. ✅
- `transfers.toSign` count → Task 2 + wired in Task 3. ✅
- `kitRequests.pending` (reuse `listMine`) → Task 3. ✅
- Deep-linked cards + attention rows → Task 5 (hrefs) rendered by Task 7 / 8. ✅
- Realtime (job + goods + van-stock + kit) → Task 6. ✅
- "Updated X ago" + refresh + monotonic guard → Task 6 (guard) + Task 8 (caption/refresh). ✅
- Full skeleton → Task 7 (`dashboardSkeleton`) used in Task 8. ✅
- Error + Retry → Task 8. ✅
- `<Link>` job rows (a11y) → Task 7 (`NextUpJobs`). ✅
- Quick actions = create actions (JC1) → Task 7 (`EngineerQuickActions`). ✅
- Component split (JC2) → Tasks 5-8. ✅
- Kit = informational row (JC3) → Task 5 (`buildAttentionRows` `kit`). ✅
- Stock card stays company-only (JC4) → Task 5 (`stock` card). ✅
- No polling / per-user events (JC5) → Task 6. ✅
- `pendingTransfers` → `transfers.incomingPending` (JC6) → Task 3 + Task 4 grep. ✅
- No schema change / no `prisma db push` → Global Constraints; nothing in any task edits `schema.prisma`. ✅

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows complete code. ✅

**3. Type consistency:** `StatCardModel`/`AttentionRowModel`/`CardIcon`/`RowIcon` defined in Task 5 are imported unchanged in Task 7; `useEngineerOverview` return fields (`overview, recent, loading, refreshing, error, updatedAt, reload`) defined in Task 6 match their consumption in Task 8; backend `countCollectible`/`countAwaitingSignature`/`listMine({status:"pending",pageSize:1}).total` produced in Tasks 1/2 match their consumption in Task 3. `updatedAt` is an ISO `string | null` in both Task 6 and Task 8. ✅
