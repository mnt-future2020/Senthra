import { describe, expect, it } from "vitest";

import { ApiError, isPermissionError, isStaleStateError } from "./api";

// These classifiers decide whether a failed action should make the screen refetch. Getting them
// wrong is silent: a stale view keeps a dead button that fails identically on every click (the
// PO "Send to supplier" case — another user had already sent the order from their own session).
describe("isStaleStateError", () => {
  it("treats a 409 conflict as stale state", () => {
    // What a PO transition guard throws: "Can't move a sent purchase order to sent."
    expect(isStaleStateError(new ApiError("Can't move a sent purchase order to sent.", 409))).toBe(true);
  });

  it("treats a 404 as stale state (someone else deleted the record)", () => {
    // The commonest concurrent-delete race: the draft is gone, so the screen must resync rather
    // than keep offering actions against a record that no longer exists.
    expect(isStaleStateError(new ApiError("Purchase order not found.", 404))).toBe(true);
  });

  it("does NOT treat a 403 as stale state", () => {
    // Nearly every 403 here is a STATIC warehouse-scope / role-permission failure, so refetching
    // hits the identical guard and fails identically — a wasted round-trip that fixes nothing.
    // Critically, the realtime rooms are permission-gated but NOT warehouse-partitioned, so a
    // scoped-out user holding a detail page open would fire one doomed request per socket event.
    // The single genuinely state-dependent 403 (assigned-PM send) is handled at its own call site.
    expect(isStaleStateError(new ApiError("You don't have access to this warehouse.", 403))).toBe(false);
  });

  it("does NOT treat a 400 validation error as stale state", () => {
    // The screen is current; the input was bad. Refetching would just hide the message.
    expect(isStaleStateError(new ApiError("Add at least one item before submitting.", 400))).toBe(false);
  });

  it("does NOT treat a 500 as stale state", () => {
    expect(isStaleStateError(new ApiError("Something went wrong.", 500))).toBe(false);
  });

  it("does NOT treat a network failure (no response) as stale state", () => {
    // status === null means the request never reached the server — refetching would fail too.
    expect(isStaleStateError(new ApiError("Network error.", null))).toBe(false);
  });

  it("does NOT treat a plain Error as stale state", () => {
    expect(isStaleStateError(new Error("boom"))).toBe(false);
    expect(isStaleStateError(null)).toBe(false);
    expect(isStaleStateError(undefined)).toBe(false);
  });
});

describe("isPermissionError", () => {
  it("is true only for 403", () => {
    expect(isPermissionError(new ApiError("Forbidden", 403))).toBe(true);
    expect(isPermissionError(new ApiError("Conflict", 409))).toBe(false);
    expect(isPermissionError(new Error("boom"))).toBe(false);
  });
});
