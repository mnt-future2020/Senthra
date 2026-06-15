// Supplier Type master-data — mirrors the Warehouse Type / Category type. The
// classification a supplier belongs to (managed under Settings).

export interface SupplierType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  supplierCount: number;
  createdAt: string;
}

export interface SupplierTypePayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
