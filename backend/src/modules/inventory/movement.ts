// Movement DTO — one normalised entry in the unified Stock Ledger (Stock Movement History).
//
// The unified ledger is a READ-ONLY union of the four append-only delta ledgers — the system's only
// sources of truth for stock movement. Each row is ONE leg at ONE location (ERP/WMS double-entry: a
// transfer/dispatch shows as two rows, tied by `reference`/sourceCode). No new ledger, no duplicate
// data, no JobStockMovement (that is a source DOCUMENT, reached via `reference`, not a ledger leg —
// emitting its lines here would double-count the engineer/customer ledgers below):
//   InventoryTransaction              → company stock in a warehouse        (locationType "warehouse")
//   EngineerStockTransaction          → company stock on an engineer's van  (locationType "engineer")
//   EngineerCustomerStockTransaction  → customer consignment on a van       (locationType "engineer")
//   DamagedStockTransaction           → the damaged pool                    (locationType "damaged")

export type MovementOwnership = "company" | "customer";
export type MovementLocationType = "warehouse" | "engineer" | "damaged";

export interface Movement {
  id: string;                 // synthetic stable key: `${ledger}:${rawId}`
  date: string;               // ISO createdAt
  type: string;               // raw ledger type (damaged is derived: write_off | restore)
  label: string;              // humanised type
  ownership: MovementOwnership;
  locationType: MovementLocationType;
  locationId: string | null;  // warehouseId or engineerId
  locationLabel: string;
  itemKind: "irm" | "customer_stock";
  itemId: string;             // irmItemId or customerStockEntryId
  itemCode: string;
  itemName: string;
  sku: string | null;
  quantityDelta: number;      // + into this location / − out of it
  balanceAfter: number | null;// on-hand at this location after the row
  fromLabel: string | null;   // simple "From → To" hint for list rendering
  toLabel: string | null;
  reference: string | null;   // sourceCode, e.g. GDN-0001 / GM-0001 / TRF-0001 / ENG-0001
  sourceType: string;         // goods_receipt | goods_out | stock_transfer | stock_adjustment |
                              // goods_management | engineer_transfer | goods_management_return | damaged_restore
  sourceId: string;
  engineerId: string | null;
  customerId: string | null;
  customerName: string | null;
  actor: string | null;       // createdBy email
  notes: string | null;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

// Humanised label for a ledger row. Keyed on the raw `type`; the value is stable across pools so the
// same verb reads consistently wherever it occurs (locationType carries the warehouse/van/damaged context).
const TYPE_LABELS: Record<string, string> = {
  goods_in: "Goods In",
  goods_out: "Goods Out",
  transfer_in: "Transfer In",
  transfer_out: "Transfer Out",
  manual_add: "Adjustment (add)",
  manual_adjust: "Adjustment (remove)",
  job_issue: "Job Issue",
  job_return: "Job Return",
  job_consume: "Consumed on Job",
  job_lost: "Lost on Job",
  usage: "Used on Site",
  return: "Returned",
  restore: "Restored from Damaged",
  write_off: "Marked Damaged",
};

export function labelFor(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Mappers — one per source ledger. Each produces a single Movement leg. ───────────────────────

// InventoryTransaction: company stock in a warehouse. Row includes irmItem{code,name,sku?} + warehouse{name}.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromInventoryTxn(row: any): Movement {
  const whName = row.warehouse?.name ?? "";
  return {
    id: `inv:${row.id}`,
    date: iso(row.createdAt),
    type: row.type,
    label: labelFor(row.type),
    ownership: "company",
    locationType: "warehouse",
    locationId: row.warehouseId ?? null,
    locationLabel: whName,
    itemKind: "irm",
    itemId: row.irmItemId,
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: row.irmItem?.sku ?? null,
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter ?? null,
    fromLabel: row.quantityDelta < 0 ? whName : null,
    toLabel: row.quantityDelta > 0 ? whName : null,
    reference: row.sourceCode ?? null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    engineerId: null,
    customerId: null,
    customerName: null,
    actor: row.createdBy ?? null,
    notes: row.notes ?? null,
  };
}

// EngineerStockTransaction: company stock on an engineer's van. Row includes irmItem{code,name}; the
// service supplies the resolved engineer display name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromEngineerTxn(row: any, engineerName: string): Movement {
  const loc = `Eng: ${engineerName}`;
  return {
    id: `eng:${row.id}`,
    date: iso(row.createdAt),
    type: row.type,
    label: labelFor(row.type),
    ownership: "company",
    locationType: "engineer",
    locationId: row.engineerId,
    locationLabel: loc,
    itemKind: "irm",
    itemId: row.irmItemId,
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: null,
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter ?? null,
    fromLabel: row.quantityDelta < 0 ? loc : null,
    toLabel: row.quantityDelta > 0 ? loc : null,
    reference: row.sourceCode ?? null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    engineerId: row.engineerId,
    customerId: null,
    customerName: null,
    actor: row.createdBy ?? null,
    notes: row.notes ?? null,
  };
}

