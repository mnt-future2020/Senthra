import { forbidden } from "../utils/http-error.js";

// Warehouse-access control — the SINGLE SOURCE OF TRUTH for "which warehouses may this actor touch".
//
//   getAccessibleWarehouseIds(actor)   ← the source of truth (reads the principal's assigned set)
//        ├─ warehouseScopeFilter(actor) ← list-filter form (Prisma `id: { in }` / `warehouseId: { in }`)
//        └─ assertWarehouseAccess(actor, warehouseId) ← single-resource 403 guard
//
// A warehouse-scoped user (role.isWarehouseScoped) carries `assignedWarehouseIds` on its principal
// (populated once in requireAuth — never re-queried per module). Everyone else (super-admin, system,
// non-scoped roles) is UNRESTRICTED (`null`). EVERY warehouse-bound surface must derive its scoping
// from these three helpers — no module may re-query assignments or invent its own check.

export interface WarehouseScopedActor {
  // The principal type — only a staff "user" can be warehouse-scoped.
  type?: string;
  // The warehouses this actor may access. `null`/absent = unrestricted (admin / non-scoped role).
  // A (possibly empty) array = restricted to exactly those warehouse ids.
  assignedWarehouseIds?: string[] | null;
}

// Convenience predicate for FUTURE warehouse-bound modules (Stock Reports, Cycle Counts, Supplier
// Deliveries, Returns, Sites, Jobs, Engineers, …): is this actor a warehouse-SCOPED user — a staff
// principal whose role restricts them to assigned warehouses? It sits ABOVE the access chain and does
// NOT replace getAccessibleWarehouseIds / warehouseScopeFilter / assertWarehouseAccess — it just lets
// new code branch (`if (isWarehouseScopedUser(actor)) { … }`) without repeating the check. Inspects
// ONLY the already-loaded principal (never the database): a scoped user is exactly a `type === "user"`
// whose `assignedWarehouseIds` was populated (requireAuth sets it to an array only when the role is
// warehouse-scoped, else null). False for null / admin / customer / system / non-scoped actors.
export function isWarehouseScopedUser(actor?: WarehouseScopedActor): boolean {
  return actor?.type === "user" && actor.assignedWarehouseIds != null;
}

// THE source of truth. Returns the actor's accessible warehouse-id set, or `null` when unrestricted
// (no actor, admin/system, or a non-warehouse-scoped role).
export function getAccessibleWarehouseIds(actor?: WarehouseScopedActor): string[] | null {
  return actor?.assignedWarehouseIds ?? null;
}

// List-filter form: `undefined` = apply no filter (unrestricted); otherwise the id list to constrain a
// Prisma `where` with `id: { in }` / `warehouseId: { in }`. A restricted actor with an empty set yields
// `[]`, which correctly matches nothing.
export function warehouseScopeFilter(actor?: WarehouseScopedActor): string[] | undefined {
  const ids = getAccessibleWarehouseIds(actor);
  return ids === null ? undefined : ids;
}

// Single-resource guard. Throws 403 when the actor is restricted and `warehouseId` isn't in their set.
// MUST be called on the RESOLVED canonical warehouse id (after any code→id lookup), never a raw URL token.
export function assertWarehouseAccess(actor: WarehouseScopedActor | undefined, warehouseId: string): void {
  const ids = getAccessibleWarehouseIds(actor);
  if (ids !== null && !ids.includes(warehouseId)) {
    throw forbidden("You don't have access to this warehouse.");
  }
}
