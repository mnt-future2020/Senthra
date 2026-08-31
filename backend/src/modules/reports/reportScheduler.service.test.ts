import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  findDueSchedules: vi.fn(),
  createRunIfAbsent: vi.fn(),
  findRun: vi.fn(),
  claimRun: vi.fn(),
  recordDelivery: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  advanceSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  MAX_ATTEMPTS: 3,
  RUN_DELIVERED: "delivered",
}));
const mail = vi.hoisted(() => ({ sendTemplatedEmail: vi.fn() }));
const { resolveRecipients } = vi.hoisted(() => ({ resolveRecipients: vi.fn() }));
const fin = vi.hoisted(() => ({ getFinanceSummary: vi.fn(), getFinanceDetail: vi.fn() }));

vi.mock("./reportSchedule.repository.js", () => repo);
// Send-time recipient resolution lives in the schedule service; the core just consumes it.
vi.mock("./reportSchedule.service.js", () => ({ resolveDeliverableRecipients: resolveRecipients }));
vi.mock("#modules/email/email.service.js", () => mail);
// The scheduler checks the template is ENABLED before sending — a disabled row makes
// sendTemplatedEmail a silent no-op, which would otherwise be recorded as a successful delivery.
const templateRepo = vi.hoisted(() => ({ findByKey: vi.fn() }));
vi.mock("#modules/email/emailTemplate.repository.js", () => templateRepo);
vi.mock("./finance.service.js", () => fin);
vi.mock("./finance.xlsx.js", () => ({
  buildFinanceWorkbook: vi.fn(async () => Buffer.from("xlsx")),
  financeWorkbookFilename: () => "Finance_Report_2026-10-01.xlsx",
  XLSX_MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}));
vi.mock("./customReports.xlsx.js", () => ({
  buildCustomReportWorkbook: vi.fn(async () => Buffer.from("xlsx")),
  customReportFilename: () => "stock-movement-2026-10-01.xlsx",
}));
vi.mock("./customReports.service.js", () => ({
  runCustomReport: vi.fn(async () => ({ report: { key: "stock_movement" }, rows: [{ a: 1 }], generatedAt: "2026-10-01T00:00:00.000Z" })),
  REPORT_MAX_ROWS: 5000,
}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: async () => "Europe/London" }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import { runDueSchedules } from "./reportScheduler.service.js";
import { completedPeriod, LAST_DAY_OF_MONTH, nextRunAfter } from "./reports.period.js";

const TZ = "Europe/London";
const iso = (d: Date) => d.toISOString();

const schedule = (over: Record<string, unknown> = {}) => ({
  id: "sch1",
  name: "Monthly IRM report",
  reportKey: "finance.summary",
  cadence: "monthly",
  timeZone: null,
  recipients: ["fd@x.co"],
  filters: null,
  enabled: true,
  nextRunAt: new Date("2026-10-01T00:00:00.000Z"),
  lastRunAt: null,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: "run1",
  scheduleId: "sch1",
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-09-30T23:59:59.999Z"),
  periodLabel: "Sep 2026",
  status: "pending",
  attempts: 0,
  ...over,
});

// 5 October — the September period is complete.
const NOW = new Date("2026-10-05T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  repo.findDueSchedules.mockResolvedValue([schedule()]);
  repo.createRunIfAbsent.mockResolvedValue(run());
  repo.findRun.mockResolvedValue(run());
  repo.claimRun.mockResolvedValue(true);
  repo.recordDelivery.mockResolvedValue(true);
  repo.completeRun.mockResolvedValue(true);
  repo.failRun.mockResolvedValue(true);
  repo.advanceSchedule.mockResolvedValue(true);
  mail.sendTemplatedEmail.mockResolvedValue(undefined);
  templateRepo.findByKey.mockResolvedValue({ key: "report.scheduled", enabled: true });
  resolveRecipients.mockResolvedValue({ emails: ["fd@x.co"], excluded: 0 });
  fin.getFinanceSummary.mockResolvedValue({
    generatedAt: "2026-10-05T09:00:00.000Z",
    tracking: { poCount: 7, supplierCount: 3 },
    totals: { netPence: 123456 },
  });
  fin.getFinanceDetail.mockResolvedValue({ rows: [{}, {}] });
});

