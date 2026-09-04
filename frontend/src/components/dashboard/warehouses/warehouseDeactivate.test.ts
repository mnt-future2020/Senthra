import { describe, expect, it } from "vitest";

import {
  awaitingActionSentence,
  warehouseDeactivateDetail,
  WAREHOUSE_DEACTIVATE_CONSEQUENCE,
} from "./warehouseDeactivate";

// ── The one thing this dialog must never do is state a number that is not true ─────────────────
//
// A confirmation exists to make a decision better informed. One that says "0 items are awaiting
// action here" over a warehouse holding eighteen — because the viewer lacks attention permission, or
// the fetch failed silently, or the first response has not landed — is worse than no dialog at all:
// it converts a missing count into a reassurance, and the user acts on it.
//
// `useEntityAttention` returns an empty map in ALL of those states as well as in the genuinely-empty
// one, by design, and they are indistinguishable from here. So the rule these cases pin is: state a
// count only when there is a positive one, and otherwise say only what is always true.

const row = (count: number) => ({ count, tone: "attention" as const, keys: {} });

describe("awaitingActionSentence", () => {
  it("states a real count", () => {
    expect(awaitingActionSentence(row(18))).toBe("18 items are awaiting action here.");
  });

  it("agrees with itself in the singular", () => {
    expect(awaitingActionSentence(row(1))).toBe("1 item is awaiting action here.");
  });

  it("says nothing when the entity has no attention row", () => {
    // Missing means "nothing outstanding" OR "not loaded" OR "not permitted" OR "fetch failed".
    expect(awaitingActionSentence(undefined)).toBe("");
  });

  it("says nothing for a zero row rather than claiming zero", () => {
    expect(awaitingActionSentence(row(0))).toBe("");
  });

  it("ignores a negative or non-finite count instead of rendering it", () => {
    expect(awaitingActionSentence(row(-3))).toBe("");
    expect(awaitingActionSentence(row(Number.NaN))).toBe("");
  });
});

describe("warehouseDeactivateDetail", () => {
  it("leads with the count, then the consequence", () => {
    expect(warehouseDeactivateDetail(row(18))).toBe(
      `18 items are awaiting action here. ${WAREHOUSE_DEACTIVATE_CONSEQUENCE}`,
    );
  });

  it("falls back to consequence-only, with no orphaned spacing or empty sentence", () => {
    const text = warehouseDeactivateDetail(undefined);
    expect(text).toBe(WAREHOUSE_DEACTIVATE_CONSEQUENCE);
    expect(text.startsWith(" ")).toBe(false);
    expect(text).not.toContain("  ");
  });

  it("always names what actually breaks — this is the half that changes the decision", () => {
    for (const attention of [row(4), undefined]) {
      const text = warehouseDeactivateDetail(attention);
      expect(text).toContain("New stock movements, purchase requests and purchase orders");
      expect(text).toContain("until it is reactivated");
      // The reassurance is load-bearing and was verified against the API: goods receipts against an
      // already-issued PO are NOT blocked. If a later edit drops this clause the dialog overstates
      // the consequence, and someone escalates a delivery that was never at risk.
      expect(text).toContain("Deliveries already on their way can still be received");
      expect(text).not.toContain("goods receipts");
    }
  });
});
