// Staff notifications for the Purchase Request (PRF) workflow. Called FIRE-AND-FORGET from the
// PRF service (the caller never awaits + swallows errors), so a failure here can NEVER roll back
// the PRF state. Mirrors purchase-order.email.ts.

import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { formatMoney } from "#modules/document/document.formatter.js";
import * as userRepo from "#modules/user/user.repository.js";
import type { PurchaseRequestWithRelations } from "./purchase-request.repository.js";

// Notify the staff who can finance-review a PRF that one has been submitted for their decision.
// Recipients are active staff whose role grants `purchase_requests.approve` (or full access "*");
// the submitter is excluded (no self-nudge). Each reviewer is emailed individually so one bad
// address never blocks the rest.
export async function notifyReviewersPrfSubmitted(
  prf: PurchaseRequestWithRelations,
  submittedByEmail: string | null,
): Promise<void> {
  const reviewers = (await userRepo.findActiveWithRole()).filter((u) => {
    const perms = u.role?.permissions ?? [];
    const canApprove = perms.includes("purchase_requests.approve") || perms.includes("*");
    return canApprove && u.email !== submittedByEmail;
  });
  if (reviewers.length === 0) {
    console.info(`PRF ${prf.code}: no finance reviewers to notify.`);
    return;
  }
  const vars = {
    prfCode: prf.code,
    supplierName: prf.supplier?.name ?? prf.supplierName ?? "",
    estimatedCost: formatMoney(prf.grandTotalPence, prf.currency || "GBP"),
    requestedBy: submittedByEmail ?? prf.createdBy ?? "",
  };
  await Promise.all(
    reviewers.map((r) =>
      sendTemplatedEmail("prf.submitted", r.email, { ...vars, reviewerName: r.firstName }).catch((e) =>
        console.error(
          `PRF ${prf.code} review email to ${r.email} failed:`,
          e instanceof Error ? e.message : e,
        ),
      ),
    ),
  );
}

// Notify the requester of the finance decision. `decision` selects the template; the reason is
// only meaningful on a rejection (empty string otherwise — the template engine has no conditionals).
export async function notifyRequesterPrfDecision(
  prf: PurchaseRequestWithRelations,
  decision: "approved" | "rejected",
  reason?: string | null,
): Promise<void> {
  const to = prf.createdBy?.trim();
  if (!to) {
    console.info(`PRF ${prf.code}: no requester email — decision notification skipped.`);
    return;
  }
  await sendTemplatedEmail(`prf.${decision}`, to, {
    prfCode: prf.code,
    supplierName: prf.supplier?.name ?? prf.supplierName ?? "",
    estimatedCost: formatMoney(prf.grandTotalPence, prf.currency || "GBP"),
    reason: reason ?? "",
  });
}
