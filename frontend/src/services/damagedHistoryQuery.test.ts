import { beforeEach, describe, expect, it, vi } from "vitest";

// The damaged-history request is addressed by a balance's NATURAL KEY, not by an id — and which id
// is the key depends on ownerType. Sending the wrong socket doesn't fail loudly: a company row is
// stored with customerStockEntryId = null (and vice versa), so a request carrying both would match
// no balance at all and 404 on a row the user is looking straight at. These tests pin the mapping.
vi.mock("@/lib/api", () => ({ api: vi.fn().mockResolvedValue({ entries: [] }) }));

import { api } from "@/lib/api";
import { getDamagedHistory } from "./goodsManagement.service";

const mockApi = api as ReturnType<typeof vi.fn>;
const urlOf = () => new URL(String(mockApi.mock.calls[0]?.[0]), "http://x");

describe("getDamagedHistory — request shape", () => {
  beforeEach(() => {
    mockApi.mockClear();
  });

  it("sends irmItemId for a company row and omits the customer socket", async () => {
    await getDamagedHistory({
      warehouseId: "wh1",
      ownerType: "company",
      irmItemId: "irm1",
      customerStockEntryId: null,
    });
    const q = urlOf().searchParams;
    expect(q.get("warehouseId")).toBe("wh1");
    expect(q.get("ownerType")).toBe("company");
    expect(q.get("irmItemId")).toBe("irm1");
    expect(q.has("customerStockEntryId")).toBe(false);
  });

  it("sends customerStockEntryId for a customer row and omits the IRM socket", async () => {
    await getDamagedHistory({
      warehouseId: "wh1",
      ownerType: "customer",
      irmItemId: null,
      customerStockEntryId: "cse1",
    });
    const q = urlOf().searchParams;
    expect(q.get("ownerType")).toBe("customer");
    expect(q.get("customerStockEntryId")).toBe("cse1");
    expect(q.has("irmItemId")).toBe(false);
  });

  it("never sends the OTHER owner type's id, even when the row carries both", async () => {
    // Defensive: a row that somehow carries both ids must still produce a single-socket key,
    // because the balance it points at has exactly one of them set.
    await getDamagedHistory({
      warehouseId: "wh1",
      ownerType: "company",
      irmItemId: "irm1",
      customerStockEntryId: "cse1",
    });
    const q = urlOf().searchParams;
    expect(q.get("irmItemId")).toBe("irm1");
    expect(q.has("customerStockEntryId")).toBe(false);
  });

  it("targets the damaged-history endpoint", async () => {
    await getDamagedHistory({
      warehouseId: "wh1",
      ownerType: "company",
      irmItemId: "irm1",
      customerStockEntryId: null,
    });
    expect(urlOf().pathname).toBe("/goods-management/damaged/history");
  });
});
