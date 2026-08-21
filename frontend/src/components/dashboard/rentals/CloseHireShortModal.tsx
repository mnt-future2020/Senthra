"use client";

import * as React from "react";

import * as rentalService from "@/services/rental.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Modal } from "@/components/ui/Modal";

/**
 * "The outstanding units are never arriving" — the exit for a hire that was ordered and not fully
 * delivered.
 *
 * Its own component rather than inline markup on the board, because the sentence explaining what
 * happens NEXT differs by case, cannot be inferred by the user, and is the whole reason this is a
 * form and not a confirm — the load-bearing part of the screen, kept where it can be read on its own.
 *
 * Mounted by the on-hire board and by the warehouse's own hire queue — the two places the decision
 * arrives on its own ("we took four last week; today we learned there is no fifth"). The RECEIVING
 * form does not use it: there the write-off is part of the delivery being entered, so it is a field
 * on the line rather than a dialog over it.
 */
export interface CloseHireShortTarget {
  /** The order and line to write against. */
  purchaseOrderId: string;
  lineId: string;
  /** What the person is looking at, so the modal can name it back to them. */
  poCode: string;
  itemName: string;
  /** The server recomputes all three; these only phrase the question. */
  quantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
}

export function CloseHireShortModal({
  target,
  onClose,
  onDone,
}: {
  target: CloseHireShortTarget | null;
  onClose: () => void;
  /**
   * Called after a successful close so the host can catch up — the line's state has moved.
   *
   * Handed the target it just closed, rather than leaving the host to read its own state: this fires
   * immediately after `onClose`, so a host reading its `target` state would be relying on React not
   * having flushed the clear yet — the kind of thing that works until it doesn't.
   */
  onDone: (closed: CloseHireShortTarget) => void;
}) {
  const { pushToast } = useDashboard();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // EVERY exit clears the box, rather than an effect clearing it on the way in: a reason typed
  // against one line and abandoned must not reappear against the next one, and this is the whole set
  // of ways out. An effect would say the same thing while tripping the React-Compiler rule the lint
  // enforces here (no setState during an effect).
  const close = () => {
    setReason("");
    onClose();
  };

  const submit = async () => {
    if (!target || busy || !reason.trim()) return;
    setBusy(true);
    try {
      await rentalService.closeHireShort(target.purchaseOrderId, target.lineId, reason.trim());
      pushToast("Hire closed short.", "success");
      close();
      onDone(target);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not close the hire short.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(target)} onClose={close} title="Close hire short">
      <div className="space-y-3">
        <p className="text-xs text-[var(--muted)]">
          {target ? (
            <>
              <strong className="text-[var(--ink)]">
                {target.quantity - target.receivedQuantity} of {target.quantity}
              </strong>{" "}
              {target.itemName} on {target.poCode} have not been delivered. Recording them as never
              arriving takes them off the receiving queue.
            </>
          ) : null}
        </p>
        {/* Says what actually happens to the hire, because it differs by case and the user cannot
            infer it: nothing delivered means the hire never happened, part-delivered means it did
            and the kit still has to go back. */}
        <p className="text-[11px] text-[var(--muted)]">
          {target && target.receivedQuantity === 0
            ? "Nothing has arrived against this hire, so it will be marked cancelled — it never happened, and it will not count as hire spend."
            : target && target.receivedQuantity > target.returnedQuantity
              ? "The units already here still have to go back — the hire stays on hire until they do."
              : "Everything that arrived is already back, so this closes the hire."}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
            Reason <span className="text-[var(--neg)]">*</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Supplier cannot supply the remaining units"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !reason.trim()}
            className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Closing…" : "Close short"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
