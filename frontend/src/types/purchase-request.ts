// Purchase Request (PRF) types — mirror the backend PublicPurchaseRequest DTO. The quotation
// step BEFORE a Purchase Order: quoted prices are captured here, finance approves, and the PO
// is generated from the approved request. Money is GBP pence (+ a pounds convenience).
// `converted` is terminal and read-only forever — revisions go through Duplicate.

export type PrfStatus = "draft" | "submitted" | "approved" | "converted" | "cancelled";

export interface PrfSupplierRef {
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

export interface PrfWarehouseRef {
  id: string;
  code: string;
  name: string;
  address: string | null;
}

export interface PrfJobRef {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
}

export interface PrfItem {
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
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string } | null;
}

/**
 * The two groups a purchase request keeps its documents in — the supplier's quotation package, and
 * the supporting documents behind the request. Mirrors PRF_DOCUMENT_TYPES on the server.
 */
export type PrfDocumentType = "quote" | "other";

export interface PrfAttachment {
  id: string;
  /** Always one of the two — the server resolves a legacy row with no stored group to `quote`. */
  documentType: PrfDocumentType;
  label: string | null;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
}

import type { PrfRentalLine } from "./rental";

export interface PurchaseRequest {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string | null;
  supplier: PrfSupplierRef | null;
  warehouseId: string;
  warehouse: PrfWarehouseRef | null;
  jobId: string | null;
  job: PrfJobRef | null;
  projectRef: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: PrfStatus;
  quoteReference: string | null;
  quoteDate: string | null;
  quoteValidUntil: string | null;
  // When the requester needs the goods on site — becomes the PO's expected delivery date.
  requiredByDate: string | null;
  // Set by the server when the required-by date falls AFTER one of this request's hires has already
  // started. Advisory — some hire companies bill from dispatch, so it is never a blocked save.
  lateHireDelivery: { earliestHireStart: string; daysLate: number } | null;
  justification: string | null;
  notes: string | null;
  // Commercial terms: `deliveryTerms` is the Incoterm code (e.g. "DDP"), `deliveryTermsLabel`
  // its resolved label; `paymentTerms` is the agreed term for THIS request (pre-filled from the
  // supplier default but editable).
  deliveryTerms: string | null;
  deliveryTermsLabel: string | null;
  paymentTerms: string | null;
  currency: string;
  subtotalPence: number;
  vatPence: number;
  grandTotalPence: number;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  items: PrfItem[];
  /** Hired lines — each with its own period and, optionally, its own delivery address. */
  rentalItems: PrfRentalLine[];
  attachments: PrfAttachment[];
  // The PO generated from this PRF (at most one), for the linked-PO badge + chain strip.
  purchaseOrder: { id: string; code: string; status: string } | null;
  revisionOfId: string | null;
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  reopenReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  convertedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
