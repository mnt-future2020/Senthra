"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { dangerBtn, ghostBtn, hintCls, inputCls, labelCls } from "@/components/ui/styles";
import type { WarehouseAssignment } from "@/types/customer";

// Close a delivery whose outstanding balance is never arriving. Terminal: the row leaves the
// warehouse's Incoming queue and can't be received into afterwards, which is why the reason is
// mandatory and the confirm button is styled as a destructive action rather than a routine save.
const MIN_REASON = 3;

export function CloseShortModal({
  assignment,
  itemName,
  onClose,
  onClosed,
}: {
  assignment: WarehouseAssignment;
  itemName: string;
  onClose: () => void;
  onClosed: (updated: WarehouseAssignment, outstanding: number) => void;
}) {
  const outstanding = assignment.quantity - assignment.receivedQuantity;
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await customerService.closeStockAssignmentShort(assignment.id, trimmed);
      // The shortfall handed to the caller comes from the row the SERVER wrote, never the one this
      // modal opened with. A receive landing while the modal was open leaves the assignment open —
      // so the close still succeeds — but it moves receivedQuantity, which makes the figure above
      // stale by exactly that amount and would overstate what never arrived. The audit line the
      // backend writes is computed from the post-write row for this reason; the confirmation the
      // user reads has to quote the same number.
      onClosed(updated, updated.quantity - updated.receivedQuantity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close this delivery.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Close delivery short"
      subtitle={`${itemName} at ${assignment.warehouseName} — ${assignment.receivedQuantity} of ${assignment.quantity} received`}
      onClose={busy ? () => {} : onClose}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="close-short-form" disabled={busy || !valid} className={dangerBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Close short
          </button>
        </>
      }
    >
      <form id="close-short-form" onSubmit={submit} className="space-y-4">
        {/* Icon-in-a-tinted-square + heading + one muted line — the same shape ConfirmDialog uses
            for every other irreversible action, so this reads as "destructive confirm" rather than
            the yellow ADVISORY banner style (DamagedStockView's WarnBanner) it borrowed before.
            Red, not amber: this ends the delivery permanently, it isn't a heads-up. */}
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--neg)]/10 text-[var(--neg)]">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            {/* "recorded as", NOT "written off". Nothing leaves any ledger here — the shortfall was
                never received, so it was never stock. "Write off" is this app's word for the
                goods-management action that really does drain an engineer's holding (`job_lost`);
                reusing it here would both misdescribe this and blunt the word where it matters.
                "not received" is the app's ONE phrase for this quantity — the same words the
                customer's portal shows them — so the number the closer types here is the number and
                the wording they'll both quote back later. */}
            <p className="text-sm font-extrabold text-[var(--ink)]">
              {outstanding} of {assignment.quantity} recorded as not received
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {/* Pluralised properly — "The 1 … stay in stock" read as a typo. Nothing-received is
                  its own case: there is no stock to reassure anyone about. */}
              {assignment.receivedQuantity > 0 && (
                <>
                  The {assignment.receivedQuantity} already received{" "}
                  {assignment.receivedQuantity === 1 ? "stays" : "stay"} in stock.{" "}
                </>
              )}
              This can&apos;t be undone.
            </p>
          </div>
        </div>
        <div>
          <label className={labelCls}>
            Reason<RequiredMark />
          </label>
          <textarea
            className={inputCls}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer only shipped 15 — remainder cancelled"
            maxLength={500}
            autoFocus
          />
          {/* Stated up front, not only on a failed submit — and it names the AUDIENCE, because that
              changes how the sentence gets written. The customer really does read this: their
              submission shows "Completed" once every warehouse is finished, and this reason is the
              only thing on their portal that says part of it was not received. */}
          <p className={hintCls}>The customer sees this on their submission, alongside the audit trail.</p>
        </div>
        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
