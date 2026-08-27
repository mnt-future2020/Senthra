import { describe, expect, it } from "vitest";

import {
  cadenceLabel,
  coverageNote,
  draftFrom,
  emptyDraft,
  LAST_DAY_OF_MONTH,
  MAX_DAY_OF_MONTH,
  OVERDUE_AFTER_MS,
  overdueSchedules,
  toPayload,
} from "./scheduleDraft";
import type { ReportSchedule, SchedulablePayloadState } from "./scheduleTypes";

const schedule = (over: Partial<ReportSchedule> = {}): ReportSchedule => ({
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
  recipientLabels: ["fd@x.co"],
  filters: null,
  enabled: true,
  nextRunAt: "2026-09-01T05:00:00.000Z",
  lastRunAt: null,
  createdBy: "Finance Director",
  createdAt: "2026-08-01T09:00:00.000Z",
  // Last-run health, as the list screen receives it. Never run, by default.
  lastRunStatus: null,
  lastRunError: null,
  lastRunExhausted: false,
  ...over,
});

const draft = (over: Partial<SchedulablePayloadState> = {}): SchedulablePayloadState => ({
  ...emptyDraft({ key: "stock_movement", label: "Stock Movement", description: "", filters: [], financial: false }),
  name: "Weekly stock",
  recipients: ["ops@x.co"],
  ...over,
});

describe("cadenceLabel", () => {
  it("names the weekday for a weekly schedule", () => {
    expect(cadenceLabel(schedule({ cadence: "weekly", dayOfWeek: 3, dayOfMonth: null, hour: 9 }))).toBe(
      "Weekly on Wednesday at 09:00",
    );
  });

  it("uses the right ordinal for a monthly schedule", () => {
    expect(cadenceLabel(schedule({ dayOfMonth: 1 }))).toBe("Monthly on the 1st at 06:00");
    expect(cadenceLabel(schedule({ dayOfMonth: 2 }))).toBe("Monthly on the 2nd at 06:00");
    expect(cadenceLabel(schedule({ dayOfMonth: 3 }))).toBe("Monthly on the 3rd at 06:00");
    expect(cadenceLabel(schedule({ dayOfMonth: 4 }))).toBe("Monthly on the 4th at 06:00");
  });

  it("gets the awkward ordinals right", () => {
    // 11th-13th break the last-digit rule; 21st/22nd/23rd/31st resume it.
    for (const [d, label] of [
      [11, "11th"],
      [12, "12th"],
      [13, "13th"],
      [21, "21st"],
      [22, "22nd"],
      [23, "23rd"],
      [31, "31st"],
    ] as const) {
      expect(cadenceLabel(schedule({ dayOfMonth: d }))).toBe(`Monthly on the ${label} at 06:00`);
    }
  });

  // Month-end is a distinct intent from "the 31st", and the label has to say so — "Monthly on the
  // -1st" would be nonsense, and calling it "the 31st" would be a lie in February.
  it("names the last-day selection rather than printing its sentinel", () => {
    expect(cadenceLabel(schedule({ dayOfMonth: LAST_DAY_OF_MONTH }))).toBe("Monthly on the last day at 06:00");
  });

  it("zero-pads the time so 06:05 never reads as 6:5", () => {
    expect(cadenceLabel(schedule({ hour: 6, minute: 5 }))).toContain("at 06:05");
  });
});

