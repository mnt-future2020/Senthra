import { beforeEach, describe, expect, it, vi } from "vitest";

// The per-customer PICKER reads behind the job form, the Jobs list filter and the report filters:
// project options (lean, complete) and the job form's site search (name, code, address — no contacts).
vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findOptions: vi.fn(),
  findProjectOptions: vi.fn(),
  searchSiteAddresses: vi.fn(),
}));

import * as customerRepo from "./customer.repository.js";
import { listCustomerProjectOptions, searchCustomerSiteOptions } from "./customer.service.js";

const CUSTOMER_ID = "a".repeat(24);
const findById = customerRepo.findById as ReturnType<typeof vi.fn>;
const findProjectOptions = customerRepo.findProjectOptions as ReturnType<typeof vi.fn>;
const searchSiteAddresses = customerRepo.searchSiteAddresses as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({ id: CUSTOMER_ID, name: "Acme" });
});

describe("listCustomerProjectOptions", () => {
  // P4: the pickers used to page 200 (clamped to 100) projects. The options read is complete.
  it("returns every project — past the old 100-row page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, code: `PRJ-${i}`, name: `Project ${i}` }));
    findProjectOptions.mockResolvedValue(many);
    const out = await listCustomerProjectOptions(CUSTOMER_ID);
    expect(out).toHaveLength(250);
    expect(out[149]).toEqual({ id: "p149", code: "PRJ-149", name: "Project 149" });
    expect(findProjectOptions).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  it("404s for an unknown customer and never reads projects", async () => {
    findById.mockResolvedValue(null);
    await expect(listCustomerProjectOptions(CUSTOMER_ID)).rejects.toThrow("Customer not found.");
    expect(findProjectOptions).not.toHaveBeenCalled();
  });
});

describe("searchCustomerSiteOptions", () => {
  it("searches ONE customer's sites, capped at the shortlist the picker states", async () => {
    searchSiteAddresses.mockResolvedValue([]);
    await searchCustomerSiteOptions(CUSTOMER_ID, "leeds");
    expect(searchSiteAddresses).toHaveBeenCalledWith(CUSTOMER_ID, "leeds", 50);
  });

  it("404s for an unknown customer and never searches", async () => {
    findById.mockResolvedValue(null);
    await expect(searchCustomerSiteOptions(CUSTOMER_ID, "x")).rejects.toThrow("Customer not found.");
    expect(searchSiteAddresses).not.toHaveBeenCalled();
  });
});
