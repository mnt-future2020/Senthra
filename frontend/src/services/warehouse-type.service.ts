import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { WarehouseType, WarehouseTypePayload } from "@/types/warehouse-type";

// Module-level cache (survives route navigation), cleared on any write + on logout.
// Mirrors category.service.
let cache: WarehouseType[] | null = null;
registerClientCache(() => {
  cache = null;
});

export const getCachedWarehouseTypes = (): WarehouseType[] | null => cache;

export function listWarehouseTypes(): Promise<WarehouseType[]> {
  return api<{ warehouseTypes: WarehouseType[] }>("/warehouse-types").then((r) => {
    cache = r.warehouseTypes;
    return r.warehouseTypes;
  });
}

export function createWarehouseType(payload: WarehouseTypePayload): Promise<WarehouseType> {
  return api<{ warehouseType: WarehouseType }>("/warehouse-types", {
    method: "POST",
    body: payload,
  }).then((r) => {
    cache = null;
    return r.warehouseType;
  });
}

export function updateWarehouseType(
  id: string,
  payload: Partial<WarehouseTypePayload>,
): Promise<WarehouseType> {
  return api<{ warehouseType: WarehouseType }>(`/warehouse-types/${id}`, {
    method: "PUT",
    body: payload,
  }).then((r) => {
    cache = null;
    return r.warehouseType;
  });
}

export function deleteWarehouseType(id: string): Promise<void> {
  return api(`/warehouse-types/${id}`, { method: "DELETE" }).then(() => {
    cache = null;
  });
}
