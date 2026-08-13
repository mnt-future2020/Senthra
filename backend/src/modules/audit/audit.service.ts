import type { Prisma } from "@prisma/client";

import * as auditLogRepo from "./audit.repository.js";
import type { AuditListFilters } from "./audit.repository.js";
import { getAccessibleWarehouseIds } from "../../lib/warehouse-access.js";
import { csvEscape, EXPORT_MAX } from "../../utils/csv.js";
import { parseFilterDate } from "../../utils/filter-date.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDateTime } from "#modules/document/document.formatter.js";

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
// Re-exported rather than redefined: the ceiling is one number for every export (utils/csv), and
// this name is what the audit tests and callers already reference.
export const AUDIT_EXPORT_MAX = EXPORT_MAX;

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
    from: parseFilterDate(params.from, "start"),
    to: parseFilterDate(params.to, "end"),
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

// The audit read surface (list / facets / export) is scoped by the caller's warehouse access.
// A warehouse-scoped actor (a warehouse manager) sees ONLY audit entries for their assigned
// warehouses; an unrestricted actor (admin / non-scoped role, or no actor) sees everything.
// `getAccessibleWarehouseIds` returns the assigned set or `null` when unrestricted — normalize
// that to the repo's `scopeWarehouseIds` (`string[]` = restrict, `undefined` = no limit).
function warehouseScope(actor?: AuditActor): string[] | undefined {
  return getAccessibleWarehouseIds(actor) ?? undefined;
}

export async function listAuditLogs(params: ListAuditParams = {}, actor?: AuditActor): Promise<PagedAuditLogs> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 25), 1), 100);
  const filters: AuditListFilters = { ...normalizeFilters(params), scopeWarehouseIds: warehouseScope(actor) };
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

export async function listFacets(actor?: AuditActor): Promise<AuditFacets> {
  const scope = warehouseScope(actor);
  const [actions, actorTypes, targetTypes] = await Promise.all([
    auditLogRepo.distinctActions(scope),
    auditLogRepo.distinctActorTypes(scope),
    auditLogRepo.distinctTargetTypes(scope),
  ]);
  return { actions, actorTypes, targetTypes };
}

export interface AuditCsvResult {
  csv: string;
  count: number;
  capped: boolean;
}

// Serialize the filtered entries to a CSV string. Reuses the SAME filter
// normalization as listAuditLogs. `capped` is true when the result hit the cap.
export async function exportAuditCsv(params: ListAuditParams = {}, actor?: AuditActor): Promise<AuditCsvResult> {
  const filters: AuditListFilters = { ...normalizeFilters(params), scopeWarehouseIds: warehouseScope(actor) };
  const rows = await auditLogRepo.findForExport(filters, AUDIT_EXPORT_MAX);
  // Timestamps render in the COMPANY timezone with the configured date format, like every other
  // generated artifact. The column names the zone rather than saying "UTC", because a reader who
  // trusts a stale header misreads every row by an hour for half the year (BST = UTC+1).
  const regional = await getRegionalSettings();
  const header = [
    `When (${regional.timezone})`,
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
        // Seconds kept: audit entries land in the same minute routinely, and their order is the point.
        formatDateTime(r.createdAt, regional, { seconds: true }),
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
