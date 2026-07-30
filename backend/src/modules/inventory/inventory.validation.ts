import { z } from "zod";

// Warehouse Inventory validation. The module is READ + TRANSFER only — the sole write is a
// warehouse-to-warehouse stock transfer. Codes / status / balances / ledger rows are SYSTEM-owned
// and never accepted from the client.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const INVENTORY_STATUSES = ["in_stock", "low_stock", "out_of_stock"] as const;

const requiredDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`);

// The movement date is a timezone-less calendar date (YYYY-MM-DD from the frontend's
// `<input type="date">`), but "today" is evaluated server-side in UTC. A user AHEAD of UTC (the UK
// during BST, or anywhere up to UTC+14) can legitimately enter a local "today" that is already
// "tomorrow" in UTC, so we allow up to one calendar day past UTC-today as the ceiling — the max real
// timezone offset (+14:00) is at most one date ahead. Anything beyond that is unambiguously future.
// Compared lexicographically against the (also YYYY-MM-DD) movement date.
const maxNonFutureDateIso = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// A required date that additionally may not be in the future — for backdated stock entries
// (opening balance / legacy / found) where a future movement date is always a mistake.
const requiredPastOrTodayDate = (label: string) =>
  requiredDate(label).refine((v) => v.slice(0, 10) <= maxNonFutureDateIso(), `${label} can't be in the future.`);

export const createTransferSchema = z
  .object({
    irmItemId: z.string({ error: "Select an item." }).regex(OBJECT_ID_RE, "Select an item."),
    fromWarehouseId: z.string({ error: "Select a source warehouse." }).regex(OBJECT_ID_RE, "Select a source warehouse."),
    toWarehouseId: z.string({ error: "Select a destination warehouse." }).regex(OBJECT_ID_RE, "Select a destination warehouse."),
    quantity: z.coerce.number({ error: "Quantity is required." }).int("Use a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
    movementDate: requiredDate("Movement date"),
    referenceNumber: z.string().trim().max(60).optional(),
    description: z.string().trim().max(2000).optional(),
    internalNotes: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.fromWarehouseId !== d.toWarehouseId, {
    message: "Source and destination warehouses must be different.",
    path: ["toWarehouseId"],
  });
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

// Manual stock add (existing / opening / legacy stock straight into a warehouse). Inbound-only:
// quantity is a positive magnitude. Codes / ledger rows / balances are SYSTEM-owned.
export const STOCK_ADJUSTMENT_REASONS = ["opening_balance", "legacy_stock", "found", "other"] as const;

export const addStockSchema = z.object({
  irmItemId: z.string({ error: "Select an item." }).regex(OBJECT_ID_RE, "Select an item."),
  warehouseId: z.string({ error: "Select a warehouse." }).regex(OBJECT_ID_RE, "Select a warehouse."),
  quantity: z.coerce.number({ error: "Quantity is required." }).int("Use a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
  movementDate: requiredPastOrTodayDate("Movement date"),
  reason: z.enum(STOCK_ADJUSTMENT_REASONS, { error: "Select a reason." }),
  referenceNumber: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type AddStockInput = z.infer<typeof addStockSchema>;

// Manual DOWNWARD correction (damage / shrinkage / miscount) — removes a positive magnitude of
// EXISTING stock. Guarded server-side so it can never take available below zero. SYSTEM-owned codes.
// NOTE: "damage_correction" was RETIRED from this list. It removed the units from inventory and
// nothing else — no damaged-pool row, no photo, no reason text, so the damage never appeared in the
// Damaged tab and no evidence survived for a claim or dispute. Worse, it was the form's default
// selection, making the wrong door the path of least resistance. Damage now goes through
// POST /goods-management/damaged/report (reportWarehouseDamage), which moves the units into the
// damaged pool with a mandatory reason + photo. Two doors for one concept guarantees the records
// diverge, so this one is closed.
//
// Historical StockAdjustment rows still hold "damage_correction" — reads are not enum-validated, so
// they keep rendering. This list only governs NEW adjustments.
export const STOCK_ADJUST_DOWN_REASONS = ["shrinkage", "miscount", "other"] as const;

export const adjustStockSchema = z.object({
  irmItemId: z.string({ error: "Select an item." }).regex(OBJECT_ID_RE, "Select an item."),
  warehouseId: z.string({ error: "Select a warehouse." }).regex(OBJECT_ID_RE, "Select a warehouse."),
  quantity: z.coerce.number({ error: "Quantity is required." }).int("Use a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
  movementDate: requiredPastOrTodayDate("Movement date"),
  reason: z.enum(STOCK_ADJUST_DOWN_REASONS, { error: "Select a reason." }),
  referenceNumber: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

// Inventory Hub — query shape constants (used in controller type assertions).
export const OWNERSHIPS = ["company", "customer"] as const;
export const LOCATION_TYPES = ["warehouse", "engineer", "customer_site", "damaged", "transit"] as const;
