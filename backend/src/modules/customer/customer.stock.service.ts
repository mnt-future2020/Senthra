import { env } from "../../config/env.js";

// Customer stock read-model SEAM (Flow 9).
//
// The customer portal's reason to exist is "see my stock". That data — qty-on-hand
// per catalogue item, dated dispatched/received movements, serialized high-value
// tracking — comes from the Stock / IRM Inventory / Goods-In-Out / Warehouse
// modules, which DO NOT EXIST YET. This service is the single, well-typed boundary
// between the customer portal and that future inventory read-model.
//
// Today there is one implementation: when the FEATURE_CUSTOMER_STOCK flag is off
// (the default), it returns `available: false` so the portal renders an honest
// "no stock data yet" state. When the inventory module ships, wire its
// per-customer read here (still scoped strictly by customerId) and flip the flag —
// no other part of the customer module changes.
//
// HARD RULE (docs): customers NEVER see pricing or cost data. No monetary field
// belongs in any of these shapes, ever.

export interface CustomerStockItem {
  sku: string;
  name: string;
  category: string;
  quantityOnHand: number;
  // High-value items are tracked by serial + physical location (no price shown).
  highValue: boolean;
  serial?: string | null;
  location?: string | null;
}

export interface CustomerStockMovement {
  sku: string;
  name: string;
  direction: "dispatched" | "received";
  quantity: number;
  date: string; // ISO
  site?: string | null;
  engineer?: string | null;
}

export interface CustomerStock {
  // false → the live inventory read-model isn't wired/enabled yet; the portal
  // shows a "no stock data yet" empty state instead of a misleading empty table.
  available: boolean;
  items: CustomerStockItem[];
  movements: CustomerStockMovement[];
}

const EMPTY: CustomerStock = { available: false, items: [], movements: [] };

// Resolve a customer's current stock. `customerId` MUST be the authenticated
// customer's own id (passed from req.principal.customerId) — never a client input.
export async function getCustomerStock(customerId: string): Promise<CustomerStock> {
  if (!env.FEATURE_CUSTOMER_STOCK) {
    return EMPTY;
  }

  // --- inventory read-model goes here, once it exists -----------------------
  // const items = await inventoryRepo.stockOnHandForCustomer(customerId);
  // const movements = await movementRepo.recentForCustomer(customerId);
  // return { available: true, items, movements };
  //
  // Until then the flag should stay off; returning EMPTY keeps the contract
  // honest if the flag is flipped before the read-model is wired.
  void customerId;
  return EMPTY;
}
