// The warehouse Inventory tab's pools, and the permission each one's pane actually reads with.
//
// Pure, so the rule is testable against the seeded roles without rendering WarehouseDetail. Each pool
// is gated on its OWN endpoint's permission — the tab itself grants nothing:
//   • irm      → /inventory                      (inventory.view)
//   • customer → /warehouses/:id/stock-entries   (stock_requests.view)
//   • damaged  → /goods-management/damaged       (goods_management.view)
//   • rental   → the warehouse's hire stock      (rentals.view)
// The customer pool used to have "no separate gate — the tab itself is the gate", and the damaged pool
// rode on inventory.view: a Finance Director landed on a customer pool that answered 403, and a Project
// Manager could open a damaged pool that did.

export type StockPool = "irm" | "customer" | "damaged" | "rental";

/** Which pools this viewer may open. */
export function stockPoolAccess(can: (permission: string) => boolean): Record<StockPool, boolean> {
  return {
    irm: can("inventory.view"),
    customer: can("stock_requests.view"),
    damaged: can("goods_management.view"),
    rental: can("rentals.view"),
  };
}

/** The Inventory TAB's gate: any one of the pools above — never a tab whose every pane would 403. */
export const INVENTORY_TAB_PERMS = ["inventory.view", "stock_requests.view", "goods_management.view", "rentals.view"];
