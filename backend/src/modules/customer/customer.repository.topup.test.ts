import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused on findStockEntryForTopUp's matching predicate (name + EXACT sku). Mock lib/prisma so
// importing the repository never constructs a real client; only customerStockEntry.findMany is used.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { customerStockEntry: { findMany: vi.fn() } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { findStockEntryForTopUp } from "./customer.repository.js";

const CUST = "c".repeat(24);
const WH = "b".repeat(24);
const findMany = prisma.customerStockEntry.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("findStockEntryForTopUp — name + exact-sku matching", () => {
  it("picks the same-named line carrying the SAME sku (not the first same-named line)", async () => {
    findMany.mockResolvedValue([
      { id: "lx", itemName: "Module", sku: "SFP-LX" },
      { id: "sx", itemName: "Module", sku: "SFP-SX" },
    ]);
    expect(await findStockEntryForTopUp(CUST, WH, "Module", "SFP-SX")).toEqual({ id: "sx" });
  });

  it("a null-sku source matches ONLY a null-sku line — never a same-named product that has a sku", async () => {
    findMany.mockResolvedValue([
      { id: "sku", itemName: "Module", sku: "SFP-LX" }, // would have been wrongly matched by the old name-only fallback
      { id: "nul", itemName: "Module", sku: null },
    ]);
    expect(await findStockEntryForTopUp(CUST, WH, "Module", null)).toEqual({ id: "nul" });
  });

  it("returns null when the only same-named line carries a different sku (no loose name-only merge)", async () => {
    findMany.mockResolvedValue([{ id: "sku", itemName: "Module", sku: "SFP-LX" }]);
    expect(await findStockEntryForTopUp(CUST, WH, "Module", null)).toBeNull();
  });

  it("matches case-insensitively on the trimmed item name", async () => {
    findMany.mockResolvedValue([{ id: "x", itemName: "  module  ", sku: "S1" }]);
    expect(await findStockEntryForTopUp(CUST, WH, "MODULE", "S1")).toEqual({ id: "x" });
  });

  it("returns null when nothing matches", async () => {
    findMany.mockResolvedValue([{ id: "x", itemName: "Other", sku: "S1" }]);
    expect(await findStockEntryForTopUp(CUST, WH, "Module", "S1")).toBeNull();
  });
});
