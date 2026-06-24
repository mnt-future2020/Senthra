import { api } from "@/lib/api";
import type { EngineerOverview, EngineerStockItem } from "@/types/engineer";

// Typed wrappers around the engineer portal API (/engineer/*). Every call is scoped on the backend
// to the signed-in staff user — there is no engineer-id parameter to pass.

export function getOwnOverview(): Promise<EngineerOverview> {
  return api<{ overview: EngineerOverview }>("/engineer/overview").then((r) => r.overview);
}

export function getOwnStock(): Promise<EngineerStockItem[]> {
  return api<{ stock: EngineerStockItem[] }>("/engineer/stock").then((r) => r.stock);
}
