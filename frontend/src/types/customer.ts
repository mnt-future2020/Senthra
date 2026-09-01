// Customer master-data types — mirror the backend customer DTOs. No monetary
// fields exist anywhere (customers must never see pricing/cost data).

export type CustomerStatus = "active" | "inactive";
export type ProjectStatus = "active" | "planned" | "on_hold" | "completed";

export interface CustomerProject {
  id: string;
  code: string | null; // auto-allocated per customer, e.g. PRJ-0001
  name: string;
  type: string | null;
  startDate: string | null; // ISO
  endDate: string | null; // ISO
  status: ProjectStatus;
  description: string | null;
  createdAt: string;
}

export interface CustomerSite {
  id: string;
  code: string | null; // auto-allocated per customer, e.g. STE-0001
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  contactPerson: string | null;
  contactNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  status: CustomerStatus;
  createdAt: string;
}

// Bulk site import result (mirror of the backend BulkSiteResult).
export interface SiteImportRowNote {
  row: number;
  name: string;
  reason: string;
}
export interface BulkSiteResult {
  createdSites: CustomerSite[];
  skipped: SiteImportRowNote[];
  failed: SiteImportRowNote[];
}

// A customer's portal user (their PM etc.) — also the customer's login identity.
// One user type for now (no per-user roles).
export interface CustomerUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  designation: string | null;
  status: CustomerStatus;
  // True until the user completes their first-login password set (the invite wall).
  mustResetPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export type StockRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "assigned"
  | "partially_received"
  | "completed";

// `closed_short` is terminal like `received`: the outstanding balance is never arriving, so the
// assignment leaves the warehouse's Incoming queue. Kept distinct from `received` so "arrived in
// full" stays reportable.
export type WarehouseAssignmentStatus = "pending" | "partially_received" | "received" | "closed_short";