describe("draftFrom → toPayload round trip", () => {
  it("returns a stored schedule unchanged through the form", () => {
    const s = schedule({ cadence: "weekly", dayOfWeek: 5, dayOfMonth: null, hour: 17, minute: 30, timeZone: "Europe/London" });
    const payload = toPayload(draftFrom(s));
    expect(payload).toMatchObject({
      name: s.name,
      reportKey: s.reportKey,
      cadence: "weekly",
      dayOfWeek: 5,
      dayOfMonth: null,
      hour: 17,
      minute: 30,
      format: "xlsx",
      // The stored ids survive the round trip — the LABELS are display-only and never sent back.
      recipients: ["u1"],
      enabled: true,
    });
  });

  // Settings -> Company -> Timezone is the single source of truth, so the form neither collects nor
  // sends one. A stored legacy override stays on the row; it is displayed, never edited.
  it("sends no timezone at all", () => {
    expect(toPayload(draftFrom(schedule({ timeZone: "America/New_York" })))).not.toHaveProperty("timeZone");
    expect(draftFrom(schedule({ timeZone: "America/New_York" }))).not.toHaveProperty("timeZone");
  });

  it("shows a day for the cadence that isn't in use, but never sends it", () => {
    // A weekly schedule has no dayOfMonth; the control still needs a value to display.
    const d = draftFrom(schedule({ cadence: "weekly", dayOfWeek: 2, dayOfMonth: null }));
    expect(d.dayOfMonth).toBe("1");
    expect(toPayload(d).dayOfMonth).toBeNull();

    // ...and the mirror case: switching that same draft to monthly drops the weekday.
    expect(toPayload({ ...d, cadence: "monthly" })).toMatchObject({ dayOfMonth: 1, dayOfWeek: null });
  });
});

describe("toPayload — recipients", () => {
  // Recipients are picked from the server's eligible-user list now, not typed. There is nothing to
  // parse; the payload is the selection.
  it("sends the selected addresses as chosen", () => {
    expect(toPayload(draft({ recipients: ["a@x.co", "b@x.co"] })).recipients).toEqual(["a@x.co", "b@x.co"]);
  });

  it("supports several recipients and an empty selection alike", () => {
    expect(toPayload(draft({ recipients: [] })).recipients).toEqual([]);
    expect(toPayload(draft({ recipients: ["a@x.co", "b@x.co", "c@x.co"] })).recipients).toHaveLength(3);
  });

  // The picker offers only authorised users, but the SERVER re-derives that set on save — the form
  // deliberately makes no authorisation decision of its own.
  it("does not filter or validate the selection — the server owns that", () => {
    expect(toPayload(draft({ recipients: ["nonsense"] })).recipients).toEqual(["nonsense"]);
  });
});

describe("toPayload — filters", () => {
  it("omits a filter box the user left blank", () => {
    // Sending warehouseId:"" would narrow the report to nothing rather than to everything.
    expect(toPayload(draft({ filters: { warehouseId: "", projectId: "p1" } })).filters).toEqual({ projectId: "p1" });
  });

  it("keeps the filters that were actually filled in", () => {
    expect(toPayload(draft({ filters: { warehouseId: "wh1", projectId: "p1" } })).filters).toEqual({
      warehouseId: "wh1",
      projectId: "p1",
    });
  });
});

describe("emptyDraft", () => {
  it("starts on the first report the server said this user may schedule", () => {
    const first = { key: "engineer_stock", label: "Engineer Stock", description: "", filters: [], financial: false };
    expect(emptyDraft(first).reportKey).toBe("engineer_stock");
  });

  it("defaults to a monthly 06:00 xlsx with nothing selected", () => {
    const d = emptyDraft({ key: "k", label: "l", description: "", filters: [], financial: false });
    expect(d).toMatchObject({ cadence: "monthly", time: "06:00", format: "xlsx", enabled: true });
    expect(d.recipients).toEqual([]);
    // No timezone field at all — there is nothing for a user to get wrong.
    expect(d).not.toHaveProperty("timeZone");
  });
});

describe("overdueSchedules", () => {
  const now = new Date("2026-09-01T12:00:00Z").getTime();
  const at = (iso: string, enabled = true) => ({ enabled, nextRunAt: iso });

  it("flags an enabled schedule whose run time came and went", () => {
    expect(overdueSchedules([at("2026-08-30T06:00:00Z")], now)).toHaveLength(1);
  });

  it("stays quiet inside the tolerance, so an ordinary sweep delay is not an alarm", () => {
    // The contract is a sweep at least hourly; one running an hour late is healthy, not broken.
    expect(overdueSchedules([at(new Date(now - OVERDUE_AFTER_MS + 60_000).toISOString())], now)).toEqual([]);
    expect(overdueSchedules([at(new Date(now - OVERDUE_AFTER_MS - 60_000).toISOString())], now)).toHaveLength(1);
  });

  it("ignores a future run and a paused schedule", () => {
    expect(overdueSchedules([at("2026-09-02T06:00:00Z")], now)).toEqual([]);
    // A paused schedule is not due at all — its stored nextRunAt is simply stale.
    expect(overdueSchedules([at("2026-01-01T06:00:00Z", false)], now)).toEqual([]);
  });

  it("returns the offending schedules, not just a count", () => {
    const late = { enabled: true, nextRunAt: "2026-08-01T06:00:00Z", id: "sch1" };
    expect(overdueSchedules([late, at("2026-09-05T06:00:00Z")], now)).toEqual([late]);
  });
});

