import { describe, expect, it, vi } from "vitest";

import { scheduleEnabledSchema, scheduleWriteSchema } from "./reports.validation.js";
import { validateBody } from "../../middleware/validate.middleware.js";
import type { Request, Response } from "express";

// ── The SHAPE gate on schedule writes ──────────────────────────────────────────────────────────
//
// POST/PUT /reports/schedules cast `req.body` straight to `ScheduleInput`. The service validated the
// SEMANTICS thoroughly while trusting the TYPES that cast asserted, and a cast asserts nothing — so a
// malformed body walked past every range check and died deeper in, as a 500:
//
//   {"name": 123}       → `input.name?.trim()` → "input.name.trim is not a function"
//   {"hour": "6"}       → `"6" < 0` false, `"6" > 23` false (string/number coercion), then a string
//                          reached Prisma's Int column
//   {"recipients": "a"} → `(input.recipients ?? []).map` → "map is not a function"
//
// These tests run the schema through the REAL `validateBody` middleware, so what is asserted is what
// the route does: a 400 carrying a human message, and `next()` never reached with a bad body.

/** Drive the real middleware and report which way it went. */
function runGate(schema: Parameters<typeof validateBody>[0], body: unknown) {
  const req = { body } as Request;
  const next = vi.fn();
  validateBody(schema)(req, {} as Response, next);
  const err = next.mock.calls[0]?.[0] as { status?: number; message?: string } | undefined;
  return { passed: next.mock.calls.length === 1 && err === undefined, status: err?.status, message: err?.message, body: req.body };
}

const VALID = {
  name: "Monthly spend",
  reportKey: "finance.summary",
  cadence: "monthly",
  dayOfMonth: 1,
  hour: 6,
  minute: 0,
  format: "xlsx",
  recipients: ["u1", "u2"],
  filters: { warehouseId: "w1" },
  enabled: true,
};

describe("a well-formed schedule body is accepted", () => {
  it("passes a realistic monthly payload", () => {
    expect(runGate(scheduleWriteSchema, VALID).passed).toBe(true);
  });

  it("passes a weekly payload", () => {
    const r = runGate(scheduleWriteSchema, { ...VALID, cadence: "weekly", dayOfMonth: null, dayOfWeek: 1 });
    expect(r.passed).toBe(true);
  });

  it("accepts the month-end sentinel (-1), which is a real day-of-month choice", () => {
    expect(runGate(scheduleWriteSchema, { ...VALID, dayOfMonth: -1 }).passed).toBe(true);
  });

  it("accepts the nulls the form sends for the cadence field it is not using", () => {
    expect(runGate(scheduleWriteSchema, { ...VALID, dayOfWeek: null, dayOfMonth: null }).passed).toBe(true);
  });

  it("trims the name, so the service's own trim is a no-op rather than a repair", () => {
    const r = runGate(scheduleWriteSchema, { ...VALID, name: "  Monthly spend  " });
    expect(r.passed).toBe(true);
    expect((r.body as { name: string }).name).toBe("Monthly spend");
  });

  it("strips an unknown field rather than storing it — the codebase's zod convention", () => {
    const r = runGate(scheduleWriteSchema, { ...VALID, timeZoneOverride: "Mars/Olympus", isAdmin: true });
    expect(r.passed).toBe(true);
    expect(r.body).not.toHaveProperty("isAdmin");
    expect(r.body).not.toHaveProperty("timeZoneOverride");
  });
});

describe("a malformed schedule body is a 400, never a 500", () => {
  // Each case names the crash it used to cause.
  const cases: [string, unknown, RegExp][] = [
    ["name as a number (`.trim is not a function`)", { ...VALID, name: 123 }, /name/i],
    ["name missing", { ...VALID, name: undefined }, /name/i],
    ["name blank once trimmed", { ...VALID, name: "   " }, /name/i],
    ["name over 120 characters", { ...VALID, name: "x".repeat(121) }, /120/],
    ["hour as a string (passed the range check by coercion, then hit an Int column)", { ...VALID, hour: "6" }, /hour/i],
    ["minute as a string", { ...VALID, minute: "30" }, /minute/i],
    ["hour out of range", { ...VALID, hour: 24 }, /hour/i],
    ["minute out of range", { ...VALID, minute: 60 }, /minute/i],
    ["hour as a fraction", { ...VALID, hour: 6.5 }, /hour/i],
    ["recipients as a string (`.map is not a function`)", { ...VALID, recipients: "u1" }, /recipient/i],
    ["recipients empty", { ...VALID, recipients: [] }, /recipient/i],
    ["recipients over the cap of 20", { ...VALID, recipients: Array.from({ length: 21 }, (_, i) => `u${i}`) }, /20/],
    ["a non-string inside recipients", { ...VALID, recipients: ["u1", { id: "u2" }] }, /recipient/i],
    ["an unknown cadence", { ...VALID, cadence: "hourly" }, /weekly or monthly/i],
    ["cadence missing", { ...VALID, cadence: undefined }, /weekly or monthly/i],
    ["an unknown format", { ...VALID, format: "pdf" }, /xlsx or csv/i],
    ["dayOfWeek out of range", { ...VALID, cadence: "weekly", dayOfWeek: 8 }, /day of week/i],
    ["dayOfWeek as a string", { ...VALID, cadence: "weekly", dayOfWeek: "1" }, /day of week/i],
    ["dayOfMonth 0", { ...VALID, dayOfMonth: 0 }, /day of month/i],
    ["dayOfMonth 32", { ...VALID, dayOfMonth: 32 }, /day of month/i],
    ["dayOfMonth -2 (only -1 means month end)", { ...VALID, dayOfMonth: -2 }, /day of month/i],
    ["reportKey missing", { ...VALID, reportKey: undefined }, /report/i],
    ["reportKey as a number", { ...VALID, reportKey: 7 }, /report/i],
    ["filters as a string", { ...VALID, filters: "warehouseId=w1" }, /filter/i],
    ["a non-string filter value", { ...VALID, filters: { warehouseId: 5 } }, /filter/i],
    ["enabled as a string", { ...VALID, enabled: "yes" }, /enabled/i],
  ];

  it.each(cases)("rejects %s", (_label, body, message) => {
    const r = runGate(scheduleWriteSchema, body);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(400);
    expect(r.message).toMatch(message);
  });

  it("refuses a body that is not an object at all", () => {
    for (const body of [null, "text", 42, []]) {
      expect(runGate(scheduleWriteSchema, body).status).toBe(400);
    }
  });
});

describe("the pause/resume toggle body", () => {
  it("accepts an explicit boolean", () => {
    expect(runGate(scheduleEnabledSchema, { enabled: false }).passed).toBe(true);
    expect(runGate(scheduleEnabledSchema, { enabled: true }).passed).toBe(true);
  });

  it("refuses a JSON null body, which used to throw reading `.enabled` off null", () => {
    expect(runGate(scheduleEnabledSchema, null).status).toBe(400);
  });

  it("refuses a missing or non-boolean value rather than silently reading it as 'off'", () => {
    // `(req.body).enabled === true` turned every one of these into "disable it" — a malformed
    // request quietly pausing a schedule is worse than being told it was malformed.
    expect(runGate(scheduleEnabledSchema, {}).status).toBe(400);
    expect(runGate(scheduleEnabledSchema, { enabled: "true" }).status).toBe(400);
    expect(runGate(scheduleEnabledSchema, { enabled: 1 }).status).toBe(400);
  });
});
