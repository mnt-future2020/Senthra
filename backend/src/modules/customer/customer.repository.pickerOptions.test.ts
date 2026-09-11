import { beforeEach, describe, expect, it, vi } from "vitest";

// The two per-customer picker queries, asserted on what they ASK Prisma for — because the point of
// both is what they leave out. A project option is id/code/name and nothing else; a site option is the
// address the job form copies, and never the site's contact person or phone number.
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    customer: { findMany: vi.fn().mockResolvedValue([]) },
    customerProject: { findMany: vi.fn().mockResolvedValue([]) },
    customerSite: { findMany: vi.fn().mockResolvedValue([]) },
  },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { findOptions, findProjectOptions, searchSiteAddresses, searchSites } from "./customer.repository.js";

const customerFindMany = prisma.customer.findMany as ReturnType<typeof vi.fn>;
const projectFindMany = prisma.customerProject.findMany as ReturnType<typeof vi.fn>;
const siteFindMany = prisma.customerSite.findMany as ReturnType<typeof vi.fn>;
const lastArgs = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
const CUSTOMER_ID = "b".repeat(24);

beforeEach(() => vi.clearAllMocks());

describe("findOptions", () => {
  it("offers ACTIVE customers only by default — the list every create form picks from", async () => {
    await findOptions();
    expect(lastArgs(customerFindMany).where).toEqual({ deletedAt: null, status: "active" });
  });

  it("with includeInactive keeps DEACTIVATED customers (a history filter must still name them) but never deleted ones", async () => {
    await findOptions({ includeInactive: true });
    expect(lastArgs(customerFindMany).where).toEqual({ deletedAt: null });
  });

  it("reads status alongside the option so a deactivated row can be flagged — and nothing else", async () => {
    await findOptions({ includeInactive: true });
    expect(lastArgs(customerFindMany).select).toEqual({ id: true, customerCode: true, name: true, status: true });
  });
});

describe("findProjectOptions", () => {
  it("selects id, code and name only", async () => {
    await findProjectOptions(CUSTOMER_ID);
    expect(lastArgs(projectFindMany).select).toEqual({ id: true, code: true, name: true });
  });

  it("is one customer's COMPLETE set — no page, no cap", async () => {
    await findProjectOptions(CUSTOMER_ID);
    const args = lastArgs(projectFindMany);
    expect(args.where).toEqual({ customerId: CUSTOMER_ID });
    expect(args.take).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });
});

describe("searchSiteAddresses", () => {
  it("returns the address fields the job form copies — and no contact fields", async () => {
    await searchSiteAddresses(CUSTOMER_ID, undefined, 50);
    const select = lastArgs(siteFindMany).select;
    expect(Object.keys(select).sort()).toEqual(
      ["addressLine1", "addressLine2", "city", "code", "country", "county", "id", "name", "postcode"].sort(),
    );
    expect(select.contactPerson).toBeUndefined();
    expect(select.contactNumber).toBeUndefined();
  });

  it("stays inside the customer it was asked about and honours the cap", async () => {
    await searchSiteAddresses(CUSTOMER_ID, "  ", 50);
    const args = lastArgs(siteFindMany);
    expect(args.where).toEqual({ customerId: CUSTOMER_ID });
    expect(args.take).toBe(50);
  });

  // Prisma's Mongo `contains` is a raw $regex — an unescaped "(" crashes the query (P2010 → 500).
  it("matches the term across name, code, postcode and city, regex-escaped", async () => {
    await searchSiteAddresses(CUSTOMER_ID, "a(b", 50);
    const { where } = lastArgs(siteFindMany);
    expect(where.customerId).toBe(CUSTOMER_ID);
    expect(where.OR.map((c: Record<string, unknown>) => Object.keys(c)[0])).toEqual(["name", "code", "postcode", "city"]);
    expect(where.OR[0].name.contains).toBe("a\\(b");
  });

  it("uses the SAME matching as the filter's site search", async () => {
    await searchSiteAddresses(CUSTOMER_ID, "leeds", 50);
    const fromForm = lastArgs(siteFindMany).where;
    await searchSites("leeds", CUSTOMER_ID, 50);
    const fromFilter = lastArgs(siteFindMany).where;
    expect(fromForm).toEqual(fromFilter);
  });
});
