// IRM Type master-data — mirrors the Supplier Type type. The item-type classification
// (Consumable, Asset, Tool…) managed under Settings.

export interface IrmType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

export interface IrmTypePayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
