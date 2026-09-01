import { describe, expect, it } from "vitest";

import { activeItems, attentionRollup, triggerState } from "./attentionRollup";
import type { AttentionItem } from "@/services/attention.service";

const item = (over: Partial<AttentionItem> & Pick<AttentionItem, "key" | "count">): AttentionItem => ({
  label: over.key,
  tone: "info",
  nav: "/dashboard/jobs",
  ...over,
});

const url = (qs: string) => new URLSearchParams(qs);

describe("attentionRollup", () => {
  it("adds up the independent queues", () => {
    const got = attentionRollup([item({ key: "a", count: 7 }), item({ key: "b", count: 2 })]);
    expect(got?.count).toBe(9);
  });

  // The rule the removed header total existed to honour: a subset chip's rows are ALREADY inside its
  // parent's number, so adding both claims more work than exists.
  it("skips a subset child so the total never overstates the backlog", () => {
    const got = attentionRollup([
      item({ key: "reorder", count: 6 }),
      item({ key: "critical", count: 5, subsetOf: "reorder" }),
    ]);
    expect(got?.count).toBe(6);
  });

  it("takes the most severe tone present", () => {
    expect(attentionRollup([item({ key: "a", count: 1, tone: "info" }), item({ key: "b", count: 1, tone: "attention" })])?.tone).toBe("attention");
    expect(attentionRollup([item({ key: "a", count: 1, tone: "attention" }), item({ key: "b", count: 1, tone: "critical" })])?.tone).toBe("critical");
  });

  // Count and tone answer different questions. A subset's rows don't ADD work, but they are still
  // urgent work — "5 of the 6 reorders are critical" must not render as a calm amber trigger.
  it("still takes a subset child's tone even though its count is skipped", () => {
    const got = attentionRollup([
      item({ key: "reorder", count: 6, tone: "attention" }),
      item({ key: "critical", count: 5, tone: "critical", subsetOf: "reorder" }),
    ]);
    expect(got).toEqual({ count: 6, tone: "critical" });
  });

  it("is null when there is nothing pending, so a clear desk renders no trigger", () => {
    expect(attentionRollup([])).toBeNull();
  });
});

describe("activeItems", () => {
  it("returns the queue whose filters are all applied", () => {
    const items = [
      item({ key: "overdue", count: 7, href: "/dashboard/jobs?status=overdue" }),
      item({ key: "rejected", count: 1, href: "/dashboard/jobs?status=rejected" }),
    ];
    expect(activeItems(items, "/dashboard/jobs", url("status=overdue")).map((i) => i.key)).toEqual(["overdue"]);
  });

  it("returns nothing on the unfiltered list", () => {
    const items = [item({ key: "overdue", count: 7, href: "/dashboard/jobs?status=overdue" })];
    expect(activeItems(items, "/dashboard/jobs", url(""))).toEqual([]);
  });

  // A count with no screen can never be "what you are looking at", so it must never render as a
  // clearable applied filter.
  it("never returns a count that has no destination", () => {
    const items = [item({ key: "aggregate", count: 4 })];
    expect(activeItems(items, "/dashboard/jobs", url("status=overdue"))).toEqual([]);
  });
});

describe("triggerState", () => {
  it("names the whole control and shows the total when nothing is applied", () => {
    expect(triggerState(52, [])).toEqual({ label: "Needs attention", count: 52, filtered: false });
  });

  // The pairing rule: the label and the number must describe the SAME thing. A queue's name beside
  // the 52-item backlog total would read as "52 ready to close", which is a lie the user can check
  // against the list footer.
  it("names the applied queue AND switches to that queue's own count", () => {
    const item = { key: "close", label: "Received — ready to close", count: 17, tone: "info" as const, nav: "/x", href: "/x?status=awaiting_close" };
    expect(triggerState(52, [item])).toEqual({ label: "Received — ready to close", count: 17, filtered: true });
  });

  // Naming one of two applied queues would claim the list is narrowed by that one alone.
  it("names neither queue when two are applied, and falls back to the total", () => {
    const a = { key: "a", label: "A", count: 3, tone: "info" as const, nav: "/x", href: "/x?a=1" };
    const b = { key: "b", label: "B", count: 4, tone: "info" as const, nav: "/x", href: "/x?b=1" };
    expect(triggerState(52, [a, b])).toEqual({ label: "2 filters", count: 52, filtered: true });
  });
});
