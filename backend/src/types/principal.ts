import type { Admin, Customer, CustomerUser } from "@prisma/client";

import type { UserWithRole } from "#modules/user/user.repository.js";

// The authenticated principal — the super-admin account (Admin model), a staff
// user (User model), or an external read-only customer (Customer model). Resolved
// by requireAuth and attached to req.principal, so handlers can branch on the
// account type without re-querying.

export interface AdminPrincipal {
  type: "admin";
  id: string;
  email: string;
  name: string | null;
}

export interface UserPrincipal {
  type: "user";
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl: string | null;
  status: string;
  mustResetPassword: boolean;
  role: { id: string; key: string; name: string } | null;
  // Effective permissions (the assigned role's permissions; "*" = all).
  permissions: string[];
}

// An external customer portal user (e.g. a Customer PM). Read-only, scoped to a
// single company: `id` is the signed-in CustomerUser, and `customerId` is the ONLY
// tenant they can ever address — every customer-facing repository query filters by
// it. Permissions are a fixed read-only set baked in here — customers are NOT
// governed by the Role system, so a role misconfiguration can never widen access.
export interface CustomerPrincipal {
  type: "customer";
  id: string; // the signed-in CustomerUser id (session subject)
  // The company this user belongs to — the one tenant they can address.
  customerId: string;
  email: string; // the user's login email
  name: string; // company name (shown across the portal)
  userName: string; // the signed-in person's name
  customerCode: string;
  logoUrl: string | null;
  mustResetPassword: boolean;
  // Effective permissions — a fixed read-only set; never derived from a Role.
  permissions: string[];
}

export type Principal = AdminPrincipal | UserPrincipal | CustomerPrincipal;

// The fixed read-only permission set every customer principal carries. NOTE: no
// runtime gate currently consults this — the customer portal is gated structurally
// by actor type (requireCustomer on the backend, AuthGuard requireType="customer"
// on the frontend), and customers reach only GET routes, never a write route. The
// set exists so principalCan() never throws on a customer and as the seam for any
// future permission-based gating. "stock.view" is intentionally not in
// PERMISSION_GROUPS (that catalog is the delegatable STAFF permissions).
export const CUSTOMER_PERMISSIONS = ["stock.view"];

export function adminPrincipal(admin: Admin): AdminPrincipal {
  return { type: "admin", id: admin.id, email: admin.email, name: admin.name };
}

export function customerPrincipal(user: CustomerUser, customer: Customer): CustomerPrincipal {
  return {
    type: "customer",
    id: user.id,
    customerId: customer.id,
    email: user.email,
    name: customer.name,
    userName: user.fullName,
    customerCode: customer.customerCode,
    logoUrl: customer.logoUrl,
    mustResetPassword: user.mustResetPassword ?? true,
    permissions: CUSTOMER_PERMISSIONS,
  };
}

export function userPrincipal(user: UserWithRole): UserPrincipal {
  return {
    type: "user",
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    profileImageUrl: user.profileImageUrl,
    status: user.status,
    mustResetPassword: user.mustResetPassword,
    role: user.role
      ? { id: user.role.id, key: user.role.key, name: user.role.name }
      : null,
    permissions: user.role?.permissions ?? [],
  };
}
