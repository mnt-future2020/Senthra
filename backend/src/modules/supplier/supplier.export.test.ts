import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supplier.repository.js", () => ({ count: vi.fn(), findMany: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY" })),
}));

import * as supplierRepo from "./supplier.repository.js";
import { EXPORT_MAX } from "../../utils/csv.js";
import { exportSuppliersCsv, listSuppliers } from "./supplier.service.js";

const count = vi.mocked(supplierRepo.count);
const findMany = vi.mocked(supplierRepo.findMany);

const row = (n: number) =>
  ({
    id: `s${n}`,
    code: `SUP-${n}`,
    name: `Supplier ${n}`,
    legalName: null,
    description: null,
    supplierType: null,
    typeId: null,
    status: "active",
    contactPerson: null,
    contactJobTitle: null,
    contactEmail: null,
    contactPhone: null,
    companyRegistrationNumber: null,
    vatNumber: null,
    website: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    county: null,
    postcode: null,
    country: null,
    paymentTerms: null,
    customPaymentTerms: null,
    currency: "GBP",
    leadTimeDays: null,
    notes: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }) as never;

/** The number of DATA rows in a built CSV (the first line is the header). */
const dataRows = (csv: string) => csv.split("\r\n").length - 1;

/**
 * Stand a population of suppliers behind the repository and let `findMany` HONOUR its skip/take.
 *
 * That detail is the point. A mock that returns a fixed array whatever it is asked for cannot
 * observe a clamped page size — it would have returned every row under the bug too, which is
 * precisely how a 100-row truncation reaches production with a green suite. Respecting `take` is
 * what makes these tests about the export rather than about the mock.
 */
const populate = (total: number) => {
  count.mockResolvedValue(total);
  findMany.mockImplementation(
    (async (_filters: unknown, skip: number, take: number) =>
      Array.from({ length: Math.max(0, Math.min(take, total - skip)) }, (_, i) => row(skip + i))) as never,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * These cover the ONE thing that made every CSV export wrong: an export asks its list function for a
 * page far larger than any client may request, and `paginate` used to clamp that request to 100
 * without telling anyone. The result was a 100-row download that also reported itself complete,
 * because `capped` is computed from the same clamped length.
 *
 * They are written against the export function rather than `paginate` alone (which has its own unit
 * tests) because the defect lived in the SEAM — both halves were individually reasonable.
 */
describe("exportSuppliersCsv row cap", () => {
  it("fetches far more than one client page", async () => {
    populate(2_000);

    await exportSuppliersCsv();

    // findMany(filters, skip, pageSize, sort) — the third argument is what paginate resolved to.
    expect(findMany.mock.calls[0]?.[2]).toBe(EXPORT_MAX + 1);
  });

  it("exports every matching row, not the first 100", async () => {
    populate(743);

    const { csv, capped } = await exportSuppliersCsv();

    expect(dataRows(csv)).toBe(743);
    expect(capped).toBe(false);
  });

  // NOT tested here: `capped` on a genuinely over-cap set. Reaching it means materialising 50,001
  // suppliers and rendering them to CSV — ~8s of CPU on every run, for arithmetic (`length >
  // EXPORT_MAX`) that only ever misreported because the fetch above it was clamped. The two halves
  // that can actually break are each covered cheaply: that the fetch asks for EXPORT_MAX + 1 (above,
  // and in utils/__tests__/pagination.test.ts), and that a capped result reaches the browser as a
  // header (utils/__tests__/csv-response.test.ts).

  it("does NOT let a client reach the raised cap through the ordinary list", async () => {
    // The whole reason the cap is an argument and not a bigger constant.
    populate(200_000);

    const { suppliers } = await listSuppliers({ page: 1, pageSize: EXPORT_MAX + 1 });

    expect(findMany.mock.calls[0]?.[2]).toBe(100);
    expect(suppliers).toHaveLength(100);
  });
});
