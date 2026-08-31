import * as inventoryRepo from "./inventory.repository.js";
import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import * as gmService from "#modules/goods-management/goods-management.service.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import {
  fromInventoryBalance,
  fromEngineerBalance,
  fromCustomerStockEntry,
  fromEngineerCustomerHolding,
  fromDamagedBalance,
  filterPositions,
  sortPositions,
  paginate,
  type StockPosition,
  type PositionFilters,
} from "./stock-position.js";
import { csvEscape, EXPORT_MAX } from "../../utils/csv.js";
import { warehouseScopeFilter, type WarehouseScopedActor } from "../../lib/warehouse-access.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDateTime } from "#modules/document/document.formatter.js";

// Engineer display name from a balance's included `engineer` relation (falls back to email, then a
// generic label). Single source of truth for the assemblers and the engineer-lens roll-up below.
const engineerName = (e: { firstName?: string | null; lastName?: string | null; email?: string | null }): string =>
  [e.firstName, e.lastName].filter(Boolean).join(" ") || e.email || "Engineer";

// Map an engineer van balance → StockPosition. Shared so the whole-inventory and item-scoped assemblers
// don't copy-paste the name derivation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapEngineerBalance = (b: any): StockPosition => fromEngineerBalance(b, engineerName(b.engineer ?? {}));

async function assembleAll(filters: PositionFilters): Promise<StockPosition[]> {
  const repoFilters = { warehouseId: filters.warehouseId, customerId: filters.customerId };

  const [companyWh, engBalances, custEntries, custHoldings, damaged] = await Promise.all([
    inventoryRepo.findAllBalancesForAggregation({ warehouseId: filters.warehouseId }),
    engineerRepo.findAllBalances(),
    customerRepo.findActiveStockEntries(repoFilters),
    gmRepo.findAllCustomerHoldings(),
    gmRepo.findAllDamaged(),
  ]);

  const positions: StockPosition[] = [
    ...companyWh.map(fromInventoryBalance),
    ...engBalances.map(mapEngineerBalance),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...custEntries.map((e: any) => fromCustomerStockEntry(e)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...custHoldings.map((h: any) => fromEngineerCustomerHolding(h)),
    ...damaged.map((d) => fromDamagedBalance(d)),
  ];
  return positions;
}

/**
 * Narrow assembled positions to what this actor is allowed to see. THE authorization boundary for
 * the Hub's position reads, and deliberately its own function so the list and the export cannot
 * answer it differently.
 *
 * They used to. `exportAllPositionsCsv` scoped its rows; `listStockPositions` took no actor at all,
 * so a warehouse-restricted user holding `inventory.view` could read every warehouse's positions
 * from the list endpoint while its own CSV of the same data came back correctly narrowed. Adding a
 * warehouse FILTER on top of that would have turned a latent gap into a one-click one — a filter
 * must only ever narrow what authorization already allows, never reach past it.
 *
 * A scoped actor sees WAREHOUSE-located rows (and their damaged counterparts) for their own
 * warehouses only. Engineer- and customer-held positions carry no warehouseId to test, so they are
 * excluded rather than passed through: handing a warehouse-restricted user the company-wide field
 * ledger would be a wider leak than the one the scope exists to prevent. This is exactly the rule
 * `selectLedgers` already applies to the movement feed.
 */
function scopePositions(all: StockPosition[], actor?: WarehouseScopedActor): StockPosition[] {
  const scope = warehouseScopeFilter(actor);
  if (scope === undefined) return all;
  return all.filter((p) => (p.locationType === "warehouse" || p.locationType === "damaged") && scope.includes(p.locationId));
}

export async function listStockPositions(
  params: PositionFilters & { page?: number; pageSize?: number } = {},
  actor?: WarehouseScopedActor,
) {
  // Order matters and is the whole point: permission scope, THEN the user's filters, THEN sort, THEN
  // the page. Filtering first would let a filter widen the set the scope was meant to bound.
  const all = scopePositions(await assembleAll(params), actor);
  const filtered = sortPositions(filterPositions(all, params));
  const { slice, total, page, pageSize, totalPages } = paginate(filtered, params.page, params.pageSize ?? 25);
  return { positions: slice, total, page, pageSize, totalPages };
}

export interface InventorySummary {
  company: { units: number; valuePence: number; value: number };
  customer: { units: number; customersHolding: number };
  engineer: { units: number; engineersHolding: number; overdue: number };
  damaged: { units: number; thisMonthUnits: number };
}

export async function getInventorySummary(): Promise<InventorySummary> {
  const all = await assembleAll({});
  const sum = (p: StockPosition[]) => p.reduce((n, r) => n + r.quantity, 0);

  const companyWh = all.filter((p) => p.ownership === "company" && p.locationType === "warehouse");
  const customerWh = all.filter((p) => p.ownership === "customer" && p.locationType === "warehouse");
  const engineer = all.filter((p) => p.locationType === "engineer");
  const damaged = all.filter((p) => p.locationType === "damaged");
  const valuePence = companyWh.reduce((n, r) => n + (r.valuePence ?? 0), 0);

  const customersHolding = new Set(customerWh.map((p) => p.customerId).filter(Boolean)).size;
  const engineersHolding = new Set(engineer.map((p) => p.locationId)).size;

  // Real counts from DB for overdue and this-month damage.
  // `overdue` goes through the goods-management service so this card counts exactly what the Overdue
  // tab lists — unique JOBS that still have stock out. It used to call a raw movement count, which
  // counted a three-scan job three times and never dropped reconciled ones, so the headline number
  // climbed forever and never matched the list it summarised.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [overdue, thisMonthUnits] = await Promise.all([
    gmService.getOverdueSummary().then((s) => s.count),
    gmRepo.countDamagedUnitsSince(monthStart),
  ]);

  return {
    company: { units: sum(companyWh), valuePence, value: valuePence / 100 },
    customer: { units: sum(customerWh), customersHolding },
    engineer: { units: sum(engineer), engineersHolding, overdue },
    damaged: { units: sum(damaged), thisMonthUnits },
  };
}

