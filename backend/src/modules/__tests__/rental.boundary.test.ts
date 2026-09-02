import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Rental is procurement plus a deadline. It must never become OWNED STOCK.
//
// A source scan rather than a runtime assertion because the failure it prevents is someone WIRING
// it up: each of these modules would silently start treating a hire as owned inventory the moment a
// reference appeared, and no unit test of either module would notice.
//
// ── 2026-08-23: `goods-management` was REMOVED from this list, deliberately ────────────────────
//
// A job can now put a hired item on its kit list, and the warehouse scans it out to the engineer and
// back in again. That required separating two claims this wall used to conflate:
//
//   1. A hire never becomes OWNED STOCK — never an InventoryBalance, never a GoodsReceipt, never
//      engineer van stock, never a reorder suggestion. This is the real invariant and it is
//      UNTOUCHED. Every rule below still enforces it.
//   2. A hire is never tracked at all once it arrives. This was never true: the hire line has
//      carried `receivedQuantity`, `returnedQuantity`, `damagedQuantity` and `hireStatus` since the
//      day it existed, and `purchaseOrder.warehouseId` has always said where the kit is. That is
//      custody bookkeeping, and issuing a unit to an engineer is a move WITHIN it.
//
// So goods-management may now name a rental model. What it may not do is route one into the owned-
// stock primitives, and that is now asserted directly — see "a rental issue writes no owned-stock
// row" in goods-management.service.test.ts, which is a behavioural check and strictly stronger than
// the grep it replaces.
//
// `engineer-stock` stays on the list: engineer RENTAL custody lives in its own module
// (`engineer-rental`) precisely so the IRM van-stock primitive keeps this guarantee.
//
// ── 2026-08-24: `job-kit-request` REMOVED, for the same reason ─────────────────────────────────
//
// An engineer can now ask for a rental item mid-job and the planner approves it from a depot holding
// a live hire with spare units. It was excluded in the first pass on the belief that a hire could
// only ever be ORDERED, never issued from stock — which stopped being true the moment rentals became
// collectable from a warehouse.
//
// The rule that replaces the grep is sharper than it was: a rental request may be fulfilled from a
// WAREHOUSE and never from a van, because custody of a hire is anchored to the depot that took
// delivery and the provider collects it from there. That is asserted behaviourally in
// job-kit-request.rental.test.ts ("refuses to source a rental from an engineer's van"), which a
// source scan could not have expressed at all.
const FORBIDDEN_IN = ["goods-in", "inventory", "engineer-stock"];
const RENTAL_REF = /rentalItem|RentalItem|purchaseOrderRentalLine|purchaseRequestRentalLine|rental-item/;

/** Comments are prose; a rental mentioned in one is a note, not a wiring. */
const codeLinesOf = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const sourceFilesIn = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

describe("rental stays outside stock", () => {
  it.each(FORBIDDEN_IN)("%s never references a rental model or module", (dir) => {
    const base = join(process.cwd(), "src", "modules", dir);
    const offenders = sourceFilesIn(base).filter((f) =>
      RENTAL_REF.test(codeLinesOf(readFileSync(join(base, f), "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  // The reorder engine plans replenishment of owned stock. A hire has no stock level at all, so a
  // rental reaching it would generate purchase requests for equipment nobody owns.
  it("the reorder engine never reads a rental model", () => {
    const code = codeLinesOf(readFileSync(join(process.cwd(), "src", "modules", "inventory", "reorder.ts"), "utf8"));
    expect(RENTAL_REF.test(code)).toBe(false);
  });

  // The rental modules are equally one-way: they own master data and lines, and must not start
  // reaching into stock either.
  it("the rental modules never reference an inventory balance or a goods receipt", () => {
    const forbidden = /inventoryBalance|InventoryBalance|goodsReceipt|GoodsReceipt|engineerStockBalance/;
    // rental-receipt is on this list from the day it existed: it is the module MOST tempted to reach
    // for stock, because it is the one doing the receiving. Its whole reason for being separate from
    // Goods In is that hired kit never becomes an inventory balance.
    // `engineer-rental` joins this list from the day it exists, and it is the module MOST tempted to
    // reach for stock — it is the one holding a balance and a ledger, shaped exactly like the IRM van
    // primitives it sits beside. Its whole reason for being a separate module rather than another
    // pair of columns on EngineerStockBalance is that hired kit is not owned stock.
    for (const dir of ["rental-item", "rental-category", "rental-receipt", "engineer-rental"]) {
      const base = join(process.cwd(), "src", "modules", dir);
      const offenders = sourceFilesIn(base).filter((f) =>
        forbidden.test(codeLinesOf(readFileSync(join(base, f), "utf8"))),
      );
      expect(offenders, `${dir} reaches into stock`).toEqual([]);
    }
  });
});

// A hire raised DIRECTLY on a purchase order (no request behind it) is still procurement plus a
// deadline. The writers that path runs through — the order service, its repository and the shared
// rental-line builder — must never reach an owned-stock primitive: a rental line becomes a
// PurchaseOrderRentalLine and nothing else.
describe("a directly-raised hire is procurement, not stock", () => {
  const OWNED_STOCK = /inventoryBalance|InventoryBalance|inventoryTransaction|InventoryTransaction|engineerStockBalance|EngineerStockBalance/;

  it.each(["purchase-order.service.ts", "purchase-order.repository.ts", "rentalLine.rows.ts", "rentalLine.validation.ts"])(
    "purchase-order/%s never references an owned-stock primitive",
    (file) => {
      const code = codeLinesOf(readFileSync(join(process.cwd(), "src", "modules", "purchase-order", file), "utf8"));
      expect(OWNED_STOCK.test(code)).toBe(false);
    },
  );
});
