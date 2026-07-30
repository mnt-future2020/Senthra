import { describe, expect, it } from "vitest";

import {
  ALL,
  DEFAULT_SUBMISSION_FILTERS,
  OPEN,
  effectiveSubmissionFilters,
  filterSubmissions,
  hasActiveSubmissionFilter,
  submissionStatusOptions,
  type SubmissionLike,
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
    expect(submissionStatusOptions(ROWS)).toEqual([
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
    expect(submissionStatusOptions(onlyPartial)).toEqual([
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
    expect(submissionStatusOptions(mixed).map((o) => o.value)).toEqual([
      OPEN,
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
    expect(submissionStatusOptions(oneCompleted).map((o) => o.value)).toEqual([OPEN, ALL, "completed"]);
  });

  it("always offers Open even at zero — it's where Clear returns to", () => {
    const finishedOnly = [sub({ status: "completed" })];
    expect(submissionStatusOptions(finishedOnly)[0]).toEqual({ value: OPEN, label: "Open (0)" });
  });

  it("omits a status no row has, so the menu can't filter to nothing", () => {
    // Only `pending` has rows, and it's the lone open status — Open (1) already selects it, so the
    // individual entry collapses away and nothing else is offered.
    expect(submissionStatusOptions([sub({ status: "pending" })]).map((o) => o.value)).toEqual([OPEN, ALL]);
  });

  it("still surfaces an unrecognised status instead of hiding those rows", () => {
    // `on_hold` isn't a known open status, so it can't collapse into Open and must stay reachable —
    // otherwise those rows would be unfilterable. (`pending` collapses: it's the lone open one.)
    const odd = [sub({ status: "pending" }), sub({ status: "on_hold" })];
    expect(submissionStatusOptions(odd).map((o) => o.value)).toEqual([OPEN, ALL, "on_hold"]);
  });
});

describe("effectiveSubmissionFilters", () => {
  const opts = submissionStatusOptions(ROWS);

  it("keeps a pick that still has an option", () => {
    const f = { search: "x", status: "pending" };
    expect(effectiveSubmissionFilters(f, opts)).toEqual(f);
  });

  it("falls back to the DEFAULT view when the picked status no longer has rows", () => {
    // Not to ALL — a vanished pick shouldn't silently widen the tab to the whole history.
    const noPending = submissionStatusOptions(ROWS.filter((r) => r.status !== "pending"));
    expect(effectiveSubmissionFilters({ search: "", status: "pending" }, noPending).status).toBe(OPEN);
  });

  it("never touches the search term", () => {
    expect(effectiveSubmissionFilters({ search: "keep me", status: ALL }, opts).search).toBe("keep me");
  });
});