export interface CustomerTxnMeta {
  engineerName: string;
  itemName: string;
  sku: string | null;
  customerId: string | null;
  customerName: string | null;
}

// EngineerCustomerStockTransaction: customer consignment on a van. The row carries only ids, so the
// service resolves item + customer + engineer metadata and passes it in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromEngineerCustomerTxn(row: any, meta: CustomerTxnMeta): Movement {
  const loc = `Eng: ${meta.engineerName}`;
  return {
    id: `engcust:${row.id}`,
    date: iso(row.createdAt),
    type: row.type,
    label: labelFor(row.type),
    ownership: "customer",
    locationType: "engineer",
    locationId: row.engineerId,
    locationLabel: loc,
    itemKind: "customer_stock",
    itemId: row.customerStockEntryId,
    itemCode: "",
    itemName: meta.itemName,
    sku: meta.sku,
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter ?? null,
    fromLabel: row.quantityDelta < 0 ? loc : null,
    toLabel: row.quantityDelta > 0 ? loc : null,
    reference: row.sourceCode ?? null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    engineerId: row.engineerId,
    customerId: meta.customerId,
    customerName: meta.customerName,
    actor: row.createdBy ?? null,
    notes: row.notes ?? null,
  };
}

export interface DamagedTxnMeta {
  itemCode: string;
  itemName: string;
  warehouseName: string;
}

// DamagedStockTransaction: the damaged pool. It has no `type` column — the verb is derived from the
// sign (+ reported damaged / write-off, − restored to usable). Item name resolved by the service.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromDamagedTxn(row: any, meta: DamagedTxnMeta): Movement {
  const type = row.quantityDelta < 0 ? "restore" : "write_off";
  const isCompany = row.ownerType === "company";
  const loc = `Damaged — ${meta.warehouseName}`.trim();
  return {
    id: `dmg:${row.id}`,
    date: iso(row.createdAt),
    type,
    label: labelFor(type),
    ownership: isCompany ? "company" : "customer",
    locationType: "damaged",
    locationId: row.warehouseId ?? null,
    locationLabel: loc,
    itemKind: isCompany ? "irm" : "customer_stock",
    itemId: row.irmItemId ?? row.customerStockEntryId ?? "",
    itemCode: meta.itemCode,
    itemName: meta.itemName,
    sku: null,
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter ?? null,
    fromLabel: row.quantityDelta < 0 ? loc : null,
    toLabel: row.quantityDelta > 0 ? loc : null,
    reference: row.sourceCode ?? null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    engineerId: null,
    customerId: row.customerId ?? null,
    customerName: null,
    actor: row.createdBy ?? null,
    notes: row.notes ?? null,
  };
}

// ── Cursor (keyset) — total order over (createdAt DESC, _id DESC) across every ledger ────────────
// A page's `nextCursor` is the (createdAt, rawId) of its last row. ObjectIds are globally unique, so
// the (createdAt, id) tuple is a valid total order even across collections — verified against Mongo.

export interface MovementCursor {
  t: number;   // createdAt epoch millis
  id: string;  // raw ObjectId of the boundary row
}

export function encodeCursor(c: MovementCursor): string {
  return Buffer.from(`${c.t}:${c.id}`, "utf8").toString("base64url");
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export function decodeCursor(raw?: string | null): MovementCursor | null {
  if (!raw) return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const i = s.indexOf(":");
    if (i < 0) return null;
    const t = Number(s.slice(0, i));
    const id = s.slice(i + 1);
    // The id flows into a Prisma `id: { lt }` keyset on an ObjectId column — a tampered/corrupt cursor
    // with a non-ObjectId id would throw P2023 (Malformed ObjectID) → 500. Reject it so a bad cursor
    // degrades to "first page" instead of erroring.
    if (!Number.isFinite(t) || !OBJECT_ID.test(id)) return null;
    return { t, id };
  } catch {
    return null;
  }
}
