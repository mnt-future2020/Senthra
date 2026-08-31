import { api, LONG_WRITE_TIMEOUT, qs } from "../lib/api";
import type {
  CreateVanStockRequestPayload,
  HoldingOption,
  PagedVanStockRequests,
  VanStockItemOption,
  VanStockLineSource,
  VanStockRequest,
  VanStockRequestType,
  WarehouseLite,
} from "../types";

// Non-job van stock requests (/van-stock-requests/*) — engineer self-service surface.

export interface ListParams {
  status?: string;
  type?: string;
  priority?: string;
  createdVia?: string;
  search?: string;
  sort?: "oldest" | "newest";
  page?: number;
  pageSize?: number;
}

export function createVanStockRequest(
  payload: CreateVanStockRequestPayload,
): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests", {
    method: "POST",
    body: payload,
  }).then((r) => r.request);
}

export function listMyVanStockRequests(params: ListParams = {}): Promise<PagedVanStockRequests> {
  return api<PagedVanStockRequests>(
    `/van-stock-requests/mine${qs(params as Record<string, unknown>)}`,
  );
}

export function getVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}`).then((r) => r.request);
}

export function cancelVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel`, {
    method: "POST",
  }).then((r) => r.request);
}

export function cancelVanStockRemaining(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel-remaining`, {
    method: "POST",
  }).then((r) => r.request);
}

/** IRM items an engineer can request (catalogue search for the restock composer). */
export function searchVanStockItems(q: string): Promise<VanStockItemOption[]> {
  return api<{ items: VanStockItemOption[] }>(
    `/van-stock-requests/item-search?q=${encodeURIComponent(q)}`,
  ).then((r) => r.items);
}

/** A restock-search hit annotated with the item's TOTAL on-hand across active warehouses. */
export interface RequestableItemOption extends VanStockItemOption {
  quantityOnHand: number;
  reorderLevel: number | null;
  // Rental hits also carry the deadline and the orders the units sit on. The wire sends both on
  // EVERY hit (null / [] for company stock), so the type says so rather than making each caller
  // guess which hits have them.
  hireEndDate: string | null;
  poCodes: string[];
}

/**
 * Restock composer search: catalogue hits annotated with each item's total on-hand across warehouses.
 * An item out of stock everywhere comes back with quantityOnHand 0 (shown disabled, not offered) — so
 * the engineer can't raise a request for stock no warehouse holds, which would only fail at scan-out.
 *
 * Returns BOTH pools — company stock and hired equipment — discriminated by `source`. For a rental
 * hit `quantityOnHand` is free-on-hire, not shelf stock: it is not ours and there is no shelf.
 */
export function searchRequestableItems(q: string): Promise<RequestableItemOption[]> {
  return api<{ items: RequestableItemOption[] }>(
    `/van-stock-requests/requestable-item-search?q=${encodeURIComponent(q)}`,
  ).then((r) => r.items);
}

/** The engineer's current van holdings (return composer source list). */
export function myHoldings(): Promise<HoldingOption[]> {
  return api<{ holdings: HoldingOption[] }>("/van-stock-requests/my-holdings").then(
    (r) => r.holdings,
  );
}

export function listWarehousesLite(): Promise<WarehouseLite[]> {
  return api<{ warehouses: WarehouseLite[] }>("/van-stock-requests/warehouses-lite").then(
    (r) => r.warehouses,
  );
}

/** Live per-warehouse shelf counts for the cart's items (a snapshot, not a reservation). */
export interface WarehouseAvailability {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  items: { irmItemId: string; quantityOnHand: number }[];
  // Hired kit at this depot — free-on-hire net of what jobs have planned. Kept as its OWN list
  // because the two ids come from different catalogues; one list keyed on a bare id could not tell
  // a tester from a cable.
  rentalItems: { rentalItemId: string; quantityOnHand: number }[];
}

export function getVanStockAvailability(
  irmItemIds: string[],
  rentalItemIds: string[] = [],
): Promise<WarehouseAvailability[]> {
  if (irmItemIds.length === 0 && rentalItemIds.length === 0) return Promise.resolve([]);
  return api<{ warehouses: WarehouseAvailability[] }>(
    `/van-stock-requests/availability${qs({
      irmItemIds: irmItemIds.join(","),
      rentalItemIds: rentalItemIds.join(","),
    })}`,
  ).then((r) => r.warehouses);
}

/** Upload an image data URI to Cloudinary via the backend and get back a URL. */
export function uploadVanStockAttachment(image: string): Promise<string> {
  // Cloudinary relay — see LONG_WRITE_TIMEOUT.
  return api<{ url: string }>("/van-stock-requests/attachments", {
    method: "POST",
    body: { image },
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.url);
}

/**
 * Items already on one of this engineer's OPEN requests of a type — the advisory duplicate guard.
 *
 * Carries the SOURCE so a duplicate hire is caught too. `irmItemId` is null on a rental line and
 * `rentalItemId` is null on a company one, so compare these through `vanStockItemKey` rather than on
 * a bare id: the two catalogues have independent id spaces, and matching on a bare id would both
 * miss real duplicates and invent false ones.
 */
export interface OpenLineItem {
  source: VanStockLineSource;
  irmItemId: string | null;
  rentalItemId: string | null;
  code: string;
}

export function myOpenLineItems(type: VanStockRequestType): Promise<OpenLineItem[]> {
  return api<{ items: OpenLineItem[] }>(
    `/van-stock-requests/mine/open-lines${qs({ type })}`,
  ).then((r) => r.items);
}
