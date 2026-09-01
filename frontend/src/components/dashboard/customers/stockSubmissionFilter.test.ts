import { describe, expect, it } from "vitest";

/** The menu is built from per-status COUNTS now (page metadata), so these fixtures tally the rows. */
const countsOf = (rows: { status: string }[]): Record<string, number> =>
  rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

import {
  ALL,
  DEFAULT_SUBMISSION_FILTERS,
  OPEN,
  effectiveSubmissionFilters,
  filterSubmissions,
  hasActiveSubmissionFilter,
  type SubmissionLike,
  ACTIONABLE_STATUSES,
  NEEDS_YOU,
  submissionStatusOptions,
  isActionable,
  OPEN_STATUSES,
} from "./stockSubmissionFilter";

const sub = (over: Partial<SubmissionLike> = {}): SubmissionLike => ({
  name: "Fibre drum",
  editedName: null,
  status: "pending",
  ...over,
});

// Two open, two finished — the detail payload now carries both, which is the whole reason the tab
// needs an "Open" default at all.
const ROWS: SubmissionLike[] = [
  sub({ name: "Fibre drum", status: "pending" }),
  sub({ name: "Optical splitter", status: "approved" }),
  sub({ name: "Patch leads", editedName: "Patch leads (Cat6)", status: "completed" }),
  sub({ name: "Connectors", status: "rejected" }),
];

const names = (rows: SubmissionLike[]) => rows.map((r) => r.name);
const showAll = { search: "", status: ALL };

describe("filterSubmissions — the Open default", () => {
  it("shows only outstanding work by default", () => {
    // A short-closed submission completes its request; without this default the tab would open on
    // the customer's whole history instead of what still needs doing.
    expect(names(filterSubmissions(ROWS, DEFAULT_SUBMISSION_FILTERS))).toEqual([
      "Fibre drum",
      "Optical splitter",
    ]);
  });

  it("shows everything when asked for ALL", () => {
    expect(filterSubmissions(ROWS, showAll)).toHaveLength(4);
  });

  it("can single out the finished ones — where a short-closure is read", () => {
    expect(names(filterSubmissions(ROWS, { search: "", status: "completed" }))).toEqual(["Patch leads"]);
  });

  it("treats a whitespace-only search as no search", () => {
    expect(filterSubmissions(ROWS, { ...showAll, search: "   " })).toHaveLength(4);
  });
});

