# Engineer Portal Dashboard — Production-Grade — Design

**Date:** 2026-07-23
**Status:** Draft for review
**Owner:** Shahul

> **On the counts and file:line references in this document.** Every reference (e.g. `EngineerDashboard.tsx:50-68`, the 6 `engineer.*` permission strings, the socket events) is a **verified snapshot taken 2026-07-23**. They are recorded as evidence the codebase was actually surveyed and to make §10 checkable. Expect line numbers to drift as the file is edited during implementation; the durable contract is the §4 invariant, not the arithmetic.

## 1. Purpose & Problem

The Engineer Portal dashboard (`frontend/src/components/dashboard/engineer/EngineerDashboard.tsx`) was rebuilt into a solid v1: a rich backend aggregation (`backend/src/modules/engineer/engineer.service.ts` `getOwnOverview`), matching types, four tone-coded workload cards, a "Needs your attention" strip, a "Next up" job list, quick actions and a recent-activity feed. It already speaks the reference/admin card language (icon tile + big number + hover accent) on the shared CSS tokens.

Three classes of gap keep it short of production-grade, measured against the admin dashboard (`frontend/src/components/dashboard/home/OverviewView.tsx`) as the in-house benchmark:

1. **It is the only engineer surface that does not live-update.** Jobs, Transfers, Field Stock and Kit Requests each subscribe to the shared socket and refetch on events (`useJobSocket`, `useGoodsSocket`, `van_stock_request:updated`, `kit_request:updated`). The dashboard does a one-shot fetch (`EngineerDashboard.tsx:50-68`), so a job assigned while it is open never appears until a manual reload.

2. **Two whole modules are invisible.** The engineer's day includes stock waiting at a warehouse and kit awaiting a planner, but neither surfaces:
   - **Field stock to collect** — restock requests in `approved`/`partially_fulfilled` ("go collect it"). Not shown.
   - **Kit requests pending** — the engineer's own requests awaiting the planner. Not shown.
   - **Transfers awaiting signature** — delivered engineer-to-engineer transfers with `requireSignature && !acknowledgedAt`. Not shown.

3. **Prod-grade polish the admin dashboard has and this one lacks:** deep-linked cards (every card links to a bare route although the lists already read `?status=` / `?section=` / `?view=`), an "Updated X ago" caption + manual refresh, a monotonic fetch guard against stale overwrites, a full-layout loading skeleton (not just the four cards), an error state with a Retry button, and `<Link>` navigation on the "Next up" rows instead of `<button onClick={router.push}>` (which loses middle-click / open-in-new-tab).

**Reference scenario.** *A field engineer opens the dashboard at the start of the day. An office planner assigns them a job and approves a field-stock restock. Today: the dashboard shows neither until the engineer reloads, and even then the restock is nowhere. After this work: the "Jobs to accept" card and a "field-stock ready to collect" row appear within a second, no reload; each card click lands on the correct pre-filtered list.*

## 2. Scope

**In scope**

- Extend the backend `getOwnOverview` aggregation with three new counts — **field-stock to collect**, **kit-requests pending**, **transfers to sign** — using the same server-side parallel pattern it already uses for jobs and transfers. Two thin `count` helpers are added (van-stock, engineer-transfer); kit reuses the existing `listMine`.
- Migrate the frontend `EngineerOverview` type to the new shape and restructure the dashboard into a small set of focused components + a data hook, mirroring the admin `home/` folder.
- **Live-update** the dashboard via the existing per-user socket events (no polling interval, no new permission).
- **Deep-link** every stat card and attention row to its pre-filtered list.
- Prod-grade polish: "Updated X ago" + manual refresh, monotonic fetch guard, full-layout skeleton, error+Retry, `<Link>` on job rows.
- Make Quick actions the engineer's **create** actions (request field stock, return stock, request transfer), matching the admin `QuickActions` convention.
- Extend backend tests (`engineer.service.test.ts`, and the two new `count` helpers).

**Out of scope / non-goals** (rationale in §9)

- **Analytics charts** (spline/bar like `reference/tabs/OverviewTab.tsx`). A field engineer's dashboard is an actionable ops board, not a trend viewer. No natural per-count time series exists.
- **Enriching the Stock card with customer-consignment / misc holdings.** Those pools are already first-class tabs on the Stock page (`?section=customer|misc`); adding them costs two more queries on the overview hot path for marginal value. The card stays company-van-stock.
- **A dedicated engineer kit-request list page.** Kit requests live inside a job (`EngineerJobDetail.tsx`) and have no page of their own; the dashboard surfaces the count only.
- **Backend schema / Prisma changes.** All three new counts are read-only aggregations over existing collections. **No `schema.prisma` edit, therefore NO `npx prisma db push`.**
- **New permissions.** All events and reads reuse the existing 6 `engineer.*` strings and the per-user socket room.

