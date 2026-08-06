import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./irm.repository.js", () => ({
  findById: vi.fn(),
  findByIds: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  replaceSuppliers: vi.fn(),
  findBySkuLower: vi.fn(),
  findIdByCode: vi.fn(),
  createWithCode: vi.fn(),
  isSkuConflict: vi.fn(),
}));
vi.mock("#modules/irm-type/irm-type.service.js", () => ({ requireActiveIrmType: vi.fn() }));
vi.mock("#modules/irm-category/irm-category.service.js", () => ({ requireActiveIrmCategory: vi.fn() }));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getIrmCodePrefix: vi.fn().mockResolvedValue("IRM") }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// Deleting an IRM item first asks four other modules whether anything still references it. Those are
// live Prisma calls, so without these stubs the delete tests silently need a running MongoDB — they
// passed only on a machine that happened to have one, and would hang for 5s then fail in CI.
// Default 0 = "nothing depends on it", the deletable case; a test overrides one to assert the guard.
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ countByIrmItem: vi.fn(async () => 0) }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({ countByIrmItem: vi.fn(async () => 0) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ countBalancesWithStockByIrmItem: vi.fn(async () => 0) }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ countEngineerStockWithStockByIrmItem: vi.fn(async () => 0) }));

import * as irmRepo from "./irm.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as irmTypeService from "#modules/irm-type/irm-type.service.js";
import * as irmCategoryService from "#modules/irm-category/irm-category.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as audit from "#modules/audit/audit.service.js";
import { createIrmItem, deleteIrmItem, requireActiveIrmItems, updateIrmItem } from "./irm.service.js";

const IRM_ID = "f".repeat(24);
const TYPE_ID = "a".repeat(24);
const NEW_TYPE_ID = "1".repeat(24);
const CAT_ID = "b".repeat(24);
const NEW_CAT_ID = "2".repeat(24);
const SUP_ID = "c".repeat(24);
const NEW_SUP_ID = "4".repeat(24);

function iRow(over: Record<string, unknown> = {}) {
  return {
    id: IRM_ID,
    code: "IRM-0001",
    name: "CAT6 Cable",
    description: null,
    brand: null,
    manufacturer: null,
    mpn: null,
    typeId: TYPE_ID,
    irmType: { id: TYPE_ID, name: "Consumable" },
    irmCategoryId: CAT_ID,
    irmCategory: { id: CAT_ID, name: "Cable" },
    status: "active",
    sku: null,
    skuLower: null,
    barcode: null,
    qrCode: null,
    suppliers: [],
    baseUnit: "Each",
    packSize: null,
    reorderLevel: null,
    maximumStock: null,
    criticalLevel: null,
    standardCostPence: null,
    currency: "GBP",
    vatRatePercent: 20,
    trackInventory: true,
    trackSerialNumbers: false,
    trackBatchNumbers: false,
    notes: null,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = irmRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = irmRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = irmRepo.softDelete as ReturnType<typeof vi.fn>;
const mockReplaceSuppliers = irmRepo.replaceSuppliers as ReturnType<typeof vi.fn>;
const mockFindBySku = irmRepo.findBySkuLower as ReturnType<typeof vi.fn>;
const mockFindIdByCode = irmRepo.findIdByCode as ReturnType<typeof vi.fn>;
const mockCreate = irmRepo.createWithCode as ReturnType<typeof vi.fn>;
const mockReqType = irmTypeService.requireActiveIrmType as ReturnType<typeof vi.fn>;
const mockReqCat = irmCategoryService.requireActiveIrmCategory as ReturnType<typeof vi.fn>;
const mockReqSupplier = supplierService.requireActiveSupplier as ReturnType<typeof vi.fn>;
const mockIsSkuConflict = irmRepo.isSkuConflict as ReturnType<typeof vi.fn>;
const mockFindByIds = irmRepo.findByIds as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

// Build an existing supplier-junction link (the shape findById returns on existing.suppliers).
function supLink(over: Record<string, unknown> = {}) {
  return {
    id: "link1",
    supplierId: SUP_ID,
    isPrimary: true,
    priority: 0,
    supplierSku: null,
    leadTimeDays: null,
    supplier: { id: SUP_ID, code: "SUP-0001", name: "Acme", status: "active" },
    ...over,
  };
}

const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(iRow(data)));
  mockFindBySku.mockResolvedValue(null);
  // No item owns the SKU as its display code (the ambiguous-scan guard) unless a test says so.
  mockFindIdByCode.mockResolvedValue(null);
  // Re-assert like the counts below: mockReturnValue survives clearAllMocks, so a test that forces
  // "this error IS a SKU conflict" would otherwise relabel every later failure as one.
  mockIsSkuConflict.mockReturnValue(false);
  // Create returns whatever columns it was handed, so a test can assert on the stored SKU.
  mockCreate.mockImplementation((data: Record<string, unknown>) => Promise.resolve(iRow(data)));
  mockReqCat.mockResolvedValue({ id: CAT_ID, name: "Cable", status: "active" });
  // Re-assert "nothing depends on this item". clearAllMocks wipes call history but NOT a
  // mockResolvedValue, so without this the guard test below would leak its non-zero count into
  // whatever ran next and delete would start refusing for no visible reason.
  vi.mocked(poRepo.countByIrmItem).mockResolvedValue(0);
  vi.mocked(inventoryRepo.countBalancesWithStockByIrmItem).mockResolvedValue(0);
});

