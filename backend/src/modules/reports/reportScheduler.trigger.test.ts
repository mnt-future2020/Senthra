import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const core = vi.hoisted(() => ({ runDueSchedules: vi.fn() }));
const cfg = vi.hoisted(() => ({ env: { REPORT_SCHEDULER_SECRET: undefined as string | undefined } }));
vi.mock("./reportScheduler.service.js", () => core);
vi.mock("../../config/env.js", () => cfg);

import { schedulerTriggerHandler, startSchedulerLoop } from "./reportScheduler.trigger.js";

const SECRET = "a-long-enough-trigger-secret";

/** Minimal Express doubles — the handler only touches these four things. */
const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const makeReq = (headers: Record<string, string> = {}, query: Record<string, string> = {}) => ({
  get: (name: string) => headers[name.toLowerCase()],
  query,
});

// The handler answers inside a promise chain, so a call has to settle before it is inspected.
const call = async (req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schedulerTriggerHandler(req as any, res as any, (() => {}) as any);
  await new Promise((r) => setImmediate(r));
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  cfg.env.REPORT_SCHEDULER_SECRET = SECRET;
  core.runDueSchedules.mockResolvedValue({ claimed: 2, delivered: 2, failed: 0 });
});

describe("the trigger actually invokes the core", () => {
  it("runs the sweep and reports the tally", async () => {
    const res = await call(makeReq({ "x-scheduler-secret": SECRET }), makeRes());
    expect(core.runDueSchedules).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ result: { claimed: 2, delivered: 2, failed: 0 } });
  });

  // Cron platforms differ in what they can attach to a request; all three carry the same secret.
  it("accepts the secret as a header, a bearer token or a query parameter", async () => {
    await call(makeReq({ "x-scheduler-secret": SECRET }), makeRes());
    await call(makeReq({ authorization: `Bearer ${SECRET}` }), makeRes());
    await call(makeReq({}, { secret: SECRET }), makeRes());
    expect(core.runDueSchedules).toHaveBeenCalledTimes(3);
  });

  // A cron platform retries a non-2xx. The core has already recorded each failure with its attempt
  // count and the next invocation retries it properly, so a 500 here would just multiply the work.
  it("still answers 200 when individual runs failed", async () => {
    core.runDueSchedules.mockResolvedValue({ claimed: 3, delivered: 1, failed: 2 });
    const res = await call(makeReq({ "x-scheduler-secret": SECRET }), makeRes());
    expect(res.statusCode).toBe(200);
  });

  it("answers 500 only when the sweep itself could not run", async () => {
    core.runDueSchedules.mockRejectedValue(new Error("database is down"));
    const res = await call(makeReq({ "x-scheduler-secret": SECRET }), makeRes());
    expect(res.statusCode).toBe(500);
    // Never the underlying error — a public endpoint does not narrate the infrastructure.
    expect(res.body).toEqual({ error: "Sweep failed." });
  });
});

describe("the trigger is never an open endpoint", () => {
  const refuses = async (req: ReturnType<typeof makeReq>, code: number) => {
    const res = await call(req, makeRes());
    expect(res.statusCode).toBe(code);
    expect(core.runDueSchedules).not.toHaveBeenCalled();
  };

  it("refuses an unauthenticated request", async () => {
    await refuses(makeReq(), 401);
  });

  it("refuses a wrong secret, including one that is merely a prefix of the real one", async () => {
    await refuses(makeReq({ "x-scheduler-secret": "wrong" }), 401);
    await refuses(makeReq({ "x-scheduler-secret": SECRET.slice(0, -1) }), 401);
    await refuses(makeReq({ "x-scheduler-secret": `${SECRET}x` }), 401);
  });

  // THE property that makes mounting the route safe by default: with nothing configured, the endpoint
  // exists but cannot send a single email. An unconfigured secret is a deployment mistake, never an
  // invitation — so it must not fall through to "no check required".
  it("refuses everything when no secret is configured", async () => {
    cfg.env.REPORT_SCHEDULER_SECRET = undefined;
    await refuses(makeReq(), 503);
    await refuses(makeReq({ "x-scheduler-secret": "anything" }), 503);
    // The most dangerous shape: a caller presenting an empty secret must not match an absent one.
    await refuses(makeReq({ "x-scheduler-secret": "" }), 503);
  });
});

