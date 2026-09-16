import type { PurchaseOrderCustomField } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./poCustomField.repository.js", () => ({
  findMany: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setSortOrders: vi.fn(),
  isLabelConflict: vi.fn(() => false),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as repo from "./poCustomField.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import {
  createCustomField,
  listCustomFields,
  reorderCustomFields,
  resolveCustomFieldValues,
  updateCustomField,
} from "./poCustomField.service.js";

const F1 = "1".repeat(24);
const F2 = "2".repeat(24);
const F3 = "3".repeat(24);
const actor = { type: "user" as const, id: "u1", email: "admin@x.co", permissions: ["settings.manage"] };

function row(id: string, over: Partial<PurchaseOrderCustomField> = {}): PurchaseOrderCustomField {
  const label = over.label ?? `Field ${id[0]}`;
  return {
    id,
    label,
    labelLower: label.toLowerCase(),
    type: "text",
    active: true,
    printOnPdf: true,
    sortOrder: Number(id[0]),
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

const mockFindMany = vi.mocked(repo.findMany);
const mockFindById = vi.mocked(repo.findById);
const mockCreate = vi.mocked(repo.create);
const mockUpdate = vi.mocked(repo.update);
const mockSetSortOrders = vi.mocked(repo.setSortOrders);
const mockAudit = vi.mocked(audit.record);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([row(F1), row(F2)]);
  mockCreate.mockImplementation(async (data) => row(F3, { ...(data as Partial<PurchaseOrderCustomField>) }));
  mockUpdate.mockImplementation(async (id, data) => row(id, data as Partial<PurchaseOrderCustomField>));
});

describe("listCustomFields", () => {
  it("returns every definition, active and inactive, in display order", async () => {
    mockFindMany.mockResolvedValue([row(F1), row(F2, { active: false })]);
    const out = await listCustomFields();
    expect(out.map((f) => [f.id, f.active])).toEqual([
      [F1, true],
      [F2, false],
    ]);
    expect(out[0]).toMatchObject({ type: "text", printOnPdf: true });
  });
});

describe("createCustomField", () => {
  it("adds an active text field at the end of the list, printing by default, and audits it", async () => {
    const out = await createCustomField({ label: "Cost centre" }, actor);
    expect(mockCreate).toHaveBeenCalledWith({
      label: "Cost centre",
      type: "text",
      active: true,
      printOnPdf: true,
      sortOrder: 3, // after F1 (1) and F2 (2)
      createdBy: "admin@x.co",
      updatedBy: "admin@x.co",
    });
    expect(out.label).toBe("Cost centre");
    expect(mockAudit.mock.calls[0]![0]).toMatchObject({ action: "purchase_order_custom_field.created" });
  });

  it("honours an explicit 'do not print'", async () => {
    await createCustomField({ label: "Internal ref", printOnPdf: false });
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ printOnPdf: false });
  });

  it("refuses a name that already exists, ignoring case", async () => {
    await expect(createCustomField({ label: "field 1" })).rejects.toThrow(/already exists\./);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("points at reactivation when the clashing field is inactive", async () => {
    mockFindMany.mockResolvedValue([row(F1, { label: "Cost centre", active: false })]);
    await expect(createCustomField({ label: "COST CENTRE" })).rejects.toThrow(/reactivate it instead/);
  });

  it("refuses a 21st active field, but inactive ones do not count", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => row(i.toString(16).padStart(24, "a"), { label: `F${i}` }));
    mockFindMany.mockResolvedValue(twenty);
    await expect(createCustomField({ label: "One more" })).rejects.toThrow(/up to 20 active/);

    mockFindMany.mockResolvedValue(twenty.map((f, i) => (i === 0 ? { ...f, active: false } : f)));
    await expect(createCustomField({ label: "One more" })).resolves.toMatchObject({ label: "One more" });
  });
});

