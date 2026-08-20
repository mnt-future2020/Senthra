import { api } from "@/lib/api";
import { downloadCsv } from "@/lib/csvExport";
import type {
  HireDamagePayload,
  HireMovementFilters,
  OnHireFilter,
  OnHireLine,
  PagedHireExtensions,
  PagedHireMovements,
  RentalCategory,
  RentalItem,
  RecordDamageChargePayload,
  RentalReceipt,
  RentalReceiptPayload,
  RentalReturnPayload,
} from "@/types/rental";

// Typed wrappers around /rental-items, /rental-categories and the on-hire list. Components call
// these, never `api()` directly.

export interface RentalListParams {
  search?: string;
  status?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedRentalItems {
  items: RentalItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Create + update payload.
 *
 * Deliberately carries NO pricing: the rental master defines what can be hired, and the agreed
 * price, VAT and currency are properties of the individual request (see the PRF rental line).
 */
export interface RentalItemPayload {
  name?: string;
  description?: string;
  rentalCategoryId?: string;
  status?: string;
  baseUnit?: string;
  notes?: string;
}

const qs = (params: Record<string, unknown>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
};

// ── Catalogue ─────────────────────────────────────────────────────────────────────────────────

export function listRentalItems(params: RentalListParams = {}): Promise<PagedRentalItems> {
  return api<PagedRentalItems>(`/rental-items${qs({ ...params })}`);
}

export async function getRentalItem(idOrCode: string): Promise<RentalItem> {
  return (await api<{ rentalItem: RentalItem }>(`/rental-items/${idOrCode}`)).rentalItem;
}

/**
 * The item's printable label, rendered by the server from its permanent code.
 *
 * Fetched rather than read off the record: nothing is stored, so there is no field to carry it and no
 * list row paying for a base64 image it never shows. It must come through `api()` — the print helper
 * embeds the data URI in an iframe, and a bare cross-origin <img> to the API would arrive without the
 * auth cookie and print an empty sticker.
 */
export async function getRentalItemBarcode(idOrCode: string): Promise<{ code: string; barcodeDataUri: string }> {
  return api<{ code: string; barcodeDataUri: string }>(`/rental-items/${idOrCode}/barcode`);
}

export async function createRentalItem(payload: RentalItemPayload): Promise<RentalItem> {
  return (await api<{ rentalItem: RentalItem }>("/rental-items", { method: "POST", body: payload })).rentalItem;
}

export async function updateRentalItem(id: string, payload: RentalItemPayload): Promise<RentalItem> {
  return (await api<{ rentalItem: RentalItem }>(`/rental-items/${id}`, { method: "PATCH", body: payload })).rentalItem;
}

export function deleteRentalItem(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/rental-items/${id}`, { method: "DELETE" });
}

// ── Categories ────────────────────────────────────────────────────────────────────────────────

export async function listRentalCategories(): Promise<RentalCategory[]> {
  return (await api<{ rentalCategories: RentalCategory[] }>("/rental-categories")).rentalCategories;
}

export async function createRentalCategory(payload: {
  name: string;
  description?: string;
  status?: string;
}): Promise<RentalCategory> {
  return (await api<{ rentalCategory: RentalCategory }>("/rental-categories", { method: "POST", body: payload }))
    .rentalCategory;
}

export async function updateRentalCategory(
  id: string,
  payload: { name?: string; description?: string; status?: string },
): Promise<RentalCategory> {
  return (await api<{ rentalCategory: RentalCategory }>(`/rental-categories/${id}`, { method: "PUT", body: payload }))
    .rentalCategory;
}

export function deleteRentalCategory(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/rental-categories/${id}`, { method: "DELETE" });
}

// ── Live hires ────────────────────────────────────────────────────────────────────────────────

export interface PagedOnHire {
  rows: OnHireLine[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The live hires. `status` is resolved SERVER-SIDE through the very predicates the attention badges
 * count, so a badge reading 3 opens exactly those 3 rows.
 */
export function listOnHire(
  // `warehouseId` narrows to the hires arriving at ONE warehouse's door — the receiving pane on a
  // warehouse page. Omitted everywhere else: a hire is chased by the PM on the order.
  params: {
    status?: OnHireFilter;
    page?: number;
    pageSize?: number;
    warehouseId?: string;
    /** ONE catalogue item's live hires — the card on its own page. */
    rentalItemId?: string;
    /** Item, order code or supplier. NARROWS the chosen window; it never escapes it. */
    search?: string;
  } = {},
): Promise<PagedOnHire> {
  return api<PagedOnHire>(`/purchase-orders/rental-lines/on-hire${qs({ ...params })}`);
}

/** Takes the hire off both deadline badges. */
export function markHireReturned(purchaseOrderId: string, lineId: string): Promise<unknown> {
  return api(`/purchase-orders/${purchaseOrderId}/rental-lines/${lineId}/return`, { method: "PATCH" });
}

/** Moves the end date. The server recomputes the reminder and clears the notification state. */
export function extendHire(
  purchaseOrderId: string,
  lineId: string,
  payload: { hireEndDate: string; notifyDaysBefore?: number; additionalChargePence?: number },
): Promise<unknown> {
  return api(`/purchase-orders/${purchaseOrderId}/rental-lines/${lineId}/extend`, { method: "PATCH", body: payload });
}

// ── Hire movements ────────────────────────────────────────────────────────────────────────────
//
// Hired kit arriving, going back, and breaking in between. Deliberately NOT the Goods In endpoints: a
// GRN writes stock, and hired equipment is the supplier's.

/** Every live movement note against a purchase order — deliveries, returns and damage alike. */
export async function listHireDeliveries(purchaseOrderId: string): Promise<RentalReceipt[]> {
  return (await api<{ receipts: RentalReceipt[] }>(`/rental-receipts/purchase-order/${purchaseOrderId}`)).receipts;
}

/** Record a delivery. The server re-checks every quantity against what is still outstanding. */
export async function createHireDelivery(payload: RentalReceiptPayload): Promise<RentalReceipt> {
  return (await api<{ receipt: RentalReceipt }>("/rental-receipts", { method: "POST", body: payload })).receipt;
}

/**
 * Record hired kit going BACK. The server caps every quantity against what is still out, and closes
 * the hire only once everything ordered arrived and everything that arrived has been collected.
 */
export async function createHireReturn(payload: RentalReturnPayload): Promise<RentalReceipt> {
  return (await api<{ receipt: RentalReceipt }>("/rental-receipts/returns", { method: "POST", body: payload })).receipt;
}

/** Report damage found while the kit is with us. Moves no quantity — it is evidence, dated today. */
export async function reportHireDamage(payload: HireDamagePayload): Promise<RentalReceipt> {
  return (await api<{ receipt: RentalReceipt }>("/rental-receipts/damage", { method: "POST", body: payload })).receipt;
}

/** Remove a condition photo. Releases the stored asset once nothing else references it. */
export async function removeHireDeliveryPhoto(receiptId: string, attachmentId: string): Promise<RentalReceipt> {
  return (
    await api<{ receipt: RentalReceipt }>(`/rental-receipts/${receiptId}/photos/${attachmentId}`, {
      method: "DELETE",
    })
  ).receipt;
}

/**
 * Record what the supplier is charging for the damage — on a note that already exists.
 *
 * The one value on a note that does not need a reversal to change: it feeds no running total, so
 * correcting it cannot leave a stored figure disagreeing with the records it summarises. It works
 * this way because of WHEN money arrives — the damage is written down the day it is found, the quote
 * comes the following week.
 */
export async function recordDamageCharge(id: string, payload: RecordDamageChargePayload): Promise<RentalReceipt> {
  return (
    await api<{ receipt: RentalReceipt }>(`/rental-receipts/${id}/damage-charge`, { method: "PATCH", body: payload })
  ).receipt;
}

/**
 * Undo a movement: the record stays and is marked, its quantities are given back. A reason is required.
 *
 * What "given back" means depends on the note — an arrival goes back to outstanding, a return puts the
 * kit back on hire, a damage report simply withdraws the claim. The server owns that; this is one call.
 */
export async function reverseHireMovement(id: string, reason: string): Promise<RentalReceipt> {
  return (
    await api<{ receipt: RentalReceipt }>(`/rental-receipts/${id}/reverse`, { method: "PATCH", body: { reason } })
  ).receipt;
}

/**
 * The REGISTER — every movement, across every order, filtered as a reporting period.
 *
 * `listHireDeliveries` above answers "what happened on THIS order", which is what the order page
 * asks. This is the other question, and until it existed nothing could ask it: a finished hire left
 * every rental screen the moment it went back, and its notes were reachable only by already knowing
 * the order number.
 */
export function listHireMovements(
  params: HireMovementFilters & { page?: number; pageSize?: number } = {},
): Promise<PagedHireMovements> {
  return api<PagedHireMovements>(`/rental-receipts${qs({ ...params })}`);
}

/**
 * Every extension agreed in a period, one row each.
 *
 * The hire line's `extensionCharge` is the SUM of these — three extensions of £275, £300 and £150
 * read as £725 and nothing more, so "what did we agree in July" had no answer until each was a
 * record of its own.
 */
export function listHireExtensions(
  params: { search?: string; purchaseOrder?: string; from?: string; to?: string; page?: number; pageSize?: number } = {},
): Promise<PagedHireExtensions> {
  return api<PagedHireExtensions>(`/purchase-orders/rental-lines/extensions${qs({ ...params })}`);
}

// ── Exports ───────────────────────────────────────────────────────────────────────────────────
// Both carry the CURRENT filters, so a download matches the view it was taken from.

export function exportRentalItemsCsv(
  // Paging is deliberately not accepted: an export is the whole filtered set, capped server-side.
  params: Omit<RentalListParams, "page" | "pageSize"> = {},
): Promise<{ capped: boolean }> {
  return downloadCsv(`/rental-items/export${qs({ ...params })}`, "rental-items");
}

export function exportOnHireCsv(
  params: { status?: OnHireFilter; search?: string } = {},
): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-orders/rental-lines/on-hire/export${qs({ ...params })}`, "rentals-on-hire");
}

/** The filtered register, one row per movement — supplier-invoice reconciliation. */
export function exportHireMovementsCsv(params: HireMovementFilters = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/rental-receipts/export.csv${qs({ ...params })}`, "hire-movements");
}

/**
 * The same movements, one row per ITEM — with the supplier's asset tags.
 *
 * The header file says a note moved 4 units and 1 was damaged. At the end of a hire the argument is
 * always about a specific unit, and the item never appears in a header row.
 */
export function exportHireMovementLinesCsv(params: HireMovementFilters = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/rental-receipts/export-lines.csv${qs({ ...params })}`, "hire-movement-lines");
}

/** The same period as a file — what the running total on a hire line cannot produce. */
export function exportHireExtensionsCsv(
  params: { search?: string; purchaseOrder?: string; from?: string; to?: string } = {},
): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-orders/rental-lines/extensions/export.csv${qs({ ...params })}`, "hire-extensions");
}
