import { CUSTOM_REPORT_FILTERS, findReport, reportsFor, type CustomReportDef, type CustomReportFilter } from "./customReports.registry.js";
import * as movementService from "#modules/inventory/movement.service.js";
import type { MovementFilters } from "#modules/inventory/movement.service.js";
import { decodeCursor } from "#modules/inventory/movement.js";
import * as reportRepo from "./customReports.repository.js";
import { isWarehouseScopedUser } from "../../lib/warehouse-access.js";
import { badRequest, forbidden } from "../../utils/http-error.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

// ── Custom Reports — the runner ────────────────────────────────────────────────────────────────
//
// One entry point. It resolves a registry KEY, validates the filters against what that report
// declares, and delegates to the module that already owns the data. It builds no queries of its own
// and holds no second copy of anybody's business rules — a report is a VIEW of an existing source,
// which is why nothing here reaches for Prisma.
//
// Financial reports are not served from here at all. Spend, VAT and cost live in the Finance module
// and its canonical layer; a costed report would reuse that, never duplicate it.

/** Hard ceiling on a single report. Beyond it the answer is "narrow the filters", not a slow page. */
export const REPORT_MAX_ROWS = 5_000;

export interface CustomReportRequest {
  reportKey: string;
  filters: Partial<Record<CustomReportFilter, string>>;
  /** Rows per page for the on-screen view. Exports take the whole (bounded) set. */
  limit?: number;
  cursor?: string | null;
}

export interface CustomReportResult {
  report: { key: string; label: string; description: string; columns: CustomReportDef["columns"] };
  rows: Record<string, string | number>[];
  /** Set when the row cap was reached — never truncate silently. */
  capped: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  appliedFilters: Record<string, string>;
  generatedAt: string;
}

/**
 * Resolve and authorise the report, and reject any filter it does not declare.
 *
 * REJECTED, not ignored: a user who filters by project on a report that cannot honour it would
 * otherwise receive the unfiltered set and believe it was scoped. Silently widening a report is worse
 * than refusing it.
 */
function resolve(actor: AuditActor | undefined, req: CustomReportRequest, isCustomer: boolean): CustomReportDef {
  const def = findReport(req.reportKey);
  if (!def) throw badRequest("That report type isn't available.");

  const canFinance = (actor?.permissions ?? []).some((p) => p === "*" || p === "reports.finance.view");
  // The SAME list the catalogue endpoint offers, so a report that is not on the dropdown is refused
  // here too — the picker is a convenience, this is the gate. A customer is never warehouse-scoped
  // (actorFrom gives every non-"user" principal a null warehouse set), so the flag is read from the
  // one helper that owns the question.
  if (!reportsFor({ isCustomer, canFinance, isWarehouseScoped: !isCustomer && isWarehouseScopedUser(actor) }).some((r) => r.key === def.key)) {
    // Deliberately the same message a missing permission gets: telling a scoped user that this report
    // exists but is not scopable for them describes the data model to someone who cannot see it.
    throw forbidden("You don't have access to that report.");
  }

  for (const [key, value] of Object.entries(req.filters)) {
    if (value === undefined || value === "") continue;
    if (!CUSTOM_REPORT_FILTERS.includes(key as CustomReportFilter)) throw badRequest(`Unknown filter "${key}".`);
    if (!def.filters.includes(key as CustomReportFilter)) {
      throw badRequest(`"${def.label}" can't be filtered by ${key}.`);
    }
  }
  return def;
}

const asDate = (v: string | undefined, endOfDay = false): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  // A date-only upper bound parses to UTC midnight, which with `lte` would EXCLUDE that whole day.
  // The movement feed already applies this rule; matching it here keeps ONE date convention.
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUTCHours(23, 59, 59, 999);
  return d;
};

/** Trim the applied filters to what actually took effect, for the report header and the export. */
function appliedOf(filters: Partial<Record<CustomReportFilter, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) if (v) out[k] = v;
  return out;
}


/**
 * The movement feed's own maximum page size (`movement.service.clampLimit`).
 *
 * Mirrored, not imported, because it is that module's UI paging concern and not a reports constant —
 * but the number has to be known here, for the reason below.
 */
const MOVEMENT_PAGE = 100;

/**
 * Collect up to `want` movements, paging the feed with its own cursor.
 *
 * `listMovements` CLAMPS a single page to 100 rows. That is correct for the ledger screen it was
 * built for and silently wrong for an export: the export path asks for `REPORT_MAX_ROWS` (5,000),
 * received 100, and — because nothing downstream looked at `hasMore` — reported `capped: false`,
 * wrote no `X-Export-Capped` header and handed the user a 100-row file that looked like the whole
 * answer. The scheduled versions of those reports mailed the same truncated workbook every month.
 *
 * Fixed HERE rather than by raising the feed's clamp: 100 is a deliberate page size for an
 * interactive ledger, and lifting it would let every caller of a shared service pull 5,000 rows in
 * one request. Paging with the keyset cursor the feed already returns keeps that contract intact and
 * confines the change to the module that actually needs the whole set.
 *
 * `capped` is then honest: it means "we stopped at the report ceiling", not "the page came back
 * short". One request is still one request for the on-screen limit of 100.
 */
