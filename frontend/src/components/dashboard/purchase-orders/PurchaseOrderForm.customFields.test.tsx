// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byLabel, byText, cleanup, click, render, wait } from "@/test/dom";
import type { PoCustomFieldDefinition, PurchaseOrder } from "@/types/purchase-order";

// The PO form's ADDITIONAL INFORMATION section — additive only. Every existing field, required marker
// and validation rule must behave exactly as before.
const h = vi.hoisted(() => ({
  listDefs: vi.fn(),
  update: vi.fn(),
  createSplit: vi.fn(),
  replace: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => p === "purchase_orders.edit" }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: h.toast }) }));
vi.mock("@/hooks/useReferenceData", () => ({ useReferenceData: () => ({ isLoading: false }) }));
vi.mock("@/hooks/useRentalItemsByIds", () => ({ useRentalItemsByIds: () => false }));
vi.mock("@/providers/NavigationGuardProvider", () => ({
  useReportDirty: () => {},
  useNavigationGuard: () => ({ attemptLeave: (fn: () => void) => fn() }),
}));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/components/dashboard/irm/IrmItemPicker", () => ({ IrmItemPicker: () => null }));
vi.mock("@/components/dashboard/purchase-requests/RentalLinesEditor", () => ({ RentalLinesEditor: () => null }));
vi.mock("@/components/ui/PaymentTermsField", () => ({ PaymentTermsField: () => null }));
vi.mock("@/services/purchase-order.service", async (orig) => ({
  ...(await orig<object>()),
  listPoCustomFields: h.listDefs,
  updatePurchaseOrder: h.update,
  createPurchaseOrdersSplit: h.createSplit,
}));

import { PurchaseOrderForm } from "./PurchaseOrderForm";

const SUP = "a".repeat(24);
const WH = "b".repeat(24);
const IRM = "c".repeat(24);
const CF_ACTIVE = "1".repeat(24);
const CF_INTERNAL = "2".repeat(24);
const CF_RETIRED = "3".repeat(24);

