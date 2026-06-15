import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { PermissionGroup, Role } from "@/types/role";

// Typed wrappers around the backend /roles endpoints.

export interface RolePayload {
  name: string;
  description?: string;
  permissions?: string[];
}

// Stale-while-revalidate cache (module-level, survives route navigation) so a view
// returning to the roles list renders the last result instantly while it refetches.
let rolesCache: Role[] | null = null;
registerClientCache(() => {
  rolesCache = null;
});
export const getCachedRoles = (): Role[] | null => rolesCache;

export function listRoles(): Promise<Role[]> {
  return api<{ roles: Role[] }>("/roles").then((r) => {
    rolesCache = r.roles;
    return r.roles;
  });
}

export function getRole(id: string): Promise<Role> {
  return api<{ role: Role }>(`/roles/${id}`).then((r) => r.role);
}

// The grouped permission catalog + ordered category list for the role-editor matrix.
export interface PermissionCatalog {
  groups: PermissionGroup[];
  categories: string[];
}
export function listPermissionCatalog(): Promise<PermissionCatalog> {
  return api<PermissionCatalog>("/roles/permissions").then((r) => ({
    groups: r.groups ?? [],
    categories: r.categories ?? [],
  }));
}

export function createRole(payload: RolePayload): Promise<Role> {
  return api<{ role: Role }>("/roles", { method: "POST", body: payload }).then(
    (r) => r.role,
  );
}

export function updateRole(id: string, payload: RolePayload): Promise<Role> {
  return api<{ role: Role }>(`/roles/${id}`, { method: "PUT", body: payload }).then(
    (r) => r.role,
  );
}

export function deleteRole(id: string): Promise<void> {
  return api(`/roles/${id}`, { method: "DELETE" }).then(() => undefined);
}