## 3. Architecture

```
                       GET /engineer/overview  (one round trip)
                                  │
  engineer.service.getOwnOverview(engineerId)  ── Promise.all ──┐
        │  jobService.listJobsForEngineer × 3 (assigned/accepted/in_progress)
        │  engineerTransferService.listMine({role:incoming,status:pending})   → transfers.incomingPending
        │  engineerTransferService.countAwaitingSignature(engineerId)  [NEW]  → transfers.toSign
        │  vanStockRequestService.countCollectible(engineerId)         [NEW]  → vanStock.toCollect
        │  kitRequestService.listMine({status:pending})                [reuse]→ kitRequests.pending
        │  engineerRepo.findBalances / findRecentTransactions                 → stock, recentActivity
        └───────────────────────────────────────────────────────────────────┘
                                  │  EngineerOverview (new shape)
                                  ▼
  Frontend  useEngineerOverview()  ── getOwnOverview() + getOwnMovements({limit:6})
        │   monotonic fetchSeq guard · updatedAt · error · reload()
        │   realtime: useJobSocket(reload) · useGoodsSocket(reload)
        │             subscribe(["van_stock_request:updated","kit_request:updated"], reload)
        ▼
  EngineerDashboard (orchestrator)
   ├─ PortalHeader  (title + "Updated Xs ago" + refresh)
   ├─ EngineerStatCards      (5 deep-linked, permission-gated cards)
   ├─ AttentionStrip         (0-6 actionable rows, each deep-linked)
   ├─ NextUpJobs             (active jobs, soonest due, <Link> rows)
   ├─ EngineerQuickActions   (create actions, permission-gated)
   └─ RecentActivityCard     (own stock-movement feed)
```

The strict layering (`route → controller → service → repository → Prisma`) and "repositories are the only place Prisma is touched" invariant are preserved: the two new counts are `prisma.count` calls added to the owning module's repository, exposed by a one-line service wrapper, and consumed by `engineer.service` exactly as it already consumes `jobService` / `engineerTransferService`.

## 4. Invariant

**The dashboard renders only what the actor is permitted to see and only what is actionable, and it stays fresh without a reload.** Concretely:

- Every card and attention row is gated by the same permission that gates its module's nav item and route guard (`engineer.jobs.view`, `engineer.transfer`, `engineer.van_stock.request`; the Stock card is ungated, matching the current behaviour). A permission the actor lacks means that card/row/quick-action is absent — never disabled-but-visible.
- An attention row exists **iff** its count > 0. The section is absent when every row is empty.
- Any socket event that changes one of the surfaced numbers triggers a silent refetch; existing data stays on screen until the fresh payload swaps in.

## 5. Backend changes

### 5.1 `EngineerOverview` shape (`engineer.service.ts` + `frontend/src/types/engineer.ts`)

```ts
export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  jobs: {
    toAccept: number; accepted: number; inProgress: number;
    overdue: number; dueThisWeek: number; next: EngineerOverviewJob[];
  };
  transfers: { incomingPending: number; toSign: number };  // was: pendingTransfers (top-level)
  vanStock: { toCollect: number };                          // NEW — restocks approved + partially_fulfilled
  kitRequests: { pending: number };                         // NEW — engineer's pending kit requests, all jobs
  recentActivity: EngineerActivity[];
}
```

`pendingTransfers` (top-level) is folded into `transfers.incomingPending`. The **only** consumer of the overview is the dashboard (the Stock page uses it solely for its `recentActivity` "last updated" map), so this rename is safe — a pre-flight `grep -r pendingTransfers` confirms no other reader before editing.

### 5.2 New count helpers

**Van stock — `van-stock-request.repository.ts` + `.service.ts`:**

```ts
// repository — "restocks the engineer still has to collect": approved or partially fulfilled.
export function countCollectibleRestocks(engineerId: string): Promise<number> {
  return prisma.vanStockRequest.count({
    where: { engineerId, type: "restock", deletedAt: null, status: { in: ["approved", "partially_fulfilled"] } },
  });
}
// service
export function countCollectible(engineerId: string): Promise<number> {
  return vanStockRepo.countCollectibleRestocks(engineerId);
}
```
(Returns are excluded — the warehouse scans those in; the engineer collects only restocks. Mirrors the existing open-of-type query at `van-stock-request.repository.ts:247`.)

**Engineer transfer — `engineer-transfer.repository.ts` + `.service.ts`:**

