import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Distinct spies for the transaction client vs the base client: the bulk insert MUST run
// on tx.customerSite.createMany (inside withTransaction). Only findMany is used on the base
// prisma client (cold-start seed + refetch). If a regression moved createMany outside the
// transaction to prisma.customerSite, that object has no createMany and the test would throw.
const { counter, customerSite, txCustomerSite } = vi.hoisted(() => ({
  counter: { update: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  customerSite: { findMany: vi.fn() },
  txCustomerSite: { createMany: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: { counter, customerSite },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({ customerSite: txCustomerSite }),
}));

import { createSitesBulk } from "./customer.repository.js";

beforeEach(() => vi.clearAllMocks());

const site = (name: string) => ({
  name, addressLine1: null, addressLine2: null, city: null, county: null, postcode: null,
  country: null, contactPerson: null, contactNumber: null, latitude: null, longitude: null, status: "active",
});

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError("no counter", { code: "P2025", clientVersion: "test" });
const uniqueConflict = () =>
  new Prisma.PrismaClientKnownRequestError("dup code", { code: "P2002", clientVersion: "test" });

describe("createSitesBulk", () => {
  it("reserves a block with ONE atomic increment of N and assigns codes from the returned end seq", async () => {
    counter.update.mockResolvedValue({ seq: 7 }); // end seq → block is 5,6,7 for N=3
    txCustomerSite.createMany.mockResolvedValue({ count: 3 });
    customerSite.findMany.mockResolvedValue([{ code: "STE-0005" }, { code: "STE-0006" }, { code: "STE-0007" }]);

    await createSitesBulk("cust1", [site("A"), site("B"), site("C")]);

    expect(counter.update).toHaveBeenCalledTimes(1);
    expect(counter.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "STE:cust1" }, data: { seq: { increment: 3 } } }),
    );
    const created = txCustomerSite.createMany.mock.calls[0][0].data as { code: string }[];
    expect(created.map((r) => r.code)).toEqual(["STE-0005", "STE-0006", "STE-0007"]);
  });

  it("cold-start: seeds from the highest existing suffix, tolerates a concurrent-seed conflict, then reserves", async () => {
    counter.update.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ seq: 2 });
    customerSite.findMany
      .mockResolvedValueOnce([{ code: "STE-0001" }]) // existing codes for seed
      .mockResolvedValueOnce([{ code: "STE-0002" }]); // refetch created
    counter.create.mockResolvedValue({});
    txCustomerSite.createMany.mockResolvedValue({ count: 1 });

    await createSitesBulk("cust2", [site("Only")]);

    expect(counter.create).toHaveBeenCalledWith({ data: { key: "STE:cust2", seq: 1 } });
    expect(counter.update).toHaveBeenCalledTimes(2);
    const created = txCustomerSite.createMany.mock.calls[0][0].data as { code: string }[];
    expect(created[0].code).toBe("STE-0002");
  });

  it("returns [] and does nothing for an empty batch", async () => {
    const res = await createSitesBulk("cust3", []);
    expect(res).toEqual([]);
    expect(counter.update).not.toHaveBeenCalled();
  });

  it("recovers from a code collision: fast-forwards the counter and retries instead of throwing", async () => {
    counter.update.mockResolvedValue({ seq: 3 }); // reserve returns startSeq 3 each attempt (N=1)
    txCustomerSite.createMany
      .mockRejectedValueOnce(uniqueConflict()) // attempt 1: drifted counter → collision
      .mockResolvedValueOnce({ count: 1 }); // attempt 2: succeeds after fast-forward
    customerSite.findMany
      .mockResolvedValueOnce([{ code: "STE-0003" }, { code: "STE-0009" }]) // fast-forward seed (max 9)
      .mockResolvedValueOnce([{ code: "STE-0003" }]); // refetch created
    counter.upsert.mockResolvedValue({});

    const res = await createSitesBulk("cust4", [site("Retry")]);

    expect(counter.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "STE:cust4" } }));
    expect(txCustomerSite.createMany).toHaveBeenCalledTimes(2);
    expect(res).toHaveLength(1);
  });
});