describe("reporting period — always the period that just ENDED", () => {
  // Emailing "October so far" on 5 October would be a different report from the one the same schedule
  // sent in September, and two runs of a cadence must be comparable.
  it("a monthly schedule run in October reports SEPTEMBER", () => {
    const p = completedPeriod(TZ, "monthly", NOW);
    expect(iso(p.from)).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(p.to)).toBe("2026-09-30T23:59:59.999Z");
    expect(p.label).toBe("Sep 2026");
  });

  it("a weekly schedule reports the previous Monday–Sunday week", () => {
    // 5 Oct 2026 is a Monday, so the completed week is Mon 28 Sep – Sun 4 Oct.
    const p = completedPeriod(TZ, "weekly", NOW);
    expect(iso(p.from)).toBe("2026-09-28T00:00:00.000Z");
    expect(iso(p.to)).toBe("2026-10-04T23:59:59.999Z");
  });

  // The BST trap: at 23:30 UTC on 30 September it is already 1 October in London, so the completed
  // month is SEPTEMBER. A UTC-only boundary would have reported August for that hour.
  it("resolves the boundary in the company timezone, not UTC", () => {
    const p = completedPeriod(TZ, "monthly", new Date("2026-09-30T23:30:00.000Z"));
    expect(iso(p.from)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("an explicit schedule timezone overrides the company default", () => {
    // Midnight UTC on 1 Oct is still 30 Sep in New York, so its completed month is AUGUST.
    const p = completedPeriod("America/New_York", "monthly", new Date("2026-10-01T00:30:00.000Z"));
    expect(iso(p.from)).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("next run — always forward, one period at a time", () => {
  // Default fire time is 06:00 LOCAL. November is GMT, so 06:00 local is 06:00 UTC.
  it("a monthly schedule next fires on the 1st of next month at its local time", () => {
    expect(iso(nextRunAfter(TZ, "monthly", NOW))).toBe("2026-11-01T06:00:00.000Z");
  });

  // October is still BST (+1), so the SAME 06:00 local is 05:00 UTC. This pair is the whole point of
  // converting through the zone rather than adding hours to a UTC midnight: "06:00 in London" must
  // stay 06:00 in both halves of the year, and a naive offset would drift by an hour every summer.
  it("a weekly schedule next fires on the following Monday, shifted correctly for BST", () => {
    expect(iso(nextRunAfter(TZ, "weekly", NOW))).toBe("2026-10-12T05:00:00.000Z");
  });

  it("honours an explicit day and time within the cadence", () => {
    // Friday (ISO 5) at 17:30 local, in BST → 16:30 UTC.
    expect(iso(nextRunAfter(TZ, "weekly", NOW, { dayOfWeek: 5, hour: 17, minute: 30 }))).toBe("2026-10-09T16:30:00.000Z");
    // The 15th at 09:00 local, still BST in October.
    expect(iso(nextRunAfter(TZ, "monthly", NOW, { dayOfMonth: 15, hour: 9, minute: 0 }))).toBe("2026-10-15T08:00:00.000Z");
  });

  // The fire time moves WHEN it runs; it must never move WHICH period the run covers, or the
  // idempotency key would shift and the same period could be delivered twice.
  it("changing the fire time does not change the reported period", () => {
    const early = completedPeriod(TZ, "monthly", NOW);
    const late = completedPeriod(TZ, "monthly", new Date("2026-10-28T22:00:00.000Z"));
    expect(iso(late.from)).toBe(iso(early.from));
  });

  // A schedule whose clock fell behind (the process was down) must advance by ONE period per sweep,
  // never compute a next run in the past and spin. The skipped periods stay visible as absent runs.
  it("never returns a time at or before the moment it was asked about", () => {
    for (const when of ["2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z", "2026-02-28T12:00:00.000Z"]) {
      const at = new Date(when);
      expect(nextRunAfter(TZ, "monthly", at).getTime()).toBeGreaterThan(at.getTime());
      expect(nextRunAfter(TZ, "weekly", at).getTime()).toBeGreaterThan(at.getTime());
    }
  });
});

describe("monthly day-of-month — every day selectable, nothing silently skipped", () => {
  // The client documents say only "Weekly / Monthly / On-demand" and never define day-of-month, so
  // this is a documented product decision. The rule: a day that does not exist in a month runs on
  // that month's LAST day, and -1 means month-end explicitly.
  const on = (dayOfMonth: number, from: string) =>
    iso(nextRunAfter(TZ, "monthly", new Date(from), { dayOfMonth, hour: 6, minute: 0 }));

  it("runs the 31st on the 31st where it exists", () => {
    // October has 31 days. BST ends on 25 October 2026, so by the 31st 06:00 local is 06:00 UTC —
    // while a mid-October run of the same schedule would be 05:00 UTC. The zone conversion is done
    // for the day it actually fires, not for the month.
    expect(on(31, "2026-10-01T00:00:00.000Z")).toBe("2026-10-31T06:00:00.000Z");
  });

  it("clamps a day the month does not have to that month's last day", () => {
    // The failure this replaces: a 28-day cap made the 29th, 30th and 31st simply unselectable.
    expect(on(31, "2026-11-01T00:00:00.000Z")).toBe("2026-11-30T06:00:00.000Z"); // Nov has 30
    expect(on(30, "2026-02-01T00:00:00.000Z")).toBe("2026-02-28T06:00:00.000Z"); // Feb 2026 has 28
    expect(on(31, "2026-04-01T00:00:00.000Z")).toBe("2026-04-30T05:00:00.000Z"); // Apr has 30
  });

  it("clamps to 29 February in a leap year, not to 28", () => {
    expect(on(31, "2028-02-01T00:00:00.000Z")).toBe("2028-02-29T06:00:00.000Z");
    expect(on(29, "2028-02-01T00:00:00.000Z")).toBe("2028-02-29T06:00:00.000Z");
    // ...and 29 is still unavailable in a common year, so it lands on the 28th.
    expect(on(29, "2027-02-01T00:00:00.000Z")).toBe("2027-02-28T06:00:00.000Z");
  });

  it("clamps DOWN rather than rolling into the next month", () => {
    // Rolling 31 Feb to 3 March would put the run inside the period the MARCH run reports: February
    // would never be announced on its own and March would be covered twice.
    expect(on(31, "2026-02-01T00:00:00.000Z")).toBe("2026-02-28T06:00:00.000Z");
  });

  it("resolves LAST_DAY_OF_MONTH per month rather than fixing one day number", () => {
    expect(on(LAST_DAY_OF_MONTH, "2026-02-01T00:00:00.000Z")).toBe("2026-02-28T06:00:00.000Z");
    expect(on(LAST_DAY_OF_MONTH, "2026-04-01T00:00:00.000Z")).toBe("2026-04-30T05:00:00.000Z");
    expect(on(LAST_DAY_OF_MONTH, "2026-12-01T00:00:00.000Z")).toBe("2026-12-31T06:00:00.000Z");
  });

  // The advance path resolves the day AGAIN against the following month; reusing the first month's
  // day index would put a 31st schedule on 1 December after November.
  it("re-resolves the day when it rolls to the next month", () => {
    // Asked on 31 Oct after the fire time has passed — the next run is November's clamped day.
    expect(on(31, "2026-10-31T23:00:00.000Z")).toBe("2026-11-30T06:00:00.000Z");
    expect(on(LAST_DAY_OF_MONTH, "2026-01-31T23:00:00.000Z")).toBe("2026-02-28T06:00:00.000Z");
  });

  // The whole point of the rule: twelve consecutive months each get exactly one run, on a real date.
  it("gives a 31st schedule twelve runs a year, one per month", () => {
    const seen = new Set<string>();
    let cursor = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 12; i++) {
      cursor = nextRunAfter(TZ, "monthly", cursor, { dayOfMonth: 31, hour: 6, minute: 0 });
      seen.add(iso(cursor).slice(0, 7));
    }
    expect(seen.size).toBe(12);
  });
});

describe("idempotency — one delivery per schedule per period", () => {
  it("keys the run on (scheduleId, periodStart), not on the clock", async () => {
    await runDueSchedules(NOW);
    expect(repo.createRunIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sch1", periodStart: new Date("2026-09-01T00:00:00.000Z") }),
    );
  });

  // Two sweeps an hour apart compute the SAME periodStart, which is what makes the unique constraint
  // catch a cron platform's retry rather than merely a simultaneous race.
  it("computes the same key on a later retry within the period", async () => {
    await runDueSchedules(NOW);
    const first = repo.createRunIfAbsent.mock.calls[0]![0].periodStart;
    vi.clearAllMocks();
    repo.findDueSchedules.mockResolvedValue([schedule()]);
    repo.createRunIfAbsent.mockResolvedValue(null);
    repo.findRun.mockResolvedValue(run({ status: "delivered" }));
    repo.claimRun.mockResolvedValue(false);
    await runDueSchedules(new Date("2026-10-05T17:00:00.000Z"));
    expect(repo.createRunIfAbsent.mock.calls[0]![0].periodStart).toEqual(first);
  });

  // The losing racer: the insert collided, the run is already delivered, so no email is sent.
  it("sends nothing when the period is already owned or delivered", async () => {
    repo.createRunIfAbsent.mockResolvedValue(null);
    repo.findRun.mockResolvedValue(run({ status: "delivered" }));
    repo.claimRun.mockResolvedValue(false);
    const res = await runDueSchedules(NOW);
    expect(mail.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.delivered).toBe(0);
  });
});

describe("concurrency — the claim decides, not the caller", () => {
  it("does no work when the claim is refused", async () => {
    repo.claimRun.mockResolvedValue(false);
    const res = await runDueSchedules(NOW);
    expect(fin.getFinanceSummary).not.toHaveBeenCalled();
    expect(mail.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  // The token is the ownership proof: completion is a compare-and-set on it, so a worker whose lease
  // lapsed mid-send cannot stamp "delivered" over a run another worker has reclaimed.
  it("completes with the same token it claimed with", async () => {
    await runDueSchedules(NOW);
    const claimToken = repo.claimRun.mock.calls[0]![1];
    expect(repo.completeRun.mock.calls[0]![1]).toBe(claimToken);
    expect(typeof claimToken).toBe("string");
  });

  it("claims BEFORE generating, so a second worker never starts its own copy", async () => {
    const order: string[] = [];
    repo.claimRun.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    fin.getFinanceSummary.mockImplementation(async () => {
      order.push("generate");
      return { generatedAt: "x", tracking: { poCount: 1, supplierCount: 1 }, totals: { netPence: 0 } };
    });
    await runDueSchedules(NOW);
    expect(order[0]).toBe("claim");
  });
});

describe("a refused claim advances the schedule only when the period is FINISHED", () => {
  // The bug this pins: two instances sweeping at once. A claims the period and starts generating; B
  // cannot claim, and used to advance the schedule anyway. If A then failed, it deliberately did not
  // advance so the period would be retried — but B had already moved the clock on, so the retry never
  // came and the period silently burnt its attempts.
  it("does NOT advance while another worker holds a live claim", async () => {
    repo.createRunIfAbsent.mockResolvedValue(null);
    repo.findRun.mockResolvedValue(run({ status: "running", attempts: 1 }));
    repo.claimRun.mockResolvedValue(false);

    const res = await runDueSchedules(NOW);
    expect(res.skipped).toBe(1);
    // The holder owns both outcomes: it advances on success, and leaves the period due on failure.
    expect(repo.advanceSchedule).not.toHaveBeenCalled();
  });

  it("DOES advance when the period is already delivered", async () => {
    repo.createRunIfAbsent.mockResolvedValue(null);
    repo.findRun.mockResolvedValue(run({ status: "delivered", attempts: 1 }));
    repo.claimRun.mockResolvedValue(false);

    await runDueSchedules(NOW);
    // Otherwise the schedule stays permanently due and every sweep reprocesses the same finished period.
    expect(repo.advanceSchedule).toHaveBeenCalled();
  });

  it("DOES advance when the period has burnt its attempts", async () => {
    repo.createRunIfAbsent.mockResolvedValue(null);
    repo.findRun.mockResolvedValue(run({ status: "failed", attempts: 3 }));
    repo.claimRun.mockResolvedValue(false);

    await runDueSchedules(NOW);
    // Bounded retry: a permanently broken schedule stops shouting and moves to the next period.
    expect(repo.advanceSchedule).toHaveBeenCalled();
  });

  // `target` is read BEFORE the claim is attempted, so by the time the claim is refused it may
  // already describe the wrong state.
  it("decides on a re-read of the run, not on the copy it fetched earlier", async () => {
    repo.createRunIfAbsent.mockResolvedValue(run({ status: "pending", attempts: 0 }));
    repo.findRun.mockResolvedValue(run({ status: "delivered", attempts: 1 }));
    repo.claimRun.mockResolvedValue(false);

    await runDueSchedules(NOW);
    expect(repo.findRun).toHaveBeenCalled();
    expect(repo.advanceSchedule).toHaveBeenCalled();
  });
});

describe("retry and failure", () => {
  it("records the failure and does NOT advance the schedule, so the period is retried", async () => {
    mail.sendTemplatedEmail.mockRejectedValue(new Error("SMTP unavailable"));
    const res = await runDueSchedules(NOW);
    expect(repo.failRun).toHaveBeenCalled();
    expect(repo.failRun.mock.calls[0]![2]).toMatch(/SMTP unavailable/);
    // Advancing on failure would skip the period entirely and nobody would notice it was missing.
    expect(repo.advanceSchedule).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
  });

  // Everyone on the list has since left, been suspended, or lost the report's permission. Sending to
  // nobody would look like success; failing keeps the period due and visible in run history.
  it("refuses to send when nobody selected is still authorised", async () => {
    resolveRecipients.mockResolvedValue({ emails: [], excluded: 2 });
    const res = await runDueSchedules(NOW);
    expect(mail.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(repo.failRun.mock.calls[0]![2]).toMatch(/recipient/i);
    // The reason is operator-facing and names nobody — run history is not where one person's
    // permission state is disclosed to another.
    expect(repo.failRun.mock.calls[0]![2]).not.toMatch(/permission|suspend|delet/i);
  });

  // A schedule pointing at a report that no longer exists would retry forever otherwise.
  it("fails a schedule whose report type has been removed from the registry", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ reportKey: "deleted_report" })]);
    const res = await runDueSchedules(NOW);
    expect(res.failed).toBe(1);
    expect(repo.failRun.mock.calls[0]![2]).toMatch(/no longer exists/i);
  });

  // A cadence nothing can compute cannot be retried into working — park it rather than spin.
  it("disables a schedule with an uncomputable cadence instead of looping on it", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ cadence: "fortnightly" })]);
    const res = await runDueSchedules(NOW);
    expect(repo.updateSchedule).toHaveBeenCalledWith("sch1", { enabled: false });
    expect(repo.createRunIfAbsent).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
  });

  // One broken schedule must not stop the rest of the sweep.
  it("isolates a failure to its own schedule", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ id: "bad" }), schedule({ id: "good" })]);
    resolveRecipients
      .mockResolvedValueOnce({ emails: [], excluded: 1 })
      .mockResolvedValue({ emails: ["fd@x.co"], excluded: 0 });
    const res = await runDueSchedules(NOW);
    expect(res.failed).toBe(1);
    expect(res.delivered).toBe(1);
  });
});

