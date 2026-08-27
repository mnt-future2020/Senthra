import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  findScheduleById: vi.fn(),
  listSchedules: vi.fn(),
  deleteSchedule: vi.fn(),
  listRuns: vi.fn(),
  findEligibleRecipients: vi.fn(),
  findRecipientProfiles: vi.fn(),
  findLatestRuns: vi.fn(),
  RUN_DELIVERED: "delivered",
  MAX_ATTEMPTS: 3,
}));
vi.mock("./reportSchedule.repository.js", () => repo);
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: async () => "Europe/London" }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as svc from "./reportSchedule.service.js";
import * as audit from "#modules/audit/audit.service.js";

// The seeded finance_director: both view rights plus export. Scheduling is an export, so every
// persona that SAVES a schedule below holds `reports.export` — the same pair the download routes ask
// for. The *_NO_EXPORT pair are the read-on-screen-only roles that must be refused.
const FINANCE = {
  id: "u1",
  type: "user" as const,
  email: "fd@x.co",
  permissions: ["reports.view", "reports.finance.view", "reports.export"],
};
const REPORTS_ONLY = { id: "u2", type: "user" as const, email: "pm@x.co", permissions: ["reports.view", "reports.export"] };
const NOBODY = { id: "u3", type: "user" as const, email: "eng@x.co", permissions: [] };
const CUSTOMER = { id: "c1", type: "customer" as const, email: "bt@x.co", permissions: [] };

/** May read the Finance report on screen; may not take the file away. */
const FINANCE_NO_EXPORT = {
  id: "u4",
  type: "user" as const,
  email: "analyst@x.co",
  permissions: ["reports.view", "reports.finance.view"],
};
/** May read operational reports on screen; may not take the file away. */
const REPORTS_NO_EXPORT = { id: "u5", type: "user" as const, email: "coord@x.co", permissions: ["reports.view"] };
/** The super-admin: "*" satisfies every check, including the export one. */
const SUPER_ADMIN = { id: null, type: "admin" as const, email: "root@x.co", permissions: ["*"] };

const input = (over: Record<string, unknown> = {}) => ({
  name: "Monthly IRM report",
  reportKey: "finance.summary",
  cadence: "monthly",
  dayOfMonth: 1,
  hour: 9,
  minute: 0,
  recipients: ["u1"],
  ...over,
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: "sch1",
  name: "Monthly IRM report",
  reportKey: "finance.summary",
  cadence: "monthly",
  enabled: true,
  recipients: ["u1"],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.createSchedule.mockImplementation(async (d: Record<string, unknown>) => ({ id: "sch1", ...d }));
  repo.updateSchedule.mockImplementation(async (id: string, d: Record<string, unknown>) => ({ ...stored(), ...d, id }));
  repo.findScheduleById.mockResolvedValue(stored());
  repo.listSchedules.mockResolvedValue([stored(), stored({ id: "sch2", reportKey: "stock_movement" })]);
  repo.listRuns.mockResolvedValue([]);
  // The eligible set the server derives. Every test that saves a schedule draws from this.
  repo.findEligibleRecipients.mockResolvedValue([
    { id: "u1", name: "Fin Director", email: "fd@x.co" },
    { id: "u9", name: "Ops Lead", email: "ops@x.co" },
  ]);
  repo.findRecipientProfiles.mockResolvedValue([
    { id: "u1", name: "Fin Director", email: "fd@x.co" },
    { id: "u9", name: "Ops Lead", email: "ops@x.co" },
  ]);
  // Health of the newest run per schedule, for the list's failure column. Empty = never run.
  repo.findLatestRuns.mockResolvedValue(new Map());
});

describe("what each actor may schedule", () => {
  it("offers finance AND the operational reports to a finance user", () => {
    const keys = svc.schedulableReports(FINANCE).map((r) => r.key);
    expect(keys).toContain("finance.summary");
    expect(keys).toContain("stock_movement");
  });

  // The core boundary: a reports-only user automates stock reports and is never shown finance.
  it("hides finance from a reports-only user", () => {
    const keys = svc.schedulableReports(REPORTS_ONLY).map((r) => r.key);
    expect(keys).not.toContain("finance.summary");
    expect(keys).toContain("stock_movement");
  });

  it("offers nothing to a user with neither permission", () => {
    expect(svc.schedulableReports(NOBODY)).toEqual([]);
  });

  // Scheduling is an internal, staff-only capability — a customer holds no staff permission at all.
  it("offers nothing to a customer, whatever else is true of them", () => {
    expect(svc.schedulableReports(CUSTOMER)).toEqual([]);
    expect(svc.schedulableReports({ ...CUSTOMER, permissions: ["reports.finance.view"] })).toEqual([]);
  });
});