describe("filterSubmissions — search", () => {
  it("matches the submitted name", () => {
    expect(names(filterSubmissions(ROWS, { ...showAll, search: "fibre" }))).toEqual(["Fibre drum"]);
  });

  it("matches the RENAMED name too", () => {
    // The row displays editedName, so searching what's on screen has to work.
    expect(names(filterSubmissions(ROWS, { ...showAll, search: "Cat6" }))).toEqual(["Patch leads"]);
  });

  it("still matches the ORIGINAL name after a rename", () => {
    // The customer on the phone calls it by what they submitted, not what we renamed it to.
    expect(names(filterSubmissions(ROWS, { ...showAll, search: "patch leads" }))).toEqual(["Patch leads"]);
  });

  it("ANDs search and status together", () => {
    expect(filterSubmissions(ROWS, { search: "fibre", status: "approved" })).toEqual([]);
    expect(names(filterSubmissions(ROWS, { search: "fibre", status: "pending" }))).toEqual(["Fibre drum"]);
  });

  it("a search still respects the Open default", () => {
    // Searching a completed item from the default view finds nothing — the status filter is what
    // widens it, and the empty state tells the user so.
    expect(filterSubmissions(ROWS, { ...DEFAULT_SUBMISSION_FILTERS, search: "patch" })).toEqual([]);
    expect(names(filterSubmissions(ROWS, { ...showAll, search: "patch" }))).toEqual(["Patch leads"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterSubmissions(ROWS, { ...showAll, search: "  OPTICAL  " })).toHaveLength(1);
  });

  it("returns an empty list rather than throwing on no rows", () => {
    expect(filterSubmissions([], { ...showAll, search: "x" })).toEqual([]);
  });
});

describe("hasActiveSubmissionFilter", () => {
  it("is false on the default view — sitting on Open is not 'filtered'", () => {
    expect(hasActiveSubmissionFilter(DEFAULT_SUBMISSION_FILTERS)).toBe(false);
    expect(hasActiveSubmissionFilter({ ...DEFAULT_SUBMISSION_FILTERS, search: "  " })).toBe(false);
  });

  it("is true once the user moves away from it", () => {
    expect(hasActiveSubmissionFilter({ ...DEFAULT_SUBMISSION_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveSubmissionFilter(showAll)).toBe(true);
    expect(hasActiveSubmissionFilter({ search: "", status: "completed" })).toBe(true);
  });

  it("defaults to Open, not to All", () => {
    // Both the first render and Clear use this, so dropping a search term can never dump the
    // customer's whole history on someone who only wanted to widen the list slightly.
    expect(DEFAULT_SUBMISSION_FILTERS).toEqual({ search: "", status: OPEN });
  });
});

describe("submissionStatusOptions", () => {
  it("offers Open first, then All, then each status by review urgency", () => {
    // TWO open statuses here (pending + approved), so both stay — Open is a genuine superset.
    expect(submissionStatusOptions(countsOf(ROWS))).toEqual([
      { value: OPEN, label: "Open (2)" },
      { value: ALL, label: "All statuses (4)" },
      { value: "pending", label: "Pending (1)" },
      { value: "approved", label: "Approved (1)" },
      { value: "completed", label: "Completed (1)" },
      { value: "rejected", label: "Rejected (1)" },
    ]);
  });

  it("drops the lone open status — Open already selects exactly those rows", () => {
    // "Open (2)" sitting next to "Partially received (2)", both selecting the same two rows, reads
    // as a bug. Only the superset is offered.
    const onlyPartial = [
      sub({ status: "partially_received" }),
      sub({ status: "partially_received" }),
      sub({ status: "completed" }),
    ];
    expect(submissionStatusOptions(countsOf(onlyPartial))).toEqual([
      { value: OPEN, label: "Open (2)" },
      { value: ALL, label: "All statuses (3)" },
      { value: "completed", label: "Completed (1)" },
    ]);
  });

  it("brings the individual option back once a second open status appears", () => {
    // With pending AND partially_received present the two stop being interchangeable, so both are
    // worth offering again.
    const mixed = [
      sub({ status: "partially_received" }),
      sub({ status: "pending" }),
      sub({ status: "completed" }),
    ];
    expect(submissionStatusOptions(countsOf(mixed)).map((o) => o.value)).toEqual([
      OPEN,
      // Open holds both of them; only `pending` is waiting on this screen, so the two select
      // different rows and both are worth offering.
      NEEDS_YOU,
      ALL,
      "pending",
      "partially_received",
      "completed",
    ]);
  });

  it("keeps finished statuses even when only one of them has rows", () => {
    // The de-duplication is about the OPEN superset only — `completed` has no superset to collapse
    // into, so it must never be dropped.
    const oneCompleted = [sub({ status: "completed" })];
    expect(submissionStatusOptions(countsOf(oneCompleted)).map((o) => o.value)).toEqual([OPEN, ALL, "completed"]);
  });

  it("always offers Open even at zero — it's where Clear returns to", () => {
    const finishedOnly = [sub({ status: "completed" })];
    expect(submissionStatusOptions(countsOf(finishedOnly))[0]).toEqual({ value: OPEN, label: "Open (0)" });
  });

  it("omits a status no row has, so the menu can't filter to nothing", () => {
    // Only `pending` has rows, and it's the lone open status — Open (1) already selects it, so the
    // individual entry collapses away and nothing else is offered.
    expect(submissionStatusOptions(countsOf([sub({ status: "pending" })])).map((o) => o.value)).toEqual([OPEN, ALL]);
  });

  it("still surfaces an unrecognised status instead of hiding those rows", () => {
    // `on_hold` isn't a known open status, so it can't collapse into Open and must stay reachable —
    // otherwise those rows would be unfilterable. (`pending` collapses: it's the lone open one.)
    const odd = [sub({ status: "pending" }), sub({ status: "on_hold" })];
    expect(submissionStatusOptions(countsOf(odd)).map((o) => o.value)).toEqual([OPEN, ALL, "on_hold"]);
  });
});

describe("effectiveSubmissionFilters", () => {
  const opts = submissionStatusOptions(countsOf(ROWS));

  it("keeps a pick that still has an option", () => {
    const f = { search: "x", status: "pending" };
    expect(effectiveSubmissionFilters(f, opts)).toEqual(f);
  });

  it("falls back to the DEFAULT view when the picked status no longer has rows", () => {
    // Not to ALL — a vanished pick shouldn't silently widen the tab to the whole history.
    const noPending = submissionStatusOptions(countsOf(ROWS.filter((r) => r.status !== "pending")));
    expect(effectiveSubmissionFilters({ search: "", status: "pending" }, noPending).status).toBe(OPEN);
  });

  it("never touches the search term", () => {
    expect(effectiveSubmissionFilters({ search: "keep me", status: ALL }, opts).search).toBe("keep me");
  });
});

// The tab badge read "2" while the tab opened on four rows, with nothing marking which two. Both
// numbers were right — they answered different questions (the badge counted `pending`, the list
// defaults to `Open`, four statuses) — but shown 2cm apart with no explanation they read as a
// contradiction. And one of the four, `approved`, was outstanding work counted by NOTHING: it has an
// "Assign warehouses" button, but the pending count stops before it and the warehouse count can only
// see assignments that step creates.
describe("isActionable — what the Submissions tab still owes", () => {
  const row = (status: string): SubmissionLike => ({ name: "x", editedName: null, status });

  it("claims a request awaiting review", () => {
    expect(isActionable(row("pending"))).toBe(true);
  });

  // The queue that had no count at all.
  it("claims an approved request still to be routed to warehouses", () => {
    expect(isActionable(row("approved"))).toBe(true);
  });

  // Still in flight, but the outstanding step is RECEIVING — done at the warehouse, and already
  // counted there. Claiming it here would double-count one piece of work across two badges.
  it("does not claim rows whose remaining work belongs to the warehouse", () => {
    expect(isActionable(row("assigned"))).toBe(false);
    expect(isActionable(row("partially_received"))).toBe(false);
  });

  it("does not claim finished rows", () => {
    expect(isActionable(row("completed"))).toBe(false);
    expect(isActionable(row("rejected"))).toBe(false);
  });

  // The marks on screen and the badge above them are summed from this ONE predicate, so they cannot
  // drift; a row that lights up is a row the number counted.
  it("marks exactly as many rows as the badge counts", () => {
    const rows = ["pending", "approved", "assigned", "partially_received", "completed"].map(row);
    expect(rows.filter(isActionable).map((r) => r.status)).toEqual(["pending", "approved"]);
  });

  // Actionable rows must survive the view the tab opens on, or the badge would point at rows the
  // default filter hides.
  it("keeps every actionable status inside the default Open view", () => {
    for (const status of ACTIONABLE_STATUSES) {
      expect(OPEN_STATUSES, `"${status}" is counted but hidden by the default filter`).toContain(status);
    }
  });
});

// "Which ones need me" is answered by a FILTER, not by painting rows. The first attempt tinted the
// actionable rows amber; in the default Open view — actionable rows plus receiving-in-progress ones —
// that routinely covered most of the list, and a highlight covering three rows in four inverts its
// own meaning: the unmarked row becomes the signal. This option is the tab's badge made clickable.
describe("Needs you — the tab's count, made selectable", () => {
  const row = (status: string, name = "x"): SubmissionLike => ({ name, editedName: null, status });

  it("selects exactly the rows the badge counts", () => {
    const rows = [row("pending"), row("partially_received"), row("approved"), row("completed")];
    const picked = filterSubmissions(rows, { search: "", status: NEEDS_YOU });
    expect(picked.map((r) => r.status)).toEqual(["pending", "approved"]);
    expect(picked.length).toBe(rows.filter(isActionable).length);
  });

  it("offers the option with its count, right under Open", () => {
    const rows = [row("pending"), row("approved"), row("partially_received"), row("completed")];
    const opts = submissionStatusOptions(countsOf(rows));
    expect(opts[0].value).toBe(OPEN);
    expect(opts[1]).toEqual({ value: NEEDS_YOU, label: "Needs you (2)" });
  });

  // An option that can only ever produce an empty list is not a choice.
  it("is hidden when nothing needs you", () => {
    const opts = submissionStatusOptions(countsOf([row("completed"), row("partially_received")]));
    expect(opts.some((o) => o.value === NEEDS_YOU)).toBe(false);
  });

  // Two entries selecting the same rows read as a bug — the same reasoning that drops a redundant
  // single open status. Open wins because it is the default and where Clear returns to.
  it("is hidden when it would select the same rows as Open", () => {
    const opts = submissionStatusOptions(countsOf([row("pending"), row("approved")]));
    expect(opts.some((o) => o.value === NEEDS_YOU)).toBe(false);
    expect(opts[0]).toEqual({ value: OPEN, label: "Open (2)" });
  });

  it("comes back as soon as Open holds something it doesn't", () => {
    const opts = submissionStatusOptions(countsOf([row("pending"), row("approved"), row("assigned")]));
    expect(opts.some((o) => o.value === NEEDS_YOU)).toBe(true);
  });

  it("still applies the search term", () => {
    const rows = [row("pending", "fibre"), row("approved", "cable")];
    expect(filterSubmissions(rows, { search: "fib", status: NEEDS_YOU }).map((r) => r.name)).toEqual(["fibre"]);
  });
});