describe("duplicate invocation is safe", () => {
  // Concurrency is decided in the DATABASE — the claim plus the (schedule, period) unique key. The
  // trigger's own job is simply not to serialise or de-duplicate, because a trigger that skipped a
  // call to "avoid" a double-run would be an in-memory source of truth.
  it("passes every concurrent call through to the core", async () => {
    const results = await Promise.all([
      call(makeReq({ "x-scheduler-secret": SECRET }), makeRes()),
      call(makeReq({ "x-scheduler-secret": SECRET }), makeRes()),
      call(makeReq({ "x-scheduler-secret": SECRET }), makeRes()),
    ]);
    expect(core.runDueSchedules).toHaveBeenCalledTimes(3);
    for (const r of results) expect(r.statusCode).toBe(200);
    // No argument: the core reads the clock itself, so two instances a millisecond apart still derive
    // the same period key and collide on it rather than sending twice.
    expect(core.runDueSchedules).toHaveBeenCalledWith();
  });

  it("holds no state between calls that could decide what has already run", () => {
    const src = readFileSync(join(process.cwd(), "src", "modules", "reports", "reportScheduler.trigger.ts"), "utf8");
    const code = src
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    // A module-level Map/Set/lastRun would be exactly the in-memory source of truth this design bans.
    expect(code).not.toMatch(/^(const|let|var)\s+\w+\s*(:[^=]+)?=\s*new (Map|Set)\(/m);
    expect(code).not.toMatch(/^let\s+last/m);
  });
});

describe("the in-process loop", () => {
  it("sweeps once immediately, then on the interval", () => {
    vi.useFakeTimers();
    try {
      const stop = startSchedulerLoop(60_000);
      // A host that redeploys more often than the interval would otherwise never sweep at all.
      expect(core.runDueSchedules).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(180_000);
      expect(core.runDueSchedules).toHaveBeenCalledTimes(4);
      stop();
      vi.advanceTimersByTime(180_000);
      // Stopped means stopped: a pass starting during teardown would query a disconnecting client.
      expect(core.runDueSchedules).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a failing sweep rather than taking the process down", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      core.runDueSchedules.mockRejectedValue(new Error("boom"));
      const stop = startSchedulerLoop(60_000);
      expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
      stop();
    } finally {
      err.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("the trigger is wired — not merely available", () => {
  const read = (...seg: string[]) => readFileSync(join(process.cwd(), "src", ...seg), "utf8");

  // The failure this whole file exists to prevent: a complete scheduler that nothing ever calls.
  // A source scan, because no unit test notices an entry point that was never mounted.
  it("mounts the HTTP trigger outside every authenticated router", () => {
    const routes = read("routes", "index.ts");
    expect(routes).toContain("schedulerTriggerHandler");
    // Registered directly on the top-level router, both verbs, with no middleware between the path
    // and the handler — a permission guard there would reject a cron, which carries no session.
    expect(routes).toMatch(/router\.post\(\s*schedulerTrigger,\s*schedulerTriggerHandler\s*\)/);
    expect(routes).toMatch(/router\.get\(\s*schedulerTrigger,\s*schedulerTriggerHandler\s*\)/);
    // Not under /reports: it is not part of the Reports API surface and no permission opens it.
    expect(routes).toMatch(/const schedulerTrigger = "\/internal\/report-scheduler\/run"/);
  });

  it("starts the in-process loop from the server entry point and stops it on shutdown", () => {
    const server = read("server.ts");
    expect(server).toContain("startSchedulerLoop");
    expect(server).toContain("stopReportScheduler");
    // Halted before the database client disconnects, like the three sweeps beside it.
    expect(server).toMatch(/stopReportScheduler\?\.\(\);[\s\S]{0,120}prisma\.\$disconnect/);
  });
});
