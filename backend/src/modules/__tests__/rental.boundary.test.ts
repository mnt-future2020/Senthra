import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Rental is procurement plus a deadline. It must never reach STOCK.
//
// A source scan rather than a runtime assertion because the failure it prevents is someone WIRING
// it up: each of these modules would silently start treating a hire as owned inventory the moment a
// reference appeared, and no unit test of either module would notice.

const FORBIDDEN_IN = ["goods-in", "inventory", "engineer-stock", "goods-management", "job-kit-request"];
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
    for (const dir of ["rental-item", "rental-category", "rental-receipt"]) {
      const base = join(process.cwd(), "src", "modules", dir);
      const offenders = sourceFilesIn(base).filter((f) =>
        forbidden.test(codeLinesOf(readFileSync(join(base, f), "utf8"))),
      );
      expect(offenders, `${dir} reaches into stock`).toEqual([]);
    }
  });
});
