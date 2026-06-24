import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./irm.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  replaceSuppliers: vi.fn(),
  findBySkuLower: vi.fn(),
  isSkuConflict: vi.fn(),
}));
vi.mock("#modules/irm-type/irm-type.service.js", () => ({ requireActiveIrmType: vi.fn() }));
vi.mock("#modules/irm-category/irm-category.service.js", () => ({ requireActiveIrmCategory: vi.fn() }));
vi.mock("#modules/supplier/supplier.service.js", () => ({ requireActiveSupplier: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getIrmCodePrefix: vi.fn().mockResolvedValue("IRM") }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as irmRepo from "./irm.repository.js";
import * as irmTypeService from "#modules/irm-type/irm-type.service.js";
import * as irmCategoryService from "#modules/irm-category/irm-category.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { deleteIrmItem, updateIrmItem } from "./irm.service.js";

const IRM_ID = "f".repeat(24);
const TYPE_ID = "a".repeat(24);
const NEW_TYPE_ID = "1".repeat(24);
const CAT_ID = "b".repeat(24);
const NEW_CAT_ID = "2".repeat(24);
const SUP_ID = "c".repeat(24);
const NEW_SUP_ID = "4".repeat(24);
const ACTIVE_OWNER = "d".repeat(24);
const INACTIVE_OWNER = "e".repeat(24);
const NEW_OWNER = "3".repeat(24);

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
    conversionRatio: null,
    minimumStock: null,
    reorderLevel: null,
    reorderQuantity: null,
    maximumStock: null,
    safetyStock: null,
    criticalLevel: null,
    standardCostPence: null,
    currency: "GBP",
    vatRatePercent: 20,
    trackInventory: true,
    trackSerialNumbers: false,
    trackBatchNumbers: false,
    allowNegativeStock: false,
    ownerUserId: null,
    owner: null,
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
const mockReqType = irmTypeService.requireActiveIrmType as ReturnType<typeof vi.fn>;
const mockReqCat = irmCategoryService.requireActiveIrmCategory as ReturnType<typeof vi.fn>;
const mockReqSupplier = supplierService.requireActiveSupplier as ReturnType<typeof vi.fn>;
const mockIsSkuConflict = irmRepo.isSkuConflict as ReturnType<typeof vi.fn>;
const mockUserFindById = userRepo.findById as ReturnType<typeof vi.fn>;
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
});

describe("updateIrmItem — owner change handling", () => {
  it("edits other fields when the existing owner is INACTIVE — owner untouched", async () => {
    mockFindById.mockResolvedValue(
      iRow({
        ownerUserId: INACTIVE_OWNER,
        owner: { id: INACTIVE_OWNER, firstName: "Ina", lastName: "Ctive", email: "ina@x.com", status: "inactive", jobTitle: null, role: null },
      }),
    );
    await expect(updateIrmItem(IRM_ID, { name: "CAT6 Cable 305m", ownerUserId: INACTIVE_OWNER })).resolves.toMatchObject({
      name: "CAT6 Cable 305m",
    });
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect("ownerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
    expect(auditActions()).toContain("irm.updated");
  });

  it("assigns a different active owner → owner_assigned", async () => {
    mockFindById.mockResolvedValue(iRow({ ownerUserId: INACTIVE_OWNER }));
    mockUserFindById.mockResolvedValue({ id: NEW_OWNER, status: "active" });
    await updateIrmItem(IRM_ID, { ownerUserId: NEW_OWNER });
    expect(mockUpdate.mock.calls[0][1].ownerUserId).toBe(NEW_OWNER);
    expect(auditActions()).toContain("irm.owner_assigned");
  });

  it("clears the owner → owner_removed", async () => {
    mockFindById.mockResolvedValue(iRow({ ownerUserId: ACTIVE_OWNER }));
    await updateIrmItem(IRM_ID, { ownerUserId: null });
    expect(mockUpdate.mock.calls[0][1].ownerUserId).toBeNull();
    expect(auditActions()).toContain("irm.owner_removed");
  });

  it("rejects assigning an inactive owner", async () => {
    mockFindById.mockResolvedValue(iRow({ ownerUserId: null }));
    mockUserFindById.mockResolvedValue({ id: INACTIVE_OWNER, status: "inactive" });
    await expect(updateIrmItem(IRM_ID, { ownerUserId: INACTIVE_OWNER })).rejects.toThrow(/not an active user/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
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

describe("updateIrmItem — stock policy cross-field (partial PATCH)", () => {
  it("rejects maximumStock below the EXISTING minimumStock when only max is patched", async () => {
    mockFindById.mockResolvedValue(iRow({ minimumStock: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { maximumStock: 50 })).rejects.toThrow(/greater than or equal/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts a max ≥ existing min on a partial PATCH", async () => {
    mockFindById.mockResolvedValue(iRow({ minimumStock: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { maximumStock: 150 })).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("accepts lowering min at/below the existing max", async () => {
    mockFindById.mockResolvedValue(iRow({ minimumStock: 100, maximumStock: 500 }));
    await expect(updateIrmItem(IRM_ID, { minimumStock: 20 })).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe("updateIrmItem — racing SKU conflict (DB P2002)", () => {
  it("maps a P2002 from the write to a friendly 409 conflict, not a 500", async () => {
    mockFindById.mockResolvedValue(iRow());
    mockUpdate.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    mockIsSkuConflict.mockReturnValue(true);
    await expect(updateIrmItem(IRM_ID, { sku: "CAT6-001" })).rejects.toThrow(/already in use/i);
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
});
