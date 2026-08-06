import { api, LONG_WRITE_TIMEOUT, qs } from "../lib/api";
import type {
  CreateVanStockRequestPayload,
  HoldingOption,
  PagedVanStockRequests,
  VanStockItemOption,
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
}

/**
 * Restock composer search: catalogue hits annotated with each item's total on-hand across warehouses.
 * An item out of stock everywhere comes back with quantityOnHand 0 (shown disabled, not offered) — so
 * the engineer can't raise a request for stock no warehouse holds, which would only fail at scan-out.
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
}

export function getVanStockAvailability(irmItemIds: string[]): Promise<WarehouseAvailability[]> {
  if (irmItemIds.length === 0) return Promise.resolve([]);
  return api<{ warehouses: WarehouseAvailability[] }>(
    `/van-stock-requests/availability?irmItemIds=${encodeURIComponent(irmItemIds.join(","))}`,
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

/** Item ids already on the engineer's OPEN requests of a type (duplicate guard hint). */
export function myOpenLineItems(
  type: VanStockRequestType,
): Promise<Array<{ irmItemId: string; code: string }>> {
  return api<{ items: Array<{ irmItemId: string; code: string }> }>(
    `/van-stock-requests/mine/open-lines${qs({ type })}`,
  ).then((r) => r.items);
}