```ts
// repository — outgoing (I am the recipient) + completed + signature required + not yet signed.
export function countAwaitingSignature(engineerId: string): Promise<number> {
  return prisma.engineerStockTransfer.count({
    where: {
      AND: [
        engineerWhere(engineerId, "outgoing"),
        { status: "completed", requireSignature: true, acknowledgedAt: null },
      ],
    },
  });
}
// service
export function countAwaitingSignature(engineerId: string): Promise<number> {
  return transferRepo.countAwaitingSignature(engineerId);
}
```
(`engineerWhere`, `requireSignature`, `acknowledgedAt` are all existing — `engineer-transfer.repository.ts:211,34,693`.)

**Kit requests — no new code.** Reuse `kitRequestService.listMine(engineerId, { status: "pending", pageSize: 1 })` and read `.total` (the pattern `getOwnOverview` already uses for incoming transfers). `listMine` scopes to the engineer and, with no `jobId`, spans all jobs (`job-kit-request.service.ts:514`).

### 5.3 `getOwnOverview` wiring

Add the three to the existing `Promise.all` (so total latency is unchanged — still one parallel batch), then place them in the returned object. The zero/empty case returns the new shape with all counts `0` and `next: []`.

## 6. Frontend changes

New folder `frontend/src/components/dashboard/engineer/dashboard/`:

| File | Responsibility |
|---|---|
| `useEngineerOverview.ts` | Data hook: fetch overview + recent movements; `load()` with a monotonic `fetchSeq` guard; `loading` / `refreshing` / `error` / `updatedAt`; realtime subscriptions; returns `reload`. |
| `EngineerStatCards.tsx` | The 5 permission-gated, deep-linked workload cards (keeps the existing `StatCard` visual). |
| `AttentionStrip.tsx` | Builds the 0–6 actionable rows from the overview + permissions; renders nothing when empty. |
| `NextUpJobs.tsx` | Active jobs soonest-due-first; `JobRow` as a `<Link>`. |
| `EngineerQuickActions.tsx` | Create actions, permission-gated (see §9 JC1). |
| `RecentActivityCard.tsx` | The engineer's own stock-movement feed (unchanged visuals). |
| `dashboardSkeleton.tsx` | Full-layout skeleton (cards + strip + next-up + right column). |

