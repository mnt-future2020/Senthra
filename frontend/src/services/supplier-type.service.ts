import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { SupplierType, SupplierTypePayload } from "@/types/supplier-type";

// Module-level cache (survives route navigation), cleared on any write + on logout.
// Mirrors warehouse-type.service / category.service.
let cache: SupplierType[] | null = null;
registerClientCache(() => {
  cache = null;
});

export const getCachedSupplierTypes = (): SupplierType[] | null => cache;

export function listSupplierTypes(): Promise<SupplierType[]> {
  return api<{ supplierTypes: SupplierType[] }>("/supplier-types").then((r) => {
    cache = r.supplierTypes;
    return r.supplierTypes;
  });
}

export function createSupplierType(payload: SupplierTypePayload): Promise<SupplierType> {
  return api<{ supplierType: SupplierType }>("/supplier-types", {
    method: "POST",
    body: payload,
  }).then((r) => {
    cache = null;
    return r.supplierType;
  });
}

export function updateSupplierType(
  id: string,
  payload: Partial<SupplierTypePayload>,
): Promise<SupplierType> {
  return api<{ supplierType: SupplierType }>(`/supplier-types/${id}`, {
    method: "PUT",
    body: payload,
  }).then((r) => {
    cache = null;
    return r.supplierType;
  });
}

export function deleteSupplierType(id: string): Promise<void> {
  return api(`/supplier-types/${id}`, { method: "DELETE" }).then(() => {
    cache = null;
  });
}
