# Audit Trail — Read Side, UI & CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the audit trail end-to-end — a filterable/paginated read API, a CSV export, and a production-grade dashboard UI (table + detail drawer + export) — so the entries already being recorded become viewable and exportable.

**Architecture:** Backend follows the existing strict-layered module pattern (`route → middleware → controller → service → repository → Prisma`); the read path reuses the `AuditLog` indexes (`action`, `targetType+targetId`, `createdAt`). The export reuses the exact same filter normalization as the list so they can't diverge, bounded by a cap. Frontend mirrors the customers feature: a typed service over `api()`, a `PermissionGate`-wrapped page, and a self-contained client panel with the shared `Pagination`/`Skeleton`/`Modal` primitives. CSV download bypasses the JSON `api()` wrapper with a `withCredentials` blob request.

**Tech Stack:** Backend — Express 5, Prisma (MongoDB), zod, TypeScript ESM/NodeNext, `express-rate-limit`. Frontend — Next.js 16 (App Router), React 19, Tailwind v4, axios, lucide-react.

**Verification note:** Per `CLAUDE.md` there is **no test runner** in either app (`pnpm test` is a placeholder). Verification is `pnpm typecheck` + `pnpm lint` (backend), `pnpm lint` + `pnpm build` (frontend), plus the manual API/UI checks each task specifies. Tasks therefore use typecheck/lint/manual gates rather than unit tests.

**Conventions to respect (from CLAUDE.md):**
- ESM/NodeNext: every relative import ends in `.js` (even from `.ts` source).
- `#modules/<domain>/...` alias for cross-module imports (with `.js`); same-module imports stay relative (`./audit.service.js`); shared dirs stay relative (`../../utils/...`).
- Repositories are the ONLY place Prisma is touched.
- Frontend: components call services, never `api()`/axios directly.

---

## File Structure

**Backend** (`backend/src/`)
- `modules/audit/audit.repository.ts` — *modify* — add `buildWhere`, `findMany`, `count`, `findForExport`, `distinctActions`; remove unused `findRecent`.
- `modules/audit/audit.service.ts` — *modify* — add filter/DTO types, `normalizeFilters`, `listAuditLogs`, `listActions`, `exportAuditCsv` (+ `csvEscape`, `AUDIT_EXPORT_MAX`).
- `modules/audit/audit.validation.ts` — *create* — parse `req.query` → `ListAuditParams` (shared by list + export).
- `modules/audit/audit.controller.ts` — *create* — `listAuditLogs`, `listActions`, `exportAuditCsv`.
- `modules/audit/audit.routes.ts` — *create* — wire the three GETs behind `requireAuth` + `requirePermission("audit.view")`.
- `middleware/rateLimit.middleware.ts` — *modify* — add `exportLimiter`.
- `routes/index.ts` — *modify* — mount `/audit`.

**Frontend** (`frontend/src/`)
- `types/audit.ts` — *create* — `AuditEntry`, `PagedAuditLogs`, `AuditActorType`.
- `lib/download.ts` — *create* — `downloadBlob(blob, filename)`.
- `services/audit.service.ts` — *create* — `listAuditLogs`, `listAuditActions`, `exportAuditCsv`.
- `app/dashboard/audit/page.tsx` — *create* — gated page.
- `components/dashboard/audit/auditDisplay.ts` — *create* — `actionLabel` / `actionTone` helpers.
- `components/dashboard/audit/AuditEntryDrawer.tsx` — *create* — detail slide-over.
- `components/dashboard/audit/AuditLogPanel.tsx` — *create* — filters + table + pagination + export.
- `components/dashboard/shell/Sidebar.tsx` — *modify* — add the nav item.

---

## Task 1: Repository — filtered reads, export query, distinct actions

**Files:**
- Modify: `backend/src/modules/audit/audit.repository.ts`

- [ ] **Step 1: Replace the repository file contents**

Replace the entire file `backend/src/modules/audit/audit.repository.ts` with:

