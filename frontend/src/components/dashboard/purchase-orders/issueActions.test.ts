import { describe, expect, it } from "vitest";

import { ISSUABLE_STATUSES, issueEligibility, markSentPayload } from "./issueActions";
import { PO_STATUS_LABELS } from "./poStatus";
import type { PoStatus } from "@/types/purchase-order";

// The rule behind BOTH issue buttons. "Send to supplier" and "Mark as sent" are one transition with
// one difference (the email), so they must appear, disable and hide together — a second button with
// its own copy of the rule is a button that eventually 409s on every click.

const po = (over: Partial<{ status: PoStatus; expectedDeliveryDate: string | null }> = {}) => ({
  status: "approved" as PoStatus,
  expectedDeliveryDate: "2026-09-10",
  ...over,
});

describe("issueEligibility — when the issue actions are offered", () => {
  it.each(ISSUABLE_STATUSES)("offers them on a %s order", (status) => {
    expect(issueEligibility(po({ status }), true)).toEqual({ visible: true, disabled: false, reason: null });
  });

  // Everything else in the lifecycle. Written against the full status list rather than a hand-picked
  // few, so a status added later cannot quietly default to "issuable".
  const NOT_ISSUABLE = (Object.keys(PO_STATUS_LABELS) as PoStatus[]).filter((s) => !ISSUABLE_STATUSES.includes(s));
  it.each(NOT_ISSUABLE)("hides them on a %s order", (status) => {
    expect(issueEligibility(po({ status }), true).visible).toBe(false);
  });

  it("hides them from a user without the send permission", () => {
    // Presentation only — the server holds the same key on both routes. This just stops offering a
    // button whose only possible outcome is a 403.
    expect(issueEligibility(po(), false).visible).toBe(false);
  });

  // DISABLED, not hidden. The order is at the right stage and the buttons belong there; it simply
  // cannot go yet — and there is no way back to draft from `approved`, so the user has to be told
  // what is missing rather than left hunting for a button that silently vanished.
  it("shows them disabled, with a reason, when the delivery date is missing", () => {
    expect(issueEligibility(po({ expectedDeliveryDate: null }), true)).toEqual({
      visible: true,
      disabled: true,
      reason: "Set an expected delivery date before issuing this order.",
    });
  });

  it("gives the same answer to both buttons — there is only one rule", () => {
    // The regression this module exists to prevent: the two conditions drifting apart. Both buttons
    // read this single result, so the assertion is that it IS single.
    const dated = issueEligibility(po(), true);
    const dateless = issueEligibility(po({ expectedDeliveryDate: null }), true);
    expect(dated.visible).toBe(dateless.visible);
    expect(dated.disabled).toBe(false);
    expect(dateless.disabled).toBe(true);
  });
});

describe("markSentPayload — the optional audit metadata", () => {
  it("sends nothing when the user filled nothing in", () => {
    // An empty body is a complete request: the business fact is that the order was issued, and the
    // channel is colour on the audit entry, not part of the transition.
    expect(markSentPayload("", "")).toEqual({ channel: undefined, note: undefined });
  });

  it("carries a chosen channel", () => {
    expect(markSentPayload("whatsapp", "")).toMatchObject({ channel: "whatsapp" });
  });

  it("treats 'email' as a channel like any other — it is not a request to send one", () => {
    // The user is saying they emailed it from their own mailbox. The server never reads it as an
    // instruction, and the manual path has no email call to reach.
    expect(markSentPayload("email", "")).toEqual({ channel: "email", note: undefined });
  });

  it("trims the note", () => {
    expect(markSentPayload("", "  Sent to Dave  ")).toMatchObject({ note: "Sent to Dave" });
  });

  it("treats a whitespace-only note as absent rather than filing a blank", () => {
    expect(markSentPayload("", "   ").note).toBeUndefined();
  });

  it("carries both together", () => {
    expect(markSentPayload("phone", "Confirmed with Dave")).toEqual({ channel: "phone", note: "Confirmed with Dave" });
  });
});
