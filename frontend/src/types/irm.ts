// IRM Catalogue item types — mirror the backend PublicIrmItem DTO. Company-owned internal
// stock MASTER DATA. Cost is internal-only (pence + pounds). Stock rollups are 0 until the
// inventory ledger module is built.

export type IrmStatus = "active" | "inactive";

export interface IrmRef {
  id: string;
  name: string;
}

export interface IrmSupplierLink {
  id: string;
  supplierId: string;
  supplier: { id: string; code: string; name: string } | null;
  isPrimary: boolean;
  priority: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
}

export interface IrmItem {
  id: string;
  code: string; // auto-allocated, e.g. IRM-0001
  name: string;
  description: string | null;
  brand: string | null;
  manufacturer: string | null;
  mpn: string | null;
  type: IrmRef | null;
  typeId: string | null;
  category: IrmRef | null;
  irmCategoryId: string | null;
  status: IrmStatus;
  // Identification.
  sku: string | null;
  barcode: string | null;
  qrCode: string | null;
  barcodeDataUri: string | null; // rendered Code128 image (base64) of the item code, when generated
  // Suppliers (junction; one primary).
  suppliers: IrmSupplierLink[];
  primarySupplier: { id: string; code: string; name: string } | null;
  // Unit.
  baseUnit: string | null;
  packSize: number | null;
  // Stock policies (advisory).
  reorderLevel: number | null;
  maximumStock: number | null;
  criticalLevel: number | null;
  // Cost (internal only).
  standardCostPence: number | null;
  standardCost: number | null; // pounds, for display
  currency: string | null;
  vatRatePercent: number | null;
  // Tracking flags.
  trackInventory: boolean;
  // Operations.
  notes: string | null;
  // Stock rollups — 0 until the inventory ledger lands.
  onHand: number;
  available: number;
  totalValuePence: number;
  // Audit.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
