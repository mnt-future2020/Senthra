import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The COMPLETE, lean option set every customer picker reads.
 *
 * Two regressions are pinned here, one of which shipped and was caught in the browser:
 *
 *   • The column is `customerCode`, NOT `code` — unlike Supplier and Warehouse. Selecting `code`
 *     makes Prisma throw, the endpoint 500s, and the picker silently falls back to an EMPTY list:
 *     every customer vanishes and a saved job renders its customer as "(inactive)". A field name
 *     that differs from its two sibling modules is exactly the kind of thing a later tidy-up
 *     "corrects".
 *   • The mapping to `{ id, code, name }` is what lets suppliers, warehouses and customers all feed
 *     one option shape. Dropping it would break every consumer at once.
 */
vi.mock("./customer.repository.js", () => ({ findOptions: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import { listCustomerOptions } from "./customer.service.js";

const row = (id: string, customerCode: string, name: string) => ({ id, customerCode, name });

describe("listCustomerOptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps customerCode onto the shared `code` option shape", async () => {
    vi.mocked(customerRepo.findOptions).mockResolvedValue([row("c1", "CUST-0020", "ABC Company")] as never);
    expect(await listCustomerOptions()).toEqual([{ id: "c1", code: "CUST-0020", name: "ABC Company" }]);
  });

  it("returns every row the repository gives it — no paging, no cap", async () => {
    const many = Array.from({ length: 250 }, (_, i) => row(`c${i}`, `CUST-${i}`, `Customer ${i}`));
    vi.mocked(customerRepo.findOptions).mockResolvedValue(many as never);
    const out = await listCustomerOptions();
    expect(out).toHaveLength(250);
    // The 201st — past the old JobForm `pageSize: 200` ceiling this endpoint exists to remove.
    expect(out[200]).toEqual({ id: "c200", code: "CUST-200", name: "Customer 200" });
  });

  it("carries no field beyond id, code and name", async () => {
    vi.mocked(customerRepo.findOptions).mockResolvedValue([row("c1", "CUST-1", "Acme")] as never);
    const [only] = await listCustomerOptions();
    expect(Object.keys(only).sort()).toEqual(["code", "id", "name"]);
  });

  it("returns an empty list rather than throwing when there are none", async () => {
    vi.mocked(customerRepo.findOptions).mockResolvedValue([] as never);
    expect(await listCustomerOptions()).toEqual([]);
  });
});
