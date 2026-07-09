import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the service: mock the data-access + side-effect modules so these are pure
// unit tests of updateSupplier's logic (no DB).
vi.mock("./supplier.repository.js", () => ({
  findById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/supplier-type/supplier-type.service.js", () => ({
  requireActiveSupplierType: vi.fn(),
}));
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({ countBySupplier: vi.fn().mockResolvedValue(0) }));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ countBySupplier: vi.fn() }));
vi.mock("#modules/irm/irm.repository.js", () => ({ countBySupplier: vi.fn() }));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({ countBySupplier: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as supplierRepo from "./supplier.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as supplierTypeService from "#modules/supplier-type/supplier-type.service.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { deleteSupplier, updateSupplier } from "./supplier.service.js";

const mockPoCount = poRepo.countBySupplier as ReturnType<typeof vi.fn>;
const mockIrmCount = irmRepo.countBySupplier as ReturnType<typeof vi.fn>;
const mockGrnCount = grnRepo.countBySupplier as ReturnType<typeof vi.fn>;

const SUP_ID = "f".repeat(24);
const ACTIVE_OWNER = "a".repeat(24);
const INACTIVE_OWNER = "b".repeat(24);
const NEW_ACTIVE_OWNER = "c".repeat(24);
const TYPE_ID = "d".repeat(24);
const NEW_TYPE_ID = "e".repeat(24);

function sRow(over: Record<string, unknown> = {}) {
  return {
    id: SUP_ID,
    code: "SUP-0001",
    name: "Corning Ltd",
    legalName: null,
    description: null,
    typeId: TYPE_ID,
    supplierType: { id: TYPE_ID, name: "Manufacturer" },
    status: "active",
    contactPerson: null,
    contactJobTitle: null,
    contactEmail: null,
    contactPhone: null,
    companyRegistrationNumber: null,
    vatNumber: null,
    website: null,
    addressLine1: "1 Fibre Way",
    addressLine2: null,
    city: "Leeds",
    county: null,
    postcode: "LS1 1AB",
    country: "United Kingdom",
    paymentTerms: null,
    customPaymentTerms: null,
    currency: "GBP",
    leadTimeDays: null,
    notes: null,
    ownerUserId: null,
    owner: null,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const mockFindById = supplierRepo.findById as ReturnType<typeof vi.fn>;
const mockUpdate = supplierRepo.update as ReturnType<typeof vi.fn>;
const mockSoftDelete = supplierRepo.softDelete as ReturnType<typeof vi.fn>;
const mockUserFindById = userRepo.findById as ReturnType<typeof vi.fn>;
const mockRequireType = supplierTypeService.requireActiveSupplierType as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

const auditActions = () => mockAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve(sRow(data)),
  );
  // No dependencies by default — each delete-guard test overrides the one it exercises.
  mockPoCount.mockResolvedValue(0);
  mockIrmCount.mockResolvedValue(0);
  mockGrnCount.mockResolvedValue(0);
});

describe("updateSupplier — owner change handling", () => {
  it("edits other fields when the existing owner is INACTIVE — no error, owner untouched", async () => {
    mockFindById.mockResolvedValue(
      sRow({
        ownerUserId: INACTIVE_OWNER,
        owner: { id: INACTIVE_OWNER, firstName: "Ina", lastName: "Ctive", email: "ina@x.com", status: "inactive", jobTitle: null, role: null },
      }),
    );
    await expect(
      updateSupplier(SUP_ID, { name: "Corning UK", ownerUserId: INACTIVE_OWNER }),
    ).resolves.toMatchObject({ name: "Corning UK" });
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect("ownerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
    expect(auditActions()).toContain("supplier.updated");
  });

  it("changes an inactive owner to a different ACTIVE owner → owner_assigned", async () => {
    mockFindById.mockResolvedValue(sRow({ ownerUserId: INACTIVE_OWNER }));
    mockUserFindById.mockResolvedValue({ id: NEW_ACTIVE_OWNER, status: "active" });
    await expect(updateSupplier(SUP_ID, { ownerUserId: NEW_ACTIVE_OWNER })).resolves.toBeTruthy();
    expect(mockUpdate.mock.calls[0][1].ownerUserId).toBe(NEW_ACTIVE_OWNER);
    expect(auditActions()).toContain("supplier.owner_assigned");
  });

  it("clears the owner via the scalar FK → owner_removed", async () => {
    mockFindById.mockResolvedValue(sRow({ ownerUserId: ACTIVE_OWNER }));
    await expect(updateSupplier(SUP_ID, { ownerUserId: null })).resolves.toBeTruthy();
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][1].ownerUserId).toBeNull();
    expect(auditActions()).toContain("supplier.owner_removed");
  });

  it("edits a supplier that has NO owner — succeeds, owner untouched", async () => {
    mockFindById.mockResolvedValue(sRow({ ownerUserId: null }));
    await expect(updateSupplier(SUP_ID, { name: "Renamed", ownerUserId: null })).resolves.toBeTruthy();
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect("ownerUserId" in mockUpdate.mock.calls[0][1]).toBe(false);
  });

  it("rejects assigning an INACTIVE owner", async () => {
    mockFindById.mockResolvedValue(sRow({ ownerUserId: null }));
    mockUserFindById.mockResolvedValue({ id: INACTIVE_OWNER, status: "inactive" });
    await expect(updateSupplier(SUP_ID, { ownerUserId: INACTIVE_OWNER })).rejects.toThrow(
      /not an active user/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("updateSupplier — status / type", () => {
  it("records activated / deactivated on a status transition", async () => {
    mockFindById.mockResolvedValue(sRow({ status: "active" }));
    await updateSupplier(SUP_ID, { status: "inactive" });
    expect(auditActions()).toContain("supplier.deactivated");
    expect(auditActions()).not.toContain("supplier.updated"); // pure status change
  });

  it("validates the type only when it changes", async () => {
    mockFindById.mockResolvedValue(sRow({ typeId: TYPE_ID }));
    // same type → no validation
    await updateSupplier(SUP_ID, { typeId: TYPE_ID });
    expect(mockRequireType).not.toHaveBeenCalled();
    // different type → validated + written
    await updateSupplier(SUP_ID, { typeId: NEW_TYPE_ID });
    expect(mockRequireType).toHaveBeenCalledWith(NEW_TYPE_ID);
    expect(mockUpdate.mock.calls.at(-1)?.[1].typeId).toBe(NEW_TYPE_ID);
  });
});

describe("updateSupplier — payment terms normalisation", () => {
  it("clears the custom text when switching to a non-custom term", async () => {
    mockFindById.mockResolvedValue(sRow({ paymentTerms: "Custom", customPaymentTerms: "Net 10 EOM" }));
    await updateSupplier(SUP_ID, { paymentTerms: "30 Days" });
    expect(mockUpdate.mock.calls[0][1].paymentTerms).toBe("30 Days");
    expect(mockUpdate.mock.calls[0][1].customPaymentTerms).toBeNull();
  });

  it("rejects switching to Custom without the custom text", async () => {
    mockFindById.mockResolvedValue(sRow({ paymentTerms: "30 Days" }));
    await expect(updateSupplier(SUP_ID, { paymentTerms: "Custom" })).rejects.toThrow(
      /custom payment terms/i,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("keeps an existing Custom term when editing an unrelated field", async () => {
    mockFindById.mockResolvedValue(sRow({ paymentTerms: "Custom", customPaymentTerms: "Net 10 EOM" }));
    await expect(updateSupplier(SUP_ID, { name: "Corning UK" })).resolves.toBeTruthy();
    expect(mockUpdate.mock.calls[0][1].paymentTerms).toBeUndefined();
  });

  it("clears payment terms (and any custom text) when explicitly sent null", async () => {
    mockFindById.mockResolvedValue(sRow({ paymentTerms: "Custom", customPaymentTerms: "Net 10 EOM" }));
    await updateSupplier(SUP_ID, { paymentTerms: null });
    expect(mockUpdate.mock.calls[0][1].paymentTerms).toBeNull();
    expect(mockUpdate.mock.calls[0][1].customPaymentTerms).toBeNull();
  });
});

describe("deleteSupplier", () => {
  it("soft-deletes a supplier and records supplier.deleted", async () => {
    mockFindById.mockResolvedValue(sRow());
    await expect(deleteSupplier(SUP_ID)).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith(SUP_ID);
    expect(auditActions()).toContain("supplier.deleted");
  });

  it("throws not found when the supplier does not exist", async () => {
    mockFindById.mockResolvedValue(null);
    await expect(deleteSupplier(SUP_ID)).rejects.toThrow(/not found/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("blocks delete when the supplier is linked to IRM catalogue items", async () => {
    mockFindById.mockResolvedValue(sRow());
    mockIrmCount.mockResolvedValue(2);
    await expect(deleteSupplier(SUP_ID)).rejects.toThrow(/in use/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("blocks delete when the supplier has purchase orders", async () => {
    mockFindById.mockResolvedValue(sRow());
    mockPoCount.mockResolvedValue(1);
    await expect(deleteSupplier(SUP_ID)).rejects.toThrow(/in use/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("blocks delete when the supplier has goods-in receipts", async () => {
    mockFindById.mockResolvedValue(sRow());
    mockGrnCount.mockResolvedValue(3);
    await expect(deleteSupplier(SUP_ID)).rejects.toThrow(/in use/i);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});
