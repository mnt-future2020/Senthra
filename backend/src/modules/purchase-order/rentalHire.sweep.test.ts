import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./purchase-order.repository.js", () => ({
  findDueForReminder: vi.fn(),
  claimReminder: vi.fn(),
  markReminderSent: vi.fn(),
  releaseReminderClaim: vi.fn(),
}));
vi.mock("#modules/email/email.service.js", () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY" })),
}));

import * as poRepo from "./purchase-order.repository.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { sweepRentalDeadlines } from "./rentalHire.sweep.js";

const claim = vi.mocked(poRepo.claimReminder);
const markSent = vi.mocked(poRepo.markReminderSent);
const release = vi.mocked(poRepo.releaseReminderClaim);
const due = vi.mocked(poRepo.findDueForReminder);
const send = vi.mocked(sendTemplatedEmail);
const regional = vi.mocked(getRegionalSettings);

const NOW = new Date("2026-09-28T09:00:00Z");

const line = (over: Record<string, unknown> = {}) =>
  ({
    id: "l1",
    itemName: "Fibre Tester",
    quantity: 1,
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    deadlineNotifyAttempts: 0,
    purchaseOrder: { code: "PO-0042", pmEmail: "pm@x.co", createdBy: "buyer@x.co" },
    ...over,
  }) as never;

/**
 * The row's REAL claim semantics, in memory: one token holds the lease until it expires, and only
 * the holder of the CURRENT token may complete or release.
 *
 * A fake that always grants the claim — or that lets any caller complete — hides exactly the races
 * these tests exist to catch. That mistake has been made in this codebase before.
 */
function installLedger(clock = { now: 1_000_000 }) {
  const row = { token: null as string | null, expires: 0, notified: false, attempts: 0 };

  claim.mockImplementation(async (_id, token, leaseMs = 120_000) => {
    if (row.notified) return false;
    if (row.token && row.expires > clock.now) return false; // a live lease is held
    row.token = token;
    row.expires = clock.now + leaseMs;
    return true;
  });
  markSent.mockImplementation(async (_id, token) => {
    if (row.token !== token) return false; // stale worker — affects zero rows
    row.notified = true;
    row.token = null;
    row.expires = 0;
    return true;
  });
  release.mockImplementation(async (_id, token, attempts) => {
    if (row.token !== token) return false; // stale worker must NOT clear a live lease
    row.token = null;
    row.expires = 0;
    row.attempts = attempts;
    return true;
  });
  return { row, clock };
}

