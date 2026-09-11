// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";

// #2 — the customer and site filters are hidden from the warehouse-scoped Warehouse Manager. A stale or
// shared link carrying them must not narrow the queue, nor count on the Filters badge.
const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  perms: new Set<string>(),
  scoped: false,
  getQueue: vi.fn(),
  listCustomerOptions: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => h.params }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ can: (p: string) => h.perms.has(p), principal: { type: "user", isWarehouseScoped: h.scoped } }),
}));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useGoodsSocket", () => ({ useGoodsSocket: () => {} }));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/services/goodsManagement.service", async (orig) => ({ ...(await orig<object>()), getQueue: h.getQueue }));
vi.mock("@/services/warehouse.service", async (orig) => ({
  ...(await orig<object>()),
  listEngineerOptions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/customer.service", async (orig) => ({ ...(await orig<object>()), listCustomerOptions: h.listCustomerOptions }));

import { GoodsManagementTab } from "./GoodsManagementTab";

const filtersTrigger = () =>
  Array.from(document.querySelectorAll("button")).find((b) => /^Filters\d*$/.test(b.textContent?.trim() ?? ""));

async function mount() {
  await render(<GoodsManagementTab warehouseId="w1" />);
  await wait();
}

beforeEach(() => {
  h.params = new URLSearchParams("tab=goods&gmCustomer=c9&gmSite=s9");
  h.getQueue.mockReset().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25, totalPages: 0, overdueAfterDays: 7 });
  h.listCustomerOptions.mockReset().mockResolvedValue([{ id: "c9", code: "CUST-9", name: "Acme Ltd" }]);
});
afterEach(cleanup);

describe("GoodsManagementTab — customer and site filters hidden from this viewer", () => {
  it("are not applied from the URL and not counted on the badge", async () => {
    h.perms = new Set(["goods_management.view", "reports.view"]);
    h.scoped = true;
    await mount();
    const params = h.getQueue.mock.calls.at(-1)?.[0];
    expect(params).toBeDefined();
    expect(params.customerId).toBeUndefined();
    expect(params.siteId).toBeUndefined();
    expect(filtersTrigger()?.textContent?.trim()).toBe("Filters");
    expect(h.listCustomerOptions).not.toHaveBeenCalled();
  });

  it("are still applied and counted for a viewer who can see them", async () => {
    h.perms = new Set(["goods_management.view", "jobs.view"]);
    h.scoped = false;
    await mount();
    expect(h.getQueue.mock.calls.at(-1)?.[0]).toMatchObject({ customerId: "c9", siteId: "s9" });
    expect(filtersTrigger()?.textContent?.trim()).toBe("Filters2");
  });
});