async function collectMovements(
  fetchPage: (cursor: string | null, size: number) => ReturnType<typeof movementService.listMovements>,
  want: number,
  startCursor: string | null,
): Promise<{ movements: Awaited<ReturnType<typeof movementService.listMovements>>["movements"]; nextCursor: string | null; hasMore: boolean }> {
  const movements: Awaited<ReturnType<typeof movementService.listMovements>>["movements"] = [];
  let cursor = startCursor;
  let nextCursor: string | null = null;
  let hasMore = false;

  while (movements.length < want) {
    const page = await fetchPage(cursor, Math.min(want - movements.length, MOVEMENT_PAGE));
    movements.push(...page.movements);
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    // Nothing further to read, or the feed returned no cursor to continue from.
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { movements: movements.slice(0, want), nextCursor, hasMore };
}

export async function runCustomReport(
  actor: AuditActor | undefined,
  req: CustomReportRequest,
  opts: { isCustomer?: boolean; customerId?: string } = {},
): Promise<CustomReportResult> {
  const isCustomer = Boolean(opts.isCustomer);
  const def = resolve(actor, req, isCustomer);
  const f = req.filters;
  const limit = Math.min(Math.max(req.limit ?? 100, 1), REPORT_MAX_ROWS);

  // A customer's own id is forced from their SESSION, never read off the query string. This is the
  // line that makes cross-customer access impossible rather than merely discouraged.
  const customerId = isCustomer ? opts.customerId : f.customerId;
  if (isCustomer && !customerId) throw forbidden("No customer context.");

  let rows: Record<string, string | number>[] = [];
  let nextCursor: string | null = null;
  let hasMore = false;
  // The HARD ceiling was reached — distinct from `hasMore`, which is just "there is another page".
  // Tracked separately because a paged report's `rows` is one page, so counting THOSE against the cap
  // could never trip it: engineer_stock would have hit 5,000 holdings and reported 100 rows, capped
  // false, with the remainder simply gone.
  let capped = false;

  if (def.key === "stock_movement") {
    const filter: MovementFilters = {
      dateFrom: asDate(f.dateFrom),
      dateTo: asDate(f.dateTo, true),
      irmItemId: f.irmItemId,
      warehouseId: f.warehouseId,
      engineerId: f.engineerId,
      customerId,
      // A customer sees only their own consignment stock — never company IRM.
      ownership: isCustomer ? "customer" : (f.itemKind === "customer" ? "customer" : f.itemKind === "irm" ? "company" : undefined),
    };
    const page = await collectMovements(
      // The ACTOR is passed, not a scope computed here. `listMovements` derives
      // `scopeWarehouseIds` from the actor and OVERWRITES whatever the filter object carried, so a
      // scope set here was silently discarded and the read ran company-wide — and, because the
      // ledger set is only narrowed when the scope is defined, it also returned the engineer vans.
      // Warehouse authorization has exactly one home (lib/warehouse-access, via movement.service);
      // this is the boundary that hands it the actor. A customer principal is unrestricted there
      // (`assignedWarehouseIds: null`), so their isolation stays `customerId`, unchanged.
      (c, size) => movementService.listMovements(filter, decodeCursor(c), size, actor),
      limit,
      req.cursor ?? null,
    );
    capped = page.movements.length >= REPORT_MAX_ROWS;
    // The feed already de-duplicates a physical event that touched two ledgers, via its synthetic
    // `${ledger}:${rawId}` id — this is a projection of those rows, so it inherits that guarantee.
    rows = page.movements.map((m) => ({
      date: m.date.slice(0, 10),
      itemName: m.itemName,
      itemCode: m.itemCode,
      movement: m.label,
      quantity: m.quantityDelta,
      location: m.locationLabel,
      engineerName: m.engineerId ? (m.toLabel ?? m.fromLabel ?? "") : "",
      customerName: m.customerName ?? "",
      reference: m.reference ?? "",
      source: m.sourceType,
    }));
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
  } else if (def.key === "project_activity") {
    const page = await runProjectActivity(actor, f, limit, req.cursor ?? null);
    rows = page.rows;
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    capped = page.capped;
  } else if (def.key === "engineer_stock") {
    const page = await runEngineerStock(f, limit, req.cursor ?? null);
    rows = page.rows;
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    capped = page.capped;
  }

  return {
    report: { key: def.key, label: def.label, description: def.description, columns: def.columns },
    rows,
    // The cursor-paged reports report it the same way they always did: a page that came back FULL at
    // the cap is the cap being hit.
    capped: capped || rows.length >= REPORT_MAX_ROWS,
    nextCursor,
    hasMore,
    appliedFilters: appliedOf({ ...f, ...(isCustomer ? { customerId: undefined } : {}) }),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Project Activity — job stock movements, resolved to the project their job belongs to.
 *
 * Two bounded steps, no N+1: the movement feed answers the period, then ONE batched job read resolves
 * every distinct job to its project. `Job.projectId` is required, so a job always resolves; a movement
 * with no job simply is not project activity and is dropped rather than bucketed as "unknown".
 */
async function runProjectActivity(
  actor: AuditActor | undefined,
  f: Partial<Record<CustomReportFilter, string>>,
  limit: number,
  cursor: string | null,
): Promise<{ rows: Record<string, string | number>[]; nextCursor: string | null; hasMore: boolean; capped: boolean }> {
  const filter: MovementFilters = {
    dateFrom: asDate(f.dateFrom),
    dateTo: asDate(f.dateTo, true),
    irmItemId: f.irmItemId,
    warehouseId: f.warehouseId,
    customerId: f.customerId,
    // Job issues and returns are what a project consumed; other ledgers are warehouse plumbing.
    sourceType: "goods_management",
  };
  const page = await collectMovements(
    // Same boundary rule as stock_movement above: the actor goes through, the scope is derived once
    // inside movement.service and never recomputed here.
    (c, size) => movementService.listMovements(filter, decodeCursor(c), size, actor),
    limit,
    cursor,
  );

  // `sourceId` on a goods_management row is the JobStockMovement id — one batched read resolves the
  // whole page to its jobs and projects. Never per row.
  const movementIds = [...new Set(page.movements.map((m) => m.sourceId).filter(Boolean))];
  const jobs = await reportRepo.findMovementJobProjects(movementIds);

  const rows = page.movements.flatMap((m) => {
    const job = jobs.get(m.sourceId);
    if (!job) return [];
    if (f.projectId && job.projectId !== f.projectId) return [];
    // Site is the third level under customer → project, and the one a field manager actually asks
    // about. Filtered here beside the project for the same reason: both live on the JOB the movement
    // belongs to, which is resolved in the batched read above rather than per row.
    if (f.siteId && job.siteId !== f.siteId) return [];
    return [
      {
        date: m.date.slice(0, 10),
        projectName: job.projectName,
        siteName: job.siteName ?? "",
        jobNumber: job.jobNumber,
        itemName: m.itemName,
        quantity: m.quantityDelta,
        engineerName: m.toLabel ?? m.fromLabel ?? "",
        customerName: m.customerName ?? "",
        movement: m.label,
      },
    ];
  });
  return {
    rows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    // Judged on the SOURCE page, never on `rows`.
    //
    // This report DROPS movements whose job does not resolve, and drops more again when a project
    // filter is set — so `rows` is always shorter than what was fetched, often far shorter. Counting
    // those survivors against the ceiling meant a run that hit the cap reported `capped: false`: the
    // export set no `X-Export-Capped` header and handed over a short file that looked complete. The
    // page coming back full at the limit is what "the cap was reached" actually means.
    capped: page.movements.length >= REPORT_MAX_ROWS,
  };
}

/** Engineer Stock — current holdings. A position, not a movement. */
async function runEngineerStock(
  f: Partial<Record<CustomReportFilter, string>>,
  limit: number,
  cursor: string | null,
): Promise<{ rows: Record<string, string | number>[]; nextCursor: string | null; hasMore: boolean; capped: boolean }> {
  // The whole ordered set, bounded by the report cap — see findEngineerHoldings for why the sort
  // cannot be pushed into the query, and therefore why the page cannot be either.
  const balances = await reportRepo.findEngineerHoldings(
    { engineerId: f.engineerId, irmItemId: f.irmItemId },
    REPORT_MAX_ROWS,
  );

  // An OFFSET cursor, unlike the movement feed's keyed one. That is honest for this report rather
  // than lazy: it is a position snapshot with no monotonic key to seek on, and the set it pages is
  // one already-materialised array. `Number()` of anything unparseable falls back to 0 — a malformed
  // cursor restarts the report rather than 500ing on it.
  const offset = Math.max(0, Math.trunc(Number(cursor)) || 0);
  const page = balances.slice(offset, offset + limit);
  const hasMore = offset + page.length < balances.length;

  return {
    rows: page.map((b) => ({
      engineerName: b.engineerName,
      itemName: b.itemName,
      itemCode: b.itemCode,
      quantity: b.quantity,
    })),
    nextCursor: hasMore ? String(offset + page.length) : null,
    hasMore,
    // Judged on the whole set, not the page: this is "there is more than the report can ever return",
    // which is a different statement from "there is another page".
    capped: balances.length >= REPORT_MAX_ROWS,
  };
}

/** The catalogue this actor may choose from — the dropdown's only source. */
export function listAvailableReports(actor: AuditActor | undefined, isCustomer: boolean): CustomReportDef[] {
  const canFinance = (actor?.permissions ?? []).some((p) => p === "*" || p === "reports.finance.view");
  return reportsFor({ isCustomer, canFinance, isWarehouseScoped: !isCustomer && isWarehouseScopedUser(actor) });
}
