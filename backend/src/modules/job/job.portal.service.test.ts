import { beforeEach, describe, expect, it, vi } from "vitest";

// The customer-portal slice of job.service. Kept apart from job.service.test.ts because that file's
// mock surface is the whole office/engineer workflow — realtime, email, goods-management, audit —
// and none of it is reachable from a read-only portal list. What matters here is narrower and
// sharper: what the customer is allowed to see, and what they are shown instead of what we store.
vi.mock("./job.repository.js", () => ({
  findManyByCustomerPortal: vi.fn().mockResolvedValue([]),
  countByCustomerPortal: vi.fn().mockResolvedValue(0),
  findByIdForCustomer: vi.fn().mockResolvedValue(null),
}));

vi.mock("#modules/goods-management/goods-management.service.js", () => ({ getJobKitTallies: vi.fn() }));
vi.mock("#modules/job-kit-request/job-kit-request.service.js", () => ({}));
vi.mock("#modules/job-kit-request/job-kit-request.repository.js", () => ({}));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({}));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({}));
vi.mock("#modules/customer/customer.repository.js", () => ({}));
vi.mock("#modules/supplier/supplier.repository.js", () => ({}));
vi.mock("#modules/irm/irm.repository.js", () => ({}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({}));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({}));
vi.mock("#modules/user/user.repository.js", () => ({}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("#modules/role/permissions.js", () => ({ roleGrants: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office_jobs" }));
vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));

import * as jobRepo from "./job.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import { countActiveJobsForCustomer, getJobForCustomer, listJobsForCustomer, portalStage } from "./job.service.js";

const CUST = "a".repeat(24);
const OTHER_CUST = "b".repeat(24);

const findMany = jobRepo.findManyByCustomerPortal as ReturnType<typeof vi.fn>;
const count = jobRepo.countByCustomerPortal as ReturnType<typeof vi.fn>;
const findById = jobRepo.findByIdForCustomer as ReturnType<typeof vi.fn>;
const kitTallies = goodsManagementService.getJobKitTallies as ReturnType<typeof vi.fn>;

// The DETAIL projection: the list row plus every field the office's cards show. Kept as a separate
// fixture because the two selects are genuinely different — the list must stay lean.
const detailRow = (over: Record<string, unknown> = {}) => ({
  ...row(),
  customerName: "Snapshot Customer",
  customer: { id: "c1", name: "Live Customer" },
  priority: "urgent",
  trsArea: "North",
  floor: "3", suite: "A", rack: "R4", shelf: "S2",
  plannerName: "Their Planner",
  plannerPhone: "0113 000 0000",
  attachments: ["https://example.com/pack.pdf"],
  assignedAt: new Date("2026-08-02T09:00:00.000Z"),
  acceptedAt: new Date("2026-08-03T09:00:00.000Z"),
  startedAt: null,
  cancelledAt: null,
  cancelReason: null,
  assignedEngineerId: "eng1",
  kitLines: [
    { id: "kl1", lineType: "irm", seCode: null, itemName: "CAT6 Cable", description: null, warehouseName: "Leeds", qty: 10, irmItemId: "irm1", customerStockEntryId: null },
  ],
  ...over,
});

// A row exactly as portalJobSelect returns it — Dates, not ISO strings.
const row = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  jobNumber: "JOB-2026-0001",
  name: "Fibre patch panel",
  jobType: "installation",
  technology: null,
  customerRef: "PO-88",
  schemeNo: "5432471",
  projectId: "p1",
  projectName: "Snapshot Project",
  project: { id: "p1", name: "Live Project" },
  siteId: "s1",
  siteName: "Snapshot Site",
  site: { id: "s1", name: "Live Site" },
  addressLine1: "1 Test Street",
  addressLine2: null,
  city: "London",
  county: null,
  postcode: "SW1A 1AA",
  country: "United Kingdom",
  completionDate: new Date("2026-08-20T00:00:00.000Z"),
  completedAt: null,
  status: "assigned",
  assignedEngineerName: "Bob Smith",
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  count.mockReset().mockResolvedValue(0);
  findById.mockReset().mockResolvedValue(null);
  kitTallies.mockReset().mockResolvedValue({});
});

const lastFilters = () => findMany.mock.calls.at(-1)?.[1];

describe("portalStage — six stored statuses, four the customer sees", () => {
  it("collapses the three staffing states into one", () => {
    expect(portalStage("assigned")).toBe("scheduled");
    expect(portalStage("accepted")).toBe("scheduled");
    // The one that matters: an engineer declining is OUR problem to re-staff. Surfacing "rejected"
    // on a customer's own job reads as us refusing their work.
    expect(portalStage("rejected")).toBe("scheduled");
  });

  it("passes the three that mean the same thing on both sides", () => {
    expect(portalStage("in_progress")).toBe("in_progress");
    expect(portalStage("completed")).toBe("completed");
    expect(portalStage("cancelled")).toBe("cancelled");
  });

  // A status added to the machine later must not 500 a customer's list before anyone maps it.
  it("falls back rather than throwing on an unmapped status", () => {
    expect(portalStage("on_hold")).toBe("scheduled");
    expect(portalStage("")).toBe("scheduled");
  });
});

describe("listJobsForCustomer — scope", () => {
  it("passes the caller's customer id to both the count and the list", async () => {
    await listJobsForCustomer(CUST);
    expect(count.mock.calls.at(-1)?.[0]).toBe(CUST);
    expect(findMany.mock.calls.at(-1)?.[0]).toBe(CUST);
    expect(findMany.mock.calls.at(-1)?.[0]).not.toBe(OTHER_CUST);
  });

  // Paging is derived from the count, so the two reads must agree on the filter as well as the
  // customer — a total computed under different filters gives page numbers that lead nowhere.
  it("counts under the same filters it lists under", async () => {
    await listJobsForCustomer(CUST, { status: "completed", search: "fibre" });
    expect(count.mock.calls.at(-1)?.[1]).toEqual(findMany.mock.calls.at(-1)?.[1]);
  });
});

describe("listJobsForCustomer — the stage filter", () => {
  it("expands a stage into every stored status behind it", async () => {
    await listJobsForCustomer(CUST, { status: "scheduled" });
    expect(lastFilters().statuses).toEqual(expect.arrayContaining(["assigned", "accepted", "rejected"]));
  });

  it("narrows to the single status behind a one-to-one stage", async () => {
    await listJobsForCustomer(CUST, { status: "completed" });
    expect(lastFilters().statuses).toEqual(["completed"]);
  });

  // The dashboard's Active-jobs card links here with ?status=active. If this filter and the count
  // resolved to different status sets, the customer would click a "4" and land on a list of 9.
  it("resolves the `active` pseudo-stage to exactly what the dashboard card counts", async () => {
    await listJobsForCustomer(CUST, { status: "active" });
    const listed = lastFilters().statuses;

    await countActiveJobsForCustomer(CUST);
    expect(listed).toEqual(count.mock.calls.at(-1)![1].statuses);
    expect(listed).not.toContain("completed");
    expect(listed).not.toContain("cancelled");
  });

  // The value comes from a URL the customer can edit or paste. An empty table is the ONE answer
  // that misleads — "no jobs" reads as a statement about their account, not about a typo.
  it("widens to every stage on an unrecognised value rather than matching nothing", async () => {
    await listJobsForCustomer(CUST, { status: "draft" });
    expect(lastFilters().statuses).toBeUndefined();

    await listJobsForCustomer(CUST, { status: "nonsense" });
    expect(lastFilters().statuses).toBeUndefined();
  });
});

describe("listJobsForCustomer — what the row carries", () => {
  it("sends the stage, never the stored status", async () => {
    findMany.mockResolvedValue([row({ status: "rejected" })]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.stage).toBe("scheduled");
    expect(jobs[0]).not.toHaveProperty("status");
  });

  // `assignedEngineerName` is a snapshot that SURVIVES the rejection, so the row still names the
  // engineer who declined. Presenting them as the customer's engineer is wrong twice: they are not
  // attending, and the customer would chase someone with no part in the job.
  it("blanks the engineer on a job that is between engineers", async () => {
    findMany.mockResolvedValue([row({ status: "rejected" })]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.engineerName).toBeNull();
  });

  it("names the engineer on a job that actually has one", async () => {
    findMany.mockResolvedValue([row({ status: "in_progress" })]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.engineerName).toBe("Bob Smith");
  });

  // Live relation over snapshot, matching toPublic — otherwise a renamed project has the customer
  // and the office quoting each other different names for the same thing.
  it("prefers the live project and site names over the snapshots", async () => {
    findMany.mockResolvedValue([row()]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.projectName).toBe("Live Project");
    expect(jobs[0]!.siteName).toBe("Live Site");
  });

  it("falls back to the snapshot when the relation is gone", async () => {
    findMany.mockResolvedValue([row({ project: null, site: null })]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.projectName).toBe("Snapshot Project");
    expect(jobs[0]!.siteName).toBe("Snapshot Site");
  });

  it("serialises dates as ISO strings", async () => {
    findMany.mockResolvedValue([row()]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.completionDate).toBe("2026-08-20T00:00:00.000Z");
    expect(jobs[0]!.createdAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("carries a null due date through rather than inventing one", async () => {
    findMany.mockResolvedValue([row({ completionDate: null })]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(jobs[0]!.completionDate).toBeNull();
  });

  // The repository's select is the first line of defence; this is the second. The mapper builds the
  // row field by field, so a widened select still cannot put an internal field on the wire.
  it("emits only the agreed fields — no internal ones, whatever the row holds", async () => {
    findMany.mockResolvedValue([
      { ...row(), notes: "internal", attachments: ["x"], cancelReason: "why", assignedEngineerEmail: "bob@x.com", priority: "urgent" },
    ]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    expect(Object.keys(jobs[0]!).sort()).toEqual(
      [
        "addressLine1", "addressLine2", "city", "completedAt", "completionDate", "country", "county",
        "createdAt", "customerRef", "engineerName", "id", "jobNumber", "jobType", "name",
        // Past the planned date and still live. Added deliberately: the customer already has the due
        // date, so showing it as though nothing were wrong is the version they would rightly object
        // to. It is a FLAG only — no day count, which on their own job reads as an accusation rather
        // than a status, and no internal status vocabulary.
        "overdue",
        "postcode", "projectId", "projectName", "schemeNo", "siteId", "siteName", "stage", "technology",
      ].sort(),
    );
  });
});

describe("getJobForCustomer — the detail page", () => {
  it("scopes the lookup to the caller's company", async () => {
    findById.mockResolvedValue(detailRow());
    await getJobForCustomer(CUST, "j1");
    expect(findById.mock.calls.at(-1)).toEqual(["j1", CUST]);
  });

  // The repository returns null for another company's job, a soft-deleted one and a draft alike, so
  // all three come back as the same 404. Anything more specific would confirm which ids exist.
  it("404s rather than saying why a job is out of reach", async () => {
    findById.mockResolvedValue(null);
    await expect(getJobForCustomer(CUST, "someone-elses-id")).rejects.toMatchObject({
      status: 404,
      message: "Job not found.",
    });
  });

  it("still sends the stage rather than the stored status, and blanks a declined engineer", async () => {
    findById.mockResolvedValue(detailRow({ status: "rejected" }));
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.stage).toBe("scheduled");
    expect(job.engineerName).toBeNull();
    expect(job).not.toHaveProperty("status");
  });

  // The page is a copy of the office's, so it carries the office's fields — the four exclusions
  // below are the whole difference, and they are what this asserts rather than the inclusions.
  it("carries the office cards' fields", async () => {
    findById.mockResolvedValue(detailRow());
    const job = await getJobForCustomer(CUST, "j1");
    expect(job).toMatchObject({
      priority: "urgent",
      trsArea: "North",
      floor: "3",
      rack: "R4",
      plannerName: "Their Planner",
      plannerPhone: "0113 000 0000",
      attachments: ["https://example.com/pack.pdf"],
    });
    expect(job.assignedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(job.customerName).toBe("Live Customer");
  });

  // The four the customer must never see. The repository's select is what actually stops them, so a
  // row carrying them here is the pessimistic case: even handed the values, the mapper drops them.
  it("drops supplier, staff contacts, internal notes and the reject reason", async () => {
    findById.mockResolvedValue({
      ...detailRow(),
      supplierName: "Acme Subcontracting",
      installerType: "external",
      assignedEngineerEmail: "bob@x.com",
      createdBy: "pm@x.com",
      acceptedBy: "bob@x.com",
      notes: "Customer always disputes the invoice",
      rejectReason: "Too far to travel",
      rejectedAt: new Date(),
    });
    const job = await getJobForCustomer(CUST, "j1");
    for (const f of ["supplierName", "installerType", "assignedEngineerEmail", "createdBy", "acceptedBy", "notes", "rejectReason", "rejectedAt"]) {
      expect(job).not.toHaveProperty(f);
    }
  });

  // The denylist above only catches the fields someone thought to name. This is the ALLOWLIST, and
  // it is what actually holds the line: the detail DTO is the widest thing this module puts on a
  // customer's wire, and a field added to the select AND the mapper would otherwise ship silently.
  // Failing here is not a bug to route around — it means a new field is reaching a customer, and the
  // list is only updated once that field is genuinely meant to.
  //
  // `assignedEngineerId` is the case in point: it IS selected (getJobKitTallies needs it) and must
  // NOT appear below. Nothing but this assertion stops a future spread putting it on the wire.
  it("emits exactly the agreed fields and nothing else", async () => {
    findById.mockResolvedValue(detailRow());
    const job = await getJobForCustomer(CUST, "j1");
    expect(Object.keys(job).sort()).toEqual(
      [
        // Identity + the customer's own references
        "id", "jobNumber", "name", "jobType", "technology", "customerRef", "schemeNo", "priority",
        // Customer & project
        "customerName", "projectId", "projectName", "siteId", "siteName", "trsArea",
        // Location
        "addressLine1", "addressLine2", "city", "county", "postcode", "country",
        "floor", "suite", "rack", "shelf",
        // Schedule & engineer. `overdue` rides along from the shared portal mapper but is always
        // FALSE here: the detail read resolves no company-timezone day start, because one date the
        // reader is already looking at does not need a marker, and a page marking late from the wrong
        // clock would contradict the list they arrived from. Present in the shape, inert in effect.
        "completionDate", "overdue", "stage", "engineerName", "plannerName", "plannerPhone",
        "assignedAt", "acceptedAt", "startedAt", "completedAt", "cancelledAt", "cancelReason",
        // The rest
        "attachments", "kitLines", "createdAt",
      ].sort(),
    );
  });

  // Cancel reason IS included where reject reason is not: a cancellation is a decision about the
  // customer's work; a rejection is one of our engineers declining to take it.
  it("keeps the cancel reason", async () => {
    findById.mockResolvedValue(detailRow({ status: "cancelled", cancelReason: "Site access refused" }));
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.cancelReason).toBe("Site access refused");
  });

  it("fills each kit line's tallies from the ONE batched goods lookup", async () => {
    findById.mockResolvedValue(detailRow());
    kitTallies.mockResolvedValue({ kl1: { issued: 10, used: 6, returned: 2, remaining: 2 } });
    const job = await getJobForCustomer(CUST, "j1");
    expect(kitTallies).toHaveBeenCalledTimes(1);
    expect(job.kitLines[0]).toMatchObject({ itemName: "CAT6 Cable", qty: 10, issued: 10, used: 6, returned: 2, remaining: 2 });
  });

  // Hands the job over instead of letting getJobKitTallies re-fetch it — without this it loads the
  // whole record again (every kit line's irmItem join, every pickup warehouse's address) for four
  // fields, one wasted round-trip per page view.
  it("passes the job it already holds to the tallies lookup", async () => {
    findById.mockResolvedValue(detailRow());
    await getJobForCustomer(CUST, "j1");
    const [, prefetched] = kitTallies.mock.calls.at(-1)!;
    expect(prefetched.assignedEngineerId).toBe("eng1");
    // The grouping keys — without them every line would fall into its own group and "remaining"
    // would stop being capped by what the engineer actually holds.
    expect(prefetched.kitLines[0]).toMatchObject({ id: "kl1", lineType: "irm", irmItemId: "irm1" });
  });

  // Those grouping ids are for the tallies lookup only — they are our internal item references.
  it("does not put the source item ids on the wire", async () => {
    findById.mockResolvedValue(detailRow());
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.kitLines[0]).not.toHaveProperty("irmItemId");
    expect(job.kitLines[0]).not.toHaveProperty("customerStockEntryId");
    // Staff-to-staff free text, same rule as the job-level notes.
    expect(job.kitLines[0]).not.toHaveProperty("notes");
  });

  // Validation only guards writes, so a row stored before the http(s) rule still holds whatever was
  // typed — and this surface renders them as links in a customer's browser.
  it("drops an attachment that isn't a safe link, including ones already stored", async () => {
    findById.mockResolvedValue(
      detailRow({ attachments: ["https://ok.com/pack.pdf", "javascript:alert(1)", "just-a-note.docx"] }),
    );
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.attachments).toEqual(["https://ok.com/pack.pdf"]);
  });

  it("withholds internal-only attachments containing #internal from customer portal DTO", async () => {
    findById.mockResolvedValue(
      detailRow({ attachments: ["https://ok.com/public-pack.pdf", "https://ok.com/internal-rams.pdf#internal"] }),
    );
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.attachments).toEqual(["https://ok.com/public-pack.pdf"]);
  });

  it("does NOT falsely withhold a URL whose fragment merely contains 'internal' as a substring", async () => {
    findById.mockResolvedValue(
      detailRow({ attachments: ["https://ok.com/docs#internaldocumentation", "https://ok.com/plan.pdf"] }),
    );
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.attachments).toEqual(["https://ok.com/docs#internaldocumentation", "https://ok.com/plan.pdf"]);
  });

  // Zeroes, not nulls: the table renders an em dash for null, which in that column means "not
  // applicable" (a misc line), not "the warehouse hasn't issued anything yet".
  it("shows zero, not blank, for a line the warehouse has not touched", async () => {
    findById.mockResolvedValue(detailRow());
    kitTallies.mockResolvedValue({});
    const job = await getJobForCustomer(CUST, "j1");
    expect(job.kitLines[0]).toMatchObject({ issued: 0, used: 0, returned: 0, remaining: 0 });
  });
});

describe("countActiveJobsForCustomer — the dashboard card", () => {
  it("counts what is still happening, and nothing that has stopped", async () => {
    await countActiveJobsForCustomer(CUST);
    const [id, filters] = count.mock.calls.at(-1)!;
    expect(id).toBe(CUST);
    expect(filters.statuses).toEqual(expect.arrayContaining(["assigned", "accepted", "rejected", "in_progress"]));
    expect(filters.statuses).not.toContain("completed");
    expect(filters.statuses).not.toContain("cancelled");
    expect(filters.statuses).not.toContain("draft");
  });
});

// The office and engineer lists redden a past-due row; the portal has to agree, because it is the
// same job. Asserting the field EXISTS is not enough — that is exactly how this shipped broken once,
// with `overdue` present on every row and true on none. These pin the VALUE, both ways.
//
// Dates are deliberately absurd (2020 / 2099) so the assertions do not depend on when the suite runs.
describe("listJobsForCustomer — overdue", () => {
  const listOne = async (over: Record<string, unknown>) => {
    findMany.mockResolvedValue([row(over)]);
    count.mockResolvedValue(1);
    const { jobs } = await listJobsForCustomer(CUST);
    return jobs[0]!;
  };

  it("marks a past-due job the customer can still be waiting on", async () => {
    for (const status of ["assigned", "accepted", "in_progress"]) {
      const job = await listOne({ status, completionDate: new Date("2020-01-01T00:00:00.000Z") });
      expect(job.overdue, status).toBe(true);
    }
  });

  it("leaves finished and called-off work alone, however old", async () => {
    for (const status of ["completed", "cancelled", "rejected"]) {
      const job = await listOne({ status, completionDate: new Date("2020-01-01T00:00:00.000Z") });
      expect(job.overdue, status).toBe(false);
    }
  });

  it("says nothing about a job that is not due yet, or has no due date", async () => {
    expect((await listOne({ status: "accepted", completionDate: new Date("2099-01-01T00:00:00.000Z") })).overdue).toBe(false);
    expect((await listOne({ status: "accepted", completionDate: null })).overdue).toBe(false);
  });

  // The day boundary is resolved from the COMPANY's timezone, server-side. If this stopped being
  // read, every row would quietly fall back to the caller's clock — the failure the whole
  // server-derived flag exists to prevent.
  it("resolves the day boundary from the company timezone", async () => {
    const tz = vi.mocked((await import("#modules/settings/settings.service.js")).getCompanyTimezone);
    tz.mockClear();
    await listOne({ status: "accepted", completionDate: new Date("2020-01-01T00:00:00.000Z") });
    expect(tz).toHaveBeenCalled();
  });
});