```ts
import type { AuditLog, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the AuditLog model (immutable audit trail). The ONLY
// place Prisma is touched for audit entries.

export interface AuditListFilters {
  search?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
}

function buildWhere(filters: AuditListFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.action) where.action = filters.action;
  if (filters.actorType) where.actorType = filters.actorType;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  }
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { actorEmail: { contains: q, mode: "insensitive" } },
      { targetLabel: { contains: q, mode: "insensitive" } },
      { targetId: { contains: q, mode: "insensitive" } },
      { action: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export function create(data: Prisma.AuditLogCreateInput): Promise<AuditLog> {
  return prisma.auditLog.create({ data });
}

// One page of matching entries, newest first.
export function findMany(
  filters: AuditListFilters = {},
  skip = 0,
  take = 25,
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });
}

export function count(filters: AuditListFilters = {}): Promise<number> {
  return prisma.auditLog.count({ where: buildWhere(filters) });
}

// All matching entries up to `take` (the export cap), newest first. A single
// bounded query keeps it memory-safe; if the cap ever needs to grow past what's
// comfortable to hold in memory, switch this to a cursor-paged loop — callers
// won't change.
export function findForExport(
  filters: AuditListFilters = {},
  take = 50_000,
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    take,
  });
}

// Distinct action keys present in the log, ascending — feeds the UI's action
// filter dropdown so it only offers values that actually exist.
export async function distinctActions(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS (no errors). The repo compiles against the generated Prisma client.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/audit/audit.repository.ts
git commit -m "feat(audit): add filtered read, export query, and distinct actions to repo"
```

---

## Task 2: Service — normalize filters, list, actions, CSV export

**Files:**
- Modify: `backend/src/modules/audit/audit.service.ts`

- [ ] **Step 1: Add read/export code to the service**

In `backend/src/modules/audit/audit.service.ts`, keep the existing `AuditActor`, `AuditEntry`, and `record()` exactly as they are. Update the import line at the top and append the new code below it.

Change the existing import line:

```ts
import * as auditLogRepo from "./audit.repository.js";
```

to:

```ts
import * as auditLogRepo from "./audit.repository.js";
import type { AuditListFilters } from "./audit.repository.js";
```

Then append to the end of the file:

```ts
// --- read side: list + export ------------------------------------------------

// Cap on a single CSV export — bounds memory and response size. Entries beyond
// this are not exported (the response signals truncation via `capped`).
export const AUDIT_EXPORT_MAX = 50_000;

const ACTOR_TYPES = ["admin", "user", "customer", "system"] as const;

// One audit row as returned to the client (snapshot fields + metadata).
export interface PublicAuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface ListAuditParams {
  search?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedAuditLogs {
  entries: PublicAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// SINGLE source of filter normalization — used by BOTH list and export so they
// can never diverge. Invalid values are dropped (no filter) rather than throwing:
// a typo'd query returns an unfiltered result, never a 500.
function normalizeFilters(params: ListAuditParams): AuditListFilters {
  const actorType =
    params.actorType && (ACTOR_TYPES as readonly string[]).includes(params.actorType)
      ? params.actorType
      : undefined;
  const from = parseDate(params.from);
  const to = parseDate(params.to);
  return {
    search: params.search?.trim() || undefined,
    action: params.action?.trim() || undefined,
    actorType,
    targetType: params.targetType?.trim() || undefined,
    from,
    to,
  };
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toPublic(row: {
  id: string;
  actorId: string | null;
  actorType: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: Date;
}): PublicAuditEntry {
  return {
    id: row.id,
    actorId: row.actorId,
    actorType: row.actorType,
    actorEmail: row.actorEmail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAuditLogs(params: ListAuditParams = {}): Promise<PagedAuditLogs> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 25), 1), 100);
  const filters = normalizeFilters(params);
  const total = await auditLogRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await auditLogRepo.findMany(filters, (page - 1) * pageSize, pageSize);
  return { entries: rows.map(toPublic), total, page, pageSize, totalPages };
}

export function listActions(): Promise<string[]> {
  return auditLogRepo.distinctActions();
}

// RFC-4180 cell escaping: wrap in quotes and double any embedded quote whenever
// the value contains a quote, comma, or newline. No dependency needed.
function csvEscape(value: string): string {
  return /["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface AuditCsvResult {
  csv: string;
  count: number;
  capped: boolean;
}

// Serialize the filtered entries to a CSV string. Reuses the SAME filter
// normalization as listAuditLogs. `capped` is true when the result hit the cap.
export async function exportAuditCsv(params: ListAuditParams = {}): Promise<AuditCsvResult> {
  const filters = normalizeFilters(params);
  const rows = await auditLogRepo.findForExport(filters, AUDIT_EXPORT_MAX);
  const header = [
    "When (UTC)",
    "Action",
    "Actor Type",
    "Actor Email",
    "Actor Id",
    "Target Type",
    "Target Id",
    "Target Label",
    "Metadata",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.action,
        r.actorType,
        r.actorEmail ?? "",
        r.actorId ?? "",
        r.targetType ?? "",
        r.targetId ?? "",
        r.targetLabel ?? "",
        r.metadata == null ? "" : JSON.stringify(r.metadata),
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return { csv: lines.join("\r\n"), count: rows.length, capped: rows.length >= AUDIT_EXPORT_MAX };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS. (If Prisma's `metadata` JSON type widens oddly, the `unknown` in `toPublic`/`PublicAuditEntry` absorbs it.)

- [ ] **Step 3: Lint**

Run: `cd backend && pnpm lint`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/audit/audit.service.ts
git commit -m "feat(audit): add list, distinct-actions, and CSV export to service"
```