describe("updateIrmItem — type / category / cost", () => {
  it("validates the type only when it changes", async () => {
    mockFindById.mockResolvedValue(iRow({ typeId: TYPE_ID }));
    await updateIrmItem(IRM_ID, { typeId: TYPE_ID });
    expect(mockReqType).not.toHaveBeenCalled();
    await updateIrmItem(IRM_ID, { typeId: NEW_TYPE_ID });
    expect(mockReqType).toHaveBeenCalledWith(NEW_TYPE_ID);
  });

  it("validates the category only when it changes", async () => {
    mockFindById.mockResolvedValue(iRow({ irmCategoryId: CAT_ID }));
    await updateIrmItem(IRM_ID, { irmCategoryId: CAT_ID });
    expect(mockReqCat).not.toHaveBeenCalled();
    await updateIrmItem(IRM_ID, { irmCategoryId: NEW_CAT_ID });
    expect(mockReqCat).toHaveBeenCalledWith(NEW_CAT_ID);
  });

  it("converts standard cost pounds → pence", async () => {
    mockFindById.mockResolvedValue(iRow());
    await updateIrmItem(IRM_ID, { standardCost: 12.34 });
    expect(mockUpdate.mock.calls[0][1].standardCostPence).toBe(1234);
  });
});

describe("updateIrmItem — SKU global-forever uniqueness", () => {
  it("rejects a SKU already used by another (even soft-deleted) item", async () => {
    mockFindById.mockResolvedValue(iRow());
    mockFindBySku.mockResolvedValue({ id: "other".padEnd(24, "0") });
    await expect(updateIrmItem(IRM_ID, { sku: "CAT6-001" })).rejects.toThrow(/never reused/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts a SKU still owned by the same item", async () => {
    mockFindById.mockResolvedValue(iRow());
    mockFindBySku.mockResolvedValue({ id: IRM_ID });
    await updateIrmItem(IRM_ID, { sku: "CAT6-001" });
    expect(mockUpdate.mock.calls[0][1].sku).toBe("CAT6-001");
    expect(mockUpdate.mock.calls[0][1].skuLower).toBe("cat6-001");
  });
});

describe("updateIrmItem — suppliers reconcile", () => {
  it("validates active + replaces the junction when suppliers change", async () => {
    mockFindById.mockResolvedValue(iRow({ suppliers: [] }));
    await updateIrmItem(IRM_ID, { suppliers: [{ supplierId: SUP_ID, isPrimary: true }] });
    expect(mockReqSupplier).toHaveBeenCalledWith(SUP_ID);
    expect(mockReplaceSuppliers).toHaveBeenCalledWith(IRM_ID, [
      { supplierId: SUP_ID, isPrimary: true, priority: 0, supplierSku: null, leadTimeDays: null },
    ]);
    expect(auditActions()).toContain("irm.updated");
  });

  it("edits other fields when an already-linked supplier is INACTIVE — link preserved, no active re-check", async () => {
    // The edit form always resends the full supplier set; the linked supplier has since
    // gone inactive. Editing the name must still succeed (mirror of the owner pattern).
    mockFindById.mockResolvedValue(
      iRow({ suppliers: [supLink({ supplier: { id: SUP_ID, code: "SUP-0001", name: "Acme", status: "inactive" } })] }),
    );
    await expect(
      updateIrmItem(IRM_ID, { name: "CAT6 Cable 305m", suppliers: [{ supplierId: SUP_ID, isPrimary: true }] }),
    ).resolves.toMatchObject({ name: "CAT6 Cable 305m" });
    expect(mockReqSupplier).not.toHaveBeenCalled(); // preserved → not re-validated
    expect(mockReplaceSuppliers).not.toHaveBeenCalled(); // unchanged set
    expect(auditActions()).toContain("irm.updated");
  });

  it("requires only a NEWLY-added supplier to be active (keeps the existing one)", async () => {
    mockFindById.mockResolvedValue(iRow({ suppliers: [supLink()] }));
    await updateIrmItem(IRM_ID, {
      suppliers: [
        { supplierId: SUP_ID, isPrimary: true },
        { supplierId: NEW_SUP_ID, isPrimary: false },
      ],
    });
    expect(mockReqSupplier).toHaveBeenCalledWith(NEW_SUP_ID);
    expect(mockReqSupplier).not.toHaveBeenCalledWith(SUP_ID);
    expect(mockReplaceSuppliers).toHaveBeenCalled();
  });

  it("rejects adding a NEW inactive supplier", async () => {
    mockFindById.mockResolvedValue(iRow({ suppliers: [supLink()] }));
    mockReqSupplier.mockImplementation((id: string) =>
      id === NEW_SUP_ID ? Promise.reject(new Error("Selected supplier is inactive and can't be used.")) : Promise.resolve({}),
    );
    await expect(
      updateIrmItem(IRM_ID, {
        suppliers: [
          { supplierId: SUP_ID, isPrimary: true },
          { supplierId: NEW_SUP_ID, isPrimary: false },
        ],
      }),
    ).rejects.toThrow(/inactive/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// The three thresholds must stack: critical ≤ reorder ≤ maximum. A PATCH may send only one of a
// pair, so the guard runs on the MERGED record — the zod refine only ever sees the request, and a
// request that lowers max alone would otherwise sail past a stored reorder level it now sits under.
// These used to compare max against `minimumStock`, a field the reorder engine never read.
//
// Each rule is scoped to requests that TOUCH one of its two fields, so a pre-existing violation can
// never block an edit to something else — see the two legacy-row cases at the end.
describe("updateIrmItem — stock policy cross-field (partial PATCH)", () => {
  it("rejects a maximum below the EXISTING reorder level when only max is patched", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { maximumStock: 50 })).rejects.toThrow(/greater than or equal to the reorder level/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts a maximum at or above the existing reorder level", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { maximumStock: 150 })).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("accepts lowering the reorder level under the existing maximum", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { reorderLevel: 20 })).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  // Critical is the MORE urgent line, so it sits at or below the trigger. Above it, the row would be
  // flagged critical before it was even due to be reordered.
  it("rejects a critical level above the EXISTING reorder level", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { criticalLevel: 150 })).rejects.toThrow(/at or below the reorder level/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // Chain closure on the merged record: with no stored reorder level, the two rules above cannot
  // fire, so this pair is the only thing keeping the numbers in order.
  it("rejects a critical level above the maximum when the item has NO reorder level", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: null, maximumStock: 50 }));
    await expect(updateIrmItem(IRM_ID, { criticalLevel: 200 })).rejects.toThrow(/at or below the maximum stock/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts a critical level at or below the reorder level", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { criticalLevel: 100 })).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  // Rows predating these rules can already violate them — nothing enforced max ≥ reorder before, and
  // criticalLevel had no rule at all. Renaming such an item must not fail with a 400 about stock
  // policy the request never mentioned; the form has no way to show or clear that error.
  it("lets an UNRELATED edit through on a legacy row that violates both rules", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 40, criticalLevel: 150 }));
    await expect(updateIrmItem(IRM_ID, { name: "CAT6 Cable 305m" })).resolves.toMatchObject({
      name: "CAT6 Cable 305m",
    });
    expect(mockUpdate).toHaveBeenCalled();
  });

  // …but touching either half of a pair means you own it, and the merged check applies in full.
  it("still rejects when a legacy row's own bad pair is patched", async () => {
    mockFindById.mockResolvedValue(iRow({ reorderLevel: 100, maximumStock: 40, criticalLevel: 150 }));
    await expect(updateIrmItem(IRM_ID, { reorderLevel: 90 })).rejects.toThrow(/greater than or equal to the reorder level/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("updateIrmItem — racing SKU conflict (DB P2002)", () => {
  it("maps a P2002 from the write to a friendly 409 conflict, not a 500", async () => {
    mockFindById.mockResolvedValue(iRow());
    mockUpdate.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    mockIsSkuConflict.mockReturnValue(true);
    // Quotes the value the write attempted, not the raw request field — someone who typed
    // "cat6 001" is looking at CAT6-001 on screen and must be told about that one.
    await expect(updateIrmItem(IRM_ID, { sku: "cat6 001" })).rejects.toThrow(
      /SKU "CAT6-001" is already in use/i,
    );
  });
});

describe("updateIrmItem — status", () => {
  it("records deactivated on a status transition", async () => {
    mockFindById.mockResolvedValue(iRow({ status: "active" }));
    await updateIrmItem(IRM_ID, { status: "inactive" });
    expect(auditActions()).toContain("irm.deactivated");
  });
});

describe("deleteIrmItem", () => {
  it("soft-deletes and records irm.deleted", async () => {
    mockFindById.mockResolvedValue(iRow());
    await expect(deleteIrmItem(IRM_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(IRM_ID);
    expect(auditActions()).toContain("irm.deleted");
  });

  it("throws not found when the item does not exist", async () => {
    mockFindById.mockResolvedValue(null);
    await expect(deleteIrmItem(IRM_ID)).rejects.toThrow(/not found/i);
  });

  // The dependency guard had no coverage at all — only the happy path was tested, so a checker that
  // stopped being consulted would not have failed anything. Deleting an item still referenced by a PO
  // or still holding stock orphans those records, which is exactly what this guard exists to prevent.
  it("REFUSES the delete when a purchase order still references the item", async () => {
    mockFindById.mockResolvedValue(iRow());
    vi.mocked(poRepo.countByIrmItem).mockResolvedValue(1);
    await expect(deleteIrmItem(IRM_ID)).rejects.toThrow(/in use/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("REFUSES the delete when stock is still on hand", async () => {
    mockFindById.mockResolvedValue(iRow());
    vi.mocked(inventoryRepo.countBalancesWithStockByIrmItem).mockResolvedValue(4);
    await expect(deleteIrmItem(IRM_ID)).rejects.toThrow(/in use/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});

describe("requireActiveIrmItems — batched active-item validation", () => {
  const ID_A = "a".repeat(24);
  const ID_B = "b".repeat(24);
  const active = (id: string) => ({ id, name: `Item ${id[0]}`, status: "active" });

  it("fetches every id in ONE query and returns a Map keyed by id", async () => {
    mockFindByIds.mockResolvedValue([active(ID_A), active(ID_B)]);
    const byId = await requireActiveIrmItems([ID_A, ID_B]);
    expect(mockFindByIds).toHaveBeenCalledTimes(1);
    expect(mockFindByIds).toHaveBeenCalledWith([ID_A, ID_B]);
    expect(byId.get(ID_A)?.name).toBe("Item a");
    expect(byId.get(ID_B)?.name).toBe("Item b");
  });

  it("de-duplicates repeated ids before the query", async () => {
    mockFindByIds.mockResolvedValue([active(ID_A)]);
    await requireActiveIrmItems([ID_A, ID_A]);
    expect(mockFindByIds).toHaveBeenCalledWith([ID_A]);
  });

  it("rejects a malformed (non-ObjectId) id up front, before any query", async () => {
    await expect(requireActiveIrmItems([ID_A, "not-an-id"])).rejects.toThrow(/select an irm item/i);
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it("throws 'no longer exists' when an id is missing from the result (soft-deleted / gone)", async () => {
    mockFindByIds.mockResolvedValue([active(ID_A)]); // ID_B absent
    await expect(requireActiveIrmItems([ID_A, ID_B])).rejects.toThrow(/no longer exists/i);
  });

  it("throws 'inactive' when any returned item is not active", async () => {
    mockFindByIds.mockResolvedValue([active(ID_A), { id: ID_B, name: "Retired", status: "inactive" }]);
    await expect(requireActiveIrmItems([ID_A, ID_B])).rejects.toThrow(/inactive/i);
  });

  it("returns an empty Map for an empty input", async () => {
    mockFindByIds.mockResolvedValue([]);
    const byId = await requireActiveIrmItems([]);
    expect(byId.size).toBe(0);
  });
});

// The item form fills the SKU in as you type, so a blank one usually only reaches here from an API
// client — but "every IRM item has a SKU" has to hold without trusting the caller to cooperate.
describe("createIrmItem — SKU generation", () => {
  const baseInput = {
    name: "Cat6 U/UTP Cable 305m Box",
    typeId: TYPE_ID,
    irmCategoryId: CAT_ID,
    baseUnit: "Each",
  } as never;

  it("generates from the name + category when none is supplied", async () => {
    await createIrmItem(baseInput);
    expect(mockCreate.mock.calls[0][0].sku).toBe("CAB-CAT6-U-UTP-CABLE-305M");
    expect(mockCreate.mock.calls[0][0].skuLower).toBe("cab-cat6-u-utp-cable-305m");
  });

  it("suffixes past a generated SKU that is already taken", async () => {
    // First candidate owned by someone else, the -2 variant free.
    mockFindBySku.mockImplementation((skuLower: string) =>
      Promise.resolve(skuLower === "cab-cat6-u-utp-cable-305m" ? { id: "other".padEnd(24, "0") } : null),
    );
    await createIrmItem(baseInput);
    expect(mockCreate.mock.calls[0][0].sku).toBe("CAB-CAT6-U-UTP-CABLE-305M-2");
  });

  it("normalizes a supplied SKU into the canonical shape", async () => {
    await createIrmItem({ ...(baseInput as object), sku: "fbr-sm12- g652d" } as never);
    expect(mockCreate.mock.calls[0][0].sku).toBe("FBR-SM12-G652D");
  });

  it("generates rather than storing null when the supplied SKU normalizes to nothing", async () => {
    await createIrmItem({ ...(baseInput as object), sku: "###" } as never);
    expect(mockCreate.mock.calls[0][0].sku).toBe("CAB-CAT6-U-UTP-CABLE-305M");
  });

  it("falls back to an IRM prefix when the category name yields no letters", async () => {
    mockReqCat.mockResolvedValue({ id: CAT_ID, name: "---", status: "active" });
    await createIrmItem(baseInput);
    expect(mockCreate.mock.calls[0][0].sku).toBe("IRM-CAT6-U-UTP-CABLE-305M");
  });
});

// A SKU that equals an item CODE makes the goods/van-stock scan ambiguous: findActiveByCodeOrBarcode
// matches one row on `code` and another on `skuLower`, then findFirst picks whichever comes back
// first. Both the already-issued codes and the shape of future ones are refused.
describe("SKU vs item code collisions", () => {
  it("rejects a SKU already owned by another item as its display code", async () => {
    mockFindById.mockResolvedValue(iRow());
    mockFindIdByCode.mockResolvedValue({ id: "other".padEnd(24, "0") });
    await expect(updateIrmItem(IRM_ID, { sku: "IRS-0006" })).rejects.toThrow(/already in use/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a SKU shaped like a FUTURE item code, before that code is ever issued", async () => {
    mockFindById.mockResolvedValue(iRow());
    await expect(updateIrmItem(IRM_ID, { sku: "IRM-0042" })).rejects.toThrow(/shape of an item code/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows a code-like SKU under a different prefix — the rule is not a blanket ban on digits", async () => {
    mockFindById.mockResolvedValue(iRow());
    await updateIrmItem(IRM_ID, { sku: "CAB-0042" });
    expect(mockUpdate.mock.calls[0][1].sku).toBe("CAB-0042");
  });
});

describe("updateIrmItem — SKU is required and never clearable", () => {
  it("refuses to clear the SKU", async () => {
    mockFindById.mockResolvedValue(iRow({ sku: "CAB-CAT6", skuLower: "cab-cat6" }));
    await expect(updateIrmItem(IRM_ID, { sku: "   " })).rejects.toThrow(/SKU is required/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips the uniqueness lookups entirely when the SKU is unchanged", async () => {
    mockFindById.mockResolvedValue(iRow({ sku: "CAB-CAT6", skuLower: "cab-cat6" }));
    await updateIrmItem(IRM_ID, { sku: "CAB-CAT6", name: "Renamed" });
    expect(mockFindBySku).not.toHaveBeenCalled();
    expect(mockFindIdByCode).not.toHaveBeenCalled();
    expect("sku" in mockUpdate.mock.calls[0][1]).toBe(false);
  });

  it("treats a re-sent SKU that only differs by formatting as unchanged, not a rename", async () => {
    // Legacy rows carry values like 'FBR-SM12- G652D'. Normalizing on the way in means the edit form
    // handing that string straight back doesn't burn the old SKU on an unrelated save.
    mockFindById.mockResolvedValue(iRow({ sku: "FBR-SM12-G652D", skuLower: "fbr-sm12-g652d" }));
    await updateIrmItem(IRM_ID, { sku: "FBR-SM12- G652D" });
    expect(mockFindBySku).not.toHaveBeenCalled();
    expect("sku" in mockUpdate.mock.calls[0][1]).toBe(false);
  });
});

// The pre-check and the write are not atomic, so a concurrent create can take the SKU in between and
// the partial unique index rejects the second one. Who chose the SKU decides what happens next.
describe("racing SKU conflict (DB P2002) — create", () => {
  const baseInput = {
    name: "Cat6 U/UTP Cable 305m Box",
    typeId: TYPE_ID,
    irmCategoryId: CAT_ID,
    baseUnit: "Each",
  } as never;

  it("re-derives a GENERATED SKU onto the next suffix instead of failing the caller", async () => {
    mockIsSkuConflict.mockReturnValue(true);
    mockCreate.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    // Model the race in the right ORDER: the base candidate is free when resolveSku first checks,
    // and only taken once the first write has been attempted. Marking it taken up front would let
    // the very first attempt pick -2 and the test would pass without the retry advancing anything.
    mockFindBySku.mockImplementation((skuLower: string) =>
      Promise.resolve(
        mockCreate.mock.calls.length > 0 && skuLower === "cab-cat6-u-utp-cable-305m"
          ? { id: "other".padEnd(24, "0") }
          : null,
      ),
    );

    await createIrmItem(baseInput);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].sku).toBe("CAB-CAT6-U-UTP-CABLE-305M");
    expect(mockCreate.mock.calls[1][0].sku).toBe("CAB-CAT6-U-UTP-CABLE-305M-2");
  });

  it("does NOT rename a SKU the caller typed — it reports the clash instead", async () => {
    mockIsSkuConflict.mockReturnValue(true);
    mockCreate.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    await expect(createIrmItem({ ...(baseInput as object), sku: "CAT6-305-BOX" } as never)).rejects.toThrow(
      /"CAT6-305-BOX" is already in use/i,
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than looping when every retry also races", async () => {
    mockIsSkuConflict.mockReturnValue(true);
    mockCreate.mockRejectedValue(new Error("E11000 duplicate key"));
    await expect(createIrmItem(baseInput)).rejects.toThrow(/already in use/i);
    // Initial attempt + SKU_RACE_RETRIES.
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("names the SKU it actually tried, never an empty string", async () => {
    mockIsSkuConflict.mockReturnValue(true);
    mockCreate.mockRejectedValue(new Error("E11000 duplicate key"));
    // No sku supplied: the old message quoted input.sku and read `SKU "" is already in use`.
    await expect(createIrmItem(baseInput)).rejects.toThrow(/SKU "CAB-CAT6-U-UTP-CABLE-305M/);
  });
});