describe("monthly day-of-month reaches the server unchanged", () => {
  it("offers every day of the month, not a 28-day cap", () => {
    // The cap made a month-end report impossible to ask for. The server clamps a day the month does
    // not have; the form no longer pretends those days do not exist.
    expect(MAX_DAY_OF_MONTH).toBe(31);
  });

  it("round-trips the last-day sentinel through the form without mangling it", () => {
    const d = draftFrom(schedule({ dayOfMonth: LAST_DAY_OF_MONTH }));
    expect(d.dayOfMonth).toBe("-1");
    expect(toPayload(d).dayOfMonth).toBe(LAST_DAY_OF_MONTH);
  });

  it("sends 29, 30 and 31 as themselves rather than clamping in the browser", () => {
    // Clamping is the SERVER's rule, applied per month at fire time. Doing it here would store the
    // wrong intent forever — a 31st schedule saved in February would become a 28th schedule.
    for (const day of [29, 30, 31]) {
      expect(toPayload(draft({ cadence: "monthly", dayOfMonth: String(day) })).dayOfMonth).toBe(day);
    }
  });
});

describe("recipient labels are display-only", () => {
  it("never round-trips a label into the payload", () => {
    const s = schedule({ recipients: ["u1", "u9"], recipientLabels: ["fd@x.co", "ops@x.co"] });
    // The server owns the mapping; sending a label back would ask it to re-resolve what it just told us.
    expect(toPayload(draftFrom(s)).recipients).toEqual(["u1", "u9"]);
    expect(draftFrom(s)).not.toHaveProperty("recipientLabels");
  });
});

// ── The period a run covers, said out loud on the form ────────────────────────────────────────
//
// The server rule is "the last COMPLETE period before the run", and it is correct — a report of "the
// month so far" is not comparable with last month's. But a run covers the month BEFORE the month it
// fires in, and the form recommends "Last day of month" first, so a Finance Director setting up
// month-end reporting was silently signed up to receive December's figures on 31 January, every
// month, forever. Nothing on the screen said so. These pin the sentences that now do.
describe("coverageNote", () => {
  const monthly = (dayOfMonth: string) => draft({ cadence: "monthly", dayOfMonth });
  const weekly = (dayOfWeek: string) => draft({ cadence: "weekly", dayOfWeek });

  it("warns that month-end reports the month BEFORE the one it fires in", () => {
    const { warn } = coverageNote(monthly(String(LAST_DAY_OF_MONTH)));
    expect(warn).toMatch(/DECEMBER/);
    expect(warn, "and says which option does the intuitive thing").toMatch(/1st/);
  });

  it("does not warn on the 1st, which reports the month that has just ended", () => {
    expect(coverageNote(monthly("1")).warn).toBeNull();
  });

  it("does not warn on a mid-month day either", () => {
    expect(coverageNote(monthly("15")).warn).toBeNull();
    expect(coverageNote(monthly("15")).covers).toMatch(/15th of February reports January/i);
  });

  // Sunday sits INSIDE the week a user is thinking of, so it has the same shape as month-end.
  it("warns on weekly-on-Sunday for the same reason", () => {
    const { warn } = coverageNote(weekly("7"));
    expect(warn).toMatch(/WEEK BEFORE/);
    expect(warn).toMatch(/Monday/);
  });

  it("does not warn on weekly-on-Monday", () => {
    expect(coverageNote(weekly("1")).warn).toBeNull();
  });

  it("always states what a run covers, warning or not", () => {
    for (const d of [monthly("1"), monthly(String(LAST_DAY_OF_MONTH)), weekly("1"), weekly("7")]) {
      expect(coverageNote(d).covers, JSON.stringify(d.cadence + d.dayOfMonth + d.dayOfWeek)).toMatch(/Each run reports/);
    }
  });
});