`EngineerDashboard.tsx` stays at its current path (the route imports it) and becomes the thin orchestrator: calls the hook, renders the header with the "Updated Xs ago" + refresh control (via `PortalHeader`'s `action` slot), shows the skeleton on first load, the error+Retry card on a failed first load, and composes the components otherwise.

### 6.1 Cards (grid `sm:grid-cols-2 lg:grid-cols-3`, matching admin)

| Card | Permission | Tone | Deep-link |
|---|---|---|---|
| Jobs to accept | `engineer.jobs.view` | amber if >0 | `/dashboard/engineer/jobs?status=assigned` |
| In progress | `engineer.jobs.view` | accent | `/dashboard/engineer/jobs?status=in_progress` |
| Field stock to collect | `engineer.van_stock.request` | accent if >0 | `/dashboard/engineer/van-stock?status=approved` |
| Transfers pending | `engineer.transfer` | accent if >0 | `/dashboard/engineer/transfers?view=incoming` |
| Stock on hand | (ungated) | neutral | `/dashboard/engineer/inventory` |

The "In progress" hint keeps the existing overdue / accepted / due-this-week cascade.

### 6.2 Attention rows (each: condition + permission → deep-link)

| Row | Condition (perm) | Deep-link |
|---|---|---|
| N jobs to accept/reject | `jobs.toAccept > 0` (jobs.view) | `jobs?status=assigned` |
| N jobs past completion date | `jobs.overdue > 0` (jobs.view) | `jobs` (list has no overdue filter) |
| N field-stock requests ready to collect | `vanStock.toCollect > 0` (van_stock.request) | `van-stock?status=approved` |
| N incoming transfers to accept | `transfers.incomingPending > 0` (transfer) | `transfers?view=incoming` |
| N delivered transfers need your signature | `transfers.toSign > 0` (transfer) | `transfers?view=outgoing` |
| N kit requests awaiting the planner | `kitRequests.pending > 0` (jobs.view) | `jobs` (informational — JC3) |

### 6.3 Realtime

`useEngineerOverview` wires the same events the module pages use, all to a stable `reload`:
`useJobSocket(reload)` (`job:new/accepted/rejected/deleted`), `useGoodsSocket(reload)` (`goods:*`, `engineer:transfer_updated`), and `subscribe(["van_stock_request:updated","kit_request:updated"], reload)`. All arrive on the engineer's per-user room, so **no permission gate is needed**, and `subscribe` re-runs `reload` on reconnect, recovering events missed while offline. No polling interval is added.

## 7. Data flow & error handling

- **First load:** `loading = true` → full skeleton. On success, data renders; on failure with no data, an error card with a Retry button (`reload`).
- **Every later load** (manual refresh, socket event): silent — `refreshing = true`, existing data stays, the refresh icon spins, the payload swaps in atomically. A `fetchSeq` ref guards against a slow older response overwriting a newer one (ported from `OverviewView.tsx:45-68`).
- **Per-section failure:** the overview is a single endpoint — it succeeds or fails as a whole; there is no partial-section error model here (unlike the admin summary). A failed refetch while data is on screen is swallowed (the stale data and "Updated X ago" caption remain); only a failed *first* load surfaces the error card.
- **`getOwnMovements` failure** stays non-fatal (already `.catch(() => empty)`), so the activity feed degrades to empty without failing the dashboard.

## 8. Testing & verification

- **Backend (`pnpm test`, vitest):**
  - `engineer.service.test.ts` — extend: the "clean zeros" case asserts the **new shape** (`transfers:{incomingPending:0,toSign:0}`, `vanStock:{toCollect:0}`, `kitRequests:{pending:0}`); a new case mocks the three new calls and asserts each count surfaces and each service is called with the engineer id.
  - `van-stock-request.service.test.ts` — a focused test for `countCollectible` (repo mocked) asserting the `restock` + `{in:[approved,partially_fulfilled]}` filter.
  - `engineer-transfer.service.test.ts` — a focused test for `countAwaitingSignature` (repo mocked) asserting the outgoing + completed + requireSignature + unacknowledged filter.
- **Gate:** backend `pnpm typecheck && pnpm lint && pnpm test`; frontend `pnpm lint && pnpm build`.
- **No `prisma db push`** — no schema change (called out because generate/typecheck would pass regardless).
- **Manual (running app, field-engineer login):** each card's number matches its module page; clicking each card lands on the correctly pre-filtered list; trigger a socket event (office assigns a job / approves a restock / completes a transfer) and confirm the dashboard updates with no reload; confirm a restricted engineer (missing `engineer.transfer`) sees neither the Transfers card nor its attention rows nor the transfer quick action.

## 9. Decision log

- **JC1 — Quick actions are create actions, not nav duplicates.** Today's quick actions repeat sidebar nav (Jobs/Stock/Transfers/Field Stock). They become the engineer's create verbs — **Request field stock** (`van-stock/new`), **Return stock** (`van-stock/return`), **Request transfer** (`transfers/new`) — matching the admin `QuickActions` (New PRF/PO/Job). Gated; the section hides when no create permission applies (nav remains in the sidebar).
- **JC2 — Split into components + a hook**, mirroring `home/` (which is 9 files). The current single 351-line file grows with realtime + more sections; focused units are easier to reason about and match the referenced admin structure.
- **JC3 — Kit-requests is one informational attention row, not a card.** Kit requests have no list page (they live in a job), so the row deep-links to the jobs list rather than a filtered kit view. It is the most cuttable signal and is deliberately low-emphasis; the count is still worth showing so an engineer knows a planner owes them a decision.
- **JC4 — Stock card stays company-van-stock.** Customer-consignment and misc holdings remain on the Stock page tabs; adding them here would cost two extra queries on the overview hot path for marginal at-a-glance value.
- **JC5 — Realtime via existing per-user events, no polling.** The socket infra already delivers every relevant event to the engineer's own room with reconnect recovery; a 60s interval (as the admin uses) is redundant here and is omitted.
- **JC6 — `pendingTransfers` → `transfers.incomingPending`.** Nesting keeps the two transfer signals together; safe because the dashboard is the sole consumer (verify with grep before editing).

## 10. Rollout checklist

1. Backend: add `countCollectibleRestocks` / `countCollectible` (van-stock), `countAwaitingSignature` (engineer-transfer); wire all three + kit `listMine` into `getOwnOverview`; update `EngineerOverview`.
2. Backend tests green (`pnpm typecheck && pnpm lint && pnpm test`).
3. Frontend: migrate `types/engineer.ts`; build the `dashboard/` components + hook; rewrite `EngineerDashboard.tsx` as orchestrator; deep-link cards + rows; realtime; polish (skeleton, refresh, error, `<Link>`).
4. `grep -r pendingTransfers frontend/ backend/` returns only the intended edits.
5. Frontend `pnpm lint && pnpm build` green.
6. Manual verification per §8. **No `prisma db push`.**
