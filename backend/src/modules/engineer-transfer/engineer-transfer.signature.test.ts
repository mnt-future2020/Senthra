import { beforeEach, describe, expect, it, vi } from "vitest";

// The engineer dashboard's "delivered transfers awaiting your signature" count read ZERO for every
// engineer, always — because `acknowledgedAt: null` matches only an explicitly-null field, and
// nothing writes it on create (acknowledgeTransfer is the only path that sets it). Un-acknowledged
// transfers therefore have it ABSENT, and absent is not null.
//
// A count stuck at zero is the worst version of this trap: it reads as an empty desk, so nobody goes
// looking. It surfaced only because the same trap was found on a PO filter and this file was swept.
vi.mock("../../lib/prisma.js", () => ({
  prisma: { engineerStockTransfer: { count: vi.fn().mockResolvedValue(0) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { countAwaitingSignature } from "./engineer-transfer.repository.js";

const count = prisma.engineerStockTransfer.count as ReturnType<typeof vi.fn>;
const clauses = () => count.mock.calls.at(-1)![0].where.AND as Array<Record<string, unknown>>;

beforeEach(() => vi.clearAllMocks());

describe("countAwaitingSignature", () => {
  it("matches a transfer whose acknowledgedAt was never written, not only an explicit null", async () => {
    await countAwaitingSignature("eng-1");
    expect(clauses()).toContainEqual({
      OR: [{ acknowledgedAt: null }, { acknowledgedAt: { isSet: false } }],
    });
  });

  // The bare form is the bug: it is what made this count zero for every engineer.
  it("never narrows to acknowledgedAt: null on its own", async () => {
    await countAwaitingSignature("eng-1");
    expect(clauses()).not.toContainEqual(expect.objectContaining({ acknowledgedAt: null }));
  });

  // The rest of the predicate has to survive the fix — a transfer nobody asked to be signed for, or
  // one still in flight, is not waiting on anybody.
  it("still counts only completed transfers that require a signature", async () => {
    await countAwaitingSignature("eng-1");
    expect(clauses()).toContainEqual({ requireSignature: true });
    expect(JSON.stringify(clauses())).toContain("completed");
  });

  it("stays scoped to the engineer asking", async () => {
    await countAwaitingSignature("eng-1");
    expect(JSON.stringify(clauses())).toContain("eng-1");
  });
});
