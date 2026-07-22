import { describe, expect, it } from "vitest";

import { BUCKET_ORDER, classify, countBuckets, effectiveDate, filterRows, urgencyBadge, filterOptions } from "./ExpectedDeliveries";
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

const rowsOf = (bucket: Bucket, n: number) => Array.from({ length: n }, () => ({ bucket }));

describe("countBuckets + filterOptions — the filter menu", () => {
  it("counts every row in the worklist, not just the visible page", () => {
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const totals = countBuckets(rows);
    expect(totals.get("overdue")).toBe(27);
    expect(totals.get("today")).toBe(5);
  });

  it("shows an option's FULL worklist count, independent of what's on screen", () => {
    // The bug this guards: counts used to be rendered by the in-table group headers, which saw
    // only the current page — so the same 27 overdue orders read "(20)" on page 1 and "(7)" on
    // page 2. Options read from countBuckets over the whole worklist, so paging can't change them.
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const options = filterOptions(countBuckets(rows));
    expect(options.find((c) => c.key === "overdue")!.count).toBe(27);
    expect(options.find((c) => c.key === "all")!.count).toBe(32);
  });

  it("leads with All and keeps buckets in fixed urgency order, No date second", () => {
    const rows = [...rowsOf("today", 1), ...rowsOf("nodate", 1), ...rowsOf("overdue", 1), ...rowsOf("tomorrow", 1)];
    const options = filterOptions(countBuckets(rows));
    expect(options.map((c) => c.key)).toEqual(["all", "overdue", "nodate", "today", "tomorrow"]);
  });

  it("omits empty buckets — an option that leads only to an empty table is a dead end", () => {
    const rows = [...rowsOf("overdue", 3), ...rowsOf("future", 2)];
    expect(filterOptions(countBuckets(rows)).map((c) => c.key)).toEqual(["all", "overdue"]);
  });

  it("never offers a This week or Future option, however many rows are in them", () => {
    // The core of this redesign: those words appear nowhere in the UI. Their rows are reachable
    // via All and identified by their own date — no label restating it.
    const rows = [...rowsOf("upcoming", 4), ...rowsOf("future", 9)];
    const options = filterOptions(countBuckets(rows));
    expect(options.map((c) => c.key)).toEqual(["all"]);
    expect(options[0].count).toBe(13); // …but All still counts every one of them
  });

  it("derives the All count from the same totals as the bucket options", () => {
    // All used to take the total as a separate argument, so a caller could hand it a number that
    // disagreed with the buckets and the menu would quietly contradict itself.
    const totals = countBuckets([...rowsOf("overdue", 3), ...rowsOf("future", 4)]);
    expect(filterOptions(totals).find((c) => c.key === "all")!.count).toBe(7);
  });
});

