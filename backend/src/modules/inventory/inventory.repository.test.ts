import { describe, expect, it, vi } from "vitest";

// upsertBalanceTx only needs a tx client + the conflict helper; mock lib/prisma so importing
// the repository never constructs a real Prisma client.
vi.mock("../../lib/prisma.js", () => ({ prisma: {}, withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import { upsertBalanceTx } from "./inventory.repository.js";

function fakeTx(resultQuantityOnHand: number) {
  return {
    inventoryBalance: {
      upsert: vi.fn().mockResolvedValue({ id: "bal", irmItemId: "i", warehouseId: "w", quantityOnHand: resultQuantityOnHand, quantityReserved: 0 }),
    },
  };
}

describe("upsertBalanceTx — non-negative on-hand invariant", () => {
  it("returns the balance when the post-change on-hand is positive", async () => {
    const tx = fakeTx(5);
    const r = await upsertBalanceTx(tx as never, "i", "w", -3);
    expect(r.quantityOnHand).toBe(5);
  });

  it("returns the balance when the post-change on-hand is exactly zero", async () => {
    const tx = fakeTx(0);
    const r = await upsertBalanceTx(tx as never, "i", "w", -5);
    expect(r.quantityOnHand).toBe(0);
  });

  it("throws (rolls back) when a decrement would take on-hand below zero", async () => {
    const tx = fakeTx(-2);
    await expect(upsertBalanceTx(tx as never, "i", "w", -10)).rejects.toThrow(/below zero/i);
  });
});