---

## Task 3: Validation — parse the query string

**Files:**
- Create: `backend/src/modules/audit/audit.validation.ts`

- [ ] **Step 1: Create the validation/parse helper**

Create `backend/src/modules/audit/audit.validation.ts`:

```ts
import type { Request } from "express";

import { queryInt } from "../../utils/request.js";
import type { ListAuditParams } from "./audit.service.js";

// Read-only GET — no body. This collapses Express's `string | string[]` query
// values to single strings and parses page/pageSize, producing the params the
// service normalizes. Invalid values are passed through as-is and dropped by the
// service's normalizeFilters (never a 400 on a read).
function str(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function parseAuditQuery(req: Request): ListAuditParams {
  const q = req.query;
  return {
    search: str(q.search),
    action: str(q.action),
    actorType: str(q.actorType),
    targetType: str(q.targetType),
    from: str(q.from),
    to: str(q.to),
    page: queryInt(q.page),
    pageSize: queryInt(q.pageSize),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/audit/audit.validation.ts
git commit -m "feat(audit): add query parsing for the audit list/export endpoints"
```

---

## Task 4: Controller — list, actions, export

**Files:**
- Create: `backend/src/modules/audit/audit.controller.ts`

- [ ] **Step 1: Create the controller**

Create `backend/src/modules/audit/audit.controller.ts`:

```ts
import * as auditService from "./audit.service.js";
import { parseAuditQuery } from "./audit.validation.js";
import { asyncHandler } from "../../utils/async-handler.js";

// GET /audit  (protected: audit.view) — paginated, filterable list.
export const listAuditLogs = asyncHandler(async (req, res) => {
  const result = await auditService.listAuditLogs(parseAuditQuery(req));
  res.json(result);
});

// GET /audit/actions  (protected: audit.view) — distinct action keys for the
// filter dropdown.
export const listActions = asyncHandler(async (_req, res) => {
  res.json({ actions: await auditService.listActions() });
});

// GET /audit/export.csv  (protected: audit.view) — CSV of the filtered view,
// streamed as a file download. Honors the same filters as the list (page/pageSize
// are ignored — the export spans all matching rows up to the cap).
export const exportAuditCsv = asyncHandler(async (req, res) => {
  const { csv, capped } = await auditService.exportAuditCsv(parseAuditQuery(req));
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${date}.csv"`);
  if (capped) res.setHeader("X-Audit-Export-Capped", "true");
  // Prepend a UTF-8 BOM so Excel opens accented text correctly.
  res.send("﻿" + csv);
});
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/audit/audit.controller.ts
git commit -m "feat(audit): add controller for list, actions, and CSV export"
```

---

## Task 5: Rate limiter + routes + mount

**Files:**
- Modify: `backend/src/middleware/rateLimit.middleware.ts`
- Create: `backend/src/modules/audit/audit.routes.ts`
- Modify: `backend/src/routes/index.ts`

- [ ] **Step 1: Add the export rate limiter**

In `backend/src/middleware/rateLimit.middleware.ts`, append after the existing `writeLimiter`:

```ts
// CSV export does heavier work than a normal read (scans up to the export cap),
// so throttle it even though a session is required.
export const exportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: json("Too many exports. Please wait a few minutes."),
});
```

- [ ] **Step 2: Create the routes file**

Create `backend/src/modules/audit/audit.routes.ts`:

```ts
import { Router } from "express";

