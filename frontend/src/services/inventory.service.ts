import axios from "axios";

import { api } from "@/lib/api";
import { env } from "@/lib/env";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import { registerClientCache } from "@/lib/clientCache";
import type { Availability, InventoryBalance, InventoryDetail, InventoryTransaction, PurchaseHistoryRow, StockTransfer } from "@/types/inventory";

// Typed wrappers around the backend /inventory endpoints (read + warehouse→warehouse transfer).
// Components call these, never api()/axios directly.

export interface InventoryListParams {
  search?: string;
  warehouse?: string;
  category?: string;
  status?: string; // in_stock | low_stock | out_of_stock
  page?: number;
  pageSize?: number;
}

export interface PagedInventory {
  inventory: InventoryBalance[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalValuePence: number;
  totalValue: number;
}

export interface TransferListParams {
  search?: string;
  irmItem?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedTransfers {
  transfers: StockTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PagedTransactions {
  transactions: InventoryTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// The transfer form payload. Quantity is sent as the raw input string; the server coerces + validates.
export interface TransferPayload {
  irmItemId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number | string;
  movementDate: string;
  referenceNumber?: string;
  description?: string;
  internalNotes?: string;
}

function listQs(params: InventoryListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.category) sp.set("category", params.category);
  if (params.status) sp.set("status", params.status);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function transferQs(params: TransferListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.irmItem) sp.set("irmItem", params.irmItem);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Stale-while-revalidate list cache (mirrors the other modules) — returning to the list renders
// instantly instead of flashing a skeleton. Cleared on logout and after a transfer mutates stock.
const listCache = new Map<string, PagedInventory>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: InventoryListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.warehouse ?? ""}|${p.category ?? ""}|${p.status ?? ""}`;

export const getCachedInventory = (params: InventoryListParams = {}): PagedInventory | undefined => listCache.get(listCacheKey(params));

export function listInventory(params: InventoryListParams = {}): Promise<PagedInventory> {
  return api<PagedInventory>(`/inventory${listQs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getInventory(id: string): Promise<InventoryDetail> {
  return api<{ inventory: InventoryDetail }>(`/inventory/${id}`).then((r) => r.inventory);
}

export function listInventoryTransactions(id: string, page = 1, pageSize = 20): Promise<PagedTransactions> {
  return api<PagedTransactions>(`/inventory/${id}/transactions?page=${page}&pageSize=${pageSize}`);
}

export function listPurchaseHistory(id: string): Promise<PurchaseHistoryRow[]> {
  return api<{ purchases: PurchaseHistoryRow[] }>(`/inventory/${id}/purchases`).then((r) => r.purchases);
}

export function getAvailability(irmItemId: string, warehouseId: string): Promise<Availability> {
  return api<Availability>(`/inventory/availability?irmItem=${irmItemId}&warehouse=${warehouseId}`);
}

export function listTransfers(params: TransferListParams = {}): Promise<PagedTransfers> {
  return api<PagedTransfers>(`/inventory/transfers${transferQs(params)}`);
}

export function createTransfer(payload: TransferPayload): Promise<StockTransfer> {
  return api<{ transfer: StockTransfer }>("/inventory/transfers", { method: "POST", body: payload }).then((r) => {
    listCache.clear(); // a transfer changes on-hand balances at both warehouses
    return r.transfer;
  });
}

// The CSV endpoint returns a file, not JSON, so it bypasses api() and makes a direct authenticated
// blob request (mirrors the audit export). Returns whether the export was capped by the server.
export async function exportInventoryCsv(params: InventoryListParams = {}): Promise<{ capped: boolean }> {
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  void _page;
  void _pageSize;
  const res = await axios.get(`${env.apiUrl}/inventory/export.csv${listQs(filters)}`, { withCredentials: true, responseType: "blob" });
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(res.headers["content-disposition"] ?? null, `inventory-${date}.csv`);
  downloadBlob(res.data as Blob, filename);
  return { capped: String(res.headers["x-inventory-export-capped"] ?? "") === "true" };
}
