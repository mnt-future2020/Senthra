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

export interface CatalogueItem {
  id: string;
  name: string;
  sku: string;
  categoryId: string;
  category: { id: string; name: string } | null;
  description: string | null;
  uom: string | null; // unit of measure, e.g. "Each" | "Metre"
  serialized: boolean;
  barcodeRequired: boolean;
  highValue: boolean;
  thresholdQty: number | null; // low-stock reorder threshold
  status: CustomerStatus;
  // Dynamic per-category custom fields (e.g. { Fibre: "Singlemode" }).
  attributes: Record<string, string> | null;
  createdAt: string;
}

export interface CustomerSite {
  id: string;
  code: string | null; // auto-allocated per customer, e.g. STE-0001
  name: string;
  addressLine: string | null;
  postcode: string | null;
  contactPerson: string | null;
  contactNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  status: CustomerStatus;
  createdAt: string;
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

export type StockRequestStatus = "pending" | "approved" | "rejected" | "completed";

// A customer-submitted stock / replenishment request — an order ask, NOT a
// catalogue write. Portal users queue one of these; an internal user reviews and
// approves/rejects it. Approval is a status move only (no catalogue/inventory write).
export interface StockRequest {
  id: string;
  name: string;
  quantity: number | null;
  reason: string | null; // business justification
  notes: string | null;
  status: StockRequestStatus;
  requestedByName: string | null;
  reviewedBy: string | null;
  adminResponse: string | null; // admin response note shown to the customer
  reviewedAt: string | null;
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

export interface Customer extends CustomerSummary {
  projects: CustomerProject[];
  catalogue: CatalogueItem[];
  sites: CustomerSite[];
  users: CustomerUser[];
  stockRequests: StockRequest[]; // PENDING only (the admin review queue)
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
    stockItems: number;
    pendingRequests: number;
  };
  recentRequests: StockRequest[];
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