import * as auditController from "./audit.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { exportLimiter } from "../../middleware/rateLimit.middleware.js";

const router = Router();

router.use(requireAuth);

// The audit trail is read-only over the API. All three endpoints require the
// audit.view permission (the super-admin holds it implicitly via "*").
router.get("/", requirePermission("audit.view"), auditController.listAuditLogs);
router.get("/actions", requirePermission("audit.view"), auditController.listActions);
router.get(
  "/export.csv",
  requirePermission("audit.view"),
  exportLimiter,
  auditController.exportAuditCsv,
);

export default router;
```

- [ ] **Step 3: Mount the routes**

In `backend/src/routes/index.ts`, add the import alongside the others (keep alphabetical-ish grouping):

```ts
import auditRoutes from "#modules/audit/audit.routes.js";
```

and add the mount in the "Feature routes" block (after `settingsRoutes`, before `userRoutes` is fine):

```ts
router.use("/audit", auditRoutes);
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Manual API check**

Start the backend (`cd backend && pnpm dev`) with the frontend running so you have an auth cookie (log in via the app), then in the browser devtools console (on the app origin, so cookies attach) or with an authenticated client:

- `GET /audit` → `{ entries, total, page, pageSize, totalPages }`.
- `GET /audit?action=<some.action>&page=1&pageSize=10` → narrowed result.
- `GET /audit/actions` → `{ actions: [...] }`.
- `GET /audit/export.csv?from=2026-01-01` → a CSV download, `Content-Type: text/csv`.
- As a principal WITHOUT `audit.view` → `403` on all three.
- Unauthenticated → `401`.

Expected: all behaviors as listed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/middleware/rateLimit.middleware.ts backend/src/modules/audit/audit.routes.ts backend/src/routes/index.ts
git commit -m "feat(audit): add export limiter, audit routes, and mount /audit"
```

---

## Task 6: Frontend types

**Files:**
- Create: `frontend/src/types/audit.ts`

- [ ] **Step 1: Create the types**

Create `frontend/src/types/audit.ts`:

```ts
// Audit trail types — mirror the backend PublicAuditEntry / PagedAuditLogs DTOs.

export type AuditActorType = "admin" | "user" | "customer" | "system";

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  // Arbitrary JSON snapshot recorded with the action (e.g. before/after values).
  metadata: unknown;
  createdAt: string; // ISO 8601
}

