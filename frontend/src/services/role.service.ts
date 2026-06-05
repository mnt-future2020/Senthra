import { api } from "@/lib/api";
import type { PermissionDef, Role } from "@/types/role";

// Typed wrappers around the backend /roles endpoints.

export interface RolePayload {
  name: string;
  description?: string;
  permissions?: string[];
}

export function listRoles(): Promise<Role[]> {
  return api<{ roles: Role[] }>("/roles").then((r) => r.roles);
}

// The permission catalog for the role editor (super-admin only).
export function listPermissionCatalog(): Promise<PermissionDef[]> {
  return api<{ permissions: PermissionDef[] }>("/roles/permissions").then(
    (r) => r.permissions,
  );
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
