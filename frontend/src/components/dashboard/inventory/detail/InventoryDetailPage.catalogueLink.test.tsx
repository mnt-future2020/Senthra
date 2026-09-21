// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";

// The route from a stock position back to the CATALOGUE record.
//
// This page answers "where is this stock"; the catalogue answers "what is this product". There was
// no route between them, so arriving here from a warehouse meant leaving and finding the item again
// by hand. The link is permission-gated because /dashboard/irm/[id] is itself behind a
// PermissionGate — an ungated link would just be an invitation to a permission wall.

const h = vi.hoisted(() => ({ perms: new Set<string>() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/hooks/useReferenceData", () => ({ useReferenceData: () => ({ data: null }) }));
// The page's own data sections fetch on mount; this suite is about the header only.
vi.mock("@/services/inventory.service", () => ({ listInventoryTransactions: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/services/stockPosition.service", () => ({
  getItemDistribution: vi.fn(() => new Promise(() => {})),
  getItemHolders: vi.fn(() => new Promise(() => {})),
  getItemJobs: vi.fn(() => new Promise(() => {})),
}));

import { InventoryDetailPage } from "./InventoryDetailPage";

const INV = {
  id: "bal1",
  irmItemId: "irm-db-id-1",
  itemCode: "IRM-0004",
  itemName: "CAT6 U/UTP Cable, 305m box",
  sku: "IRM-CAT6-305-NEW",
  categoryName: "Tools",
  warehouseId: "wh1",
  warehouseName: "London Logistics Hub",
  warehouseCode: "WH-0005",
  status: "in_stock",
  onHand: 104,
  available: 104,
  reserved: 0,
  unitCost: 42.5,
  stockValue: 4420,
  unitOfMeasure: "Box",
  lastMovementAt: "2026-08-28T10:28:00.000Z",
} as unknown as Parameters<typeof InventoryDetailPage>[0]["initial"];

const catalogueLink = () =>
  [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("View in catalogue")) ?? null;

beforeEach(() => {
  h.perms = new Set<string>();
});
afterEach(cleanup);

describe("link to the IRM catalogue", () => {
  it("is shown to a viewer who holds irm.view", async () => {
    h.perms.add("irm.view");
    await render(<InventoryDetailPage initial={INV} />);
    await wait();
    expect(catalogueLink()).not.toBeNull();
  });

  // The destination is itself gated, so offering it to someone who cannot open it would send them
  // to a permission wall. Same rule SupplierDetail applies to its Items tab.
  it("is hidden from a viewer who does not", async () => {
    await render(<InventoryDetailPage initial={INV} />);
    await wait();
    expect(catalogueLink()).toBeNull();
  });

  // By CODE, not the database id: every other entry into the catalogue (the IRM list, a supplier's
  // items, the form's post-save redirect) links by code, and the page resolves either.
  it("targets the catalogue by item code", async () => {
    h.perms.add("irm.view");
    await render(<InventoryDetailPage initial={INV} />);
    await wait();

    const href = catalogueLink()?.getAttribute("href");
    expect(href).toBe("/dashboard/irm/IRM-0004");
    expect(href).not.toContain("irm-db-id-1");
  });

  // A real anchor, not a button: this is navigation to another record, so middle-click and
  // "open in new tab" have to work — you want the catalogue beside the stock page, not instead of it.
  it("is an anchor, so it can be opened in a new tab", async () => {
    h.perms.add("irm.view");
    await render(<InventoryDetailPage initial={INV} />);
    await wait();
    expect(catalogueLink()?.tagName).toBe("A");
  });

  it("sits alongside Move stock when the viewer holds both", async () => {
    h.perms.add("irm.view");
    h.perms.add("inventory.move");
    await render(<InventoryDetailPage initial={INV} />);
    await wait();

    expect(catalogueLink()).not.toBeNull();
    const move = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Move stock"));
    expect(move).toBeTruthy();
  });

  // DetailHeader renders its actions wrapper on truthiness and `<></>` is truthy, so a reader with
  // neither permission would otherwise get an empty flex row holding the header open.
  it("leaves no empty actions row when the viewer has neither permission", async () => {
    const container = await render(<InventoryDetailPage initial={INV} />);
    await wait();

    expect(catalogueLink()).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Move stock"))).toBe(false);
    // The header still renders its title — it is the ACTIONS wrapper that must be absent.
    expect(container.textContent).toContain("CAT6 U/UTP Cable, 305m box");
    expect(container.querySelector(".justify-end")).toBeNull();
  });
});