// ── What `generate()` asks the report for ─────────────────────────────────────────────────────
//
// `runCustomReport` is mocked here (this suite is about the scheduler, not the reports), which is
// exactly how a schedule that could never succeed shipped unnoticed: the service REJECTS a filter a
// report does not declare — deliberately, so nobody is handed a wider result than they asked for —
// and the scheduler was injecting the period into every report regardless. Engineer Stock declares
// `engineerId`/`irmItemId` and no dates, so every run threw and burnt its attempts until the schedule
// gave up, with nothing on the list to say so. These assert the ARGUMENTS, which is the part a mock
// can still see.
describe("the period is applied only to reports that accept it", () => {
  const argsOf = async () => {
    const custom = await import("./customReports.service.js");
    return vi.mocked(custom.runCustomReport).mock.calls[0]![1] as { filters: Record<string, string> };
  };

  it("sends no date filter to a POSITION report that declares none", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ reportKey: "engineer_stock", filters: { engineerId: "e1" } })]);
    const res = await runDueSchedules(NOW);

    expect(res.delivered, "an engineer_stock schedule must actually deliver").toBe(1);
    const { filters } = await argsOf();
    expect(filters).toEqual({ engineerId: "e1" });
    expect(filters.dateFrom).toBeUndefined();
    expect(filters.dateTo).toBeUndefined();
  });

  it("still applies the period to a report that does declare the dates", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ reportKey: "stock_movement" })]);
    await runDueSchedules(NOW);

    const { filters } = await argsOf();
    // September — the COMPLETED period at NOW, not the month the sweep happens to run in. Derived
    // from the same helper the scheduler uses, so this pins "the period was passed through" rather
    // than re-stating a timezone boundary that already has its own tests.
    const range = completedPeriod(TZ, "monthly", NOW);
    expect(range.label).toBe("Sep 2026");
    expect(filters.dateFrom).toBe(iso(range.from));
    expect(filters.dateTo).toBe(iso(range.to));
  });

  // A report whose filter set SHRANK after a schedule was saved must keep running, not start failing
  // for the same reason engineer_stock did.
  it("drops a stored filter the report no longer accepts", async () => {
    repo.findDueSchedules.mockResolvedValue([
      schedule({ reportKey: "engineer_stock", filters: { engineerId: "e1", warehouseId: "w9" } }),
    ]);
    const res = await runDueSchedules(NOW);

    expect(res.delivered).toBe(1);
    expect((await argsOf()).filters).toEqual({ engineerId: "e1" });
  });
});

