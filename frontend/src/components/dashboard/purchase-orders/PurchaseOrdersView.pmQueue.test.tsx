// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";

// "Awaiting my action" is the PM's own worklist: it asks the server for `status=pm_review` AND
// `pm=me`, and the server turns `me` into the signed-in principal's id.
//
// The bug, as reported: on Purchase Orders the button was permanently stuck on "No purchase orders
// match" for a super admin. Not a data problem — a PO's PM is always a STAFF USER (the server's
// `resolvePmCandidates` reads the user collection, and `assignPm` refuses anything else), while an
// admin signs in as an admin principal, because login checks that collection first. So `pm=me` sent
// an id from the wrong collection and could never match a single row. Admins hold every permission,
// so the Send-permission gate passed and they got a button with no reachable answer.
//
// Hence a staff-user check, and hence it also guards the URL param: an admin who lands on
// `?awaiting=1` from a bookmark or a shared link must get the ordinary list, not an empty one with
// the only control that would clear it hidden from them.
const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  perms: new Set<string>(),
  principalType: "user" as "user" | "admin",
  listPurchaseOrders: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => h.params,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    can: (p: string) => h.perms.has(p),
    principal: { type: h.principalType, isWarehouseScoped: false },
  }),
}));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useReferenceData", () => ({ useReferenceData: () => ({ isLoading: false }) }));
vi.mock("@/hooks/usePurchaseOrderSocket", () => ({ usePurchaseOrderSocket: () => {} }));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/components/dashboard/shell/AttentionMenu", () => ({ AttentionMenu: () => null }));
vi.mock("@/services/purchase-order.service", async (orig) => ({
  ...(await orig<object>()),
  listPurchaseOrders: h.listPurchaseOrders,
  getCachedPurchaseOrders: () => null,
}));

import { PurchaseOrdersView } from "./PurchaseOrdersView";

const pmButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Awaiting my action");
const lastQuery = () => h.listPurchaseOrders.mock.calls.at(-1)?.[0] ?? {};

async function mount() {
  await render(<PurchaseOrdersView />);
  await wait(400); // the list fetch is debounced
}

beforeEach(() => {
  h.params = new URLSearchParams("awaiting=1");
  h.principalType = "user";
  h.perms = new Set(["purchase_orders.view", "purchase_orders.send"]);
  h.listPurchaseOrders
    .mockReset()
    .mockResolvedValue({ purchaseOrders: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
});
afterEach(cleanup);

describe("Purchase Orders — the PM worklist belongs to staff users", () => {
  it("offers it to a staff user who can send, and scopes the query to them", async () => {
    await mount();
    expect(pmButton()).toBeDefined();
    expect(lastQuery()).toMatchObject({ status: "pm_review", pm: "me" });
  });

  it("is not offered to an admin, whose id can never be a PO's pmUserId", async () => {
    h.principalType = "admin";
    // Admins hold every permission, which is exactly why the permission check alone let them in.
    h.perms = new Set(["purchase_orders.view", "purchase_orders.send", "purchase_orders.export"]);
    await mount();
    expect(pmButton()).toBeUndefined();
  });

  // The half that matters for the reported screenshot: the URL already said `awaiting=1`.
  it("ignores ?awaiting=1 for an admin instead of showing an empty list", async () => {
    h.principalType = "admin";
    h.perms = new Set(["purchase_orders.view", "purchase_orders.send"]);
    await mount();
    const q = lastQuery();
    expect(q).not.toHaveProperty("pm");
    expect(q.status).toBeUndefined(); // the ordinary unfiltered list, not pm_review
  });

  // A user without Send is not a PM either, so the same two rules apply.
  it("ignores it for a staff user who cannot send", async () => {
    h.perms = new Set(["purchase_orders.view"]);
    await mount();
    expect(pmButton()).toBeUndefined();
    expect(lastQuery()).not.toHaveProperty("pm");
  });
});
