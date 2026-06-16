import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./inventory.repository.js", () => ({
  upsertBalanceTx: vi.fn(),
  insertTransactionTx: vi.fn(),
  findBalance: vi.fn(),
  listBalances: vi.fn(),
  listTransactions: vi.fn(),
}));

import * as inventoryRepo from "./inventory.repository.js";
import { applyInbound } from "./inventory.service.js";

const IRM_ID = "c".repeat(24);
const WH_ID = "d".repeat(24);
const GRN_ID = "e".repeat(24);
const tx = {} as never;

const mockUpsert = inventoryRepo.upsertBalanceTx as ReturnType<typeof vi.fn>;
const mockInsert = inventoryRepo.insertTransactionTx as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyInbound", () => {
  it("upserts the balance and appends an immutable ledger row with the post-apply snapshot", async () => {
    mockUpsert.mockResolvedValue({ quantityOnHand: 25 });
    await applyInbound(tx, { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 5, sourceType: "goods_receipt", sourceId: GRN_ID, sourceCode: "GRN-0001", createdBy: "wh@x.com" });

    expect(mockUpsert).toHaveBeenCalledWith(tx, IRM_ID, WH_ID, 5);
    const ledger = mockInsert.mock.calls[0][1];
    expect(ledger).toMatchObject({
      irmItemId: IRM_ID,
      warehouseId: WH_ID,
      quantityDelta: 5,
      type: "goods_in",
      sourceType: "goods_receipt",
      sourceId: GRN_ID,
      sourceCode: "GRN-0001",
      balanceAfter: 25,
      createdBy: "wh@x.com",
    });
  });

  it("is a no-op for a zero / negative quantity (e.g. a fully-damaged line)", async () => {
    await applyInbound(tx, { irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 0, sourceType: "goods_receipt", sourceId: GRN_ID });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
