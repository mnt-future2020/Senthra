import { describe, expect, it } from "vitest";

import { BUCKET_ORDER, classify, countBuckets, effectiveDate, paginateGroups } from "./ExpectedDeliveries";
import type { Bucket } from "./ExpectedDeliveries";

// Local midnight, matching how the component anchors "today".
const todayMs = (() => {
  const d = new Date("2026-07-20T09:15:00");
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

// Build an ISO string for a date N days from the anchor, at an awkward hour so we also prove the
// comparison is date-only (a delivery at 23:00 today is still "today", not "tomorrow").
const daysOut = (n: number, hour = 13) => {
  const d = new Date(todayMs);
  d.setDate(d.getDate() + n);
  d.setHours(hour, 30, 0, 0);
  return d.toISOString();
};

const bucketOf = (iso: string | null) => classify(iso, todayMs).bucket;

describe("classify — delivery time buckets", () => {
  it("puts a PO with NO date in its own bucket, not in 'future'", () => {
    // The bug this guards: a missing date used to render under "Future", telling the warehouse
    // manager "3 future deliveries" when nobody had actually committed to a delivery at all.
    expect(bucketOf(null)).toBe("nodate");
    expect(classify(null, todayMs).daysDiff).toBeNull();
  });

  it("buckets past dates as overdue and reports how many days late", () => {
    expect(bucketOf(daysOut(-1))).toBe("overdue");
    expect(bucketOf(daysOut(-30))).toBe("overdue");
    expect(classify(daysOut(-3), todayMs).daysDiff).toBe(-3);
  });

  it("buckets today, tomorrow, and the next-7-days window", () => {
    expect(bucketOf(daysOut(0))).toBe("today");
    expect(bucketOf(daysOut(1))).toBe("tomorrow");
    expect(bucketOf(daysOut(2))).toBe("upcoming");
    expect(bucketOf(daysOut(7))).toBe("upcoming");
  });

  it("treats day 8 onwards as future (the 7-day boundary is inclusive)", () => {
    expect(bucketOf(daysOut(8))).toBe("future");
    expect(bucketOf(daysOut(365))).toBe("future");
  });

  it("compares whole calendar days, ignoring the time of day", () => {
    // A delivery at 23:30 tonight is still today's problem; one at 00:30 tomorrow is not.
    expect(bucketOf(daysOut(0, 23))).toBe("today");
    expect(bucketOf(daysOut(1, 0))).toBe("tomorrow");
  });
});

describe("effectiveDate — which date the warehouse plans against", () => {
  it("prefers the supplier's confirmed date over our expectation", () => {
    // The bug this guards: the warehouse read expectedDeliveryDate only, so a supplier-confirmed
    // slip never moved the row — the worklist silently kept showing the buyer's original guess.
    expect(
      effectiveDate({ expectedDeliveryDate: "2026-07-24T00:00:00.000Z", confirmedDeliveryDate: "2026-07-29T00:00:00.000Z" }),
    ).toEqual({ iso: "2026-07-29T00:00:00.000Z", confirmed: true });
  });

  it("falls back to the expected date when the supplier hasn't confirmed one", () => {
    expect(effectiveDate({ expectedDeliveryDate: "2026-07-24T00:00:00.000Z", confirmedDeliveryDate: null })).toEqual({
      iso: "2026-07-24T00:00:00.000Z",
      confirmed: false,
    });
  });

  it("reports no date when neither is set", () => {
    expect(effectiveDate({ expectedDeliveryDate: null, confirmedDeliveryDate: null })).toEqual({ iso: null, confirmed: false });
  });

  it("a confirmed slip past today moves the row into overdue", () => {
    // End-to-end of the two units: confirmed date wins, and the bucket follows it.
    const { iso } = effectiveDate({ expectedDeliveryDate: daysOut(5), confirmedDeliveryDate: daysOut(-2) });
    expect(bucketOf(iso)).toBe("overdue");
  });
});

describe("bucket counts vs. pagination", () => {
  const rowsOf = (bucket: Bucket, n: number) => Array.from({ length: n }, () => ({ bucket }));

  it("counts every row in the worklist, not just the visible page", () => {
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const totals = countBuckets(rows);
    expect(totals.get("overdue")).toBe(27);
    expect(totals.get("today")).toBe(5);
  });

  it("reports the FULL bucket total on every page, while rows stay page-scoped", () => {
    // The bug this guards: the header used to count only the current slice, so the same 27
    // overdue orders read "(20)" on page 1 and "(7)" on page 2 — and neither matched the
    // summary line above the table.
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const totals = countBuckets(rows);

    const p1 = paginateGroups(rows, 1, totals);
    expect(p1.totalPages).toBe(2);
    const overdue1 = p1.pagedGroups.find((g) => g.key === "overdue")!;
    expect(overdue1.total).toBe(27); // what the header shows
    expect(overdue1.rows).toHaveLength(20); // what's actually rendered

    const p2 = paginateGroups(rows, 2, totals);
    const overdue2 = p2.pagedGroups.find((g) => g.key === "overdue")!;
    expect(overdue2.total).toBe(27); // SAME total on page 2
    expect(overdue2.rows).toHaveLength(7);
  });

  it("shows only the buckets present on the current page", () => {
    // 'today' rows all sit on page 2, so page 1 must not render an empty 'today' header.
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const totals = countBuckets(rows);
    expect(paginateGroups(rows, 1, totals).pagedGroups.map((g) => g.key)).toEqual(["overdue"]);
    expect(paginateGroups(rows, 2, totals).pagedGroups.map((g) => g.key)).toEqual(["overdue", "today"]);
  });

  it("keeps buckets in their fixed urgency order, with No date second", () => {
    const rows = [...rowsOf("future", 1), ...rowsOf("nodate", 1), ...rowsOf("overdue", 1), ...rowsOf("today", 1)];
    const { pagedGroups } = paginateGroups(rows, 1, countBuckets(rows));
    expect(pagedGroups.map((g) => g.key)).toEqual(["overdue", "nodate", "today", "future"]);
  });

  it("clamps an out-of-range page instead of rendering nothing", () => {
    const rows = rowsOf("overdue", 27);
    const totals = countBuckets(rows);
    // Page 9 doesn't exist (only 2 pages) — clamp to the last rather than show a blank table.
    expect(paginateGroups(rows, 9, totals).pagedGroups[0].rows).toHaveLength(7);
    expect(paginateGroups(rows, 0, totals).pagedGroups[0].rows).toHaveLength(20);
  });

  it("handles an empty worklist without inventing pages", () => {
    const { pagedGroups, totalPages } = paginateGroups([], 1, countBuckets([]));
    expect(pagedGroups).toEqual([]);
    expect(totalPages).toBe(1);
  });

  // Rows are paginated from a flat array but rendered under group headers, so the row order and
  // the header order MUST come from the same sequence. If they diverge (e.g. undated rows sorted
  // above overdue while the header renders below it), an overdue order can be pushed off page 1
  // by rows that display beneath it.
  it("orders rows by the same bucket sequence the headers render in", () => {
    // Mirrors the component's sort: rows arrive at paginateGroups already ordered by bucket.
    const unsorted = [...rowsOf("future", 21), ...rowsOf("nodate", 1), ...rowsOf("overdue", 1)];
    const rows = [...unsorted].sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket));

    const { pagedGroups } = paginateGroups(rows, 1, countBuckets(rows));
    // Page 1 leads with the most urgent buckets rather than being flooded by 'future'.
    expect(pagedGroups.map((g) => g.key)).toEqual(["overdue", "nodate", "future"]);
    expect(pagedGroups[0].rows).toHaveLength(1); // the overdue row made page 1
    expect(pagedGroups[1].rows).toHaveLength(1); // so did the undated one
    // …and the header sequence matches the row sequence exactly — the invariant that keeps a
    // paginated slice consistent with the headers above it.
    expect(pagedGroups.map((g) => g.key)).toEqual(BUCKET_ORDER.filter((k) => pagedGroups.some((g) => g.key === k)));
  });
});
