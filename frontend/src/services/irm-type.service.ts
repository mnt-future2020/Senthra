import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { IrmType, IrmTypePayload } from "@/types/irm-type";

// Module-level cache, cleared on any write + on logout. Mirrors supplier-type.service.
let cache: IrmType[] | null = null;
registerClientCache(() => {
  cache = null;
});

export const getCachedIrmTypes = (): IrmType[] | null => cache;

export function listIrmTypes(): Promise<IrmType[]> {
  return api<{ irmTypes: IrmType[] }>("/irm-types").then((r) => {
    cache = r.irmTypes;
    return r.irmTypes;
  });
}

export function createIrmType(payload: IrmTypePayload): Promise<IrmType> {
  return api<{ irmType: IrmType }>("/irm-types", { method: "POST", body: payload }).then((r) => {
    cache = null;
    return r.irmType;
  });
}

export function updateIrmType(id: string, payload: Partial<IrmTypePayload>): Promise<IrmType> {
  return api<{ irmType: IrmType }>(`/irm-types/${id}`, { method: "PUT", body: payload }).then((r) => {
    cache = null;
    return r.irmType;
  });
}

export function deleteIrmType(id: string): Promise<void> {
  return api(`/irm-types/${id}`, { method: "DELETE" }).then(() => {
    cache = null;
  });
}
