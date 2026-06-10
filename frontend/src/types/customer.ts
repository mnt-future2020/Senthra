// Customer master-data types — mirror the backend customer DTOs. No monetary
// fields exist anywhere (customers must never see pricing/cost data).

export type CustomerStatus = "active" | "inactive";

export interface CustomerProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface CatalogueItem {
  id: string;
  name: string;
  sku: string;
  category: string;
  // Dynamic per-category custom fields (e.g. { Fibre: "Singlemode" }).
  attributes: Record<string, string> | null;
  createdAt: string;
}

export interface CustomerSite {
  id: string;
  name: string;
  postcode: string | null;
  createdAt: string;
}

// Grid row + the shape embedded in the detail view. Mirrors the backend
// PublicCustomerSummary.
export interface CustomerSummary {
  id: string;
  customerCode: string;
  name: string;
  // Company
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
  mustResetPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Customer extends CustomerSummary {
  projects: CustomerProject[];
  catalogue: CatalogueItem[];
  sites: CustomerSite[];
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
