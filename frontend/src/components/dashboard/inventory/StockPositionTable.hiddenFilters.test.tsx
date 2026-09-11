// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";

// #2 — a filter this viewer cannot see must not narrow the list from a stale or shared link, nor count
// on the Filters badge. Same rule as Custom Reports and Users.
const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  perms: new Set<string>(),
  scoped: false,
  listPositions: vi.fn(),
  listCustomerOptions: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => h.params }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ can: (p: string) => h.perms.has(p), principal: { type: "user", isWarehouseScoped: h.scoped } }),
}));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/services/stockPosition.service", async (orig) => ({ ...(await orig<object>()), listPositions: h.listPositions }));
vi.mock("@/services/warehouse.service", async (orig) => ({
  ...(await orig<object>()),
  listWarehouses: vi.fn().mockResolvedValue({ warehouses: [] }),
}));
vi.mock("@/services/customer.service", async (orig) => ({ ...(await orig<object>()), listCustomerOptions: h.listCustomerOptions }));

import { StockPositionTable } from "./StockPositionTable";

const filtersTrigger = () =>
  Array.from(document.querySelectorAll("button")).find((b) => /^Filters\d*$/.test(b.textContent?.trim() ?? ""));

async function mount() {
  await render(<StockPositionTable columns={["item"]} filters={["warehouse", "customer", "status"]} />);
  await wait(300); // the positions fetch is debounced
}

beforeEach(() => {
  h.params = new URLSearchParams("tab=customer&customer=c9");
  h.listPositions.mockReset().mockResolvedValue({ positions: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
  h.listCustomerOptions.mockReset().mockResolvedValue([{ id: "c9", code: "CUST-9", name: "Acme Ltd" }]);
});
afterEach(cleanup);

describe("StockPositionTable — a customer filter hidden from this viewer", () => {
  it("is not applied from the URL and not counted on the badge", async () => {
    h.perms = new Set(["inventory.view", "reports.view"]);
    h.scoped = true; // the Warehouse Manager: reports.view does not open the company-wide customer list
    await mount();
    expect(h.listPositions).toHaveBeenCalled();
    expect(h.listPositions.mock.calls.at(-1)?.[0]).not.toHaveProperty("customer");
    expect(filtersTrigger()?.textContent?.trim()).toBe("Filters");
    expect(h.listCustomerOptions).not.toHaveBeenCalled();
  });

  it("still applies and counts it for a viewer who can see it", async () => {
    h.perms = new Set(["inventory.view", "customers.view"]);
    h.scoped = false;
    await mount();
    expect(h.listPositions.mock.calls.at(-1)?.[0]).toMatchObject({ customer: "c9" });
    expect(filtersTrigger()?.textContent?.trim()).toBe("Filters1");
  });
});
