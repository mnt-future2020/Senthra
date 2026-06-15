// Supplier master-data types — mirror the backend Supplier DTO. Master-data only: no
// procurement / purchase-order / goods-in / pricing fields here.

export type SupplierStatus = "active" | "inactive";

// The supplier's classification, resolved from the SupplierType master.
export interface SupplierTypeRef {
  id: string;
  name: string;
}

// The internal owner as surfaced on a supplier (resolved from the staff User).
export interface SupplierOwner {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" label
}

export interface Supplier {
  id: string;
  code: string; // auto-allocated, e.g. SUP-0001
  name: string;
  legalName: string | null;
  description: string | null;
  type: SupplierTypeRef | null;
  typeId: string | null;
  status: SupplierStatus;
  // Contact.
  contactPerson: string | null;
  contactJobTitle: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Business.
  companyRegistrationNumber: string | null;
  vatNumber: string | null;
  website: string | null;
  // Address (UK).
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  // Payment.
  paymentTerms: string | null;
  customPaymentTerms: string | null;
  currency: string | null;
  // Operational.
  leadTimeDays: number | null;
  notes: string | null;
  // Internal owner.
  ownerUserId: string | null;
  owner: SupplierOwner | null;
  // Audit — staff email that created / last updated this supplier.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
