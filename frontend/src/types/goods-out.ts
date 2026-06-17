// Goods Out (Dispatch) types — mirror the backend PublicGoodsOut DTO. Warehouse → engineer dispatch
// of IRM stock. Quantities are integers; no money on a dispatch. Serial/batch items are blocked in v1.

export type GoodsOutStatus = "draft" | "dispatched" | "cancelled";

export type DispatchReason =
  | "job_work"
  | "customer_request"
  | "installation"
  | "maintenance"
  | "replacement"
  | "warehouse_replenishment"
  | "emergency_dispatch"
  | "other";

export interface GoodsOutWarehouseRef {
  id: string;
  code: string;
  name: string;
}
export interface GoodsOutEngineerRef {
  id: string;
  name: string;
  email: string | null;
  employeeId: string | null;
}

export interface GoodsOutItem {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string; trackInventory: boolean; trackSerialNumbers: boolean; trackBatchNumbers: boolean } | null;
}

export interface GoodsOut {
  id: string;
  code: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  warehouse: GoodsOutWarehouseRef | null;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  engineerEmployeeId: string | null;
  engineer: GoodsOutEngineerRef | null;
  status: GoodsOutStatus;
  dispatchDate: string;
  dispatchReason: DispatchReason;
  expectedReturnDate: string | null;
  authorizedById: string | null;
  authorizedByName: string | null;
  jobId: string | null;
  projectId: string | null;
  customerStockRequestId: string | null;
  referenceNumber: string | null;
  description: string | null;
  internalNotes: string | null;
  items: GoodsOutItem[];
  totalQuantity: number;
  createdBy: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
