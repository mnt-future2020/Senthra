// Goods In (GRN) types — mirror the backend PublicGoodsReceipt DTO. Receiving workflow only.
// Quantities are integers; the only money is read-only (sourced from the PO, never set here).

export type GrnStatus = "draft" | "completed" | "cancelled";
export type GrnQualityStatus = "passed" | "partial" | "failed";

export interface GrnSupplierRef {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface GrnWarehouseRef {
  id: string;
  code: string;
  name: string;
  address: string | null;
}

export interface GrnItem {
  id: string;
  purchaseOrderItemId: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  orderedQuantity: number;
  previouslyReceived: number;
  receivedQuantity: number;
  damagedQuantity: number;
  acceptedQuantity: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string; trackInventory: boolean } | null;
}

export interface GrnAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}

export interface GoodsReceipt {
  id: string;
  code: string;
  purchaseOrderId: string;
  poCode: string | null;
  purchaseOrder: { id: string; code: string; status: string } | null;
  supplierId: string | null;
  supplierName: string | null;
  supplier: GrnSupplierRef | null;
  warehouseId: string;
  warehouse: GrnWarehouseRef | null;
  status: GrnStatus;
  receivedDate: string;
  referenceNumber: string | null;
  carrier: string | null;
  deliveryNoteNumber: string | null;
  vehicleRegistration: string | null;
  description: string | null;
  qualityStatus: GrnQualityStatus;
  qualityNotes: string | null;
  internalNotes: string | null;
  items: GrnItem[];
  attachments: GrnAttachment[];
  totalReceived: number;
  totalAccepted: number;
  totalDamaged: number;
  createdBy: string | null;
  completedBy: string | null;
  completedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