describe("updateCustomField", () => {
  it("renames an active field and records the rename", async () => {
    mockFindById.mockResolvedValue(row(F1, { label: "Cost center" }));
    const out = await updateCustomField(F1, { label: "Cost centre" }, actor);
    expect(mockUpdate).toHaveBeenCalledWith(F1, { updatedBy: "admin@x.co", label: "Cost centre" });
    expect(out.label).toBe("Cost centre");
    expect(mockAudit.mock.calls[0]![0].metadata).toEqual({
      changes: [{ field: "label", from: "Cost center", to: "Cost centre", label: "Name: Cost center → Cost centre" }],
    });
  });

  it("refuses to rename an inactive field — but allows it together with reactivation", async () => {
    mockFindById.mockResolvedValue(row(F1, { active: false }));
    await expect(updateCustomField(F1, { label: "New" })).rejects.toThrow(/Reactivate this field before renaming/);
    expect(mockUpdate).not.toHaveBeenCalled();

    await updateCustomField(F1, { label: "New", active: true });
    expect(mockUpdate).toHaveBeenCalledWith(F1, expect.objectContaining({ label: "New", active: true }));
  });

  it("refuses a rename onto another field's name", async () => {
    mockFindById.mockResolvedValue(row(F1));
    await expect(updateCustomField(F1, { label: "FIELD 2" })).rejects.toThrow(/already exists/);
  });

  it("deactivates without touching the name, and says so in the audit", async () => {
    mockFindById.mockResolvedValue(row(F1));
    await updateCustomField(F1, { active: false }, actor);
    expect(mockUpdate).toHaveBeenCalledWith(F1, { updatedBy: "admin@x.co", active: false });
    expect(mockAudit.mock.calls[0]![0].metadata).toMatchObject({ changes: [{ field: "active", label: "Deactivated" }] });
  });

  it("refuses to reactivate past the active cap", async () => {
    mockFindById.mockResolvedValue(row(F1, { active: false }));
    mockFindMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => row(i.toString(16).padStart(24, "b"), { label: `F${i}` })));
    await expect(updateCustomField(F1, { active: true })).rejects.toThrow(/up to 20 active/);
  });

  it("switches printing on the PDF off", async () => {
    mockFindById.mockResolvedValue(row(F1));
    await updateCustomField(F1, { printOnPdf: false });
    expect(mockUpdate).toHaveBeenCalledWith(F1, { updatedBy: null, printOnPdf: false });
  });

  it("answers 404 for an unknown or malformed id — and never queries with a malformed one", async () => {
    mockFindById.mockResolvedValue(null);
    await expect(updateCustomField(F3, { active: false })).rejects.toThrow(/not found/i);
    mockFindById.mockClear();
    await expect(updateCustomField("not-an-id", { active: false })).rejects.toThrow(/not found/i);
    expect(mockFindById).not.toHaveBeenCalled();
  });
});

describe("reorderCustomFields", () => {
  it("writes the complete new order and returns the list", async () => {
    await reorderCustomFields([F2, F1], actor);
    expect(mockSetSortOrders).toHaveBeenCalledWith([F2, F1], "admin@x.co");
    expect(mockAudit.mock.calls[0]![0]).toMatchObject({ action: "purchase_order_custom_field.reordered" });
  });

  it.each([[[F1]], [[F1, F3]], [[F1, F2, F3]]])("refuses a list that is not the current one (%j)", async (ids) => {
    await expect(reorderCustomFields(ids)).rejects.toThrow(/changed while you were reordering/);
    expect(mockSetSortOrders).not.toHaveBeenCalled();
  });
});

describe("resolveCustomFieldValues", () => {
  it("costs no read when the body carries no values", async () => {
    const stored = [{ fieldId: F1, label: "Field 1", value: "v", printOnPdf: true }];
    await expect(resolveCustomFieldValues(stored, {})).resolves.toBe(stored);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("merges the body onto the stored values against the live definitions", async () => {
    mockFindMany.mockResolvedValue([row(F1, { label: "Cost centre" }), row(F2, { printOnPdf: false })]);
    await expect(resolveCustomFieldValues([], { [F1]: " CC-42 ", [F2]: "Dana" })).resolves.toEqual([
      { fieldId: F1, label: "Cost centre", value: "CC-42", printOnPdf: true },
      { fieldId: F2, label: "Field 2", value: "Dana", printOnPdf: false },
    ]);
  });
});
