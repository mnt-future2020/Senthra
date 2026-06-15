// Warehouse Type master-data — mirrors the Category type. The operational
// classification a warehouse belongs to (managed under Settings).

export interface WarehouseType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  warehouseCount: number;
  createdAt: string;
}

export interface WarehouseTypePayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
