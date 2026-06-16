// Purchase Order types — mirror the backend PublicPurchaseOrder DTO. Procurement workflow
// only. Money is GBP pence (+ a pounds convenience). Status is a forward-only machine.

export type PoStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "partially_received"
  | "fully_received"
  | "closed"
  | "cancelled";

export type PoPriority = "low" | "normal" | "high" | "urgent";

export interface PoSupplierRef {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTerms: string | null;
  currency: string | null;
  leadTimeDays: number | null;
}

export interface PoWarehouseRef {
  id: string;
  code: string;
  name: string;
  address: string | null;
}

export interface PoItem {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  unitPricePence: number;
  unitPrice: number;
  vatRate: number;
  lineTotalPence: number;
  lineTotal: number;
  receivedQuantity: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string } | null;
}

export interface PoAttachment {
  id: string;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}

export interface PurchaseOrder {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string | null;
  supplier: PoSupplierRef | null;
  warehouseId: string;
  warehouse: PoWarehouseRef | null;
  status: PoStatus;
  priority: PoPriority;
  referenceNumber: string | null;
  description: string | null;
  orderDate: string;
  expectedDeliveryDate: string | null;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  internalNotes: string | null;
  supplierNotes: string | null;
  items: PoItem[];
  attachments: PoAttachment[];
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rejectionReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
