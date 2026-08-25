import { describe, expect, it } from "vitest";

/**
 * WHEN A CUSTOMER STOCK ENTRY MAY BE DELETED.
 *
 * `customer_stock.delete` existed end to end since the module was written — route, permission,
 * dependency checks, audit — and the two sibling sections in the same component both offered it. Only
 * the stock table never grew the button, so a role could hold the key with nothing to use it on. That
 * is the failure this project already names out loud: "a pair of keys hand-written in nine places is
 * how a role ends up holding a permission with no button to use it."
 *
 * The rule the button mirrors is the FIRST of the server's two refusals, and the only one a table row
 * can answer for itself:
 *
 *     "Stock still on the shelf goes first: deleting it would remove the units with no ledger entry
 *      anywhere, which is the one loss that leaves no trace at all."
 *
 * The second — anything else pointing at the entry — needs queries the row does not have, so the
 * server keeps that one and its message is shown verbatim.
 */
const deleteBlockedReason = (entry: { quantity: number; itemName: string }): string | undefined =>
  entry.quantity > 0
    ? `${entry.quantity} unit${entry.quantity === 1 ? "" : "s"} still in stock — move or dispatch the stock before deleting the entry.`
    : undefined;

describe("customer stock entry deletion", () => {
  it("allows an entry holding nothing", () => {
    expect(deleteBlockedReason({ quantity: 0, itemName: "Splice tray" })).toBeUndefined();
  });

  // Not hidden — DISABLED, carrying the reason. Hiding it on the rows that would be refused makes the
  // control column flicker down the table and leaves the reader to infer the rule from which rows have
  // a trash icon.
  it("refuses one that still holds stock, and says how much", () => {
    expect(deleteBlockedReason({ quantity: 4, itemName: "Splice tray" })).toMatch(/4 units still in stock/);
  });

  it("counts one unit in the singular", () => {
    expect(deleteBlockedReason({ quantity: 1, itemName: "Splice tray" })).toMatch(/1 unit still in stock/);
  });

  // A negative balance is not a licence to delete. It should never occur, and if a hand-edited row
  // produces one, the entry is the evidence of it — the server refuses on the same comparison.
  it("treats a negative balance as nothing on the shelf, matching the server's own test", () => {
    expect(deleteBlockedReason({ quantity: -1, itemName: "Splice tray" })).toBeUndefined();
  });
});
