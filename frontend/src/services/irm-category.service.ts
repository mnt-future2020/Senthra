import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { IrmCategory, IrmCategoryPayload } from "@/types/irm-category";

// Module-level cache, cleared on any write + on logout. Mirrors supplier-type.service.
let cache: IrmCategory[] | null = null;
registerClientCache(() => {
  cache = null;
});

export const getCachedIrmCategories = (): IrmCategory[] | null => cache;

export function listIrmCategories(): Promise<IrmCategory[]> {
  return api<{ irmCategories: IrmCategory[] }>("/irm-categories").then((r) => {
    cache = r.irmCategories;
    return r.irmCategories;
  });
}

export function createIrmCategory(payload: IrmCategoryPayload): Promise<IrmCategory> {
  return api<{ irmCategory: IrmCategory }>("/irm-categories", { method: "POST", body: payload }).then((r) => {
    cache = null;
    return r.irmCategory;
  });
}

export function updateIrmCategory(id: string, payload: Partial<IrmCategoryPayload>): Promise<IrmCategory> {
  return api<{ irmCategory: IrmCategory }>(`/irm-categories/${id}`, { method: "PUT", body: payload }).then((r) => {
    cache = null;
    return r.irmCategory;
  });
}

export function deleteIrmCategory(id: string): Promise<void> {
  return api(`/irm-categories/${id}`, { method: "DELETE" }).then(() => {
    cache = null;
  });
}