// ── Task 16: Item-scoped detail endpoints ────────────────────────────────────────────────────────

// Item-scoped assembly — the company pools that can hold an IRM item: warehouse (InventoryBalance),
// engineer van (EngineerStockBalance) and company damaged (DamagedStockBalance, ownerType=company).
// The customer pools are intentionally omitted: they only ever produce `customer_stock` positions,
// which the item-detail endpoints below already discard for an IRM item. This returns the SAME
// StockPosition rows, in the SAME order (warehouse → engineer → damaged) as
// `assembleAll({}).filter(p => p.itemKind === "irm" && p.itemId === irmItemId)`, but reads only this
// item's rows (leading-`irmItemId` indexes) instead of scanning the entire inventory. Mappers are
// reused verbatim, so there is no duplicated business logic. `assembleAll` is unchanged and remains the
// implementation for the whole-inventory consumers (list / summary / CSV).
async function assembleForIrmItem(irmItemId: string): Promise<StockPosition[]> {
  const [companyWh, engBalances, damaged] = await Promise.all([
    inventoryRepo.findAllBalances({ irmItemId }),
    engineerRepo.findBalancesByIrmItem(irmItemId),
    gmRepo.findCompanyDamagedByIrmItem(irmItemId),
  ]);

  return [
    ...companyWh.map(fromInventoryBalance),
    ...engBalances.map(mapEngineerBalance),
    ...damaged.map((d) => fromDamagedBalance(d)),
  ];
}

/** All StockPosition rows for a given IRM item across every pool and location. */
export async function getItemDistribution(irmItemId: string): Promise<StockPosition[]> {
  return assembleForIrmItem(irmItemId);
}

export interface ItemHolders {
  engineers: Array<{ engineerId: string; locationLabel: string; quantity: number; lastMovementAt: string }>;
  customers: Array<{ customerId: string | null; customerName: string | null; locationLabel: string; quantity: number; lastMovementAt: string }>;
}

/** Who currently holds stock of this IRM item — engineers (on-van) and customer consignment rows. */
export async function getItemHolders(irmItemId: string): Promise<ItemHolders> {
  const forItem = await assembleForIrmItem(irmItemId);

  const engineers = forItem
    .filter((p) => p.locationType === "engineer")
    .map((p) => ({
      engineerId: p.locationId,
      locationLabel: p.locationLabel,
      quantity: p.quantity,
      lastMovementAt: p.lastMovementAt,
    }));

  const customers = forItem
    .filter((p) => p.ownership === "customer")
    .map((p) => ({
      customerId: p.customerId,
      customerName: p.customerName,
      locationLabel: p.locationLabel,
      quantity: p.quantity,
      lastMovementAt: p.lastMovementAt,
    }));

  return { engineers, customers };
}

