import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { Department } from "@/types/department";

// Typed wrappers around the backend /departments endpoints.

// Stale-while-revalidate cache (module-level, survives route navigation) so the
// user-form picker and the manage screen render the last result instantly. Kept in
// sync on mutations so a freshly created/renamed/removed department shows everywhere
// without a refetch.
let departmentsCache: Department[] | null = null;
registerClientCache(() => {
  departmentsCache = null;
});
export const getCachedDepartments = (): Department[] | null => departmentsCache;

const byName = (a: Department, b: Department) => a.name.localeCompare(b.name);

export function listDepartments(): Promise<Department[]> {
  return api<{ departments: Department[] }>("/departments").then((r) => {
    departmentsCache = r.departments;
    return r.departments;
  });
}

export function createDepartment(name: string): Promise<Department> {
  return api<{ department: Department }>("/departments", {
    method: "POST",
    body: { name },
  }).then((r) => {
    if (departmentsCache) {
      departmentsCache = [...departmentsCache, r.department].sort(byName);
    }
    return r.department;
  });
}

export function updateDepartment(id: string, name: string): Promise<Department> {
  return api<{ department: Department }>(`/departments/${id}`, {
    method: "PUT",
    body: { name },
  }).then((r) => {
    if (departmentsCache) {
      departmentsCache = departmentsCache.map((d) => (d.id === id ? r.department : d)).sort(byName);
    }
    return r.department;
  });
}

export function deleteDepartment(id: string): Promise<void> {
  return api(`/departments/${id}`, { method: "DELETE" }).then(() => {
    if (departmentsCache) {
      departmentsCache = departmentsCache.filter((d) => d.id !== id);
    }
    return undefined;
  });
}
