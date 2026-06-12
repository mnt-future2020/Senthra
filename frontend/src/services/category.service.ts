import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { Category, CategoryPayload } from "@/types/category";

// Typed wrappers around the backend /categories endpoints.

// Stale-while-revalidate cache (module-level, survives route navigation) so the
// catalogue-item form's category picker + the Settings list render instantly while
// they refetch.
let categoriesCache: Category[] | null = null;
registerClientCache(() => {
  categoriesCache = null;
});
export const getCachedCategories = (): Category[] | null => categoriesCache;

export function listCategories(): Promise<Category[]> {
  return api<{ categories: Category[] }>("/categories").then((r) => {
    categoriesCache = r.categories;
    return r.categories;
  });
}

export function getCategory(idOrKey: string): Promise<Category> {
  return api<{ category: Category }>(`/categories/${idOrKey}`).then((r) => r.category);
}

export function createCategory(payload: CategoryPayload): Promise<Category> {
  return api<{ category: Category }>("/categories", { method: "POST", body: payload }).then(
    (r) => {
      categoriesCache = null;
      return r.category;
    },
  );
}

export function updateCategory(id: string, payload: Partial<CategoryPayload>): Promise<Category> {
  return api<{ category: Category }>(`/categories/${id}`, { method: "PUT", body: payload }).then(
    (r) => {
      categoriesCache = null;
      return r.category;
    },
  );
}

export function deleteCategory(id: string): Promise<void> {
  return api(`/categories/${id}`, { method: "DELETE" }).then(() => {
    categoriesCache = null;
  });
}
