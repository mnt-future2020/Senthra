// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { byLabel, byText, cleanup, click, render, wait } from "@/test/dom";

const h = vi.hoisted(() => ({
  params: new URLSearchParams("tab=custom&type=stock_levels"),
  replace: vi.fn(),
  items: [{ id: "i1", name: "Cable Drum", code: "IRM-0001", sku: null, status: "active" }],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }), useSearchParams: () => h.params }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ can: (p: string) => p === "reports.view", principal: { type: "user", isWarehouseScoped: false } }),
}));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/services/reports.service", async (orig) => ({
  ...(await orig<object>()),
  listCustomReportTypes: vi.fn().mockResolvedValue([
    { key: "stock_levels", label: "Stock levels", description: "", filters: ["irmItemId"], columns: [], customerVisible: false, financial: false },
  ]),
}));
vi.mock("@/services/irm.service", async (orig) => ({
  ...(await orig<object>()),
  listIrmItems: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/hooks/useIrmItemsByIds", () => ({ useIrmItemsByIds: () => false }));
vi.mock("./reportFilterOptions", () => ({
  useReportFilterOptions: () => ({ customers: [], warehouses: [], items: h.items, engineers: [] }),
  useProjectOptions: () => [],
}));

import { CustomReportsView } from "./CustomReportsView";

afterEach(cleanup);

async function openItemMenu() {
  await render(<CustomReportsView />);
  await wait();
  await click(byText("Filters"));
  await click(byLabel("Item"));
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
}

describe("Custom Reports — the item filter (#3)", () => {
  it("stays open when a click lands inside its menu without choosing an item", async () => {
    await openItemMenu();
    await click(byText("Type to search the whole catalogue."));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("still selects an item", async () => {
    await openItemMenu();
    await click(byText("Cable Drum"));
    expect(h.replace).toHaveBeenLastCalledWith(expect.stringContaining("irmItemId=i1"), { scroll: false });
  });
});
