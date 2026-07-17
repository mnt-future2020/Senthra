// Stock Movement History — the unified Stock Ledger read model.
//
// A READ-ONLY, cursor-paginated union of the four append-only delta ledgers (the only sources of truth
// for stock movement). Each ledger is fetched keyset-ordered by (createdAt DESC, id DESC); the pages are
// merged on that same total order, so the result is one coherent, deeply-paginable movement stream with
// NO new table, NO duplicate data and NO write-path changes. JobStockMovement is deliberately absent —
// it is a source document (reached via `reference`), not a ledger leg, so including it would double-count
// the engineer/customer ledgers it spawns.

import * as inventoryRepo from "./inventory.repository.js";
import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import {
  fromInventoryTxn,
  fromEngineerTxn,
  fromEngineerCustomerTxn,
  fromDamagedTxn,
  encodeCursor,
  decodeCursor,
  type Movement,
  type MovementCursor,
} from "./movement.js";

export interface MovementFilters {
  dateFrom?: Date;
  dateTo?: Date;
  irmItemId?: string;
  warehouseId?: string;
  engineerId?: string;
  customerId?: string;
  ownership?: "company" | "customer";
  locationType?: "warehouse" | "engineer" | "damaged";
  type?: string;
  sourceType?: string;
}

export interface MovementPage {
  movements: Movement[];
  nextCursor: string | null;
  hasMore: boolean;
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function asDate(v: unknown): Date | undefined {
  const s = asStr(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
// A date-only `to` bound (e.g. "2026-06-30") parses to UTC midnight; with `lte` that would silently
// EXCLUDE every movement on that day. Treat a date-only upper bound as the inclusive end of the day so
// "To = 30 Jun" actually includes 30 Jun. A full datetime is honoured verbatim.
function asDateEnd(v: unknown): Date | undefined {
  const s = asStr(v);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  if (DATE_ONLY.test(s)) d.setUTCHours(23, 59, 59, 999);
  return d;
}

// Parse the shared movement query params (express req.query) into MovementFilters. Junk values are
// dropped, never thrown on — a movement feed should degrade to "unfiltered", not 500.
export function movementFiltersFrom(q: Record<string, unknown>): MovementFilters {
  const ownership = asStr(q.ownership);
  const location = asStr(q.location);
  return {
    dateFrom: asDate(q.dateFrom),
    dateTo: asDateEnd(q.dateTo),
    irmItemId: asStr(q.irmItem),
    warehouseId: asStr(q.warehouse),
    engineerId: asStr(q.engineer),
    customerId: asStr(q.customer),
    ownership: ownership === "company" || ownership === "customer" ? ownership : undefined,
    locationType: location === "warehouse" || location === "engineer" || location === "damaged" ? location : undefined,
    type: asStr(q.type),
    sourceType: asStr(q.sourceType),
  };
}

type LedgerKind = "inventory" | "engineer" | "engineerCustomer" | "damaged";
const ALL_LEDGERS: LedgerKind[] = ["inventory", "engineer", "engineerCustomer", "damaged"];

// Which `type` values each ledger can emit — lets a type filter prune ledgers that could never match.
const CAN_EMIT: Record<LedgerKind, ReadonlySet<string>> = {
  inventory: new Set(["goods_in", "goods_out", "transfer_in", "transfer_out", "manual_add", "manual_adjust", "restore"]),
  engineer: new Set(["goods_out", "transfer_in", "transfer_out", "job_issue", "job_return", "job_consume", "job_lost", "return", "usage", "van_restock", "van_return"]),
  engineerCustomer: new Set(["job_issue", "job_return", "job_consume", "job_lost", "transfer_in", "transfer_out"]),
  damaged: new Set(["write_off", "restore"]),
};

// Narrow the ledger set to those that can possibly satisfy the filters (also makes the query cheaper).
function selectLedgers(f: MovementFilters, restrictTo?: LedgerKind[]): LedgerKind[] {
  let kinds = restrictTo ? ALL_LEDGERS.filter((k) => restrictTo.includes(k)) : [...ALL_LEDGERS];
  if (f.ownership === "company") kinds = kinds.filter((k) => k !== "engineerCustomer");
  if (f.ownership === "customer") kinds = kinds.filter((k) => k === "engineerCustomer" || k === "damaged");
  if (f.locationType === "warehouse") kinds = kinds.filter((k) => k === "inventory");
  if (f.locationType === "engineer") kinds = kinds.filter((k) => k === "engineer" || k === "engineerCustomer");
  if (f.locationType === "damaged") kinds = kinds.filter((k) => k === "damaged");
  if (f.engineerId) kinds = kinds.filter((k) => k === "engineer" || k === "engineerCustomer");
  if (f.warehouseId) kinds = kinds.filter((k) => k === "inventory" || k === "damaged");
  if (f.irmItemId) kinds = kinds.filter((k) => k === "inventory" || k === "engineer" || k === "damaged");
  if (f.customerId) kinds = kinds.filter((k) => k === "engineerCustomer" || k === "damaged");
  if (f.type) kinds = kinds.filter((k) => CAN_EMIT[k].has(f.type!));
  return kinds;
}

interface Tagged {
  kind: LedgerKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: any;
  createdAt: Date;
  id: string;
}

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return 25;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

// Core query: fetch limit+1 keyset rows from every selected ledger, merge on (createdAt DESC, id DESC),
// take the page, then resolve the metadata the bare ledger rows lack and map to the Movement DTO.
async function queryUnified(
  filters: MovementFilters,
  cursor: MovementCursor | null,
  limit: number,
  restrictTo?: LedgerKind[],
): Promise<MovementPage> {
  const kinds = selectLedgers(filters, restrictTo);
  if (kinds.length === 0) return { movements: [], nextCursor: null, hasMore: false };

  const before = cursor ? { createdAt: new Date(cursor.t), id: cursor.id } : null;
  const fetch = limit + 1;

  // A customerId filter must be translated to the consignment ledger's entry ids (it stores no customerId).
  // An empty result must stay an empty `in: []` (which matches nothing) — a non-ObjectId sentinel would
  // throw P2023 (Malformed ObjectID) → 500 when the customer has no stock entries.
  let customerEntryIds: string[] | undefined;
  if (filters.customerId && kinds.includes("engineerCustomer")) {
    customerEntryIds = await gmRepo.findCustomerStockEntryIdsByCustomer(filters.customerId);
  }
  const damagedSign = filters.type === "restore" ? "neg" : filters.type === "write_off" ? "pos" : undefined;

  const tasks: Promise<Tagged[]>[] = [];
  if (kinds.includes("inventory")) {
    tasks.push(
      inventoryRepo
        .findInventoryTxnPage(
          { dateFrom: filters.dateFrom, dateTo: filters.dateTo, irmItemId: filters.irmItemId, warehouseId: filters.warehouseId, type: filters.type, sourceType: filters.sourceType },
          before,
          fetch,
        )
        .then((rows) => rows.map((r) => ({ kind: "inventory" as const, row: r, createdAt: r.createdAt, id: r.id }))),
    );
  }
  if (kinds.includes("engineer")) {
    tasks.push(
      engineerRepo
        .findEngineerTxnPage(
          { dateFrom: filters.dateFrom, dateTo: filters.dateTo, irmItemId: filters.irmItemId, engineerId: filters.engineerId, type: filters.type, sourceType: filters.sourceType },
          before,
          fetch,
        )
        .then((rows) => rows.map((r) => ({ kind: "engineer" as const, row: r, createdAt: r.createdAt, id: r.id }))),
    );
  }
  if (kinds.includes("engineerCustomer")) {
    tasks.push(
      gmRepo
        .findEngineerCustomerTxnPage(
          { dateFrom: filters.dateFrom, dateTo: filters.dateTo, engineerId: filters.engineerId, customerStockEntryIds: customerEntryIds, type: filters.type, sourceType: filters.sourceType },
          before,
          fetch,
        )
        .then((rows) => rows.map((r) => ({ kind: "engineerCustomer" as const, row: r, createdAt: r.createdAt, id: r.id }))),
    );
  }
  if (kinds.includes("damaged")) {
    tasks.push(
      gmRepo
        .findDamagedTxnPage(
          {
            dateFrom: filters.dateFrom,
            dateTo: filters.dateTo,
            warehouseId: filters.warehouseId,
            ownerType: filters.ownership,
            irmItemId: filters.irmItemId,
            customerId: filters.customerId,
            sourceType: filters.sourceType,
            sign: damagedSign,
          },
          before,
          fetch,
        )
        .then((rows) => rows.map((r) => ({ kind: "damaged" as const, row: r, createdAt: r.createdAt, id: r.id }))),
    );
  }

  const merged = (await Promise.all(tasks)).flat();
  // Total order: newest first, ObjectId as the deterministic tiebreak (matches each ledger's keyset).
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ t: last.createdAt.getTime(), id: last.id }) : null;

  const movements = await mapPage(page);
  return { movements, nextCursor, hasMore };
}

// Resolve the metadata bare ledger rows lack (one batch query per kind of lookup), then map to Movement.
async function mapPage(page: Tagged[]): Promise<Movement[]> {
  const engineerIds = new Set<string>();
  const entryIds = new Set<string>();
  const irmIds = new Set<string>();
  const warehouseIds = new Set<string>();
  for (const t of page) {
    if (t.kind === "engineer" || t.kind === "engineerCustomer") engineerIds.add(t.row.engineerId);
    if (t.kind === "engineerCustomer") entryIds.add(t.row.customerStockEntryId);
    if (t.kind === "damaged") {
      if (t.row.warehouseId) warehouseIds.add(t.row.warehouseId);
      if (t.row.ownerType === "company" && t.row.irmItemId) irmIds.add(t.row.irmItemId);
      if (t.row.ownerType !== "company" && t.row.customerStockEntryId) entryIds.add(t.row.customerStockEntryId);
    }
  }
  const [engNames, entryMeta, irmMeta, whNames] = await Promise.all([
    engineerRepo.findEngineerNamesByIds([...engineerIds]),
    gmRepo.findCustomerEntryMetaByIds([...entryIds]),
    inventoryRepo.findIrmMetaByIds([...irmIds]),
    inventoryRepo.findWarehouseNamesByIds([...warehouseIds]),
  ]);

  return page.map((t) => {
    switch (t.kind) {
      case "inventory":
        return fromInventoryTxn(t.row);
      case "engineer":
        return fromEngineerTxn(t.row, engNames.get(t.row.engineerId) ?? "Engineer");
      case "engineerCustomer": {
        const m = entryMeta.get(t.row.customerStockEntryId);
        return fromEngineerCustomerTxn(t.row, {
          engineerName: engNames.get(t.row.engineerId) ?? "Engineer",
          itemName: m?.itemName ?? "Customer item",
          sku: m?.sku ?? null,
          customerId: m?.customerId ?? null,
          customerName: m?.customerName ?? null,
        });
      }
      case "damaged": {
        const isCompany = t.row.ownerType === "company";
        const meta = isCompany
          ? { itemCode: irmMeta.get(t.row.irmItemId)?.code ?? "", itemName: irmMeta.get(t.row.irmItemId)?.name ?? "Item", warehouseName: whNames.get(t.row.warehouseId) ?? "" }
          : { itemCode: "", itemName: entryMeta.get(t.row.customerStockEntryId)?.itemName ?? "Customer item", warehouseName: whNames.get(t.row.warehouseId) ?? "" };
        return fromDamagedTxn(t.row, meta);
      }
    }
  });
}

// Company-wide history (admin). Honours every structured filter.
export function listMovements(filters: MovementFilters, cursor: MovementCursor | null, limit?: number): Promise<MovementPage> {
  return queryUnified(filters, cursor, clampLimit(limit));
}

// Engineer-scoped history. The engineerId is ALWAYS the signed-in engineer (never client-supplied), and
// only the two engineer-van ledgers are ever queried — warehouse/damaged movements are never exposed.
export function listEngineerMovements(engineerId: string, filters: MovementFilters, cursor: MovementCursor | null, limit?: number): Promise<MovementPage> {
  const scoped: MovementFilters = { ...filters, engineerId, warehouseId: undefined };
  return queryUnified(scoped, cursor, clampLimit(limit), ["engineer", "engineerCustomer"]);
}

// ── CSV export of the FILTERED movement history ──────────────────────────────────────────────────
// Walks the keyset cursor through every matching row (up to a hard cap so an unbounded ledger can't OOM
// the process), honouring the exact same filters as the on-screen feed.
const EXPORT_CAP = 50_000;
const EXPORT_PAGE = 1000;

async function collectMovements(filters: MovementFilters, restrictTo?: LedgerKind[]): Promise<{ rows: Movement[]; capped: boolean }> {
  const rows: Movement[] = [];
  let cursor: MovementCursor | null = null;
  for (;;) {
    const page = await queryUnified(filters, cursor, EXPORT_PAGE, restrictTo);
    rows.push(...page.movements);
    if (rows.length >= EXPORT_CAP) return { rows: rows.slice(0, EXPORT_CAP), capped: true };
    if (!page.hasMore || !page.nextCursor) return { rows, capped: false };
    cursor = decodeCursor(page.nextCursor);
    if (!cursor) return { rows, capped: false };
  }
}

// Formula-injection-safe cell escaping — mirrors aggregation.service / inventory.service csvEscape.
function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface MovementCsvResult {
  csv: string;
  count: number;
  capped: boolean;
}

// The movement DTO carries NO value/cost field, so the export is pricing-safe by construction (honours
// the "customers never see pricing" constraint without special-casing).
export async function exportMovementsCsv(filters: MovementFilters): Promise<MovementCsvResult> {
  const { rows, capped } = await collectMovements(filters);
  const header = [
    "Date (UTC)", "Type", "Item", "Code", "SKU", "Ownership", "Location Type",
    "Location", "Quantity", "Balance After", "Reference", "Source", "Actor",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const m of rows) {
    lines.push(
      [
        m.date,
        m.label,
        m.itemName,
        m.itemCode,
        m.sku ?? "",
        m.ownership,
        m.locationType,
        m.locationLabel,
        String(m.quantityDelta),
        m.balanceAfter == null ? "" : String(m.balanceAfter),
        m.reference ?? "",
        m.sourceType,
        m.actor ?? "",
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return { csv: lines.join("\r\n"), count: rows.length, capped };
}
