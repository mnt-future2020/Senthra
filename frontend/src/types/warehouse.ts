// Warehouse master-data types — mirror the backend Warehouse DTO. Stock rollups are
// present but always 0 until the inventory ledger module is built. No pricing/cost.

export type WarehouseStatus = "active" | "inactive";

// The warehouse's operational type, resolved from the WarehouseType master.
export interface WarehouseTypeRef {
  id: string;
  name: string;
}

// A staff user in a picker (the engineer dropdowns) — id + label only.
export interface WarehouseManager {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" label
}

// A warehouse's manager, derived from the Users & Roles assignment. Adds the name parts +
// profile image so the detail page renders the standard staff avatar chip.
export interface WarehouseManagerRef extends WarehouseManager {
  firstName: string;
  lastName: string;
  // Only so the form can OFFER to copy the manager into the warehouse's own contact fields — the
  // site contact (what suppliers, couriers and collecting engineers see) stays separate data.
  phone: string | null;
  profileImageUrl: string | null;
}

export interface Warehouse {
  id: string;
  code: string; // auto-allocated, e.g. WH-0001
  name: string;
  description: string | null;
  type: WarehouseTypeRef | null;
  typeId: string | null;
  isDefault: boolean;
  // Address (UK).
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  // Geolocation — derived from the postcode server-side; read-only.
  latitude: number | null;
  longitude: number | null;
  // Contact.
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Operational metadata (display-only).
  operatingHours: string | null;
  timezone: string | null;
  notes: string | null;
  // Managers — DERIVED, read-only. The staff assigned to this warehouse under Users & Roles
  // (warehouse-scoped roles only), NOT a field on the warehouse. Empty when nobody is assigned.
  managers: WarehouseManagerRef[];
  status: WarehouseStatus;
  // Stock rollups — 0 until the inventory ledger lands.
  totalStockItems: number;
  totalStockQuantity: number;
  // Audit — staff email that created / last updated this warehouse.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
