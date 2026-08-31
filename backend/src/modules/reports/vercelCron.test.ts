import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Vercel DEMO deployment's wake-up wiring.
 *
 * Vercel runs this API as a serverless function (`api/index.js` exports the Express app instead of
 * calling `listen`), so `server.ts` never executes and `startSchedulerLoop()` never starts. Nothing
 * errors when that happens — the sweep simply never runs and every scheduled report silently stops.
 * A cron entry is the only thing that wakes it there.
 *
 * These guard the CONFIGURATION, which is the part with no other safety net: the application code is
 * covered by the scheduler suites, but a cron pointing at a path that does not exist fails silently
 * on a platform nobody is watching.
 *
 * Production is unaffected. The always-on host still runs the in-process loop; this file asserts the
 * demo's alternative path exists and matches the route it claims to call.
 */

const BACKEND = join(import.meta.dirname, "..", "..", "..");
const vercel = JSON.parse(readFileSync(join(BACKEND, "vercel.json"), "utf8")) as {
  rewrites?: { source: string; destination: string }[];
  crons?: { path: string; schedule: string }[];
};
const routes = readFileSync(join(BACKEND, "src", "routes", "index.ts"), "utf8");

describe("vercel.json cron wiring", () => {
  it("declares exactly one cron", () => {
    expect(vercel.crons).toHaveLength(1);
  });

  // THE drift guard: the cron names a URL, the router names a path, and nothing else connects them.
  it("points at the path the router actually registers", () => {
    const declared = vercel.crons![0]!.path;
    expect(routes, `no route registered for ${declared}`).toContain(`const schedulerTrigger = "${declared}"`);
    expect(routes).toContain("router.get(schedulerTrigger, schedulerTriggerHandler)");
  });

  // Vercel Cron issues GET only. A POST-only trigger would 404 on the platform and nowhere else.
  it("is reachable by GET, which is all Vercel Cron can send", () => {
    expect(routes).toMatch(/router\.get\(schedulerTrigger/);
  });

  // ── DAILY, and it has to be ─────────────────────────────────────────────────────────────────
  //
  // This was "0 * * * *". Vercel HOBBY does not merely throttle a sub-daily cron, it REFUSES THE
  // DEPLOYMENT: "Hobby accounts are limited to daily cron jobs. This cron expression would run more
  // than once per day." So the hourly expression did not delay reports on the demo — it took the
  // whole backend deployment down with it.
  //
  // 06:00 UTC. Vercel crons run in UTC and Hobby precision is +/-59 min, and that drift is always
  // LATE, never early ("will trigger anywhere between 1:00 am and 1:59 am"), so this sweeps somewhere
  // in 06:00-06:59 UTC.
  //
  // A schedule's default fire time is 06:00 in the COMPANY timezone (ReportSchedule.hour defaults to
  // 6) — 05:00 UTC under BST, 06:00 UTC under GMT. Both are <= the sweep window, and the due query is
  // `nextRunAt: { lte: now }` (inclusive), so the GMT case landing exactly on 06:00 UTC is still
  // collected rather than missed by a boundary. A schedule set later in the day waits for the next
  // sweep; one daily sweep cannot do better, and the demo is the only place this applies.
  //
  // Production is untouched: the always-on host runs the in-process loop every 15 minutes.
  it("uses a DAILY schedule, which is all Vercel Hobby will deploy", () => {
    const [minute, hour, ...rest] = vercel.crons![0]!.schedule.split(" ");
    expect(rest.join(" "), "day/month/weekday must stay unrestricted — this runs every day").toBe("* * *");
    // A literal hour, not "*" and not a step: both run more than once a day and fail deployment.
    expect(hour, "an hourly or sub-hourly cron FAILS deployment on Hobby").toMatch(/^\d{1,2}$/);
    expect(minute).toMatch(/^\d{1,2}$/);
  });

  it("does not sweep before the default schedule fire time in either GMT or BST", () => {
    // ReportSchedule.hour defaults to 6 (company timezone) = 05:00 UTC in BST, 06:00 UTC in GMT.
    // Hobby fires up to 59 minutes LATE and never early, and `findDueSchedules` matches on
    // `nextRunAt: { lte: now }`, so a sweep at exactly 06:00 UTC still collects the GMT case.
    // Earlier than 06:00 UTC would miss it for a whole day every winter.
    const hour = Number(vercel.crons![0]!.schedule.split(" ")[1]);
    expect(hour, "a sweep before 06:00 UTC misses the default 06:00 schedule under GMT").toBeGreaterThanOrEqual(6);
  });

  // Every route reaches Express through this rewrite; removing it takes the whole API down, cron
  // included.
  it("keeps the catch-all rewrite that puts Express behind the function", () => {
    expect(vercel.rewrites).toEqual([{ source: "/(.*)", destination: "/api" }]);
  });
});

describe("the trigger is the ONLY thing the cron adds", () => {
  it("introduces no second scheduler entry point", () => {
    const trigger = readFileSync(join(BACKEND, "src", "modules", "reports", "reportScheduler.trigger.ts"), "utf8");
    // Both the HTTP handler and the in-process loop must call the same core.
    expect(trigger).toContain("runDueSchedules");
    // No recurrence maths in the trigger — it wakes the scheduler, it does not decide what is due.
    for (const f of ["completedPeriod", "nextRunAfter", "cadence"]) {
      expect(trigger, `${f} belongs in the scheduler core, not the trigger`).not.toContain(f);
    }
  });

  it("leaves the always-on production loop in place", () => {
    const server = readFileSync(join(BACKEND, "src", "server.ts"), "utf8");
    expect(server).toContain("startSchedulerLoop");
    // Gated on the env var, so Vercel can switch it off without changing what a real host does.
    expect(server).toContain("env.REPORT_SCHEDULER_IN_PROCESS");
  });
});

// ── The two-variable trap ──────────────────────────────────────────────────────────────────────
//
// Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET` — ITS variable name. The app
// checks `REPORT_SCHEDULER_SECRET` — OURS. Two names, one value, and nothing in either system
// compares them: a mismatch is a 401 every hour, forever, with no report sent and no error surfaced
// anywhere a human looks.
//
// It cannot be asserted at runtime (the app never sees CRON_SECRET) and it cannot be asserted in
// `docs/`, which is gitignored — a deployer cloning this repo never receives that directory. So the
// contract has to live in a TRACKED file, and this pins it there.
describe("the Vercel cron secret contract is documented where a deployer will see it", () => {
  const example = readFileSync(join(BACKEND, ".env.example"), "utf8");

  it("names Vercel's own CRON_SECRET beside ours", () => {
    expect(example).toMatch(/CRON_SECRET/);
    expect(example).toMatch(/REPORT_SCHEDULER_SECRET/);
  });

  it("states that the two must hold the same value", () => {
    expect(example.toLowerCase()).toMatch(/same secret|identical value|same value/);
  });

  it("warns that a mismatch fails silently", () => {
    expect(example.toLowerCase()).toMatch(/silent|nothing tells you|never sent|never runs/);
  });

  it("records the plan caveat for the schedule this repo declares", () => {
    // A deployer needs to know WHY the sweep is daily here and hourly everywhere else.
    expect(example.toLowerCase()).toMatch(/hobby|pro/);
  });
});

describe("no secret is committed", () => {
  it("keeps the scheduler secret out of vercel.json", () => {
    const raw = readFileSync(join(BACKEND, "vercel.json"), "utf8");
    expect(raw).not.toMatch(/REPORT_SCHEDULER_SECRET|CRON_SECRET/);
  });

  // .env.example ships the NAME and a placeholder, never a value.
  it("keeps .env.example free of a usable secret", () => {
    const example = readFileSync(join(BACKEND, ".env.example"), "utf8");
    // The ASSIGNMENT line, not the prose above it that also names the variable.
    const line = example.split("\n").find((l) => /^\s*#?\s*REPORT_SCHEDULER_SECRET\s*=/.test(l)) ?? "";
    expect(line, "no REPORT_SCHEDULER_SECRET= line found").not.toBe("");
    expect(line.trim().startsWith("#"), "it must stay commented out, never shipped enabled").toBe(true);
    expect(line, "the value must be an obvious placeholder").toMatch(/change-me/i);
  });
});
