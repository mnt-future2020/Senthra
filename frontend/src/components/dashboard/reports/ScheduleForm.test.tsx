// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { byLabel, byText, choose, cleanup, click, render, wait } from "@/test/dom";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  scoped: false,
  searchJobSites: vi.fn(),
  items: [
    { id: "i1", name: "Cable Drum", code: "IRM-0001", sku: null, status: "active" },
    { id: "i2", name: "Fibre Splice Kit", code: "IRM-0002", sku: null, status: "active" },
  ],
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ can: (p: string) => h.perms.has(p), principal: { type: "user", isWarehouseScoped: h.scoped } }),
}));
vi.mock("@/components/ui/Select", async () => ({ Select: (await import("@/test/dom")).SelectStub }));
vi.mock("@/components/ui/MultiSelect", () => ({ MultiSelect: () => null }));
vi.mock("@/services/reports.service", async (orig) => ({
  ...(await orig<object>()),
  listScheduleRecipients: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/job.service", async (orig) => ({ ...(await orig<object>()), searchJobSites: h.searchJobSites }));
vi.mock("@/services/irm.service", async (orig) => ({
  ...(await orig<object>()),
  listIrmItems: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("@/hooks/useIrmItemsByIds", () => ({ useIrmItemsByIds: () => false }));
vi.mock("./reportFilterOptions", () => ({
  useReportFilterOptions: () => ({
    customers: [
      { value: "c1", label: "Acme Ltd" },
      { value: "c2", label: "Beta Ltd" },
    ],
    warehouses: [],
    items: h.items,
    engineers: [],
  }),
  useProjectOptions: () => [],
}));

import { ScheduleForm } from "./ScheduleForm";
import type { SchedulablePayloadState } from "./scheduleTypes";

const PROJECT_ACTIVITY = {
  key: "project_activity",
  label: "Project activity",
  description: "",
  filters: ["dateFrom", "dateTo", "customerId", "projectId", "siteId", "warehouseId", "irmItemId"],
};

const draft = (filters: Record<string, string> = {}): SchedulablePayloadState => ({
  name: "Weekly activity",
  reportKey: "project_activity",
  cadence: "weekly",
  dayOfWeek: "1",
  dayOfMonth: "1",
  time: "08:00",
  format: "xlsx",
  recipients: [],
  filters,
  enabled: true,
});

const onChange = vi.fn();
const mount = (filters?: Record<string, string>) =>
  render(
    <ScheduleForm
      types={[PROJECT_ACTIVITY] as never}
      companyTimeZone="Europe/London"
      draft={draft(filters)}
      onChange={onChange}
      onCancel={() => {}}
      onSave={() => {}}
      saving={false}
    />,
  );
const lastFilters = () => (onChange.mock.calls.at(-1)?.[0] as SchedulablePayloadState).filters;

beforeEach(() => {
  h.perms = new Set(["reports.view"]);
  h.scoped = false;
  onChange.mockClear();
  h.searchJobSites.mockReset().mockResolvedValue({
    sites: [{ id: "s1", name: "Leeds Depot", code: "STE-0001", postcode: "LS1 1AA", customerName: "Acme Ltd" }],
  });
});
afterEach(cleanup);

describe("ScheduleForm — the item filter (#3)", () => {
  it("stays open when a click lands inside its menu without choosing an item", async () => {
    await mount();
    await click(byLabel("Item"));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await click(byText("Type to search the whole catalogue."));

    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("still selects an item", async () => {
    await mount();
    await click(byLabel("Item"));
    await click(byText("Cable Drum"));
    expect(lastFilters()).toMatchObject({ irmItemId: "i1" });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("ScheduleForm — the Project Activity site filter (#4)", () => {
  it("is a site SEARCH narrowed to the chosen customer, not an empty dropdown", async () => {
    await mount({ customerId: "c1" });
    const trigger = byLabel("Site");
    expect(trigger?.tagName).toBe("BUTTON");

    await click(trigger);
    await wait(300);
    expect(h.searchJobSites).toHaveBeenCalledWith("", "c1");

    await click(byText("STE-0001 — Leeds Depot"));
    expect(lastFilters()).toEqual({ customerId: "c1", siteId: "s1" });
  });

  it("changing the customer drops a site chosen under the previous one", async () => {
    await mount({ customerId: "c1", siteId: "s1" });
    await choose(byLabel("Customer"), "c2");
    expect(lastFilters()).toEqual({ customerId: "c2" });
  });

  it("is hidden — not drawn empty — for a warehouse-scoped reporter the site search refuses", async () => {
    h.scoped = true;
    await mount();
    expect(byLabel("Site")).toBeNull();
    expect(byLabel("siteId")).toBeNull();
  });

  it("is offered to a warehouse-scoped user who holds jobs.view", async () => {
    h.scoped = true;
    h.perms = new Set(["reports.view", "jobs.view"]);
    await mount();
    expect(byLabel("Site")?.tagName).toBe("BUTTON");
  });
});