describe("delivery", () => {
  // A workbook that stopped at the row cap opens looking complete. The recipient cannot re-run it with
  // narrower filters unless the email says it was cut.
  it("tells the recipient when the attached report was truncated", async () => {
    const custom = await import("./customReports.service.js");
    // Once, not permanently: mockResolvedValue would outlive clearAllMocks and leak `capped` into
    // every later test in this file.
    vi.mocked(custom.runCustomReport).mockResolvedValueOnce({
      report: { key: "stock_movement" },
      rows: [{ a: 1 }],
      generatedAt: "2026-10-01T00:00:00.000Z",
      capped: true,
    } as never);
    repo.findDueSchedules.mockResolvedValue([schedule({ reportKey: "stock_movement" })]);
    await runDueSchedules(NOW);
    expect(mail.sendTemplatedEmail.mock.calls[0]![2].summary).toMatch(/not included|narrow/i);
  });

  // The point of re-checking at send time: the rest of the list still gets its report.
  it("keeps sending to the eligible recipients when one has been excluded", async () => {
    resolveRecipients.mockResolvedValue({ emails: ["ops@x.co"], excluded: 1 });
    const res = await runDueSchedules(NOW);
    expect(res.delivered).toBe(1);
    expect(mail.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    // deliveredTo records who it ACTUALLY reached — a list shorter than the schedule's is the honest,
    // non-revealing signal that somebody was dropped.
    expect(repo.completeRun.mock.calls[0]![2]).toMatchObject({ deliveredTo: ["ops@x.co"] });
  });

  // ── Partial delivery — the gap the unique key does not cover ────────────────────────────────
  //
  // `@@unique([scheduleId, periodStart])` stops a PERIOD running twice. It says nothing about a run
  // that got halfway down its recipient list before SMTP threw: the run is marked failed, the next
  // sweep retries the same period, and everyone already reached receives a second copy. For a monthly
  // finance workbook that is the failure people actually notice.
  it("does not re-mail a recipient the previous attempt already reached", async () => {
    resolveRecipients.mockResolvedValue({ emails: ["a@x.co", "b@x.co", "c@x.co"], excluded: 0 });
    // The retry: attempt 1 got as far as a@ and b@ before dying.
    repo.findRun.mockResolvedValue(run({ status: "failed", attempts: 1, deliveredTo: ["a@x.co", "b@x.co"] }));

    await runDueSchedules(NOW);

    expect(mail.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendTemplatedEmail.mock.calls[0]![1]).toBe("c@x.co");
    // The run still records everyone who has the report, across both attempts — not just this one's.
    expect(repo.completeRun.mock.calls[0]![2]).toMatchObject({ deliveredTo: ["a@x.co", "b@x.co", "c@x.co"] });
  });

  // Recorded per send, so a throw on the NEXT recipient cannot un-remember this one. Writing the list
  // once at the end would lose the whole record of a run that failed partway.
  it("records each delivery as it happens, not once at the end", async () => {
    resolveRecipients.mockResolvedValue({ emails: ["a@x.co", "b@x.co"], excluded: 0 });
    await runDueSchedules(NOW);
    expect(repo.recordDelivery).toHaveBeenCalledTimes(2);
    expect(repo.recordDelivery.mock.calls.map((c) => c[2])).toEqual(["a@x.co", "b@x.co"]);
    // Under the claim token, so a worker whose lease lapsed cannot write to a run somebody else owns.
    expect(repo.recordDelivery.mock.calls[0]![1]).toBe(repo.claimRun.mock.calls[0]![1]);
  });

  it("emails every recipient with the workbook attached, through the existing mail service", async () => {
    // The addresses come from the send-time resolution, not from the stored row — that is what makes
    // a recipient who changed address keep receiving it, at the new one.
    resolveRecipients.mockResolvedValue({ emails: ["a@x.co", "b@x.co"], excluded: 0 });
    await runDueSchedules(NOW);
    expect(mail.sendTemplatedEmail).toHaveBeenCalledTimes(2);
    const [key, to, vars, opts] = mail.sendTemplatedEmail.mock.calls[0]!;
    expect(key).toBe("report.scheduled");
    expect(to).toBe("a@x.co");
    expect(vars).toMatchObject({ reportName: "Monthly IRM report", period: "Sep 2026" });
    expect(opts.attachments[0]).toMatchObject({ filename: expect.stringContaining(".xlsx") });
  });

  // An inbox is not an authorised surface: the access decision was made when someone was added to the
  // recipient list, and the figures belong in the attachment, not in a forwardable message body.
  it("puts no financial figure in the email body", async () => {
    await runDueSchedules(NOW);
    const vars = mail.sendTemplatedEmail.mock.calls[0]![2] as Record<string, string>;
    for (const v of Object.values(vars)) {
      expect(String(v)).not.toMatch(/£|\d+\.\d{2}/);
    }
  });

  it("records who it reached and advances the schedule on success", async () => {
    const res = await runDueSchedules(NOW);
    expect(repo.completeRun.mock.calls[0]![2]).toMatchObject({ deliveredTo: ["fd@x.co"] });
    // Guarded on the nextRunAt we read (so two workers cannot both advance it), moved to the next
    // period at the schedule's own local fire time — November is GMT, so 06:00 local is 06:00 UTC.
    expect(repo.advanceSchedule).toHaveBeenCalledWith(
      "sch1",
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-11-01T06:00:00.000Z"),
      NOW,
    );
    expect(res.delivered).toBe(1);
  });

  it("generates a custom report through the canonical runner, not its own query", async () => {
    repo.findDueSchedules.mockResolvedValue([schedule({ reportKey: "stock_movement" })]);
    await runDueSchedules(NOW);
    expect(fin.getFinanceSummary).not.toHaveBeenCalled();
    expect(mail.sendTemplatedEmail).toHaveBeenCalledTimes(1);
  });
});

describe("the sweep itself", () => {
  it("does nothing and touches nothing when no schedule is due", async () => {
    repo.findDueSchedules.mockResolvedValue([]);
    const res = await runDueSchedules(NOW);
    expect(res).toEqual({ due: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(repo.createRunIfAbsent).not.toHaveBeenCalled();
  });

  it("returns a tally rather than throwing, so a trigger never retries a completed sweep", async () => {
    repo.claimRun.mockRejectedValue(new Error("database gone"));
    await expect(runDueSchedules(NOW)).resolves.toMatchObject({ due: 1, failed: 1 });
  });
});

// The run row is the ONLY record of who actually received a given period's report. It must not be
// rewritten to match the schedule's current recipient list — somebody removed between attempt 1 and
// attempt 2 still got the file, and losing that is losing the only trace of it.
describe("the run records what happened, not who is listed now", () => {
  it("keeps a recipient who was reached earlier but has since been removed", async () => {
    repo.findRun.mockResolvedValue(run({ status: "failed", attempts: 1, deliveredTo: ["gone@x.co", "a@x.co"] }));
    resolveRecipients.mockResolvedValue({ emails: ["a@x.co", "b@x.co"], excluded: 0 });

    await runDueSchedules(NOW);

    expect(mail.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendTemplatedEmail.mock.calls[0]![1]).toBe("b@x.co");
    expect(repo.completeRun.mock.calls[0]![2]).toMatchObject({
      deliveredTo: ["gone@x.co", "a@x.co", "b@x.co"],
    });
  });
});

// ── A disabled template must FAIL the run, not silently succeed ───────────────────────────────
//
// `sendTemplatedEmail` treats a disabled row as "skip": it logs and returns NORMALLY. That is right
// for a notification nobody must receive, and fatal here — the run would be recorded delivered to
// every recipient while nothing was sent, leaving run history, the status badge and the overdue
// banner all green while a monthly report quietly stopped arriving.
describe("a disabled email template stops the run rather than faking it", () => {
  const disabled = () => templateRepo.findByKey.mockResolvedValue({ key: "report.scheduled", enabled: false });

  it("fails the run instead of marking it delivered", async () => {
    disabled();
    const res = await runDueSchedules(NOW);
    expect(res.delivered).toBe(0);
    expect(res.failed).toBe(1);
    expect(repo.completeRun).not.toHaveBeenCalled();
  });

  it("sends nothing and records no delivery", async () => {
    disabled();
    await runDueSchedules(NOW);
    expect(mail.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(repo.recordDelivery).not.toHaveBeenCalled();
  });

  // The operator has to be able to find out WHY from the run row.
  it("names the template and where to enable it", async () => {
    disabled();
    await runDueSchedules(NOW);
    expect(repo.failRun.mock.calls[0]![2]).toMatch(/Scheduled Report.*disabled.*Email Templates/i);
  });

  it("checks once per run, before generating or sending anything", async () => {
    disabled();
    await runDueSchedules(NOW);
    expect(templateRepo.findByKey).toHaveBeenCalledWith("report.scheduled");
  });

  it("delivers normally when the template is enabled", async () => {
    const res = await runDueSchedules(NOW);
    expect(res.delivered).toBe(1);
    expect(mail.sendTemplatedEmail).toHaveBeenCalled();
  });

  // A MISSING row falls back to the built-in default inside the mail service, so it must not block.
  it("does not block when there is no template row at all", async () => {
    templateRepo.findByKey.mockResolvedValue(null);
    expect((await runDueSchedules(NOW)).delivered).toBe(1);
  });
});
