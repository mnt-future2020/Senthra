import { describe, expect, it, vi } from "vitest";

// The repository module instantiates a Prisma client at import; stub it (this test only exercises
// the pure error-classifier, which makes no DB calls).
vi.mock("../../lib/prisma.js", () => ({ prisma: {}, withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import { Prisma } from "@prisma/client";
import { isSerialUniqueViolation } from "./goods-in.repository.js";

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: { target } });
}

// The DB-level backstop for serial uniqueness: a P2002 from GoodsReceiptSerial @@unique must be
// recognised so the repository can map it to a friendly 409 (concurrent duplicate protection).
describe("isSerialUniqueViolation — serial-uniqueness backstop detection", () => {
  it("detects a P2002 raised by the serial unique index (constraint name or field list)", () => {
    expect(isSerialUniqueViolation(p2002("GoodsReceiptSerial_irmItemId_serialLower_key"))).toBe(true);
    expect(isSerialUniqueViolation(p2002(["irmItemId", "serialLower"]))).toBe(true);
  });

  it("ignores a P2002 from a different unique (e.g. the GRN code) or with no target", () => {
    expect(isSerialUniqueViolation(p2002("GoodsReceipt_code_key"))).toBe(false);
    expect(isSerialUniqueViolation(p2002(undefined))).toBe(false);
  });

  it("ignores non-P2002 Prisma errors and plain errors", () => {
    expect(isSerialUniqueViolation(new Prisma.PrismaClientKnownRequestError("Not found", { code: "P2025", clientVersion: "test" }))).toBe(false);
    expect(isSerialUniqueViolation(new Error("boom"))).toBe(false);
    expect(isSerialUniqueViolation(null)).toBe(false);
  });
});
