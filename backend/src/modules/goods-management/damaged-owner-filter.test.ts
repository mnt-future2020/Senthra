import { beforeEach, describe, expect, it, vi } from "vitest";

// The damaged pool's OWNER switcher.
//
// Two regressions are pinned here:
//
//  1. The pills' counts were derived from the rows on screen — i.e. from the set AFTER `ownerType`
//     had narrowed it. Selecting "Company" therefore reported customer = 0 and rental = 0, and the
//     switcher (which only renders when more than one pool is non-empty) removed itself, leaving the
//     reader inside a filter with no control to leave it by. Counts must span BOTH owned pools
//     whatever is selected.
//
//  2. Asking for "no owned rows" (the reader is looking at the HIRE pool, which comes from a
//     different endpoint) was done by sending a made-up ownerType of `__none__`. A fake enum member
//     is a filter that breaks the moment the real values are validated — and they are validated now.

vi.mock("./goods-management.repository.js", () => ({
  findDamagedByWarehouse: vi.fn(),
  findDamagedByCustomer: vi.fn(),
  findAllDamaged: vi.fn(),
  findLatestDamagedTxnsByBalances: vi.fn(async () => new Map()),
}));

import * as gmRepo from "./goods-management.repository.js";
import { listDamaged } from "./goods-management.service.js";

const WH = "aaaaaaaaaaaaaaaaaaaaaaaa";

const bal = (id: string, ownerType: "company" | "customer", itemName: string) => ({
  id,
  warehouseId: WH,
  warehouse: { name: "Leeds Depot" },
  ownerType,
  irmItemId: ownerType === "company" ? "irm1" : null,
  customerStockEntryId: ownerType === "customer" ? "cse1" : null,
  customerId: ownerType === "customer" ? "cust1" : null,
  itemName,
  quantity: 2,
  updatedAt: new Date("2026-08-31T09:00:00.000Z"),
});

beforeEach(() => {
  vi.mocked(gmRepo.findAllDamaged).mockResolvedValue([
    bal("d1", "company", "Fibre Tester"),
    bal("d2", "company", "Patch Panel"),
    bal("d3", "customer", "Customer SFP"),
  ] as never);
  vi.mocked(gmRepo.findLatestDamagedTxnsByBalances).mockResolvedValue(new Map() as never);
});

describe("counts do not depend on which pool is selected", () => {
  it("reports BOTH pools when nothing is filtered", async () => {
    const { rows, counts } = await listDamaged({});
    expect(rows).toHaveLength(3);
    expect(counts).toEqual({ company: 2, customer: 1 });
  });

  it("still reports BOTH pools when the company pool is selected", async () => {
    const { rows, counts } = await listDamaged({ ownerType: "company" });
    expect(rows.map((r) => r.id)).toEqual(["d1", "d2"]);
    // The regression: this used to be {company: 2, customer: 0}, which unmounted the switcher.
    expect(counts).toEqual({ company: 2, customer: 1 });
  });

  it("still reports BOTH pools when the customer pool is selected", async () => {
    const { rows, counts } = await listDamaged({ ownerType: "customer" });
    expect(rows.map((r) => r.id)).toEqual(["d3"]);
    expect(counts).toEqual({ company: 2, customer: 1 });
  });

  it("reports both pools even when the selected one is EMPTY", async () => {
    vi.mocked(gmRepo.findAllDamaged).mockResolvedValue([bal("d1", "company", "Fibre Tester")] as never);
    const { rows, counts } = await listDamaged({ ownerType: "customer" });
    expect(rows).toHaveLength(0);
    // A zero-result selection must still be able to say what the OTHER pool holds, or there is no
    // way back to it.
    expect(counts).toEqual({ company: 1, customer: 0 });
  });

  it("narrows counts by SEARCH — but still across both pools", async () => {
    const { rows, counts } = await listDamaged({ search: "fibre" });
    expect(rows.map((r) => r.id)).toEqual(["d1"]);
    expect(counts).toEqual({ company: 1, customer: 0 });
  });

  it("search + owner compose, and the counts describe the searched set, not the owned slice", async () => {
    const { rows, counts } = await listDamaged({ search: "e", ownerType: "customer" });
    // "e" matches Fibre Tester, Patch Panel and Customer SFP; the owner narrows the ROWS only.
    expect(rows.map((r) => r.id)).toEqual(["d3"]);
    expect(counts).toEqual({ company: 2, customer: 1 });
  });
});

describe("asking for no owned rows needs no fake ownerType", () => {
  it("countsOnly returns the counts and no rows", async () => {
    const { rows, counts } = await listDamaged({ countsOnly: true });
    expect(rows).toEqual([]);
    // This is what the hire pool needs: a populated switcher without transferring rows it won't draw.
    expect(counts).toEqual({ company: 2, customer: 1 });
  });

  it("REJECTS an unknown ownerType rather than silently matching nothing", async () => {
    // The old `__none__` sentinel relied on this being lenient. It is not.
    await expect(listDamaged({ ownerType: "__none__" })).rejects.toThrow(/invalid owner/i);
    await expect(listDamaged({ ownerType: "rental" })).rejects.toThrow(/invalid owner/i);
  });

  it("treats an empty ownerType as no filter, not as an invalid one", async () => {
    const { rows } = await listDamaged({ ownerType: "" });
    expect(rows).toHaveLength(3);
  });
});
