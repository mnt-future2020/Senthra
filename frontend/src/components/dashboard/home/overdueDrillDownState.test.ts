import { describe, expect, it } from "vitest";

import { acceptsResponse, closedDrillDownState, drillDownView } from "./overdueDrillDownState";
import type { OverdueGroup, OverdueGroupsResult } from "@/types/goodsManagement";

// ── The drill-down's lifecycle ─────────────────────────────────────────────────────────────────
//
// Every case here reproduces something the panel actually did in the browser, and every one of them
// fails against the version that only cleared the engineer filter on close.

const group = (id: string, count: number): OverdueGroup => ({
  id,
  label: id,
  code: id.toUpperCase(),
  count,
  oldestDaysOut: 26,
});

const result = (warehouses: OverdueGroup[], total: number): OverdueGroupsResult => ({
  days: 5,
  total,
  byWarehouse: warehouses,
  byEngineer: [group("eng-1", total)],
});

describe("closing the panel", () => {
  // THE bug. Narrow to an engineer holding 2, close, reopen: the picker said "All engineers" over a
  // subtitle reading "2 jobs", under a card reading 7. Clearing the filter without clearing what the
  // filter produced is what made those two disagree.
  it("clears the result, not just the filter that produced it", () => {
    expect(closedDrillDownState()).toEqual({
      engineerId: null,
      engineers: [],
      data: null,
      error: null,
    });
  });

  it("clears a failed load, so a fixed request is not greeted by the last one's banner", () => {
    // Observed live: an expired session left "Unauthorized" on screen, and it survived close/reopen
    // because `error` was only ever cleared by a SUCCESSFUL fetch.
    expect(closedDrillDownState().error).toBeNull();
  });

  it("drops the engineer roster too — it is only ever built from an unfiltered load", () => {
    expect(closedDrillDownState().engineers).toEqual([]);
  });

  // Reopening must go through the loading state rather than paint the previous session's numbers.
  it("leaves a state that renders as loading, never as a stale or empty list", () => {
    expect(drillDownView(closedDrillDownState())).toBe("loading");
  });
});

describe("what the body renders", () => {
  it("shows the list once there is data", () => {
    expect(drillDownView({ data: result([group("wh-a", 5), group("wh-b", 2)], 7), error: null })).toBe("list");
  });

  it("shows the empty state only when the server actually returned nothing", () => {
    expect(drillDownView({ data: result([], 0), error: null })).toBe("empty");
  });

  // The second bug: `loading && !data` left a window in which BOTH were false — a close clears the
  // data while the in-flight request is still settling — and the panel drew the list's column
  // headers over no rows. Asking "is there anything to show?" has no such window.
  it("never treats absent data as an empty result, whatever a loading flag says", () => {
    expect(drillDownView({ data: null, error: null })).toBe("loading");
  });

  // A failed load knows nothing, so "nothing is overdue" would be a claim it cannot make.
  it("prefers the error over an empty state when a load failed", () => {
    expect(drillDownView({ data: null, error: "Unauthorized" })).toBe("error");
    expect(drillDownView({ data: result([], 0), error: "Unauthorized" })).toBe("error");
  });
});

describe("late responses", () => {
  it("accepts the reply belonging to the current request", () => {
    expect(acceptsResponse(3, 3)).toBe(true);
  });

  // A filter changed twice quickly: the first reply must not overwrite the second's.
  it("drops a superseded reply", () => {
    expect(acceptsResponse(2, 3)).toBe(false);
  });

  // Close burns a sequence number, so a request still in flight when the panel shut cannot land and
  // repopulate exactly the state the close just cleared.
  it("drops a reply that arrives after the panel was closed", () => {
    const openSeq = 4;
    const afterClose = openSeq + 1; // close bumps the counter
    expect(acceptsResponse(openSeq, afterClose)).toBe(false);
  });

  // Repeated open/close: each open takes a fresh number, so nothing from an earlier one is accepted.
  it("keeps every previous session's replies out after repeated open/close", () => {
    let seq = 0;
    const opens = [++seq, (seq += 2), (seq += 2)]; // open, close+open, close+open
    const current = seq;
    expect(acceptsResponse(opens[0]!, current)).toBe(false);
    expect(acceptsResponse(opens[1]!, current)).toBe(false);
    expect(acceptsResponse(opens[2]!, current)).toBe(true);
  });
});
