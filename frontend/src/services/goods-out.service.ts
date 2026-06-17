import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { GoodsOut } from "@/types/goods-out";

// Typed wrappers around the backend /goods-out endpoints (draft CRUD + dispatch/cancel). The only
// inventory-writing action is dispatch.

export interface GoodsOutListParams {
  search?: string;
  status?: string;
  warehouse?: string;
  engineer?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedGoodsOut {
  goodsOut: GoodsOut[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One dispatch line.
export interface GoodsOutLinePayload {
  irmItemId: string;
  quantity: number | string;
  notes?: string;
}

export interface GoodsOutPayload {
  warehouseId?: string;
  engineerId?: string;
  dispatchDate?: string;
  dispatchReason?: string;
  expectedReturnDate?: string;
  authorizedById?: string;
  authorizedByName?: string;
  referenceNumber?: string;
  description?: string;
  internalNotes?: string;
  items?: GoodsOutLinePayload[];
}

function qs(params: GoodsOutListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.engineer) sp.set("engineer", params.engineer);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedGoodsOut>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: GoodsOutListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.warehouse ?? ""}|${p.engineer ?? ""}|${p.sort ?? ""}`;

export const getCachedGoodsOut = (params: GoodsOutListParams = {}): PagedGoodsOut | undefined => listCache.get(listCacheKey(params));

export function listGoodsOut(params: GoodsOutListParams = {}): Promise<PagedGoodsOut> {
  return api<PagedGoodsOut>(`/goods-out${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getGoodsOut(idOrCode: string): Promise<GoodsOut> {
  return api<{ goodsOut: GoodsOut }>(`/goods-out/${idOrCode}`).then((r) => r.goodsOut);
}

const mutate = (p: Promise<{ goodsOut: GoodsOut }>): Promise<GoodsOut> =>
  p.then((r) => {
    listCache.clear();
    return r.goodsOut;
  });

export function createGoodsOut(payload: GoodsOutPayload): Promise<GoodsOut> {
  return mutate(api<{ goodsOut: GoodsOut }>("/goods-out", { method: "POST", body: payload }));
}
export function updateGoodsOut(id: string, payload: GoodsOutPayload): Promise<GoodsOut> {
  return mutate(api<{ goodsOut: GoodsOut }>(`/goods-out/${id}`, { method: "PATCH", body: payload }));
}
export function deleteGoodsOut(id: string): Promise<void> {
  return api(`/goods-out/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// --- workflow transitions ---------------------------------------------------
const action = (id: string, name: string, body?: unknown): Promise<GoodsOut> =>
  mutate(api<{ goodsOut: GoodsOut }>(`/goods-out/${id}/${name}`, { method: "POST", body: body ?? {} }));

export const dispatchGoodsOut = (id: string) => action(id, "dispatch");
export const cancelGoodsOut = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });
