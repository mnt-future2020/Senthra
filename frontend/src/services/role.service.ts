import { api } from "@/lib/api";
import type { Role } from "@/types/role";

// Typed wrappers around the backend /roles endpoints.

export interface RolePayload {
  name: string;
  description?: string;
}

export function listRoles(): Promise<Role[]> {
  return api<{ roles: Role[] }>("/roles").then((r) => r.roles);
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