export interface PagedAuditLogs {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/types/audit.ts
git commit -m "feat(audit): add frontend audit types"
```

---

## Task 7: Frontend — blob download helper

**Files:**
- Create: `frontend/src/lib/download.ts`

- [ ] **Step 1: Create the helper**

Create `frontend/src/lib/download.ts`:

```ts
// Trigger a browser download for an in-memory Blob (e.g. a CSV export). Creates a
// temporary object URL + anchor, clicks it, then revokes the URL.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has initiated the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Pull the filename out of a Content-Disposition header, falling back to a default.
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match?.[1] ?? fallback;
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/download.ts
git commit -m "feat(audit): add blob download helper"
```

---

## Task 8: Frontend service

**Files:**
- Create: `frontend/src/services/audit.service.ts`

- [ ] **Step 1: Create the service**

Create `frontend/src/services/audit.service.ts`:

```ts
import axios from "axios";

import { api } from "@/lib/api";
import { env } from "@/lib/env";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import type { PagedAuditLogs } from "@/types/audit";

// Typed wrappers around the backend /audit endpoints. Components call these, never
// api()/axios directly.

export interface AuditListParams {
  search?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: AuditListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.action) sp.set("action", params.action);
  if (params.actorType) sp.set("actorType", params.actorType);
  if (params.targetType) sp.set("targetType", params.targetType);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listAuditLogs(params: AuditListParams = {}): Promise<PagedAuditLogs> {
  return api<PagedAuditLogs>(`/audit${qs(params)}`);
}

export function listAuditActions(): Promise<string[]> {
  return api<{ actions: string[] }>("/audit/actions").then((r) => r.actions);
}

// The CSV endpoint returns a file, not JSON, so it bypasses the api() wrapper and
// makes a direct authenticated blob request. Note: this does NOT get the silent
// refresh-on-401 that api() provides — acceptable since the user is already on an
// authenticated page. Returns whether the export was capped (server truncated it).
export async function exportAuditCsv(
  params: AuditListParams = {},
): Promise<{ capped: boolean }> {
  // Drop pagination — the export spans all matching rows up to the server cap.
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  const res = await axios.get(`${env.apiUrl}/audit/export.csv${qs(filters)}`, {
    withCredentials: true,
    responseType: "blob",
  });
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(
    res.headers["content-disposition"] ?? null,
    `audit-log-${date}.csv`,
  );
  downloadBlob(res.data as Blob, filename);
  const capped = String(res.headers["x-audit-export-capped"] ?? "") === "true";
  return { capped };
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS. (The `_page` / `_pageSize` rest-destructure discards are intentional; if the lint config flags unused vars, prefer `delete`-free rest as written — names prefixed `_` are conventionally allowed.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/audit.service.ts
git commit -m "feat(audit): add frontend audit service with CSV export"
```

---

## Task 9: Frontend — display helpers

**Files:**
- Create: `frontend/src/components/dashboard/audit/auditDisplay.ts`

- [ ] **Step 1: Create the helpers**

Create `frontend/src/components/dashboard/audit/auditDisplay.ts`:

```ts
// Presentation helpers for audit actions. Audit `action` keys are dotted verbs
// like "customer.project.created". We humanize unmapped keys and color them by
// the trailing verb so the table reads at a glance and future actions still render.

export type ActionTone = "create" | "update" | "delete" | "auth" | "neutral";

const VERB_TONE: Record<string, ActionTone> = {
  created: "create",
  updated: "update",
  deleted: "delete",
  login: "auth",
  logout: "auth",
};

export function actionTone(action: string): ActionTone {
  const verb = action.split(".").pop() ?? "";
  return VERB_TONE[verb] ?? "neutral";
}

// Tailwind classes per tone (uses the app's CSS variables / a small fixed palette).
export const TONE_CLASSES: Record<ActionTone, string> = {
  create: "bg-emerald-500/12 text-emerald-600",
  update: "bg-amber-500/12 text-amber-600",
  delete: "bg-rose-500/12 text-rose-600",
  auth: "bg-sky-500/12 text-sky-600",
  neutral: "bg-[var(--surface-2)] text-[var(--muted)]",
};

// "customer.project.created" → "Customer · Project · Created"
export function actionLabel(action: string): string {
  return action
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

// Relative time for the table ("2h ago"); the cell title shows the absolute time.
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/audit/auditDisplay.ts
git commit -m "feat(audit): add audit action display helpers"
```

---

## Task 10: Frontend — detail drawer

**Files:**
- Create: `frontend/src/components/dashboard/audit/AuditEntryDrawer.tsx`

- [ ] **Step 1: Create the drawer**

Create `frontend/src/components/dashboard/audit/AuditEntryDrawer.tsx`:

```tsx
"use client";

import * as React from "react";
import { X } from "lucide-react";

import type { AuditEntry } from "@/types/audit";
import { actionLabel, absoluteTime } from "./auditDisplay";

// Right-side slide-over showing the full audit entry incl. pretty-printed metadata.
// Closes on backdrop click, Escape, or the close button.
export function AuditEntryDrawer({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  const metadataText =
    entry.metadata == null ? null : JSON.stringify(entry.metadata, null, 2);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="anim-fade-in h-full w-full max-w-md overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-2)] p-5">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">
              {actionLabel(entry.action)}
            </h3>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">{entry.action}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <dl className="space-y-3 p-5 text-xs">
          <Row label="When">{absoluteTime(entry.createdAt)}</Row>
          <Row label="Actor">
            {entry.actorEmail ?? "—"}
            <span className="ml-2 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
              {entry.actorType}
            </span>
          </Row>
          <Row label="Actor ID">
            <span className="font-mono text-[var(--muted)]">{entry.actorId ?? "—"}</span>
          </Row>
          <Row label="Target">
            {entry.targetType ? (
              <>
                <span className="font-semibold text-[var(--ink)]">{entry.targetType}</span>
                {entry.targetLabel ? `: ${entry.targetLabel}` : ""}
              </>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Target ID">
            <span className="font-mono text-[var(--muted)]">{entry.targetId ?? "—"}</span>
          </Row>
        </dl>

        <div className="border-t border-[var(--border-2)] p-5">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            Metadata
          </p>
          {metadataText ? (
            <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink)]">
              {metadataText}
            </pre>
          ) : (
            <p className="text-xs text-[var(--muted)]">No metadata recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
        {label}
      </dt>
      <dd className="text-[var(--ink)]">{children}</dd>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/audit/AuditEntryDrawer.tsx
git commit -m "feat(audit): add audit entry detail drawer"
```

---

## Task 11: Frontend — the panel (filters + table + export)

**Files:**
- Create: `frontend/src/components/dashboard/audit/AuditLogPanel.tsx`

- [ ] **Step 1: Create the panel**

Create `frontend/src/components/dashboard/audit/AuditLogPanel.tsx`:

```tsx
"use client";

import * as React from "react";
import { Download, ScrollText, Search } from "lucide-react";

import * as auditService from "@/services/audit.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import type { AuditEntry } from "@/types/audit";
import { AuditEntryDrawer } from "./AuditEntryDrawer";
import { actionLabel, actionTone, TONE_CLASSES, relativeTime, absoluteTime } from "./auditDisplay";

const PAGE_SIZE = 25;
const ACTOR_TYPES = ["admin", "user", "customer", "system"] as const;

const selectCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]";

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>
              <td className="px-4 py-3"><Skeleton className="h-5 w-40 rounded-full" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-32" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-28" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditLogPanel() {
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [action, setAction] = React.useState("");
  const [actorType, setActorType] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);

  const [actions, setActions] = React.useState<string[]>([]);
  const [data, setData] = React.useState<import("@/types/audit").PagedAuditLogs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<AuditEntry | null>(null);
  const [exporting, setExporting] = React.useState(false);

  // Debounce the search box.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load the distinct action list once for the dropdown.
  React.useEffect(() => {
    auditService.listAuditActions().then(setActions).catch(() => setActions([]));
  }, []);

  const filters = React.useMemo(
    () => ({
      search: debounced || undefined,
      action: action || undefined,
      actorType: actorType || undefined,
      from: from || undefined,
      to: to || undefined,
    }),
    [debounced, action, actorType, from, to],
  );

  // Re-fetch on any query change.
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    auditService
      .listAuditLogs({ ...filters, page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setData(res);
        setError(null);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load the audit log.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, page]);

  const entries = data?.entries ?? [];
  const showSkeleton = loading && entries.length === 0;
  const isFiltered = Boolean(debounced || action || actorType || from || to);
  const total = data?.total ?? 0;

  const resetPageThen =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };

  const clearFilters = () => {
    setSearch("");
    setDebounced("");
    setAction("");
    setActorType("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const { capped } = await auditService.exportAuditCsv(filters);
      pushToast(
        capped
          ? "Exported the first 50,000 rows — narrow the filters for a smaller export."
          : "Audit log exported.",
        capped ? "alert" : "success",
      );
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Export failed.", "alert");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header + export */}
      <div
        className="flex flex-col gap-3 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Audit Log</h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Every change made in the system, newest first.
          </p>
        </div>
        <button
          onClick={doExport}
          disabled={exporting || total === 0}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs font-extrabold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:items-center lg:flex-wrap">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => resetPageThen(setSearch)(e.target.value)}
            placeholder="Search actor, target or action…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <select
          value={action}
          onChange={(e) => resetPageThen(setAction)(e.target.value)}
          className={selectCls}
          title="Action"
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <select
          value={actorType}
          onChange={(e) => resetPageThen(setActorType)(e.target.value)}
          className={selectCls}
          title="Actor type"
        >
          <option value="">All actors</option>
          {ACTOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => resetPageThen(setFrom)(e.target.value)}
            className={selectCls}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => resetPageThen(setTo)(e.target.value)}
            className={selectCls}
          />
        </label>
        {isFiltered && (
          <button
            onClick={clearFilters}
            className="text-xs font-bold text-[var(--accent)] hover:opacity-80 lg:ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <TableSkeleton />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ScrollText className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No entries match these filters" : "No audit entries yet"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 text-[var(--muted)]" title={absoluteTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}
                      >
                        {actionLabel(e.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[var(--ink)]">{e.actorEmail ?? "—"}</span>
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--faint)]">
                        {e.actorType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {e.targetType ? (
                        <>
                          <span className="font-semibold text-[var(--ink)]">{e.targetType}</span>
                          {e.targetLabel ? `: ${e.targetLabel}` : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          label="entries"
          onPage={setPage}
        />
      )}

      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS. (If the `import("@/types/audit").PagedAuditLogs` inline import draws a lint complaint, replace it by adding `PagedAuditLogs` to the `@/types/audit` import at the top and using `PagedAuditLogs | null` directly.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/audit/AuditLogPanel.tsx
git commit -m "feat(audit): add audit log panel with filters, table, and export"
```

---

## Task 12: Frontend — page + nav

**Files:**
- Create: `frontend/src/app/dashboard/audit/page.tsx`
- Modify: `frontend/src/components/dashboard/shell/Sidebar.tsx`

- [ ] **Step 1: Create the page**

Create `frontend/src/app/dashboard/audit/page.tsx`:

```tsx
import { AuditLogPanel } from "@/components/dashboard/audit/AuditLogPanel";
import { PermissionGate } from "@/components/auth/PermissionGate";

export default function AuditPage() {
  return (
    <PermissionGate anyOf={["audit.view"]}>
      <AuditLogPanel />
    </PermissionGate>
  );
}
```

- [ ] **Step 2: Add the nav item**

In `frontend/src/components/dashboard/shell/Sidebar.tsx`:

Add `ScrollText` to the lucide import (line 6):

```tsx
import { Building2, Package, ScrollText, Settings, UserCog, UserRound, X, ChevronDown, LogOut } from "lucide-react";
```

Add the nav entry to the `NAV` array (after the Settings entry):

```tsx
  {
    href: "/dashboard/audit",
    label: "Audit Log",
    icon: ScrollText,
    perms: ["audit.view"],
  },
```

(The existing `NAV.filter((item) => item.perms.some((p) => can(p)))` already hides it from anyone without `audit.view`, and customers get their own nav so they never see it.)

- [ ] **Step 3: Lint + build**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: PASS — the new route compiles and the dashboard builds.

- [ ] **Step 4: Manual UI check**

With backend + frontend running, logged in as the super-admin (or a role holding `audit.view`):

- The **Audit Log** item appears in the sidebar; clicking it opens `/dashboard/audit`.
- The table loads recent entries; the action / actor-type dropdowns and date range narrow results; search works; pagination pages through.
- Clicking a row opens the drawer with all fields and pretty-printed metadata; Escape / backdrop / X closes it.
- **Export CSV** downloads `audit-log-<date>.csv` honoring the active filters; it opens cleanly in Excel/Sheets with accents intact; the button is disabled when the table is empty.
- Log in as a user whose role lacks `audit.view`: the nav item is absent, and visiting `/dashboard/audit` directly shows the `PermissionGate` "no access" panel.

Expected: all behaviors as listed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/dashboard/audit/page.tsx frontend/src/components/dashboard/shell/Sidebar.tsx
git commit -m "feat(audit): add audit log page and sidebar nav item"
```

---

## Final verification

- [ ] **Backend:** `cd backend && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Frontend:** `cd frontend && pnpm lint && pnpm build` → PASS.
- [ ] **End-to-end:** with both apps running, perform an audited action (e.g. create/rename a role or job title), then open the Audit Log — the new entry appears at the top with the correct actor and target. Filter to its action, open its drawer, and export the filtered view; confirm the CSV contains that row with its metadata intact.