/** Jobs that have a kit line referencing this IRM item. */
export async function getItemJobs(irmItemId: string) {
  const jobs = await jobRepo.findJobsByIrmItem(irmItemId);
  return jobs.map((j) => ({
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    status: j.status,
    customerName: j.customerName,
    assignedEngineerEmail: j.assignedEngineer?.email ?? null,
    createdAt: j.createdAt.toISOString(),
    kitLines: j.kitLines
      .filter((l) => l.irmItemId === irmItemId)
      .map((l) => ({ id: l.id, qty: l.qty, warehouseName: l.warehouseName ?? null })),
  }));
}

// ── Task 18-BE: All-Inventory CSV ────────────────────────────────────────────────────────────────

export interface AllPositionsCsvResult {
  csv: string;
  count: number;
  /** True when the filtered set was longer than EXPORT_MAX and the file stops short of it. */
  capped: boolean;
}

/**
 * `actor` is what keeps this export inside the caller's warehouses.
 *
 * It is not optional decoration. This branch grants `inventory.export` to the warehouse-manager role,
 * whose comment in permissions.ts promises the download is "the same rows the screen already shows
 * them — never the company's". Nothing here delivered that: `assembleAll` scopes only on the explicit
 * `?warehouse=` filter, so a scoped manager calling this route with no filter received every
 * warehouse, every engineer's van and every customer's holdings in one file.
 *
 * A restricted actor keeps only the positions physically in a warehouse they hold — `warehouse` and
 * `damaged` both carry the warehouse id in `locationId`. Engineer vans, customer sites and transit
 * are dropped rather than guessed at: they are not the manager's warehouses, and defaulting to
 * "include" is what produced the leak in the first place. An unrestricted actor (admin, system, any
 * non-scoped role) is untouched — `warehouseScopeFilter` returns undefined for them.
 */