describe("filterRows — filtering and pagination together", () => {
  it("'all' returns every row, paginated", () => {
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const { rows: page1, totalPages, matchCount } = filterRows(rows, "all", 1);
    expect(matchCount).toBe(32);
    expect(totalPages).toBe(2);
    expect(page1).toHaveLength(20);
    expect(filterRows(rows, "all", 2).rows).toHaveLength(12);
  });

  it("a bucket filter narrows both the rows AND the page count", () => {
    // matchCount/totalPages must describe the FILTERED set, not the whole worklist — otherwise
    // pagination offers page 2 of a filter that only fills one page.
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    const { rows: shown, totalPages, matchCount } = filterRows(rows, "today", 1);
    expect(matchCount).toBe(5);
    expect(totalPages).toBe(1);
    expect(shown).toHaveLength(5);
    expect(shown.every((r) => r.bucket === "today")).toBe(true);
  });

  it("clamps an out-of-range page instead of rendering nothing", () => {
    // Reachable by sitting on page 2 and then selecting a filter with fewer rows: the page index
    // survives the filter change, so an unclamped slice would render a blank table.
    const rows = [...rowsOf("overdue", 27), ...rowsOf("today", 5)];
    expect(filterRows(rows, "today", 2).rows).toHaveLength(5);
    expect(filterRows(rows, "all", 9).rows).toHaveLength(12); // clamped to the last page
    expect(filterRows(rows, "all", 0).rows).toHaveLength(20); // clamped to the first
  });

  it("returns an empty page — not a crash — for a bucket with no rows", () => {
    const rows = rowsOf("future", 3);
    const { rows: shown, totalPages, matchCount } = filterRows(rows, "overdue", 1);
    expect(shown).toEqual([]);
    expect(matchCount).toBe(0);
    expect(totalPages).toBe(1);
  });

  it("handles an empty worklist without inventing pages", () => {
    expect(filterRows([], "all", 1)).toEqual({ rows: [], totalPages: 1, matchCount: 0 });
  });

  it("preserves the caller's row order within a filter", () => {
    // The component sorts by BUCKET_ORDER then date before calling in; filtering must not reshuffle.
    const rows = [...rowsOf("future", 2), ...rowsOf("nodate", 1), ...rowsOf("overdue", 1)].sort(
      (a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
    );
    expect(filterRows(rows, "all", 1).rows.map((r) => r.bucket)).toEqual(["overdue", "nodate", "future", "future"]);
  });
});

describe("urgencyBadge — the per-row urgency cue", () => {
  it("badges overdue rows with how many days late", () => {
    // The ONLY fact a badge adds that the date column can't give at a glance, and the reason the
    // badge survives at all now that the group headers are gone.
    expect(urgencyBadge({ bucket: "overdue", daysDiff: -3 })).toBe("3d late");
    expect(urgencyBadge({ bucket: "overdue", daysDiff: -1 })).toBe("1d late");
  });

  it("badges NOTHING else — every other badge would restate the date beside it", () => {
    // The invariant this whole redesign turns on. A "Today" badge next to today's date, a
    // "No date" badge next to "Not set", a "Future" badge next to 05 Aug — each states one fact
    // twice, which is what made the original screen confusing. The bucket is how you FILTER;
    // it is never repeated on the row.
    expect(urgencyBadge({ bucket: "today", daysDiff: 0 })).toBeNull();
    expect(urgencyBadge({ bucket: "tomorrow", daysDiff: 1 })).toBeNull();
    expect(urgencyBadge({ bucket: "nodate", daysDiff: null })).toBeNull();
    expect(urgencyBadge({ bucket: "upcoming", daysDiff: 3 })).toBeNull();
    expect(urgencyBadge({ bucket: "future", daysDiff: 15 })).toBeNull();
  });

  it("returns null for an overdue row with no daysDiff rather than rendering a bare badge", () => {
    // Unreachable via classify() (overdue always carries a diff), but the types permit it and a
    // badge reading just "late" would be noise.
    expect(urgencyBadge({ bucket: "overdue", daysDiff: null })).toBeNull();
  });
});

describe("the filter counts never claim rows aren't on the table", () => {
  it("All counts the unlabelled buckets even though no option names them", () => {
    // The bug this guards: an "+N scheduled later" note was briefly added beside the filter to
    // surface the unlabelled buckets, but those rows are ALREADY listed under All — so a single
    // upcoming delivery rendered as "All 1  +1 scheduled later" above one row, implying a second
    // delivery existed somewhere off-screen. Unlabelled rows are counted by All and by nothing else.
    const rows = [...rowsOf("overdue", 2), ...rowsOf("today", 4), ...rowsOf("upcoming", 5), ...rowsOf("future", 6)];
    const options = filterOptions(countBuckets(rows));
    const all = options.find((c) => c.key === "all")!.count;
    expect(all).toBe(17); // every row, labelled bucket or not
    expect(options.map((c) => c.key)).toEqual(["all", "overdue", "today"]); // …but only 2 named options
  });

  it("never renders a count that exceeds the rows the table can show", () => {
    // Every option's count must be reachable by selecting it: All shows all rows, each bucket option
    // shows its own. No option may describe rows the table won't list.
    const rows = [...rowsOf("overdue", 3), ...rowsOf("future", 4)];
    for (const c of filterOptions(countBuckets(rows))) {
      expect(filterRows(rows, c.key, 1).matchCount).toBe(c.count);
    }
  });
});
