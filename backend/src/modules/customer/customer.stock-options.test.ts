import { beforeEach, describe, expect, it, vi } from "vitest";

// Option lists that a LIST view's paging must never be allowed to truncate.
//
// The regression these pin: the job form's customer-stock picker was switched from an unpaged read
// to `pageSize: 100`, and the server clamps pageSize to 100 — so there was no way to ask for more.
// Two things broke, and only one of them was visible:
//
//   • entries past the hundredth could not be picked at all, and
//   • the form GROUPS these by item and SUMS the on-hand per warehouse, so the quantity its
//     per-line cap is enforced against was computed from a partial set. A partial set does not
//     merely hide options — it understates the cap, which lets an edit accept more stock than the
//     customer actually holds.
//
// That is why this read is unpaged rather than paged-with-a-bigger-number.

vi.mock("./customer.repository.js", () => ({
  findStockOptionsByCustomer: vi.fn(),
  findById: vi.fn(),
}));

import * as customerRepo from "./customer.repository.js";
import { listCustomerStockOptions } from "./customer.service.js";

const CUST = "aaaaaaaaaaaaaaaaaaaaaaaa";

/** `n` entries of ONE item spread over two warehouses — the shape the picker groups and sums. */
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `entry-${i + 1}`,
    itemName: "Fibre Patch Lead",
    sku: "FPL-01",
    quantity: 1,
    warehouseId: i % 2 === 0 ? "wh-london" : "wh-leeds",
    warehouseName: i % 2 === 0 ? "London" : "Leeds",
  }));

beforeEach(() => {
  vi.mocked(customerRepo.findById).mockResolvedValue({ id: CUST, deletedAt: null } as never);
});

describe("customer stock options are COMPLETE", () => {
  it("returns every entry when there are fewer than 100", async () => {
    vi.mocked(customerRepo.findStockOptionsByCustomer).mockResolvedValue(entries(40) as never);
    expect(await listCustomerStockOptions(CUST)).toHaveLength(40);
  });

  it("returns every entry when there are MORE than 100", async () => {
    vi.mocked(customerRepo.findStockOptionsByCustomer).mockResolvedValue(entries(250) as never);
    const options = await listCustomerStockOptions(CUST);
    // The regression returned exactly 100 here.
    expect(options).toHaveLength(250);
  });

  it("includes entry 101 and beyond, by id", async () => {
    vi.mocked(customerRepo.findStockOptionsByCustomer).mockResolvedValue(entries(250) as never);
    const ids = new Set((await listCustomerStockOptions(CUST)).map((o) => o.id));
    expect(ids.has("entry-101")).toBe(true);
    expect(ids.has("entry-250")).toBe(true);
  });

  it("preserves the per-warehouse SUM the form caps against", async () => {
    vi.mocked(customerRepo.findStockOptionsByCustomer).mockResolvedValue(entries(250) as never);
    const options = await listCustomerStockOptions(CUST);
    const sumFor = (wh: string) => options.filter((o) => o.warehouseId === wh).reduce((n, o) => n + o.quantity, 0);
    // 125 entries of 1 at each warehouse. Truncating at 100 would have reported 50 — a cap half the
    // real on-hand, which is the failure nobody would have seen until a job over-issued.
    expect(sumFor("wh-london")).toBe(125);
    expect(sumFor("wh-leeds")).toBe(125);
  });

  it("hands back no duplicate ids", async () => {
    vi.mocked(customerRepo.findStockOptionsByCustomer).mockResolvedValue(entries(250) as never);
    const options = await listCustomerStockOptions(CUST);
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
  });

  it("refuses a customer that does not exist rather than answering for nobody", async () => {
    vi.mocked(customerRepo.findById).mockResolvedValue(null as never);
    await expect(listCustomerStockOptions(CUST)).rejects.toThrow();
  });
});
