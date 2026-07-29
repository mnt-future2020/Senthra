import { describe, expect, it } from "vitest";

import {
  ALL,
  EMPTY_SUBMISSION_FILTERS,
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

const ROWS: SubmissionLike[] = [
  sub({ name: "Fibre drum", status: "pending" }),
  sub({ name: "Optical splitter", status: "approved" }),
  sub({ name: "Patch leads", editedName: "Patch leads (Cat6)", status: "completed" }),
  sub({ name: "Connectors", status: "pending" }),
];

const names = (rows: SubmissionLike[]) => rows.map((r) => r.name);

describe("filterSubmissions", () => {
  it("returns everything when nothing is filtered", () => {
    expect(filterSubmissions(ROWS, EMPTY_SUBMISSION_FILTERS)).toHaveLength(4);
  });

  it("matches the submitted name", () => {
    expect(names(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, search: "fibre" }))).toEqual([
      "Fibre drum",
    ]);
  });

  it("matches the RENAMED name too", () => {
    // The row displays editedName, so searching what's on screen has to work.
    expect(names(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, search: "Cat6" }))).toEqual([
      "Patch leads",
    ]);
  });

  it("still matches the ORIGINAL name after a rename", () => {
    // The customer on the phone calls it by what they submitted, not what we renamed it to.
    expect(names(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, search: "patch leads" }))).toEqual([
      "Patch leads",
    ]);
  });

  it("filters by status", () => {
    expect(names(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, status: "pending" }))).toEqual([
      "Fibre drum",
      "Connectors",
    ]);
  });

  it("ANDs search and status together", () => {
    expect(filterSubmissions(ROWS, { search: "fibre", status: "approved" })).toEqual([]);
    expect(names(filterSubmissions(ROWS, { search: "fibre", status: "pending" }))).toEqual(["Fibre drum"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, search: "  OPTICAL  " })).toHaveLength(1);
  });

  it("treats a whitespace-only search as no search", () => {
    expect(filterSubmissions(ROWS, { ...EMPTY_SUBMISSION_FILTERS, search: "   " })).toHaveLength(4);
  });

  it("returns an empty list rather than throwing on no rows", () => {
    expect(filterSubmissions([], { ...EMPTY_SUBMISSION_FILTERS, search: "x" })).toEqual([]);
  });
});

describe("hasActiveSubmissionFilter", () => {
  it("is false when nothing is set, or for whitespace only", () => {
    expect(hasActiveSubmissionFilter(EMPTY_SUBMISSION_FILTERS)).toBe(false);
    expect(hasActiveSubmissionFilter({ ...EMPTY_SUBMISSION_FILTERS, search: "  " })).toBe(false);
  });

  it("is true once a search or status is set", () => {
    expect(hasActiveSubmissionFilter({ ...EMPTY_SUBMISSION_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveSubmissionFilter({ ...EMPTY_SUBMISSION_FILTERS, status: "pending" })).toBe(true);
  });
});

describe("submissionStatusOptions", () => {
  it("orders by review urgency, not alphabetically, and counts each", () => {
    expect(submissionStatusOptions(ROWS)).toEqual([
      { value: ALL, label: "All statuses (4)" },
      { value: "pending", label: "Pending (2)" },
      { value: "approved", label: "Approved (1)" },
      { value: "completed", label: "Completed (1)" },
    ]);
  });

  it("omits a status no row has, so the menu can't filter to nothing", () => {
    expect(submissionStatusOptions([sub({ status: "pending" })]).map((o) => o.value)).toEqual([ALL, "pending"]);
  });

  it("still surfaces an unrecognised status instead of hiding those rows", () => {
    const odd = [sub({ status: "pending" }), sub({ status: "on_hold" })];
    expect(submissionStatusOptions(odd).map((o) => o.value)).toEqual([ALL, "pending", "on_hold"]);
  });
});

describe("effectiveSubmissionFilters", () => {
  const opts = submissionStatusOptions(ROWS);

  it("keeps a pick that still has an option", () => {
    const f = { search: "x", status: "pending" };
    expect(effectiveSubmissionFilters(f, opts)).toEqual(f);
  });

  it("falls back to ALL when the picked status no longer has rows", () => {
    const noPending = submissionStatusOptions(ROWS.filter((r) => r.status !== "pending"));
    expect(effectiveSubmissionFilters({ ...EMPTY_SUBMISSION_FILTERS, status: "pending" }, noPending).status).toBe(ALL);
  });

  it("never touches the search term", () => {
    const f = { search: "keep me", status: ALL };
    expect(effectiveSubmissionFilters(f, opts).search).toBe("keep me");
  });
});