const def = (id: string, label: string, over: Partial<PoCustomFieldDefinition> = {}): PoCustomFieldDefinition => ({
  id,
  label,
  type: "text",
  active: true,
  printOnPdf: true,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const draft = (over: Partial<PurchaseOrder> = {}) =>
  ({
    id: "f".repeat(24),
    code: "PO-0007",
    status: "draft",
    supplierId: SUP,
    supplierName: "Acme",
    supplier: { id: SUP, code: "SUP-1", name: "Acme", contactPerson: null, contactEmail: null, contactPhone: null, paymentTerms: null, currency: "GBP", leadTimeDays: null },
    warehouseId: WH,
    warehouse: { id: WH, code: "WH-1", name: "Leeds", address: null },
    orderDate: "2026-09-01T00:00:00.000Z",
    expectedDeliveryDate: "2026-09-10T00:00:00.000Z",
    referenceNumber: "REF-1",
    priority: "normal",
    jobId: null,
    projectRef: "PROJ-1",
    description: "Cabling",
    deliveryAddress: null,
    deliveryInstructions: null,
    deliveryTerms: null,
    paymentTerms: "30 Days",
    internalNotes: null,
    supplierNotes: null,
    items: [{ id: "l1", irmItemId: IRM, itemName: "CAT6", sku: null, baseUnit: "Each", quantity: 10, unitPricePence: 500, unitPrice: 5, vatRate: 20, lineTotalPence: 5000, lineTotal: 50, receivedQuantity: 0, notes: null, irmItem: { id: IRM, code: "IRM-1", name: "CAT6", status: "active" } }],
    rentalItems: [],
    customFields: [],
    ...over,
  }) as unknown as PurchaseOrder;

async function typeInto(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const buttonByText = (t: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === t);
const labelTexts = () => Array.from(document.querySelectorAll("label")).map((l) => l.textContent?.trim());

async function mountEdit(order = draft()) {
  await render(<PurchaseOrderForm mode="edit" order={order} />);
  await wait();
}

beforeEach(() => {
  // jsdom has no layout, so no scrollIntoView — the form calls it (focusFirstInvalid) on a blocked save.
  Element.prototype.scrollIntoView = vi.fn();
  h.listDefs.mockReset().mockResolvedValue([]);
  h.update.mockReset().mockImplementation(async () => draft());
  h.createSplit.mockReset();
  h.replace.mockReset();
  h.toast.mockReset();
});
afterEach(cleanup);

describe("PO form — Additional information", () => {
  it("shows no section, and sends no custom fields, when no field is configured", async () => {
    await mountEdit();
    expect(byText("Additional information")).toBeNull();
    await click(buttonByText("Save changes"));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0]![1]).not.toHaveProperty("customFields");
  });

  it("shows no section when every configured field is inactive", async () => {
    h.listDefs.mockResolvedValue([def(CF_RETIRED, "Legacy ref", { active: false })]);
    await mountEdit();
    expect(byText("Additional information")).toBeNull();
  });

  it("offers the active fields in order, prefilled from the order, and keeps a retired value read-only", async () => {
    h.listDefs.mockResolvedValue([
      def(CF_INTERNAL, "Internal ref", { sortOrder: 1, printOnPdf: false }),
      def(CF_ACTIVE, "Cost centre", { sortOrder: 0 }),
      def(CF_RETIRED, "Legacy ref", { sortOrder: 2, active: false }),
    ]);
    await mountEdit(
      draft({
        customFields: [
          { fieldId: CF_ACTIVE, label: "Cost centre", value: "CC-1", printOnPdf: true },
          { fieldId: CF_RETIRED, label: "Legacy ref", value: "OLD-9", printOnPdf: true },
        ],
      }),
    );
    expect(byText("Additional information")).not.toBeNull();
    expect((byLabel("Cost centre") as HTMLInputElement).value).toBe("CC-1");
    expect((byLabel("Internal ref") as HTMLInputElement).value).toBe("");
    expect(byLabel("Legacy ref")).toBeNull(); // not editable…
    expect(byText("OLD-9")).not.toBeNull(); // …but still shown
    expect(byText("Internal — not printed on the purchase order.")).not.toBeNull();
    const order = Array.from(document.querySelectorAll("input[aria-label]")).map((i) => i.getAttribute("aria-label"));
    expect(order.indexOf("Cost centre")).toBeLessThan(order.indexOf("Internal ref"));
  });

  it("saves the typed values with the draft — and every existing field exactly as before", async () => {
    h.listDefs.mockResolvedValue([def(CF_ACTIVE, "Cost centre"), def(CF_INTERNAL, "Internal ref", { sortOrder: 1 })]);
    await mountEdit(draft({ customFields: [{ fieldId: CF_ACTIVE, label: "Cost centre", value: "CC-1", printOnPdf: true }] }));
    await typeInto(byLabel("Cost centre"), "CC-42");
    await typeInto(byLabel("Internal ref"), "IR-7");
    await click(buttonByText("Save changes"));

    const payload = h.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.customFields).toEqual({ [CF_ACTIVE]: "CC-42", [CF_INTERNAL]: "IR-7" });
    expect(payload).toMatchObject({
      supplierId: SUP,
      warehouseId: WH,
      orderDate: "2026-09-01",
      expectedDeliveryDate: "2026-09-10",
      referenceNumber: "REF-1",
      projectRef: "PROJ-1",
      description: "Cabling",
      paymentTerms: "30 Days",
      items: [{ irmItemId: IRM, quantity: 10, unitPricePence: 500, vatRate: 20 }],
    });
  });

  it("keeps the existing required markers — and adds none for custom fields", async () => {
    h.listDefs.mockResolvedValue([def(CF_ACTIVE, "Cost centre")]);
    await mountEdit();
    const labels = labelTexts();
    for (const required of ["Supplier*", "Delivery warehouse*", "Order date*", "Expected delivery date*"]) {
      expect(labels).toContain(required);
    }
    expect(labels).toContain("Cost centre");
    expect(labels).not.toContain("Cost centre*");
  });

  it("still blocks the save on a missing expected delivery date, custom fields or not", async () => {
    h.listDefs.mockResolvedValue([def(CF_ACTIVE, "Cost centre")]);
    await mountEdit();
    await typeInto(byLabel("Cost centre"), "CC-42");
    const expected = Array.from(document.querySelectorAll("input[type=date]"))[1] as HTMLInputElement;
    await typeInto(expected, "");
    await click(buttonByText("Save changes"));
    expect(h.update).not.toHaveBeenCalled();
    expect(byText("Expected delivery date is required.")).not.toBeNull();
  });

  it("an empty custom field never blocks a save", async () => {
    h.listDefs.mockResolvedValue([def(CF_ACTIVE, "Cost centre")]);
    await mountEdit();
    await click(buttonByText("Save changes"));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect((h.update.mock.calls[0]![1] as Record<string, unknown>).customFields).toEqual({ [CF_ACTIVE]: "" });
  });

  it("shows retained inactive values read-only even when no active field remains", async () => {
    h.listDefs.mockResolvedValue([def(CF_RETIRED, "Legacy ref", { active: false })]);
    await mountEdit(
      draft({ customFields: [{ fieldId: CF_RETIRED, label: "Legacy ref", value: "OLD-9", printOnPdf: true }] }),
    );
    expect(byText("Additional information")).not.toBeNull();
    expect(document.body.textContent).toContain("No longer in use");
    expect(byText("OLD-9")).not.toBeNull();
    expect(byLabel("Legacy ref")).toBeNull();
  });

  // The definitions decide which values are live and which are retired. Until they arrive — or if the
  // request fails — neither is known, so the section stays away rather than mislabel live values.
  it("hides the section rather than calling live values retired when the definitions fail to load", async () => {
    h.listDefs.mockRejectedValue(new Error("offline"));
    await mountEdit(
      draft({ customFields: [{ fieldId: CF_ACTIVE, label: "Cost centre", value: "CC-1", printOnPdf: true }] }),
    );
    expect(byText("Additional information")).toBeNull();
    expect(document.body.textContent).not.toContain("No longer in use");
    // …and the save leaves every stored value exactly as it is.
    await click(buttonByText("Save changes"));
    expect(h.update.mock.calls[0]![1] as Record<string, unknown>).not.toHaveProperty("customFields");
  });
});
