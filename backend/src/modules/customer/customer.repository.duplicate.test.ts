import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused on findDuplicateStockEntry's matching predicate (Direct Add duplicate guard): same
// name + EXACT sku, returning the matched entry's code. Same shape as the top-up predicate test;
// mock lib/prisma so importing the repository never constructs a real client.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { customerStockEntry: { findMany: vi.fn() } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { findDuplicateStockEntry } from "./customer.repository.js";

const CUST = "c".repeat(24);
const WH = "b".repeat(24);
const findMany = prisma.customerStockEntry.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("findDuplicateStockEntry — Direct Add duplicate guard", () => {
  it("flags a same-name + same-sku line and returns its barcode as the code", async () => {
    findMany.mockResolvedValue([{ id: "dup", itemName: "mouse123", sku: "M-1", barcode: "CSE-00018" }]);
    expect(await findDuplicateStockEntry(CUST, WH, "mouse123", "M-1")).toEqual({ id: "dup", code: "CSE-00018" });
  });

  it("returns a null code when the duplicate entry has no barcode yet", async () => {
    findMany.mockResolvedValue([{ id: "dup", itemName: "mouse123", sku: null, barcode: null }]);
    expect(await findDuplicateStockEntry(CUST, WH, "mouse123", null)).toEqual({ id: "dup", code: null });
  });

  it("matches case/space-insensitively on the item name", async () => {
    findMany.mockResolvedValue([{ id: "x", itemName: "  Mouse123  ", sku: "M-1", barcode: "CSE-1" }]);
    expect(await findDuplicateStockEntry(CUST, WH, "MOUSE123", "M-1")).toEqual({ id: "x", code: "CSE-1" });
  });

  it("does NOT flag a same-named line carrying a different sku (distinct product)", async () => {
    findMany.mockResolvedValue([{ id: "x", itemName: "mouse123", sku: "M-2", barcode: "CSE-1" }]);
    expect(await findDuplicateStockEntry(CUST, WH, "mouse123", "M-1")).toBeNull();
  });

  it("a null-sku add matches ONLY a null-sku line, never a same-named line that has a sku", async () => {
    findMany.mockResolvedValue([{ id: "sku", itemName: "mouse123", sku: "M-1", barcode: "CSE-1" }]);
    expect(await findDuplicateStockEntry(CUST, WH, "mouse123", null)).toBeNull();
  });

  it("returns null when nothing in this warehouse matches (a different warehouse is queried separately)", async () => {
    findMany.mockResolvedValue([{ id: "x", itemName: "other", sku: "M-1", barcode: "CSE-1" }]);
    expect(await findDuplicateStockEntry(CUST, WH, "mouse123", "M-1")).toBeNull();
  });
});
