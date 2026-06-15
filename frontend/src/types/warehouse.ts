// Warehouse master-data types — mirror the backend Warehouse DTO. Stock rollups are
// present but always 0 until the inventory ledger module is built. No pricing/cost.

export type WarehouseStatus = "active" | "inactive";

// The warehouse's operational type, resolved from the WarehouseType master.
export interface WarehouseTypeRef {
  id: string;
  name: string;
}

// The manager as surfaced on a warehouse (resolved from the staff User).
export interface WarehouseManager {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" label
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
  // Manager.
  managerUserId: string | null;
  manager: WarehouseManager | null;
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
