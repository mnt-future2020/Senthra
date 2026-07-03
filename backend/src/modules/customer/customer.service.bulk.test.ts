import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findSitesByCustomer: vi.fn(),
  createSitesBulk: vi.fn(),
}));
vi.mock("../../lib/geocode.js", () => ({
  geocodePostcode: vi.fn(),
  geocodePostcodesBulk: vi.fn(),
  canonicalPostcode: (p: string) => p.trim().toUpperCase().replace(/\s+/g, ""),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// Trim the heavy dependency graph this module pulls in transitively.
vi.mock("#modules/auth/email-namespace.js", () => ({ assertEmailNamespaceFree: vi.fn() }));
vi.mock("#modules/auth/auth.service.js", () => ({ issueResetEmail: vi.fn() }));
vi.mock("#modules/auth/session.service.js", () => ({}));
vi.mock("./customer.stock.service.js", () => ({ getCustomerStock: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({}));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn(), getStockCodePrefix: vi.fn() }));
vi.mock("../../lib/warehouse-access.js", () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import { geocodePostcodesBulk } from "../../lib/geocode.js";
import * as audit from "#modules/audit/audit.service.js";
import { bulkAddSites } from "./customer.service.js";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const createdSite = (code: string, name: string) => ({
  id: code, code, name, addressLine1: null, addressLine2: null, city: null, county: null,
  postcode: null, country: null, contactPerson: null, contactNumber: null, latitude: null,
  longitude: null, status: "active", createdAt: new Date("2026-07-02T00:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  asMock(customerRepo.findById).mockResolvedValue({ id: "c1", name: "LOBBI" });
  asMock(customerRepo.findSitesByCustomer).mockResolvedValue([]);
  asMock(geocodePostcodesBulk).mockResolvedValue(new Map());
});

describe("bulkAddSites", () => {
  it("partitions rows into created / skipped / failed", async () => {
    asMock(customerRepo.findSitesByCustomer).mockResolvedValue([{ name: "Existing", postcode: "LS1 4DY" }]);
    asMock(customerRepo.createSitesBulk).mockResolvedValue([createdSite("STE-0001", "New Site")]);

    const res = await bulkAddSites("c1", [
      { name: "New Site", postcode: "M1 1AA" },   // created
      { name: "Existing", postcode: "ls1 4dy" },  // skipped (matches existing, case-insensitive)
      { name: "", postcode: "M1 1AA" },           // failed (no name)
    ], "sites.xlsx");

    expect(res.createdSites).toHaveLength(1);
    expect(res.skipped).toEqual([{ row: 2, name: "Existing", reason: expect.stringContaining("Already exists") }]);
    expect(res.failed[0]).toMatchObject({ row: 3 });
    expect(customerRepo.createSitesBulk).toHaveBeenCalledWith("c1", [expect.objectContaining({ name: "New Site" })]);
  });

  it("skips a duplicate that appears twice within the same file", async () => {
    asMock(customerRepo.createSitesBulk).mockResolvedValue([createdSite("STE-0001", "Dup")]);
    const res = await bulkAddSites("c1", [
      { name: "Dup", postcode: "M1 1AA" },
      { name: "dup", postcode: "m1 1aa" },
    ], undefined);
    expect(res.createdSites).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
  });

  it("attaches geocoded coords by canonical postcode, best-effort", async () => {
    asMock(geocodePostcodesBulk).mockResolvedValue(new Map([["M11AA", { latitude: 53.4, longitude: -2.2 }]]));
    asMock(customerRepo.createSitesBulk).mockResolvedValue([createdSite("STE-0001", "Geo")]);
    await bulkAddSites("c1", [{ name: "Geo", postcode: "M1 1AA" }], undefined);
    const staged = asMock(customerRepo.createSitesBulk).mock.calls[0][1];
    expect(staged[0]).toMatchObject({ latitude: 53.4, longitude: -2.2 });
  });

  it("echoes the client-sent sheet rowNumber in failed/skipped notes (not the array index)", async () => {
    asMock(customerRepo.findSitesByCustomer).mockResolvedValue([{ name: "Exists", postcode: "LS1 4DY" }]);
    asMock(customerRepo.createSitesBulk).mockResolvedValue([]);
    const res = await bulkAddSites("c1", [
      { name: "", rowNumber: 42 },                       // failed → row 42, not 1
      { name: "Exists", postcode: "ls1 4dy", rowNumber: 7 }, // skipped → row 7, not 2
    ], undefined);
    expect(res.failed[0].row).toBe(42);
    expect(res.skipped[0].row).toBe(7);
  });

  it("records ONE audit entry with fileName + counts", async () => {
    asMock(customerRepo.createSitesBulk).mockResolvedValue([createdSite("STE-0001", "A")]);
    await bulkAddSites("c1", [{ name: "A" }], "my.xlsx");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(asMock(audit.record).mock.calls[0][0]).toMatchObject({
      action: "customer.sites.bulk_imported",
      metadata: expect.objectContaining({ fileName: "my.xlsx", created: 1, skipped: 0, failed: 0 }),
    });
  });
});
