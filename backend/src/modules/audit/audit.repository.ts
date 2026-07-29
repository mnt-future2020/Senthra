import type { AuditLog, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for the AuditLog model (immutable audit trail). The ONLY
// place Prisma is touched for audit entries.

export interface AuditListFilters {
  search?: string;
  action?: string;
  /** Exclude actions whose dotted key starts with this prefix (e.g. "auth." to drop login/logout/
   *  refresh from a business-activity view). The full Audit Log leaves this unset and shows everything. */
  excludeActionPrefix?: string;
  actorType?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  /** Warehouse SECURITY scope. When set (a warehouse-scoped actor), the result is hard-limited to
   *  warehouse-target entries for exactly these warehouse ids — this OVERRIDES any client-supplied
   *  targetType/targetId so a crafted query can't widen the view, and an empty array matches nothing.
   *  Absent (an unrestricted actor: admin / non-scoped role) applies no such limit. Set by the service
   *  from the principal's assigned warehouses; never from client input. */
  scopeWarehouseIds?: string[];
}

// Exported so the warehouse-scope override can be unit-tested directly (it's a security boundary,
// not a convenience filter). Building the Prisma `where` is the single place the scope is enforced.
export function buildAuditWhere(filters: AuditListFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  // Exact `action` wins over the prefix exclusion (they're never usefully combined; a specific
  // action filter already scopes tighter than "everything except a prefix").
  if (filters.action) where.action = filters.action;
  else if (filters.excludeActionPrefix) where.action = { not: { startsWith: filters.excludeActionPrefix } };
  if (filters.actorType) where.actorType = filters.actorType;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  }
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { actorEmail: { contains: q, mode: "insensitive" } },
      { targetLabel: { contains: q, mode: "insensitive" } },
      { targetId: { contains: q, mode: "insensitive" } },
      { action: { contains: q, mode: "insensitive" } },
    ];
  }
  // Warehouse scope LAST so a client can never widen past it. AND-composed with the search OR by
  // Prisma (top-level keys are ANDed), so a scoped search stays inside the scope.
  //
  // A client `targetId` is INTERSECTED with the scope, not discarded. Discarding it silently turned
  // "this ONE warehouse's history" into "every warehouse I'm assigned to" — and because targetType
  // is forced to "warehouse" anyway, the caller got back plausible-looking warehouse entries and had
  // no way to tell its filter had been ignored (the warehouse detail page's Activity tab read as
  // that warehouse's history while listing its siblings' too). Intersecting keeps the boundary
  // intact in BOTH directions: an id inside the set narrows to exactly it, and an id outside the set
  // — or a crafted non-warehouse target — narrows to nothing rather than falling back to the set.
  if (filters.scopeWarehouseIds) {
    where.targetType = "warehouse";
    where.targetId = {
      in: filters.targetId
        ? filters.scopeWarehouseIds.filter((id) => id === filters.targetId)
        : filters.scopeWarehouseIds,
    };
  }
  return where;
}

// Same scope, reduced to the `where` used by the distinct-value (facet) queries. Empty/absent
// scope → no constraint (the facets span the whole log, for an unrestricted actor).
function facetScopeWhere(scopeWarehouseIds?: string[]): Prisma.AuditLogWhereInput | undefined {
  if (!scopeWarehouseIds) return undefined;
  return { targetType: "warehouse", targetId: { in: scopeWarehouseIds } };
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
    where: buildAuditWhere(filters),
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });
}

export function count(filters: AuditListFilters = {}): Promise<number> {
  return prisma.auditLog.count({ where: buildAuditWhere(filters) });
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
    where: buildAuditWhere(filters),
    orderBy: { createdAt: "desc" },
    take,
  });
}

// Distinct action keys present in the log, ascending — feeds the UI's action
// filter dropdown so it only offers values that actually exist. `scopeWarehouseIds`
// (a warehouse-scoped actor) limits the facet to that actor's visible slice, so the
// dropdown never reveals actions from warehouses/domains they can't see.
export async function distinctActions(scopeWarehouseIds?: string[]): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: facetScopeWhere(scopeWarehouseIds),
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return rows.map((r) => r.action);
}

// Distinct actor types actually present (admin | user | customer | system). The
// UI offers only these, so a value no event ever produces (e.g. "system" until
// system-generated events exist) never shows as a dead filter option. Scoped as above.
export async function distinctActorTypes(scopeWarehouseIds?: string[]): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: facetScopeWhere(scopeWarehouseIds),
    distinct: ["actorType"],
    select: { actorType: true },
    orderBy: { actorType: "asc" },
  });
  return rows.map((r) => r.actorType);
}

// Distinct target types present (customer | role | user | email_template | …),
// nulls excluded — feeds the "domain" filter so entries can be narrowed by which
// entity they concern. A warehouse scope collapses this to just "warehouse".
export async function distinctTargetTypes(scopeWarehouseIds?: string[]): Promise<string[]> {
  const scope = facetScopeWhere(scopeWarehouseIds);
  const rows = await prisma.auditLog.findMany({
    where: scope ?? { targetType: { not: null } },
    distinct: ["targetType"],
    select: { targetType: true },
    orderBy: { targetType: "asc" },
  });
  return rows.flatMap((r) => (r.targetType ? [r.targetType] : []));
}
