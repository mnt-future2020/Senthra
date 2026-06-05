import type { Admin } from "@prisma/client";

import type { UserWithRole } from "#modules/user/user.repository.js";

// The authenticated principal — either the super-admin account (Admin model) or a
// staff user (User model). Resolved by requireAuth and attached to req.principal,
// so handlers can branch on the account type without re-querying.

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

export type Principal = AdminPrincipal | UserPrincipal;

export function adminPrincipal(admin: Admin): AdminPrincipal {
  return { type: "admin", id: admin.id, email: admin.email, name: admin.name };
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
