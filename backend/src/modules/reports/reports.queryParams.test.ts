import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Scalar query parameters, read the way Express actually delivers them ───────────────────────
//
// `customRequestFrom` cast `req.query` to `Record<string, string | undefined>`. Express does not
// promise that: a DUPLICATED parameter (`?irmItemId=a&irmItemId=b`) arrives as an ARRAY. An array is
// neither `undefined` nor `""`, so it passed the service's emptiness check untouched and reached
// Prisma as an array on a scalar ObjectId equality — a 500 for a malformed request.
//
// The fix is the shared reader (`queryStr`), not a new parser, so these endpoints now behave the way
// every other list endpoint in this codebase already did. These tests drive the REAL controller
// handlers with the shapes Express really produces, and assert on what the service is handed.

const svc = vi.hoisted(() => ({
  runCustomReport: vi.fn(),
  listAvailableReports: vi.fn(() => []),
  REPORT_MAX_ROWS: 5_000,
}));
const scheduleSvc = vi.hoisted(() => ({ listRecipientOptions: vi.fn(async () => []) }));

vi.mock("./customReports.service.js", () => svc);
vi.mock("./reportSchedule.service.js", () => scheduleSvc);
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("./finance.service.js", () => ({ getFinanceSummary: vi.fn(), getFinanceDetail: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: vi.fn(async () => "Europe/London") }));

import { runCustomReport, scheduleRecipientOptions } from "./reports.controller.js";
import type { Request, Response } from "express";

const PRINCIPAL = { id: "u1", type: "user" as const, email: "pm@x.co", permissions: ["reports.view"], assignedWarehouseIds: null };

/** Drive a controller the way Express would, and hand back what it wrote. */
async function call(handler: (req: Request, res: Response, next: (e?: unknown) => void) => unknown, query: unknown) {
  const req = { query, params: {}, principal: PRINCIPAL, get: () => undefined } as unknown as Request;
  const json = vi.fn();
  const res = { json, status: vi.fn(() => res), setHeader: vi.fn(), end: vi.fn() } as unknown as Response;
  const next = vi.fn();
  await handler(req, res, next);
  return { json, error: next.mock.calls[0]?.[0] as { status?: number; message?: string } | undefined };
}

/** The request object the service was handed on the last call. */
const lastRequest = () => svc.runCustomReport.mock.calls.at(-1)![1] as {
  reportKey: string;
  filters: Record<string, unknown>;
  limit?: number;
  cursor: string | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.runCustomReport.mockResolvedValue({
    report: { key: "stock_movement", label: "Stock Movement", description: "", columns: [] },
    rows: [],
    capped: false,
    nextCursor: null,
    hasMore: false,
    appliedFilters: {},
    generatedAt: "2026-05-01T00:00:00.000Z",
  });
});

describe("a duplicated scalar parameter collapses instead of reaching Prisma as an array", () => {
  it("collapses a duplicated filter to its first value", async () => {
    // `?irmItemId=aaa…&irmItemId=bbb…` — the exact shape that 500'd.
    await call(runCustomReport, { report: "stock_movement", irmItemId: ["a".repeat(24), "b".repeat(24)] });

    expect(lastRequest().filters.irmItemId).toBe("a".repeat(24));
  });

  it("collapses every scalar filter, not just the one that was reported", async () => {
    await call(runCustomReport, {
      report: ["stock_movement", "engineer_stock"],
      dateFrom: ["2026-01-01", "2026-06-01"],
      dateTo: ["2026-01-31", "x"],
      customerId: ["c1", "c2"],
      projectId: ["p1", "p2"],
      warehouseId: ["w1", "w2"],
      engineerId: ["e1", "e2"],
      itemKind: ["irm", "customer"],
      cursor: ["cur1", "cur2"],
    });

    const r = lastRequest();
    // The report key too: `String(["a","b"])` produced the string "a,b", which is not a key any
    // report has — a confusing 400 for what is really a malformed query.
    expect(r.reportKey).toBe("stock_movement");
    expect(r.cursor).toBe("cur1");
    expect(r.filters).toMatchObject({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      customerId: "c1",
      projectId: "p1",
      warehouseId: "w1",
      engineerId: "e1",
      itemKind: "irm",
    });
  });

  it("never hands the service a non-string for any filter", async () => {
    await call(runCustomReport, {
      report: "stock_movement",
      // Express's extended parser also produces objects for `?a[b]=c`.
      warehouseId: { $ne: null },
      customerId: ["c1", "c2"],
      engineerId: [],
    });

    for (const [key, value] of Object.entries(lastRequest().filters)) {
      expect(typeof value === "string" || value === undefined, `${key} is ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("a duplicated ?limit= is a 400, not a NaN handed to Prisma", async () => {
    const { error } = await call(runCustomReport, { report: "stock_movement", limit: ["10", "20"] });
    // `queryStr` collapses to "10", which is a valid limit — the point is that it is never NaN.
    expect(error).toBeUndefined();
    expect(lastRequest().limit).toBe(10);
  });

  it("an outright invalid ?limit= is still a controlled 400", async () => {
    const { error } = await call(runCustomReport, { report: "stock_movement", limit: "abc" });
    expect(error?.status).toBe(400);
    expect(svc.runCustomReport).not.toHaveBeenCalled();
  });
});

describe("absent and empty parameters keep their existing meaning", () => {
  it("an absent filter stays undefined", async () => {
    await call(runCustomReport, { report: "stock_movement" });

    const r = lastRequest();
    expect(r.filters.warehouseId).toBeUndefined();
    expect(r.cursor).toBeNull();
    expect(r.limit).toBeUndefined();
  });

  it("an empty filter stays empty — the service treats it as unset, and that is unchanged", async () => {
    await call(runCustomReport, { report: "stock_movement", warehouseId: "" });
    expect(lastRequest().filters.warehouseId).toBe("");
  });

  it("a valid single value passes through untouched", async () => {
    await call(runCustomReport, { report: "stock_movement", warehouseId: "w1", limit: "250" });

    const r = lastRequest();
    expect(r.filters.warehouseId).toBe("w1");
    expect(r.limit).toBe(250);
  });

  it("an ObjectId-shaped value is passed on verbatim — validity is the service's call, not this layer's", async () => {
    await call(runCustomReport, { report: "stock_movement", irmItemId: "not-an-objectid" });
    expect(lastRequest().filters.irmItemId).toBe("not-an-objectid");
  });

  it("a missing report key reaches the service as '' and is refused there, not here", async () => {
    await call(runCustomReport, {});
    expect(lastRequest().reportKey).toBe("");
  });
});

describe("the recipient picker reads its key the same way", () => {
  it("collapses a duplicated ?reportKey= rather than joining it into 'a,b'", async () => {
    await call(scheduleRecipientOptions, { reportKey: ["finance.summary", "stock_movement"] });
    expect(scheduleSvc.listRecipientOptions).toHaveBeenCalledWith(expect.anything(), "finance.summary");
  });

  it("an absent key is the empty string, which the service refuses", async () => {
    await call(scheduleRecipientOptions, {});
    expect(scheduleSvc.listRecipientOptions).toHaveBeenCalledWith(expect.anything(), "");
  });
});
