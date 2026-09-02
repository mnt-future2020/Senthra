import type { MarkSentPayload, PoIssueChannel } from "@/services/purchase-order.service";
import type { PoStatus } from "@/types/purchase-order";

// ── The two doors onto `sent`, and the ONE rule that governs both ─────────────────────────────
//
// "Send to supplier" and "Mark as sent" are the same transition. The second exists because a PO is
// routinely handed to the supplier outside Senthra — WhatsApp, the buyer's own mailbox, a printed
// copy, a phone call — and pressing Send in that case fires a duplicate email at a supplier who
// already has the order. The only difference between the two is that email; everything deciding
// WHETHER an order may be issued is identical.
//
// So the rule lives here once rather than beside each button. An order that Mark as sent could reach
// and Send could not — or the reverse — would be a state machine with two answers, and the drift
// would show up as a button that 409s on every click.
//
// This MIRRORS the server (`ALLOWED_TRANSITIONS` + the delivery-date gate in issuePurchaseOrder),
// which stays authoritative: hiding a button is presentation, never security. The mirror exists so
// the round-trip is not the first place a user learns the order is not ready.

/** Statuses an order can be issued FROM. Mirrors the `→ "sent"` edges of ALLOWED_TRANSITIONS. */
export const ISSUABLE_STATUSES: PoStatus[] = ["approved", "pm_review"];

export interface IssueEligibility {
  /** Whether the issue actions belong on screen at all. */
  visible: boolean;
  /** On screen but not usable yet — the order is missing something the issued document needs. */
  disabled: boolean;
  /** Why it is disabled, for the button's title. Null when it is usable. */
  reason: string | null;
}

/**
 * May this order be issued, and if not, why not.
 *
 * The delivery date is a DISABLED state rather than a hidden one, deliberately: the order is at the
 * right stage and the button belongs there, it just cannot go yet — and past `approved` there is no
 * way back to draft, so the user needs to be told what is missing rather than left hunting for a
 * button that silently vanished.
 */
export function issueEligibility(
  po: { status: PoStatus; expectedDeliveryDate: string | null },
  canSend: boolean,
): IssueEligibility {
  if (!canSend || !ISSUABLE_STATUSES.includes(po.status)) {
    return { visible: false, disabled: true, reason: null };
  }
  if (!po.expectedDeliveryDate) {
    // The date is printed on the issued document and the receiving warehouse schedules against it.
    return { visible: true, disabled: true, reason: "Set an expected delivery date before issuing this order." };
  }
  return { visible: true, disabled: false, reason: null };
}

/**
 * The Mark-as-sent body.
 *
 * Both fields are optional and are AUDIT METADATA ONLY — nothing on the order stores them, and
 * nothing downstream branches on them. Blank means ABSENT rather than empty: a cleared picker posts
 * "" and a note of spaces is not a note, and sending either would file a placeholder in the ledger
 * where "the user did not say" is the honest record. The server normalises the same way.
 */
export function markSentPayload(channel: PoIssueChannel | "", note: string): MarkSentPayload {
  return {
    channel: channel || undefined,
    note: note.trim() || undefined,
  };
}
