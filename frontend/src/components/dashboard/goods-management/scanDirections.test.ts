import { describe, expect, it } from "vitest";

import { defaultScanDirection, scanDirections } from "./scanDirections";

// Cancelling a job doesn't move a single unit — the engineer walks away still holding the kit — so the
// warehouse has to be able to scan it back in. What it must NOT be able to do is issue more stock to a
// job nobody is working. The server enforces both (postIssue rejects cancelled, postReturn accepts it);
// this is the same rule on the panel, so the impossible half is never offered rather than explained
// after the fact by a 409.
describe("scanDirections — what a job's scan panel may do", () => {
  it("gives a live job both halves", () => {
    for (const s of ["accepted", "in_progress", "completed"]) {
      expect(scanDirections(s)).toEqual(["issue", "return"]);
    }
  });

  it("gives a cancelled job returns only", () => {
    expect(scanDirections("cancelled")).toEqual(["return"]);
  });

  // Landing on a tab the job can't use would show an empty panel with no way to post.
  it("opens a cancelled job on the tab it can actually use", () => {
    expect(defaultScanDirection("cancelled")).toBe("return");
    expect(defaultScanDirection("in_progress")).toBe("issue");
  });
});
