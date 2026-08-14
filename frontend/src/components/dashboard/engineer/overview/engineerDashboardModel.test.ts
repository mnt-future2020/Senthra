import { describe, it, expect } from "vitest";

import type { EngineerOverview } from "@/types/engineer";
import { buildStatCards, buildAttentionRows } from "./engineerDashboardModel";

const base: EngineerOverview = {
  stock: { lines: 3, totalQuantity: 29 },
  customerStock: { lines: 2, totalQuantity: 5 },
  misc: { lines: 1, totalQuantity: 3 },
  jobs: { toAccept: 2, accepted: 1, inProgress: 4, overdue: 1, dueThisWeek: 0, next: [] },
  transfers: { incomingPending: 1, toSign: 2 },
  vanStock: { toCollect: 3 },
  kitRequests: { pending: 1 },
  recentActivity: [],
};
const allow = () => true;
const deny = () => false;

describe("buildStatCards", () => {
  it("builds the six permission-gated cards, each deep-linked to its filtered list", () => {
    const cards = buildStatCards(base, allow);
    expect(cards.map((c) => c.key)).toEqual(["toAccept", "inProgress", "vanStock", "transfers", "stock", "customer"]);
    const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(byKey.toAccept.href).toBe("/dashboard/engineer/jobs?status=assigned");
    expect(byKey.inProgress.href).toBe("/dashboard/engineer/jobs?status=in_progress");
    expect(byKey.vanStock.href).toBe("/dashboard/engineer/van-stock?status=collectible");
    expect(byKey.transfers.href).toBe("/dashboard/engineer/transfers?view=incoming&status=pending");
    expect(byKey.customer.href).toBe("/dashboard/engineer/inventory?section=customer");
    expect(byKey.vanStock.value).toBe(3); // vanStock.toCollect
    expect(byKey.customer.value).toBe(5); // customerStock.totalQuantity
    expect(byKey.stock.value).toBe(29);
  });

  it("folds the misc count into the stock card hint when present", () => {
    const stock = buildStatCards(base, allow).find((c) => c.key === "stock")!;
    expect(stock.hint).toBe("3 items held · 1 misc");
  });

  it("omits the misc suffix when there are no misc items", () => {
    const stock = buildStatCards({ ...base, misc: { lines: 0, totalQuantity: 0 } }, allow).find((c) => c.key === "stock")!;
    expect(stock.hint).toBe("3 items held");
  });

  it("hides every card without permission (all cards, incl. stock, are permission-gated)", () => {
    expect(buildStatCards(base, deny)).toEqual([]);
  });

  it("flags overdue in the in-progress hint", () => {
    const inProg = buildStatCards(base, allow).find((c) => c.key === "inProgress")!;
    expect(inProg.hint).toBe("1 overdue across active jobs");
    expect(inProg.hintTone).toBe("red");
  });

  // The hint counts ACTIVE jobs (assigned + accepted + in_progress); the value counts `in_progress`
  // alone. So it is not a breakdown of the number above it, and can legitimately exceed it — "1 /
  // In progress / 4 overdue" is a real state, usually because the late job is still Accepted. Left
  // unqualified it reads as "4 of that 1 are late", which is impossible, so every branch that spans
  // the wider set has to name it.
  it("says which set the hint counts, so it can never read as a share of the value", () => {
    const spanning = buildStatCards(
      { ...base, jobs: { ...base.jobs, inProgress: 1, overdue: 4 } },
      allow,
    ).find((c) => c.key === "inProgress")!;
    expect(spanning.value).toBe(1);
    expect(spanning.hint).toContain("across active jobs");
  });

  it("qualifies the due-this-week branch the same way", () => {
    const due = buildStatCards(
      { ...base, jobs: { ...base.jobs, overdue: 0, accepted: 0, dueThisWeek: 3 } },
      allow,
    ).find((c) => c.key === "inProgress")!;
    expect(due.hint).toBe("3 due this week across active jobs");
  });

  // The card opens its OWN headline. The wider overdue set is reachable from the attention row below,
  // which filters to exactly it — so neither number sends anyone to a list that doesn't hold it.
  it("keeps the card pointed at in-progress, leaving the overdue set to the attention row", () => {
    const inProg = buildStatCards(base, allow).find((c) => c.key === "inProgress")!;
    expect(inProg.href).toBe("/dashboard/engineer/jobs?status=in_progress");
    const row = buildAttentionRows(base, allow).find((r) => r.key === "overdue")!;
    expect(row.href).toBe("/dashboard/engineer/jobs?status=overdue");
  });
});

describe("buildAttentionRows", () => {
  it("includes only rows whose count > 0 and whose permission holds, in priority order", () => {
    expect(buildAttentionRows(base, allow).map((r) => r.key)).toEqual(["accept", "overdue", "collect", "transfers", "sign", "kit"]);
  });

  it("deep-links actionable rows to their filtered destination", () => {
    const byKey = Object.fromEntries(buildAttentionRows(base, allow).map((r) => [r.key, r]));
    expect(byKey.overdue.href).toBe("/dashboard/engineer/jobs?status=overdue");
    expect(byKey.transfers.href).toBe("/dashboard/engineer/transfers?view=incoming&status=pending");
  });

  it("leaves the kit row informational (no href) — no aggregate view, engineer can't action it", () => {
    const byKey = Object.fromEntries(buildAttentionRows(base, allow).map((r) => [r.key, r]));
    expect(byKey.kit.href).toBeUndefined();
  });

  it("gates the kit row on engineer.jobs.request_kit, not engineer.jobs.view", () => {
    const can = (p: string) => p !== "engineer.jobs.request_kit";
    expect(buildAttentionRows(base, can).map((r) => r.key)).not.toContain("kit");
  });

  it("returns nothing when everything is clear", () => {
    const clear: EngineerOverview = {
      ...base,
      jobs: { ...base.jobs, toAccept: 0, overdue: 0 },
      transfers: { incomingPending: 0, toSign: 0 },
      vanStock: { toCollect: 0 },
      kitRequests: { pending: 0 },
    };
    expect(buildAttentionRows(clear, allow)).toEqual([]);
  });

  it("drops both transfer rows without engineer.transfer", () => {
    const can = (p: string) => p !== "engineer.transfer";
    const keys = buildAttentionRows(base, can).map((r) => r.key);
    expect(keys).not.toContain("transfers");
    expect(keys).not.toContain("sign");
  });
});
