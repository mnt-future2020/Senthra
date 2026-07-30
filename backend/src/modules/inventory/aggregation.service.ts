import * as inventoryRepo from "./inventory.repository.js";
import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
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
import { csvEscape } from "../../utils/csv.js";

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

export async function listStockPositions(
  params: PositionFilters & { page?: number; pageSize?: number } = {},
) {
  const all = await assembleAll(params);
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

  // Real counts from DB for overdue and this-month damage
  const cutoff = new Date(Date.now() - 14 * 86400000); // 14 days ago
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [overdue, thisMonthUnits] = await Promise.all([
    gmRepo.countOverdueIssues(cutoff),
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
}

export async function exportAllPositionsCsv(filters: PositionFilters): Promise<AllPositionsCsvResult> {
  const all = await assembleAll(filters);
  const rows = sortPositions(filterPositions(all, filters));

  const header = [
    "Item", "SKU", "Ownership", "Location", "Location Type",
    "Qty", "Available", "Value (GBP)", "Status", "Last Movement (UTC)",
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
        p.lastMovementAt,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }

  return { csv: lines.join("\r\n"), count: rows.length };
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