export async function exportAllPositionsCsv(
  filters: PositionFilters,
  actor?: WarehouseScopedActor,
): Promise<AllPositionsCsvResult> {
  // Same boundary as the list — see scopePositions for why this is shared rather than repeated.
  const all = scopePositions(await assembleAll(filters), actor);
  // Capped like every other export. This one alone rendered EVERY matching row into one string: the
  // set grows with the business and an unfiltered request would eventually be asked to hold all of
  // it in memory. It also reported a `count` header nothing on the client read, while the flag that
  // actually matters — "this file is not the whole answer" — was the one it never sent.
  const matched = sortPositions(filterPositions(all, filters));
  const rows = matched.slice(0, EXPORT_MAX);

  // Company timezone + configured date format, like every generated artifact; the column names the
  // zone so a reader is never left guessing which one the timestamps are in.
  const regional = await getRegionalSettings();
  const header = [
    "Item", "SKU", "Ownership", "Location", "Location Type",
    "Qty", "Available", "Value (GBP)", "Status", `Last Movement (${regional.timezone})`,
  ];
  const lines = [header.map(csvEscape).join(",")];

  for (const p of rows) {
    // Customer-owned and damaged-customer rows never expose value (Global Constraints)
    const showValue = p.ownership === "company" && p.locationType !== "damaged";
    lines.push(
      [
        p.itemName,
        p.sku ?? "",
        p.ownership,
        p.locationLabel,
        p.locationType,
        String(p.quantity),
        String(p.available),
        showValue && p.value != null ? p.value.toFixed(2) : "",
        p.status,
        formatDateTime(p.lastMovementAt, regional),
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }

  return { csv: lines.join("\r\n"), count: rows.length, capped: matched.length > EXPORT_MAX };
}

// ── Engineer lens — engineers + their holdings & jobs ──────────────────────────
export interface EngineerOverviewRow {
  engineerId: string;
  name: string;
  email: string | null;
  itemsHeld: number;
  totalQty: number;
  activeJobs: number;
}

// Every active field engineer with a roll-up of what they're holding + how many active jobs they have.
/**
 * The engineer lens's filters + paging. The list took NO parameters at all: every engineer, every
 * time, with no way to narrow it and no ceiling as the field team grows.
 *
 * Filtering and paging both happen after the roll-up because the numbers a reader filters ON
 * (`itemsHeld`, `totalQty`, `activeJobs`) are computed here, not stored — so `total` counts exactly
 * the rows the pager walks, which is the property that keeps a paginator from running off the end.
 */
export interface EngineerLensParams {
  /** Engineer name or email. */
  search?: string;
  /** Only engineers actually holding something — the operational reading of this list. */
  holdingOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PagedEngineerOverview {
  rows: EngineerOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const ENGINEER_LENS_PAGE_SIZE = 25;

/** One engineer, as a filter option. Deliberately narrower than EngineerOverviewRow — a picker
 *  needs an id and a name, and the roll-up numbers are the LIST view's business, not an option's. */
export interface EngineerOption {
  engineerId: string;
  name: string;
  email: string;
}

/**
 * Every field engineer, for the OPTION PICKERS (movement feed, custom reports, transfer composer).
 *
 * COMPLETE and unpaged, deliberately. This started as `listEngineerInventory()`, which returned the
 * whole roster; making the lens paged briefly turned the pickers into "the first 100 engineers", and
 * an option list that silently omits people is worse than one that is slow — an engineer past the
 * cap simply could not be picked, with nothing on screen saying so.
 *
 * It is also far cheaper than what it replaced: one indexed user query returning three columns, with
 * none of the balance/holding/job roll-ups the lens needs. Bounded by the size of the field team,
 * which is the same bound the identical picker on the jobs side has always had.
 */
export async function listEngineerOptions(): Promise<EngineerOption[]> {
  const users = await engineerRepo.findEngineers();
  return users
    .map((e) => ({ engineerId: e.id, name: engineerName(e), email: e.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listEngineerInventoryPaged(params: EngineerLensParams = {}): Promise<PagedEngineerOverview> {
  const all = await listEngineerInventory();
  const term = params.search?.trim().toLowerCase();
  const matched = all
    .filter((r) => !params.holdingOnly || r.itemsHeld > 0)
    .filter((r) => !term || [r.name, r.email].some((f) => f?.toLowerCase().includes(term)));
  const total = matched.length;
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? ENGINEER_LENS_PAGE_SIZE), 1), 100);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  return { rows: matched.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, totalPages };
}

export async function listEngineerInventory(): Promise<EngineerOverviewRow[]> {
  const [engineers, engBalances, custHoldings, jobCounts] = await Promise.all([
    engineerRepo.findEngineers(),
    engineerRepo.findAllBalances(),
    gmRepo.findAllCustomerHoldings(),
    jobRepo.countActiveJobsByEngineer(),
  ]);
  const agg = new Map<string, { items: number; qty: number }>();
  const bump = (id: string, qty: number) => {
    const cur = agg.get(id) ?? { items: 0, qty: 0 };
    cur.items += 1;
    cur.qty += qty;
    agg.set(id, cur);
  };
  for (const b of engBalances) bump(b.engineerId, b.quantityOnHand);
  for (const h of custHoldings) bump(h.engineerId, h.quantityOnHand);

  return engineers
    .map((e) => {
      const a = agg.get(e.id) ?? { items: 0, qty: 0 };
      return {
        engineerId: e.id,
        name: engineerName(e),
        email: e.email,
        itemsHeld: a.items,
        totalQty: a.qty,
        activeJobs: jobCounts.get(e.id) ?? 0,
      };
    })
    .sort((a, b) => b.totalQty - a.totalQty || b.activeJobs - a.activeJobs || a.name.localeCompare(b.name));
}

export interface EngineerHeldItem {
  itemCode: string;
  itemName: string;
  ownership: "company" | "customer";
  customerName: string | null;
  quantity: number;
}
export interface EngineerJobRow {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
  customerName: string | null;
}
export interface EngineerInventoryDetail {
  holdings: EngineerHeldItem[];
  jobs: EngineerJobRow[];
}

// One engineer's current holdings (company IRM + customer consignment) and their active jobs.
export async function getEngineerInventory(engineerId: string): Promise<EngineerInventoryDetail> {
  const [company, customer, activeJobs] = await Promise.all([
    engineerRepo.findBalancesByEngineer(engineerId),
    gmRepo.findCustomerHoldingsByEngineer(engineerId),
    // Every OPEN job for this engineer — DB-filtered to the active statuses. (findManyByEngineer is
    // paged and would cap this at 20; the Hub must list them all.)
    jobRepo.findActiveByEngineer(engineerId),
  ]);
  const holdings: EngineerHeldItem[] = [
    ...company.map((b) => ({
      itemCode: b.irmItem?.code ?? "",
      itemName: b.irmItem?.name ?? "",
      ownership: "company" as const,
      customerName: null,
      quantity: b.quantityOnHand,
    })),
    ...customer.map((h) => ({
      itemCode: "",
      itemName: h.itemName,
      ownership: "customer" as const,
      customerName: h.customerName ?? null,
      quantity: h.quantityOnHand,
    })),
  ];
  const jobs: EngineerJobRow[] = activeJobs
    .map((j) => ({ id: j.id, jobNumber: j.jobNumber, name: j.name, status: j.status, customerName: j.customerName ?? null }));
  return { holdings, jobs };
}
