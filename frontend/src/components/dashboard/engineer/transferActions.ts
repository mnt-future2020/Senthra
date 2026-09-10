// What the engineer's "My requests" row offers on a PENDING transfer they are receiving. Extracted
// from EngineerTransfers so the rule is unit-testable without rendering React.
//
// Only the engineer who RAISED a request may cancel it — the server enforces exactly that (the
// requester, or an office user with transfer oversight, who works from the office board instead).
// A transfer the office arranged for this engineer — approving a kit request that pulls from another
// engineer's van, or the board's "New transfer" — records the OFFICE user as requester, yet still
// lands in the engineer's "My requests". Offering Cancel there gave a button that could only ever fail
// with a permission error. Cancelling it would also quietly strip a kit request of its stock source,
// so the fix is to not offer it, not to allow it.

import type { EngineerTransfer } from "@/services/engineerTransfer.service";

export type OutgoingPendingAction = "cancel" | "arranged-by-office";

export function outgoingPendingAction(
  transfer: Pick<EngineerTransfer, "requestedById">,
  viewerId: string | null | undefined,
): OutgoingPendingAction {
  // An unknown viewer or a row with no recorded requester never gets Cancel: the server would refuse.
  return viewerId && transfer.requestedById === viewerId ? "cancel" : "arranged-by-office";
}
