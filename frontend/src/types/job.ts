// Job + kit-line types. The shape mirrors the backend PublicJob / PublicJobKitLine DTOs
// (Date columns serialised to ISO strings; every optional column is `| null`). Jobs are a
// staff/engineer-only surface — they carry no price/cost fields.

export type JobStatus =
  | "draft"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "completed"
  | "rejected"
  | "cancelled";

export type JobLineType = "customer_stock" | "irm" | "misc";

export type JobPriority = "low" | "normal" | "high" | "urgent";

export type JobType =
  | "installation"
  | "survey"
  | "maintenance"
  | "decommission"
  | "other";

export type InstallerType = "internal" | "external";

export interface JobKitLine {
  id: string;
  lineType: JobLineType;
  seCode: string | null;
  itemName: string;
  description: string | null;
  customerStockEntryId: string | null;
  irmItemId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  // Live pickup-warehouse address (null for misc lines) — powers the engineer's "where to collect" modal.
  warehouse: JobKitWarehouse | null;
  qty: number;
  notes: string | null;
  // Goods-management tallies (0 until stock is issued against this line). issued = used + returned + remaining.
  issued: number;
  used: number;
  returned: number;
  remaining: number;
}

export interface JobKitWarehouse {
  id: string;
  name: string;
  code: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  contactPhone: string | null;
}

export interface Job {
  id: string;
  jobNumber: string;
  customerRef: string | null;
  schemeNo: string | null;
  name: string;
  jobType: string;
  technology: string | null;
  customerId: string;
  customerName: string | null;
  projectId: string;
  projectName: string | null;
  siteId: string | null;
  siteName: string | null;
  trsArea: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  suite: string | null;
  rack: string | null;
  shelf: string | null;
  completionDate: string | null;
  priority: string;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  assignedEngineerEmail: string | null;
  supplierId: string | null;
  supplierName: string | null;
  installerType: string;
  status: string;
  goodsStatus: string; // goods-lifecycle: not_issued | partially_issued | issued | awaiting_return | reconciled
  plannerName: string | null;
  plannerPhone: string | null;
  notes: string | null;
  attachments: string[];
  kitLines: JobKitLine[];
  assignedAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobSummary = Job;