export interface WarehouseAssignment {
  id: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  quantity: number;
  receivedQuantity: number;
  status: WarehouseAssignmentStatus;
  receivedBy: string | null;
  receivedAt: string | null;
  notes: string | null;
  // Set only when status is "closed_short".
  closureReason: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export interface StockRequest {
  id: string;
  name: string;
  editedName: string | null;
  catalogueItemId: string | null;
  // Set when this submission tops up an existing received stock line (no duplicate row).
  linkedStockEntryId: string | null;
  quantity: number | null;
  reason: string | null;
  notes: string | null;
  status: StockRequestStatus;
  requestedByName: string | null;
  reviewedBy: string | null;
  adminResponse: string | null;
  reviewedAt: string | null;
  // What the CUSTOMER asked for at submission — a preference, never the destination. The
  // destination is `warehouseAssignments`, which a reviewer sets and may split.
  preferredWarehouseId: string | null;
  preferredWarehouseName: string | null;
  // False once that warehouse has been deactivated since submission — the preference is still
  // worth showing, but must not be offered as a pre-fill.
  preferredWarehouseActive: boolean;
  warehouseAssignments: WarehouseAssignment[];
  createdAt: string;
}

// ── Portal (what the CUSTOMER sees about their own submission) ────────────────────────────────
// A deliberate subset of the admin shapes above, mirroring the server's PortalStockRequest. The
// staff emails that acted on the line (receivedBy / closedBy / reviewedBy) and the warehouse's
// internal notes are not the customer's to read, so they never leave the server for this route.
export interface PortalWarehouseAssignment {
  warehouseName: string;
  quantity: number;
  receivedQuantity: number;
  status: WarehouseAssignmentStatus;
  closureReason: string | null;
  closedAt: string | null;
}

// One of the customer's own consignment lines, as the portal receives it. Narrower than
// CustomerStockEntry on two counts: `receivedBy` is warehouse staff, not theirs; and
// serialized/serialNumber/highValue/thresholdQty/attributes are dead columns no form in the app
// fills, so a portal screen built on them would render permanently empty rows.
export interface PortalStockEntry {
  id: string;
  warehouseName: string;
  warehouseCode: string;
  itemName: string;
  sku: string | null;
  categoryName: string | null;
  description: string | null;
  uom: string | null;
  quantity: number;
  barcode: string | null;
  status: StockEntryStatus;
  receivedAt: string | null;
  createdAt: string;
}

export interface PortalStockRequest {
  id: string;
  name: string;
  editedName: string | null;
  linkedStockEntryId: string | null;
  quantity: number | null;
  reason: string | null;
  status: StockRequestStatus;
  adminResponse: string | null;
  // The preference the customer expressed, echoed back. Name only.
  preferredWarehouseName: string | null;
  warehouseAssignments: PortalWarehouseAssignment[];
  createdAt: string;
}

export interface PendingStockItem {
  assignmentId: string;
  requestId: string;
  customerName: string;
  customerCode: string;
  itemName: string;
  quantity: number;
  receivedQuantity: number;
  status: string;
  warehouseName: string;
  warehouseCode: string | null;
  createdAt: string;
}

export type StockEntryStatus = "draft" | "active";

export interface CustomerStockEntry {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  assignmentId: string | null;
  itemName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  description: string | null;
  uom: string | null;
  quantity: number;
  serialized: boolean;
  serialNumber: string | null;
  highValue: boolean;
  thresholdQty: number | null;
  attributes: Record<string, string> | null;
  barcode: string | null;
  barcodeDataUri: string | null;
  status: StockEntryStatus;
  receivedBy: string | null;
  receivedAt: string | null;
  createdAt: string;
}

// Grid row + the shape embedded in the detail view. Mirrors the backend
// PublicCustomerSummary.
export interface CustomerSummary {
  id: string;
  customerCode: string;
  name: string;
  // Company
  legalName: string | null;
  registrationNumber: string | null;
  industry: string | null;
  website: string | null;
  logoUrl: string | null;
  notes: string | null;
  status: string;
  // Primary contact
  contactPerson: string | null;
  contactJobTitle: string | null;
  email: string;
  phone: string | null;
  altPhone: string | null;
  // Address (UK)
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  // Audit — staff email that created / last updated this customer.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// NOTE: sites/projects are NOT on the detail payload — they can number in the thousands
// (bulk import), so the detail tabs load them through the paged list endpoints instead.
export interface Customer extends CustomerSummary {
  users: CustomerUser[];
  // EVERY submission including completed / rejected — the tab defaults its own filter to open.
  stockRequests: StockRequest[];
}

// What a logged-in customer sees about themselves (the portal).
export interface CustomerSelfProfile {
  id: string;
  customerCode: string;
  name: string;
  logoUrl: string | null;
  website: string | null;
  contactPerson: string | null;
  contactJobTitle: string | null;
  email: string;
  phone: string | null;
}

// Portal dashboard summary — company header + live counts + a few recent requests.
export interface CustomerOverview {
  customer: {
    id: string;
    customerCode: string;
    name: string;
    logoUrl: string | null;
    status: string;
  };
  counts: {
    activeProjects: number;
    totalProjects: number;
    totalSites: number;
    /** Submissions still needing something — pending | approved | assigned | partially_received. */
    openRequests: number;
    /** Stock entry ROWS (one per item × warehouse) — what My Stock lists. */
    stockEntries: number;
    /** UNITS across those rows. The headline: "how much stock do you hold for me". */
    stockUnits: number;
    /** Units short-closed and never arriving. Usually 0 — the UI only shows it when it isn't. */
    notReceivedUnits: number;
    /** Jobs still happening — scheduled or in progress. Matches what the Jobs page lists under
     *  those two stages, because the server derives both from the same status set. */
    activeJobs: number;
  };
  /** Units per warehouse, biggest first. Empty when the customer has no stock with us. Carries the
   *  id so a row can link to My Stock filtered to that warehouse. */
  stockByWarehouse: {
    warehouseId: string;
    warehouseName: string;
    warehouseCode: string;
    units: number;
    entries: number;
  }[];
  recentRequests: PortalStockRequest[];
}

// --- Flow 9 stock (read-only portal). Lit up by the backend feature flag; until
// then `available` is false and items/movements are empty. NO pricing fields. ---

export interface CustomerStockItem {
  sku: string;
  name: string;
  category: string;
  quantityOnHand: number;
  highValue: boolean;
  serial?: string | null;
  location?: string | null;
}

export interface CustomerStockMovement {
  sku: string;
  name: string;
  direction: "dispatched" | "received";
  quantity: number;
  date: string;
  site?: string | null;
  engineer?: string | null;
}

export interface CustomerStock {
  available: boolean;
  items: CustomerStockItem[];
  movements: CustomerStockMovement[];
}