beforeEach(() => {
  vi.clearAllMocks();
  installLedger();
  send.mockResolvedValue(undefined);
  regional.mockResolvedValue({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY" } as never);
});

describe("sweepRentalDeadlines — the happy path", () => {
  it("sends one reminder and marks it sent", async () => {
    due.mockResolvedValue([line()]);
    const r = await sweepRentalDeadlines(NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledWith("l1", expect.any(String));
    expect(r).toMatchObject({ scanned: 1, sent: 1, skipped: 0, failed: 0, lostLease: 0 });
  });

  it("emails the purchase order's PM", async () => {
    due.mockResolvedValue([line()]);
    await sweepRentalDeadlines(NOW);
    expect(send.mock.calls[0]![1]).toBe("pm@x.co");
  });

  it("falls back to the raiser when no PM is assigned", async () => {
    due.mockResolvedValue([line({ purchaseOrder: { code: "PO-0042", pmEmail: null, createdBy: "buyer@x.co" } })]);
    await sweepRentalDeadlines(NOW);
    expect(send.mock.calls[0]![1]).toBe("buyer@x.co");
  });

  it("sends nothing when there is nobody to send to", async () => {
    due.mockResolvedValue([line({ purchaseOrder: { code: "PO-0042", pmEmail: null, createdBy: null } })]);
    const r = await sweepRentalDeadlines(NOW);
    expect(send).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("does nothing at all when nothing is due", async () => {
    due.mockResolvedValue([]);
    const r = await sweepRentalDeadlines(NOW);
    expect(claim).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 0, sent: 0 });
  });

  // A hire date is a calendar day stored as UTC midnight, so it must be RENDERED in UTC. Formatted
  // in a zone behind UTC it would name the PREVIOUS day — the wrong deadline, in the one message
  // whose entire job is naming the deadline.
  it("renders the deadline as its calendar day, not shifted by the company timezone", async () => {
    regional.mockResolvedValue({ timezone: "America/New_York", dateFormat: "DD/MM/YYYY" } as never);
    due.mockResolvedValue([line({ hireEndDate: new Date("2026-10-01T00:00:00Z") })]);
    await sweepRentalDeadlines(NOW);
    expect(send.mock.calls[0]![2]).toMatchObject({ hireEndDate: "01/10/2026" });
  });
});

describe("sweepRentalDeadlines — concurrency", () => {
  // THE property. Two sweeps racing the same row must produce ONE email.
  it("sends once when two sweeps run concurrently", async () => {
    due.mockResolvedValue([line()]);
    const [a, b] = await Promise.all([sweepRentalDeadlines(NOW), sweepRentalDeadlines(NOW)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
  });

  it("claims with a fresh token each pass rather than a constant", async () => {
    due.mockResolvedValue([line()]);
    await sweepRentalDeadlines(NOW);
    const first = claim.mock.calls[0]![1];

    vi.clearAllMocks();
    installLedger();
    send.mockResolvedValue(undefined);
    regional.mockResolvedValue({ timezone: "Europe/London", dateFormat: "DD/MM/YYYY" } as never);
    due.mockResolvedValue([line()]);
    await sweepRentalDeadlines(NOW);

    expect(claim.mock.calls[0]![1]).not.toBe(first);
  });

  it("never re-sends a reminder that was already completed", async () => {
    const { row } = installLedger();
    row.notified = true;
    due.mockResolvedValue([line()]);
    const r = await sweepRentalDeadlines(NOW);
    expect(send).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });
});

// Simultaneous initial claims are the easy case. These are the ones an expiry-only lease gets
// wrong: the lease lapses while its holder is still inside a slow SMTP call.
describe("sweepRentalDeadlines — lease expiry mid-send", () => {
  it("a worker whose lease expired mid-send cannot mark the row sent", async () => {
    const { clock } = installLedger();
    due.mockResolvedValue([line()]);
    send.mockImplementation(async () => {
      clock.now += 130_000; // past the 120s lease
      await poRepo.claimReminder("l1", "worker-b-token");
    });

    const r = await sweepRentalDeadlines(NOW);

    await expect(markSent.mock.results[0]!.value).resolves.toBe(false);
    expect(r).toMatchObject({ sent: 0, lostLease: 1 });
  });

  // THE bug the token exists to prevent: without it this release would clear worker B's LIVE lease,
  // and a third worker could then claim while B was still sending.
  it("a stale worker's failed send cannot release the live worker's claim", async () => {
    const { row, clock } = installLedger();
    due.mockResolvedValue([line()]);
    send.mockImplementation(async () => {
      clock.now += 130_000;
      await poRepo.claimReminder("l1", "worker-b-token");
      throw new Error("SMTP timed out");
    });

    const r = await sweepRentalDeadlines(NOW);

    await expect(release.mock.results[0]!.value).resolves.toBe(false);
    expect(row.token).toBe("worker-b-token"); // B still owns it
    expect(r).toMatchObject({ sent: 0, failed: 0, lostLease: 1 });
  });

  it("lets a later pass re-claim a row whose holder crashed and never returned", async () => {
    const { clock } = installLedger();
    await poRepo.claimReminder("l1", "crashed-worker");
    clock.now += 130_000; // the lease lapses with nobody completing it
    due.mockResolvedValue([line()]);
    const r = await sweepRentalDeadlines(NOW);
    expect(r).toMatchObject({ sent: 1 });
  });
});

describe("sweepRentalDeadlines — failure handling", () => {
  it("releases the claim and counts a failure when the send throws", async () => {
    due.mockResolvedValue([line()]);
    send.mockRejectedValue(new Error("SMTP down"));
    const r = await sweepRentalDeadlines(NOW);
    expect(markSent).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("l1", expect.any(String), 1);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
  });

  // A broken SMTP config must not retry forever. Giving up is safe because the BADGE is the durable
  // notification — it is recomputed from the rows on every read, whatever the sweep did.
  it("gives up after the attempt limit instead of retrying forever", async () => {
    due.mockResolvedValue([line({ deadlineNotifyAttempts: 5 })]);
    const r = await sweepRentalDeadlines(NOW);
    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(r.givenUp).toBe(1);
  });

  /**
   * A given-up row must leave the QUERY, not just be skipped once it is in hand.
   *
   * `findDueForReminder` selected on "not yet notified and not leased", and giving up writes neither
   * — so the row kept matching forever. It also sorts to the FRONT (`orderBy hireEndDate asc`, and a
   * row that has burned five attempts is among the soonest to expire), so it consumed one of the 100
   * slots in every subsequent pass. A few days of broken SMTP is enough to fill the batch with rows
   * that will never be sent, and a genuinely-due hire sitting at position 101 then gets no reminder
   * at all — while the log repeats the same hundred "giving up" lines every two hours.
   *
   * Bounding it in the query is what takes them out of the running set. The in-hand check above stays
   * as a backstop for a row claimed before the limit was lowered.
   */
  it("excludes rows past the attempt limit from the query itself", async () => {
    due.mockResolvedValue([]);
    await sweepRentalDeadlines(NOW);
    expect(due).toHaveBeenCalledWith(expect.any(Date), expect.any(Number), 5);
  });

  // One line when the last attempt fails, not one on every pass forever after. The message is about
  // a transition — "this reminder has stopped being retried" — and a transition happens once.
  it("logs the give-up once, when the final attempt fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    due.mockResolvedValue([line({ deadlineNotifyAttempts: 4 })]);
    send.mockRejectedValue(new Error("SMTP down"));
    release.mockResolvedValue(true);
    await sweepRentalDeadlines(NOW);
    expect(error.mock.calls.some((c) => String(c[0]).includes("giving up"))).toBe(true);
    error.mockRestore();
  });
});