describe("create — authorization", () => {
  it("lets a finance user create a finance schedule", async () => {
    const s = await svc.createSchedule(FINANCE, input());
    expect(s.reportKey).toBe("finance.summary");
    expect(repo.createSchedule).toHaveBeenCalled();
  });

  it("refuses a finance schedule from a reports-only user", async () => {
    await expect(svc.createSchedule(REPORTS_ONLY, input())).rejects.toThrow(/can't schedule that report/i);
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it("refuses any schedule from a customer", async () => {
    await expect(svc.createSchedule(CUSTOMER, input({ reportKey: "stock_movement" }))).rejects.toThrow(
      /can't schedule that report/i,
    );
  });

  // The same message either way: distinguishing "doesn't exist" from "you may not" tells an
  // unauthorised caller what exists.
  it("gives the same refusal for an unknown report as for an unauthorised one", async () => {
    const unknown = await svc.createSchedule(REPORTS_ONLY, input({ reportKey: "nope" })).catch((e) => e.message);
    const unauthorised = await svc.createSchedule(REPORTS_ONLY, input()).catch((e) => e.message);
    expect(unknown).toBe(unauthorised);
  });
});

describe("create — validation is server-side and authoritative", () => {
  const bad = (over: Record<string, unknown>, re: RegExp) =>
    expect(svc.createSchedule(FINANCE, input(over))).rejects.toThrow(re);

  it("rejects a blank name, a bad cadence and a bad format", async () => {
    await bad({ name: "  " }, /name/i);
    await bad({ cadence: "fortnightly" }, /weekly or monthly/i);
    await bad({ format: "pdf" }, /xlsx or csv/i);
  });

  // 29, 30 and 31 used to be unselectable — a 28-day cap made a month-end report impossible to ask
  // for. They are accepted now; a month too short for the chosen day runs on its last day instead.
  it("accepts every day of the month, and the explicit last-day selection", async () => {
    for (const dayOfMonth of [1, 28, 29, 30, 31, -1]) {
      await expect(svc.createSchedule(FINANCE, input({ dayOfMonth }))).resolves.toMatchObject({ dayOfMonth });
    }
  });

  it("rejects out-of-range day and time", async () => {
    await bad({ cadence: "weekly", dayOfWeek: 0 }, /day of week/i);
    await bad({ cadence: "weekly", dayOfWeek: 8 }, /day of week/i);
    await bad({ dayOfMonth: 0 }, /day of month/i);
    await bad({ dayOfMonth: 32 }, /day of month/i);
    // -1 is the ONE negative value that means something ("last day"); -2 is just wrong.
    await bad({ dayOfMonth: -2 }, /day of month/i);
    await bad({ hour: 24 }, /hour/i);
    await bad({ minute: 60 }, /minute/i);
  });

  // This used to VALIDATE a client-supplied zone. It no longer needs to: the field is not read at all,
  // so an unusable zone cannot reach the database however it is sent.
  it("cannot store an unusable timezone, because it never reads one from the request", async () => {
    const s = await svc.createSchedule(FINANCE, input({ timeZone: "Mars/Olympus" }));
    expect(s.timeZone).toBeNull();
  });

  it("requires at least one recipient, and caps the list", async () => {
    await bad({ recipients: [] }, /at least one recipient/i);
    await bad({ recipients: Array.from({ length: 21 }, (_, i) => `u${i}`) }, /at most 20/i);
  });

  it("rejects a filter the chosen report cannot honour", async () => {
    await expect(
      svc.createSchedule(REPORTS_ONLY, input({ reportKey: "engineer_stock", filters: { customerId: "c1" } })),
    ).rejects.toThrow(/can't be filtered by customerId/i);
  });

  it("rejects a filter name outside the registry vocabulary entirely", async () => {
    await expect(
      svc.createSchedule(REPORTS_ONLY, input({ reportKey: "stock_movement", filters: { sortBy: "price" } })),
    ).rejects.toThrow(/unknown filter/i);
  });

  // The reporting period comes from the cadence. A stored date range would pin every future run to
  // the same period forever.
  it("strips a fixed date range rather than persisting it", async () => {
    const s = await svc.createSchedule(REPORTS_ONLY, {
      ...input({ reportKey: "stock_movement" }),
      filters: { dateFrom: "2026-01-01", dateTo: "2026-01-31", warehouseId: "wh1" },
    });
    expect(s.filters).toEqual({ warehouseId: "wh1" });
  });

  it("stores a report KEY and validated filters — never a query", async () => {
    const s = await svc.createSchedule(REPORTS_ONLY, input({ reportKey: "stock_movement", filters: { warehouseId: "wh1" } }));
    expect(s.reportKey).toBe("stock_movement");
    expect(Object.keys(s.filters as object)).toEqual(["warehouseId"]);
  });
});

describe("create — scheduling maths", () => {
  it("computes a nextRunAt in the future", async () => {
    const s = await svc.createSchedule(FINANCE, input());
    expect((s.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("clears the irrelevant day field for the cadence", async () => {
    const weekly = await svc.createSchedule(FINANCE, input({ cadence: "weekly", dayOfWeek: 3 }));
    expect(weekly.dayOfWeek).toBe(3);
    expect(weekly.dayOfMonth).toBeNull();

    const monthly = await svc.createSchedule(FINANCE, input({ cadence: "monthly", dayOfMonth: 5 }));
    expect(monthly.dayOfMonth).toBe(5);
    expect(monthly.dayOfWeek).toBeNull();
  });
});

describe("update, enable/disable and delete all re-check the boundary", () => {
  it("refuses to edit a finance schedule from a reports-only user", async () => {
    await expect(svc.updateSchedule(REPORTS_ONLY, "sch1", input())).rejects.toThrow(/can't schedule that report/i);
    expect(repo.updateSchedule).not.toHaveBeenCalled();
  });

  // Not even a rename: the check is on the STORED report, before the payload is even considered.
  it("refuses a reports-only user editing a finance schedule even to a report they can run", async () => {
    await expect(
      svc.updateSchedule(REPORTS_ONLY, "sch1", input({ reportKey: "stock_movement" })),
    ).rejects.toThrow(/can't schedule that report/i);
  });

  it("recomputes nextRunAt on update, so an edit is not silently ignored until next period", async () => {
    const s = await svc.updateSchedule(FINANCE, "sch1", input({ cadence: "weekly", dayOfWeek: 5 }));
    expect((s.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("enables and disables, auditing each", async () => {
    await svc.setEnabled(FINANCE, "sch1", false);
    expect(repo.updateSchedule).toHaveBeenCalledWith("sch1", expect.objectContaining({ enabled: false }));
    expect(vi.mocked(audit.record).mock.calls.at(-1)![0].action).toBe("report_schedule.disabled");

    await svc.setEnabled(FINANCE, "sch1", true);
    expect(vi.mocked(audit.record).mock.calls.at(-1)![0].action).toBe("report_schedule.enabled");
  });

  it("refuses enable/disable and delete from an unauthorised user", async () => {
    await expect(svc.setEnabled(REPORTS_ONLY, "sch1", false)).rejects.toThrow(/can't schedule/i);
    await expect(svc.deleteSchedule(REPORTS_ONLY, "sch1")).rejects.toThrow(/can't schedule/i);
    expect(repo.deleteSchedule).not.toHaveBeenCalled();
  });

  it("deletes and audits when authorised", async () => {
    await svc.deleteSchedule(FINANCE, "sch1");
    expect(repo.deleteSchedule).toHaveBeenCalledWith("sch1");
    expect(vi.mocked(audit.record).mock.calls.at(-1)![0].action).toBe("report_schedule.deleted");
  });

  it("404s on a schedule that does not exist", async () => {
    repo.findScheduleById.mockResolvedValue(null);
    await expect(svc.getSchedule(FINANCE, "gone")).rejects.toThrow(/not found/i);
  });
});

describe("listing and run history are filtered by the same rule", () => {
  // A reports-only user must not even learn that a finance schedule exists — its recipients and
  // filters are configuration they are not entitled to.
  it("hides finance schedules from a reports-only user's list", async () => {
    const mine = await svc.listSchedules(REPORTS_ONLY);
    expect(mine.map((s) => s.reportKey)).toEqual(["stock_movement"]);
  });

  it("shows both to a finance user", async () => {
    expect((await svc.listSchedules(FINANCE)).map((s) => s.reportKey)).toEqual(["finance.summary", "stock_movement"]);
  });

  it("returns nothing at all to a user with neither permission", async () => {
    expect(await svc.listSchedules(NOBODY)).toEqual([]);
  });

  it("gates run history behind the same check as the schedule", async () => {
    await expect(svc.listRuns(REPORTS_ONLY, "sch1")).rejects.toThrow(/can't schedule that report/i);
    await expect(svc.listRuns(FINANCE, "sch1")).resolves.toEqual([]);
  });

  // The claim is the scheduler's internal lease: hand it out and a caller learns exactly when a run
  // becomes reclaimable. Run history answers "did it go out", nothing more.
  it("never returns the scheduler's claim token or lease expiry", async () => {
    repo.listRuns.mockResolvedValue([
      {
        id: "run1",
        scheduleId: "sch1",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        periodLabel: "August 2026",
        status: "delivered",
        attempts: 1,
        claimToken: "secret-lease-token",
        claimExpiresAt: new Date("2026-09-01T00:10:00Z"),
        startedAt: new Date("2026-09-01T05:00:00Z"),
        completedAt: new Date("2026-09-01T05:00:09Z"),
        deliveredTo: ["fd@x.co"],
        error: null,
        rowCount: 240,
      },
    ]);

    const [run] = await svc.listRuns(FINANCE, "sch1");
    expect(run).not.toHaveProperty("claimToken");
    expect(run).not.toHaveProperty("claimExpiresAt");
    expect(run).not.toHaveProperty("scheduleId");
    // ...while still carrying everything the history table actually renders.
    expect(run).toMatchObject({ periodLabel: "August 2026", status: "delivered", attempts: 1, rowCount: 240 });
  });
});

describe("timezone comes from Settings -> Company, not from the request", () => {
  it("stores no timezone on a new schedule, so it follows the company setting for life", async () => {
    const created = await svc.createSchedule(FINANCE, input());
    expect(created.timeZone).toBeNull();
  });

  // The whole point of removing the field: a crafted request cannot re-introduce a per-schedule zone.
  it("ignores a timeZone sent by a client instead of honouring it", async () => {
    const created = await svc.createSchedule(FINANCE, input({ timeZone: "America/New_York" }));
    expect(created.timeZone).toBeNull();
    // ...and the fire time was computed in the COMPANY zone. 09:00 London on 1 Oct is 08:00 UTC (BST);
    // in New York it would have been 13:00 UTC, so the stored instant proves which zone was used.
    expect((created.nextRunAt as Date).getUTCHours()).not.toBe(13);
  });

  it("carries an existing schedule's legacy override rather than silently retargeting it", async () => {
    // A row created before the company setting became authoritative. Editing its NAME must not move
    // the hour it fires at.
    repo.findScheduleById.mockResolvedValue(stored({ timeZone: "America/New_York" }));
    const updated = await svc.updateSchedule(FINANCE, "sch1", input({ name: "Renamed" }));
    expect(updated.timeZone).toBe("America/New_York");
  });

  it("cannot introduce an override through an edit either", async () => {
    repo.findScheduleById.mockResolvedValue(stored({ timeZone: null }));
    const updated = await svc.updateSchedule(FINANCE, "sch1", input({ timeZone: "Asia/Tokyo" }));
    expect(updated.timeZone).toBeNull();
  });
});

describe("recipients are real, active, authorised users", () => {
  it("offers only users holding the report's own permission", async () => {
    await svc.listRecipientOptions(FINANCE, "finance.summary");
    expect(repo.findEligibleRecipients).toHaveBeenCalledWith(["reports.finance.view", "reports.export"]);

    await svc.listRecipientOptions(REPORTS_ONLY, "stock_movement");
    expect(repo.findEligibleRecipients).toHaveBeenLastCalledWith(["reports.view", "reports.export"]);
  });

  // Learning who can receive a finance report is itself finance information.
  it("refuses to list recipients for a report the caller may not schedule", async () => {
    await expect(svc.listRecipientOptions(REPORTS_ONLY, "finance.summary")).rejects.toThrow(
      /can't schedule that report/i,
    );
    expect(repo.findEligibleRecipients).not.toHaveBeenCalled();
  });

  // A schedule records WHO was chosen, not the address they had that day.
  it("stores user ids, so a later change of address follows the person", async () => {
    const s = await svc.createSchedule(FINANCE, input({ recipients: ["u1", "u9"] }));
    expect(s.recipients).toEqual(["u1", "u9"]);
  });

  it("normalises a legacy email selection onto the user's id", async () => {
    const s = await svc.createSchedule(FINANCE, input({ recipients: ["FD@X.CO"] }));
    expect(s.recipients).toEqual(["u1"]);
  });

  it("de-duplicates a user selected twice, however they were named", async () => {
    const s = await svc.createSchedule(FINANCE, input({ recipients: ["u1", "fd@x.co"] }));
    expect(s.recipients).toEqual(["u1"]);
  });

  // THE security test: the selection is a suggestion, and the server re-derives the truth. Whether
  // the id belongs to nobody, to a suspended user, or to somebody without the report's permission, it
  // never reaches the eligible set and so it is refused.
  it("rejects a crafted user id that is not in the server-derived set", async () => {
    await expect(svc.createSchedule(FINANCE, input({ recipients: ["u404"] }))).rejects.toThrow(
      /isn't an active user authorised to receive/i,
    );
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it("rejects a crafted email that belongs to no eligible user", async () => {
    await expect(svc.createSchedule(FINANCE, input({ recipients: ["outsider@evil.co"] }))).rejects.toThrow(
      /isn't an active user authorised to receive/i,
    );
  });

  it("rejects an unauthorised recipient smuggled in beside a valid one", async () => {
    await expect(svc.createSchedule(FINANCE, input({ recipients: ["u1", "u404"] }))).rejects.toThrow(
      /isn't an active user authorised to receive/i,
    );
  });

  // An inactive, soft-deleted or email-less user is simply absent from findEligibleRecipients, which
  // is the repository's job; the service must then refuse them exactly like any other stranger.
  it("rejects anyone the eligibility query left out", async () => {
    repo.findEligibleRecipients.mockResolvedValue([]);
    await expect(svc.createSchedule(FINANCE, input())).rejects.toThrow(/isn't an active user authorised/i);
  });

  it("re-checks on update, so an edit cannot smuggle a recipient past the create-time check", async () => {
    await expect(svc.updateSchedule(FINANCE, "sch1", input({ recipients: ["u404"] }))).rejects.toThrow(
      /isn't an active user authorised/i,
    );
    expect(repo.updateSchedule).not.toHaveBeenCalled();
  });

  // A Finance schedule and a stock schedule ask different questions of the directory.
  it("validates against the permission of the report BEING SAVED", async () => {
    await svc.createSchedule(REPORTS_ONLY, input({ reportKey: "stock_movement", recipients: ["u1"] }));
    expect(repo.findEligibleRecipients).toHaveBeenLastCalledWith(["reports.view", "reports.export"]);
  });
});

describe("send-time authorisation — eligibility is re-checked on every run", () => {
  const schedule = (recipients: string[], reportKey = "finance.summary") => ({ reportKey, recipients });

  it("sends to the recipient's CURRENT email, not the one stored when it was set up", async () => {
    repo.findEligibleRecipients.mockResolvedValue([{ id: "u1", name: "Fin Director", email: "new-address@x.co" }]);
    expect(await svc.resolveDeliverableRecipients(schedule(["u1"]))).toEqual({
      emails: ["new-address@x.co"],
      excluded: 0,
    });
  });

  // The reason this exists: a schedule is a standing instruction, and authorising once at save time
  // would let somebody keep receiving the Finance report after losing the right to open it.
  it("drops a selected user who is no longer eligible, and keeps sending to the rest", async () => {
    repo.findEligibleRecipients.mockResolvedValue([{ id: "u9", name: "Ops Lead", email: "ops@x.co" }]);
    expect(await svc.resolveDeliverableRecipients(schedule(["u1", "u9"]))).toEqual({
      emails: ["ops@x.co"],
      excluded: 1,
    });
  });

  it("reports a COUNT of exclusions, never who or why", async () => {
    repo.findEligibleRecipients.mockResolvedValue([]);
    const out = await svc.resolveDeliverableRecipients(schedule(["u1", "u9"]));
    // Run history is visible to everyone who can see the schedule; one person's permission state is
    // not another's business.
    expect(out).toEqual({ emails: [], excluded: 2 });
    expect(JSON.stringify(out)).not.toMatch(/u1|u9|permission/i);
  });

  it("resolves a legacy email row against the same live set", async () => {
    repo.findEligibleRecipients.mockResolvedValue([{ id: "u1", name: "Fin Director", email: "fd@x.co" }]);
    expect(await svc.resolveDeliverableRecipients(schedule(["fd@x.co"]))).toEqual({
      emails: ["fd@x.co"],
      excluded: 0,
    });
  });

  it("checks against the report's OWN permission", async () => {
    await svc.resolveDeliverableRecipients(schedule(["u1"], "finance.summary"));
    expect(repo.findEligibleRecipients).toHaveBeenLastCalledWith(["reports.finance.view", "reports.export"]);
    await svc.resolveDeliverableRecipients(schedule(["u1"], "stock_movement"));
    expect(repo.findEligibleRecipients).toHaveBeenLastCalledWith(["reports.view", "reports.export"]);
  });

  // A schedule pointing at a removed report has no permission to check against, so nobody is
  // deliverable — the scheduler turns that into a failed run rather than an unchecked send.
  it("deems nobody deliverable when the report no longer exists", async () => {
    expect(await svc.resolveDeliverableRecipients(schedule(["u1"], "gone"))).toEqual({ emails: [], excluded: 1 });
    expect(repo.findEligibleRecipients).not.toHaveBeenCalled();
  });

  it("does not need an actor — the scheduler runs unattended", async () => {
    repo.findEligibleRecipients.mockResolvedValue([{ id: "u1", name: "Fin Director", email: "fd@x.co" }]);
    await expect(svc.resolveDeliverableRecipients(schedule(["u1"]))).resolves.toBeTruthy();
  });
});

describe("the list is readable — stored ids are resolved for display", () => {
  // The regression this prevents: recipients became user ids, and the list column went on rendering
  // the stored value — so a one-recipient schedule showed a 24-character ObjectId where an address
  // used to be, and an older row beside it still showed an email.
  it("returns a label for every stored id, in the same order", async () => {
    repo.listSchedules.mockResolvedValue([stored({ recipients: ["u9", "u1"] })]);
    const [s] = await svc.listSchedules(FINANCE);
    expect(s!.recipientLabels).toEqual(["ops@x.co", "fd@x.co"]);
    // The ids are still there — the edit form selects against them.
    expect(s!.recipients).toEqual(["u9", "u1"]);
  });

  it("resolves a legacy email row too, without a migration", async () => {
    repo.listSchedules.mockResolvedValue([stored({ recipients: ["FD@X.CO"] })]);
    expect((await svc.listSchedules(FINANCE))[0]!.recipientLabels).toEqual(["fd@x.co"]);
  });

  // A deleted user still occupies a slot in the list; a blank cell would read as "no recipients".
  it("names a recipient it cannot resolve rather than leaving a gap", async () => {
    repo.findRecipientProfiles.mockResolvedValue([]);
    repo.listSchedules.mockResolvedValue([stored({ recipients: ["u1", "u404"] })]);
    expect((await svc.listSchedules(FINANCE))[0]!.recipientLabels).toEqual(["Unknown user", "Unknown user"]);
  });

  // One lookup for the whole page, not one per row.
  it("resolves every schedule in a single query", async () => {
    repo.listSchedules.mockResolvedValue([
      stored({ id: "a", recipients: ["u1"] }),
      stored({ id: "b", recipients: ["u9"] }),
      stored({ id: "c", recipients: ["u1", "u9"] }),
    ]);
    await svc.listSchedules(FINANCE);
    expect(repo.findRecipientProfiles).toHaveBeenCalledTimes(1);
    expect(repo.findRecipientProfiles).toHaveBeenCalledWith(["u1", "u9", "u1", "u9"]);
  });

  it("does not query at all when there is nothing to show", async () => {
    repo.listSchedules.mockResolvedValue([]);
    expect(await svc.listSchedules(FINANCE)).toEqual([]);
    expect(repo.findRecipientProfiles).not.toHaveBeenCalled();
  });
});

// ── Scheduling is an EXPORT ────────────────────────────────────────────────────────────────────
//
// A scheduled report runs the same builders the download routes run and mails the resulting file
// out on a cadence. So it needs the same pair those routes need — the report's own view right PLUS
// `reports.export` — and NOT a fourth `reports.schedule` permission. Without this, `reports.export`
// would be a UI preference: denied the download button, granted the same workbook by asking the
// scheduler to send it every Monday.
describe("scheduling requires reports.export, because a scheduled report is an export", () => {
  describe("create", () => {
    it("refuses a finance schedule from someone who may VIEW finance but not export", async () => {
      await expect(svc.createSchedule(FINANCE_NO_EXPORT, input())).rejects.toMatchObject({ status: 403 });
      expect(repo.createSchedule).not.toHaveBeenCalled();
    });

    it("refuses an operational schedule from someone who may VIEW reports but not export", async () => {
      await expect(
        svc.createSchedule(REPORTS_NO_EXPORT, input({ reportKey: "stock_movement", recipients: ["u9"] })),
      ).rejects.toMatchObject({ status: 403 });
      expect(repo.createSchedule).not.toHaveBeenCalled();
    });

    it("allows it once export is granted alongside the view right", async () => {
      await expect(svc.createSchedule(FINANCE, input())).resolves.toBeTruthy();
      await expect(
        svc.createSchedule(REPORTS_ONLY, input({ reportKey: "stock_movement", recipients: ["u9"] })),
      ).resolves.toBeTruthy();
    });

    // "*" must keep satisfying every check — the super-admin holds no literal `reports.export` row.
    it("lets the super-admin's wildcard through", async () => {
      await expect(svc.createSchedule(SUPER_ADMIN, input())).resolves.toBeTruthy();
    });

    // Export alone is not a back door: it says how data may leave, never which data may be reached.
    it("does not let export alone substitute for the report's view right", async () => {
      const EXPORT_ONLY = { id: "u6", type: "user" as const, email: "x@x.co", permissions: ["reports.export"] };
      await expect(svc.createSchedule(EXPORT_ONLY, input())).rejects.toMatchObject({ status: 403 });
      await expect(
        svc.createSchedule(EXPORT_ONLY, input({ reportKey: "stock_movement", recipients: ["u9"] })),
      ).rejects.toMatchObject({ status: 403 });
    });

    // The finance split survives the new gate: export does NOT unlock the money report.
    it("still refuses finance to an operational user who holds export", async () => {
      await expect(svc.createSchedule(REPORTS_ONLY, input())).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("edit", () => {
    it("refuses an edit from a view-only user, even to a schedule they can see", async () => {
      repo.findScheduleById.mockResolvedValue(stored());
      await expect(svc.updateSchedule(FINANCE_NO_EXPORT, "sch1", input())).rejects.toMatchObject({ status: 403 });
      expect(repo.updateSchedule).not.toHaveBeenCalled();
    });

    // The edit path must not be looser than the create path — an existing schedule is still a
    // standing export, and retargeting its recipients is the act with the most reach.
    it("refuses a recipient change from a view-only user", async () => {
      repo.findScheduleById.mockResolvedValue(stored());
      await expect(
        svc.updateSchedule(FINANCE_NO_EXPORT, "sch1", input({ recipients: ["u1", "u9"] })),
      ).rejects.toMatchObject({ status: 403 });
      expect(repo.updateSchedule).not.toHaveBeenCalled();
    });

    it("allows the same edit once export is held", async () => {
      repo.findScheduleById.mockResolvedValue(stored());
      await expect(svc.updateSchedule(FINANCE, "sch1", input())).resolves.toBeTruthy();
    });
  });

  // Asymmetric on purpose: stopping an export is always allowed, restarting one is an export.
  describe("pause and resume", () => {
    it("lets a view-only user PAUSE a schedule", async () => {
      repo.findScheduleById.mockResolvedValue(stored());
      await expect(svc.setEnabled(FINANCE_NO_EXPORT, "sch1", false)).resolves.toBeTruthy();
      expect(repo.updateSchedule).toHaveBeenCalledWith("sch1", expect.objectContaining({ enabled: false }));
    });

    it("refuses a view-only user RESUMING one", async () => {
      repo.findScheduleById.mockResolvedValue(stored({ enabled: false }));
      await expect(svc.setEnabled(FINANCE_NO_EXPORT, "sch1", true)).rejects.toMatchObject({ status: 403 });
      expect(repo.updateSchedule).not.toHaveBeenCalled();
    });

    it("lets an export holder resume", async () => {
      repo.findScheduleById.mockResolvedValue(stored({ enabled: false }));
      await expect(svc.setEnabled(FINANCE, "sch1", true)).resolves.toBeTruthy();
    });
  });

  // Reading configuration and delivery state extracts nothing, so it stays on the view rights alone.
  describe("reads are NOT gated on export — nothing leaves the system", () => {
    it("still lists schedules for a view-only user", async () => {
      const list = await svc.listSchedules(FINANCE_NO_EXPORT);
      expect(list.map((s) => s.id)).toEqual(["sch1", "sch2"]);
    });

    it("still opens a schedule and its run history for a view-only user", async () => {
      repo.findScheduleById.mockResolvedValue(stored());
      await expect(svc.getSchedule(FINANCE_NO_EXPORT, "sch1")).resolves.toBeTruthy();
      await expect(svc.listRuns(FINANCE_NO_EXPORT, "sch1")).resolves.toEqual([]);
    });

    // The dropdown is view-based: a view-only user still sees WHICH reports exist, they just cannot
    // save one. Narrowing this would wrongly empty the list for the read-only surface above.
    it("still reports what the view rights make schedulable", () => {
      expect(svc.schedulableReports(FINANCE_NO_EXPORT).map((r) => r.key)).toContain("finance.summary");
    });
  });

  // The picker only fills a form this actor cannot save; gating it costs nothing and stops a
  // view-only user enumerating who holds the finance right.
  describe("recipient selection", () => {
    it("refuses the recipient directory to a view-only user", async () => {
      await expect(svc.listRecipientOptions(FINANCE_NO_EXPORT, "finance.summary")).rejects.toMatchObject({
        status: 403,
      });
      expect(repo.findEligibleRecipients).not.toHaveBeenCalled();
    });

    it("serves it to an export holder, filtered by the report's own permission", async () => {
      await svc.listRecipientOptions(FINANCE, "finance.summary");
      expect(repo.findEligibleRecipients).toHaveBeenCalledWith(["reports.finance.view", "reports.export"]);
    });

    // A RECIPIENT needs `reports.export` too.
    //
    // This block used to assert the opposite, on the reasoning that "the extraction is the schedule
    // owner's act". It is not: the owner sets it up once, the recipient receives the file every month.
    // Asking less of the person who ends up holding the workbook than of the person who scheduled it
    // inverted the split — someone deliberately denied `reports.export`, with the download buttons
    // hidden and the routes answering 403, was emailed the same bytes on a cadence.
    it("requires export of a RECIPIENT, not just the report's view right", async () => {
      await svc.listRecipientOptions(REPORTS_ONLY, "stock_movement");
      expect(repo.findEligibleRecipients).toHaveBeenCalledWith(["reports.view", "reports.export"]);
    });

    // Send-time re-resolution is unattended and has no actor; it must not start demanding export.
    it("still resolves deliverable recipients at send time with no actor at all", async () => {
      const out = await svc.resolveDeliverableRecipients({ reportKey: "finance.summary", recipients: ["u1"] });
      expect(out).toEqual({ emails: ["fd@x.co"], excluded: 0 });
    });
  });
});

// ── Delete is an EXPORT-level act, not an off switch ──────────────────────────────────────────
//
// Pause and delete were gated alike, on the reasoning that both "stop files leaving". Only pause
// does: it is reversible, keeps the configuration and the run history, and is the lever an operator
// reaches for when a schedule misfires — the one moment a permission check must not get in the way.
// Delete destroys a schedule a view-only user could never have built, and its delivery record.
describe("deleting a schedule needs the same right as creating one", () => {
  it("refuses a user who may read schedules but not export", async () => {
    await expect(svc.deleteSchedule(FINANCE_NO_EXPORT, "sch1")).rejects.toThrow(/export/i);
    expect(repo.deleteSchedule).not.toHaveBeenCalled();
  });

  // The asymmetry is deliberate and must stay: the off switch stays open to anyone who can see it.
  it("still lets that same user PAUSE it", async () => {
    await expect(svc.setEnabled(FINANCE_NO_EXPORT, "sch1", false)).resolves.toBeDefined();
  });

  it("refuses that user the RESUME, which restarts the extraction", async () => {
    await expect(svc.setEnabled(FINANCE_NO_EXPORT, "sch1", true)).rejects.toThrow(/export/i);
  });
});

// ── A failing schedule has to be legible from the LIST ────────────────────────────────────────
//
// After MAX_ATTEMPTS the scheduler gives up on the period and advances, so the row goes back to an
// "Active" badge and a future "Next run" while the report is no longer arriving. The only place that
// showed was one schedule's own run-history modal — found, never noticed. A report that silently
// stopped is the failure this whole module exists to prevent.
describe("the list carries the last run's health", () => {
  const runRow = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    scheduleId: "sch1",
    status: "delivered",
    attempts: 1,
    error: null,
    ...over,
  });

  beforeEach(() => {
    repo.listSchedules.mockResolvedValue([
      { id: "sch1", reportKey: "finance.summary", name: "Monthly", recipients: ["u1"], enabled: true },
    ]);
  });

  it("reports a schedule that has never run as exactly that", async () => {
    repo.findLatestRuns.mockResolvedValue(new Map());
    const [row] = await svc.listSchedules(FINANCE);
    expect(row!.lastRunStatus).toBeNull();
    expect(row!.lastRunExhausted).toBe(false);
  });

  it("flags a schedule whose last run burnt every attempt", async () => {
    repo.findLatestRuns.mockResolvedValue(
      new Map([["sch1", runRow({ status: "failed", attempts: 3, error: "SMTP refused" })]]),
    );
    const [row] = await svc.listSchedules(FINANCE);
    expect(row!.lastRunExhausted, "this is the row that looks Active but is dead").toBe(true);
    expect(row!.lastRunStatus).toBe("failed");
    expect(row!.lastRunError).toBe("SMTP refused");
  });

  // A failure with retries LEFT is not yet a problem — the next sweep will have another go, and
  // shouting about it would train people to ignore the banner that matters.
  it("does not flag a failure that still has attempts left", async () => {
    repo.findLatestRuns.mockResolvedValue(new Map([["sch1", runRow({ status: "failed", attempts: 1 })]]));
    const [row] = await svc.listSchedules(FINANCE);
    expect(row!.lastRunExhausted).toBe(false);
    expect(row!.lastRunStatus).toBe("failed");
  });

  it("never flags a delivered run, whatever its attempt count", async () => {
    repo.findLatestRuns.mockResolvedValue(new Map([["sch1", runRow({ status: "delivered", attempts: 3 })]]));
    const [row] = await svc.listSchedules(FINANCE);
    expect(row!.lastRunExhausted).toBe(false);
  });

  it("resolves the health of every schedule in one query", async () => {
    repo.findLatestRuns.mockResolvedValue(new Map());
    await svc.listSchedules(FINANCE);
    expect(repo.findLatestRuns).toHaveBeenCalledTimes(1);
    expect(repo.findLatestRuns).toHaveBeenCalledWith(["sch1"]);
  });
});

// ── Editing must not throw away a period that is still owed a retry ───────────────────────────
//
// A failed run leaves `nextRunAt` in the PAST on purpose, so the next sweep retries that period.
// Recomputing it from `new Date()` on every edit pushed it into the future and silently dropped the
// retry — so fixing the recipient list after a failure, the single most likely reason anyone edits a
// failing schedule, was exactly what discarded that month's report.
describe("updateSchedule preserves a pending run", () => {
  const stored = {
    id: "sch1",
    name: "Monthly IRM report",
    reportKey: "finance.summary",
    cadence: "monthly",
    dayOfWeek: null,
    dayOfMonth: 1,
    hour: 6,
    minute: 0,
    timeZone: null,
    format: "xlsx",
    recipients: ["u1"],
    filters: null,
    enabled: true,
    // In the PAST: the last period failed and is awaiting its retry.
    nextRunAt: new Date("2026-09-01T05:00:00.000Z"),
  };
  const base = { name: "Monthly IRM report", reportKey: "finance.summary", cadence: "monthly", dayOfMonth: 1, hour: 6, minute: 0, recipients: ["u1"] };

  beforeEach(() => {
    repo.findScheduleById.mockResolvedValue(stored);
    repo.updateSchedule.mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve({ ...stored, ...data }));
  });

  it("keeps nextRunAt when only the recipients change", async () => {
    await svc.updateSchedule(FINANCE, "sch1", { ...base, recipients: ["u1", "u9"] });
    expect(repo.updateSchedule.mock.calls[0]![1].nextRunAt).toEqual(stored.nextRunAt);
  });

  it("keeps nextRunAt when only the name or format changes", async () => {
    await svc.updateSchedule(FINANCE, "sch1", { ...base, name: "Renamed", format: "csv" });
    expect(repo.updateSchedule.mock.calls[0]![1].nextRunAt).toEqual(stored.nextRunAt);
  });

  // A timing change is the one case where the edit is ABOUT when it fires, so it must move — or the
  // change would look ignored until the following period.
  it("recomputes nextRunAt when the day changes", async () => {
    await svc.updateSchedule(FINANCE, "sch1", { ...base, dayOfMonth: 15 });
    expect(repo.updateSchedule.mock.calls[0]![1].nextRunAt).not.toEqual(stored.nextRunAt);
  });

  it("recomputes nextRunAt when the time changes", async () => {
    await svc.updateSchedule(FINANCE, "sch1", { ...base, hour: 9 });
    expect(repo.updateSchedule.mock.calls[0]![1].nextRunAt).not.toEqual(stored.nextRunAt);
  });

  it("recomputes nextRunAt when the cadence changes", async () => {
    await svc.updateSchedule(FINANCE, "sch1", { ...base, cadence: "weekly", dayOfWeek: 1 });
    expect(repo.updateSchedule.mock.calls[0]![1].nextRunAt).not.toEqual(stored.nextRunAt);
  });
});
