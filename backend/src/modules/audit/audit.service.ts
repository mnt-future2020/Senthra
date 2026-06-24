import type { Prisma } from "@prisma/client";

import * as auditLogRepo from "./audit.repository.js";
import type { AuditListFilters } from "./audit.repository.js";

// Actor is snapshotted (id + email) so an entry stays meaningful even if that
// account is later renamed or removed.
export interface AuditActor {
  id?: string | null;
  type?: "admin" | "user" | "customer" | "system";
  email?: string | null;
  // The actor's effective permissions ("*" = all). Not persisted on the audit
  // row — carried so authorization guards can enforce a no-escalation rule (a
  // delegate must not grant permissions it doesn't itself hold).
  permissions?: string[];
  // The actor's accessible warehouse-id set, or null/absent = unrestricted. Not persisted — carried
  // so the warehouse-access helpers (getAccessibleWarehouseIds/assertWarehouseAccess/scopeFilter)
  // can scope every warehouse-bound operation to a warehouse-scoped role's assignments.
  assignedWarehouseIds?: string[] | null;
}

export interface AuditEntry {
  actor?: AuditActor;
  action: string; // "user.created", "role.deleted", ...
  targetType?: string; // user | role | email_template
  targetId?: string;
  targetLabel?: string; // snapshot, e.g. the user's email
  metadata?: Record<string, unknown>;
}

// Record an audit entry. Fire-and-forget by design: auditing must never break or
// slow the operation it describes, so a write failure is logged server-side only.
export function record(entry: AuditEntry): void {
  const data: Prisma.AuditLogCreateInput = {
    actorId: entry.actor?.id ?? null,
    actorType: entry.actor?.type ?? "admin",
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    targetLabel: entry.targetLabel ?? null,
  };
  if (entry.metadata) data.metadata = entry.metadata as Prisma.InputJsonValue;

  void auditLogRepo
    .create(data)
    .catch((e) =>
      console.error("Audit log write failed:", e instanceof Error ? e.message : e),
    );
}

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
  targetId?: string;
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

// Parse a filter date. A date-only value ("YYYY-MM-DD", what the UI's date input
// sends) is widened to the whole UTC day: the `start` edge → 00:00:00.000, the
// `end` edge → 23:59:59.999. This makes a "To" date INCLUSIVE of that day's events
// instead of cutting off at midnight, and keeps the range timezone-stable (the
// audit timestamps are stored in UTC). A full ISO datetime is used as-is. Invalid
// input → undefined (no filter).
function parseDate(value: string | undefined, edge: "start" | "end"): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${edge === "end" ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// SINGLE source of filter normalization — used by BOTH list and export so they
// can never diverge. Invalid values are dropped (no filter) rather than throwing:
// a typo'd query returns an unfiltered result, never a 500.
function normalizeFilters(params: ListAuditParams): AuditListFilters {
  const actorType =
    params.actorType && (ACTOR_TYPES as readonly string[]).includes(params.actorType)
      ? params.actorType
      : undefined;
  return {
    search: params.search?.trim() || undefined,
    action: params.action?.trim() || undefined,
    actorType,
    targetType: params.targetType?.trim() || undefined,
    targetId: params.targetId?.trim() || undefined,
    from: parseDate(params.from, "start"),
    to: parseDate(params.to, "end"),
  };
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

// The distinct values present in the log, for the filter dropdowns. Derived from
// the data so a filter never offers a value that would match zero rows.
export interface AuditFacets {
  actions: string[];
  actorTypes: string[];
  targetTypes: string[];
}

export async function listFacets(): Promise<AuditFacets> {
  const [actions, actorTypes, targetTypes] = await Promise.all([
    auditLogRepo.distinctActions(),
    auditLogRepo.distinctActorTypes(),
    auditLogRepo.distinctTargetTypes(),
  ]);
  return { actions, actorTypes, targetTypes };
}

// CSV cell escaping with spreadsheet formula-injection defense. The audit log
// stores user-controlled values (customer names, emails, SKUs, target labels), so
// a cell beginning with =, +, -, @, tab, or CR could be executed as a formula by
// Excel/Sheets on open. Neutralize that by prefixing such a value with a single
// quote, THEN apply RFC-4180 quoting (wrap + double any embedded quote) whenever
// the value contains a quote, comma, or newline. No dependency needed.
function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
