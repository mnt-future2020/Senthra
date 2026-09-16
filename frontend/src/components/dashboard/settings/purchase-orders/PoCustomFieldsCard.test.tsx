// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byLabel, byText, cleanup, click, render, wait } from "@/test/dom";
import type { PoCustomFieldDefinition } from "@/types/purchase-order";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: h.toast }) }));
vi.mock("@/providers/NavigationGuardProvider", () => ({ useReportDirty: () => {} }));
vi.mock("@/services/purchase-order.service", () => ({
  listPoCustomFields: h.list,
  createPoCustomField: h.create,
  updatePoCustomField: h.update,
  reorderPoCustomFields: h.reorder,
}));

import { PoCustomFieldsCard } from "./PoCustomFieldsCard";

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
const A = def("a".repeat(24), "Cost centre", { sortOrder: 0 });
const B = def("b".repeat(24), "Site contact", { sortOrder: 1, printOnPdf: false });
const C = def("c".repeat(24), "Legacy ref", { sortOrder: 2, active: false });

async function typeInto(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const buttonByText = (t: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === t);
const rowLabels = () => Array.from(document.querySelectorAll("ul[aria-label='PO custom fields'] li span.truncate")).map((s) => s.textContent);

async function mount() {
  await render(<PoCustomFieldsCard />);
  await wait();
}

beforeEach(() => {
  h.perms = new Set(["settings.view", "settings.manage"]);
  h.list.mockReset().mockResolvedValue([A, B, C]);
  h.create.mockReset();
  h.update.mockReset();
  h.reorder.mockReset();
  h.toast.mockReset();
});
afterEach(cleanup);

describe("PoCustomFieldsCard", () => {
  it("lists every configured field in order, marking the inactive ones", async () => {
    await mount();
    expect(rowLabels()).toEqual(["Cost centre", "Site contact", "Legacy ref"]);
    expect(byText("Inactive")).not.toBeNull();
    expect(byLabel("Print Cost centre on PDF")?.getAttribute("aria-checked")).toBe("true");
    expect(byLabel("Print Site contact on PDF")?.getAttribute("aria-checked")).toBe("false");
    // Only an ACTIVE field can be renamed.
    expect(byLabel("Rename Cost centre")).not.toBeNull();
    expect(byLabel("Rename Legacy ref")).toBeNull();
  });

  it("offers no required/optional control and nothing about the standard PO fields", async () => {
    await mount();
    expect(document.body.textContent).not.toMatch(/required/i);
    expect(document.body.textContent).not.toMatch(/supplier\b|order date|expected delivery/i);
  });

  it("adds a field, printing on the PDF by default", async () => {
    h.create.mockResolvedValue(def("d".repeat(24), "Budget code", { sortOrder: 3 }));
    await mount();
    await typeInto(byLabel("New field name"), "Budget code");
    await click(buttonByText("Add field"));
    expect(h.create).toHaveBeenCalledWith({ label: "Budget code", printOnPdf: true });
    expect(rowLabels()).toContain("Budget code");
  });

  it("refuses a duplicate name before asking the server", async () => {
    await mount();
    await typeInto(byLabel("New field name"), "cost CENTRE");
    await click(buttonByText("Add field"));
    expect(h.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('A field called "Cost centre" already exists.');
  });

  it("renames an active field", async () => {
    h.update.mockResolvedValue({ ...A, label: "Cost center" });
    await mount();
    await click(byLabel("Rename Cost centre"));
    await typeInto(byLabel("Field name"), "Cost center");
    await click(buttonByText("Save"));
    expect(h.update).toHaveBeenCalledWith(A.id, { label: "Cost center" });
    expect(rowLabels()[0]).toBe("Cost center");
  });

  it("deactivates a field and says its values are kept", async () => {
    h.update.mockResolvedValue({ ...A, active: false });
    await mount();
    await click(byLabel("Cost centre active"));
    expect(h.update).toHaveBeenCalledWith(A.id, { active: false });
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/orders that already have a value keep it/));
  });

  it("switches a field's Print on PDF", async () => {
    h.update.mockResolvedValue({ ...B, printOnPdf: true });
    await mount();
    await click(byLabel("Print Site contact on PDF"));
    expect(h.update).toHaveBeenCalledWith(B.id, { printOnPdf: true });
    expect(byLabel("Print Site contact on PDF")?.getAttribute("aria-checked")).toBe("true");
  });

  it("reorders by sending the complete new order", async () => {
    h.reorder.mockResolvedValue([B, A, C]);
    await mount();
    await click(byLabel("Move Cost centre down"));
    expect(h.reorder).toHaveBeenCalledWith([B.id, A.id, C.id]);
    expect(rowLabels()).toEqual(["Site contact", "Cost centre", "Legacy ref"]);
  });

  it("puts the list back when the reorder fails", async () => {
    h.reorder.mockRejectedValue(new Error("The field list changed while you were reordering it. Refresh and try again."));
    await mount();
    await click(byLabel("Move Cost centre down"));
    await wait();
    expect(rowLabels()).toEqual(["Cost centre", "Site contact", "Legacy ref"]);
    expect(document.body.textContent).toContain("The field list changed");
  });

  it("is read-only without settings.manage", async () => {
    h.perms = new Set(["settings.view"]);
    await mount();
    expect(byLabel("New field name")).toBeNull();
    expect(byLabel("Rename Cost centre")).toBeNull();
    expect((byLabel("Cost centre active") as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel("Move Cost centre down") as HTMLButtonElement).disabled).toBe(true);
  });
});
