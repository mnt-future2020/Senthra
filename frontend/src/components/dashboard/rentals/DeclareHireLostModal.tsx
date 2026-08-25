"use client";

import * as React from "react";

import * as rentalService from "@/services/rental.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Modal } from "@/components/ui/Modal";

/**
 * "It is not coming back" — the exit for hired equipment an engineer lost.
 *
 * The counterpart to Close hire short, from the other end of the hire. That one says the rest was
 * never delivered; this says the rest is never returning. Without it a hire whose kit was stolen or
 * left on a site could not finish at all: the collection note refuses units that are with an engineer,
 * close-short only covers units that never arrived, and the job holding them could never reconcile.
 *
 * WHAT THIS DOES NOT DO is commit any money. Declaring a loss moves custody and nothing else — what
 * the provider charges for the replacement is agreed later, on their own damage note, by whoever
 * negotiates it. Keeping the two apart is why finding the tester afterwards is its own action rather
 * than an undo, and why a credit note never puts a missing unit back on the shelf.
 */
const REASONS = [
  { value: "not_returned", label: "Not returned by the engineer" },
  { value: "lost_in_transit", label: "Lost in transit" },
  { value: "engineer_left", label: "Engineer left the company holding it" },
  { value: "site_theft", label: "Stolen from site or van" },
  { value: "other", label: "Other" },
] as const;

/** One hire the units could be on, with who is holding them. */
export interface DeclareHireLostHire {
  purchaseOrderId: string;
  lineId: string;
  poCode: string;
  itemName: string;
  qty: number;
  /** Who is holding this hire's issued units, and how many each — the server's `holders`. */
  holders: { engineerId: string; engineerName: string; quantity: number }[];
}

/**
 * A LIST, not a single hire, because the screens that open this do not all know which one.
 *
 * The warehouse's hire pane acts on the row it was clicked from and passes one. The job reconcile
 * panel knows only that a job is short — and the same catalogue item can be out on two orders with two
 * providers — so it passes what it found and lets the person say which. One hire skips the question
 * entirely, which is the ordinary case and must not be made to feel like a decision.
 */
export interface DeclareHireLostTarget {
  hires: DeclareHireLostHire[];
}

export function DeclareHireLostModal({
  target,
  onClose,
  onDone,
}: {
  target: DeclareHireLostTarget | null;
  onClose: () => void;
  /** Fires after a successful declaration so the host can refetch — the hire's numbers have moved. */
  onDone: () => void;
}) {
  const { pushToast } = useDashboard();
  const [lineId, setLineId] = React.useState("");
  const [engineerId, setEngineerId] = React.useState("");
  const [quantity, setQuantity] = React.useState(1);
  const [reason, setReason] = React.useState<string>("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // WHICH HIRE. One is the ordinary case and is taken without asking; more than one is a real question
  // — two providers, two deadlines, two invoices — and guessing it would put the write-off on the wrong
  // supplier's account.
  const hires = target?.hires ?? [];
  const hire = hires.find((h) => h.lineId === lineId) ?? (hires.length === 1 ? hires[0] : undefined);

  // Then WHO. Same rule: not a decision when there is one, but still shown, because this writes off
  // somebody else's equipment against a named person and the name has to be on screen before the
  // button is pressed.
  const holders = hire?.holders ?? [];
  const chosen = holders.find((h) => h.engineerId === engineerId) ?? (holders.length === 1 ? holders[0] : undefined);
  const max = chosen?.quantity ?? 0;

  // Every exit clears the form rather than an effect clearing it on the way in: a reason typed against
  // one hire and abandoned must not reappear against the next, and this is the whole set of ways out.
  // An effect would say the same thing while tripping the React-Compiler rule the lint enforces here.
  const close = () => {
    setLineId("");
    setEngineerId("");
    setQuantity(1);
    setReason("");
    setNotes("");
    onClose();
  };

  const invalid =
    !target || !hire || !chosen || !reason || quantity < 1 || quantity > max || (reason === "other" && !notes.trim());

  const submit = async () => {
    if (invalid || busy || !hire || !chosen) return;
    setBusy(true);
    try {
      await rentalService.declareHireLost(hire.purchaseOrderId, hire.lineId, {
        engineerId: chosen.engineerId,
        engineerName: chosen.engineerName,
        quantity,
        reason,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      pushToast(`${quantity} × ${hire.itemName} declared lost.`, "success");
      close();
      onDone();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not declare the equipment lost.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const fieldCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]";

  return (
    <Modal open={Boolean(target)} onClose={close} title="Declare hired equipment lost">
      <div className="space-y-3">
        <p className="text-xs text-[var(--muted)]">
          {hire ? (
            <>
              <strong className="text-[var(--ink)]">{hire.itemName}</strong> on {hire.poCode}. This
              records that the units are gone so the hire can be settled and closed.
            </>
          ) : (
            <>Choose which hire these units came off — each one is a different order and a different provider.</>
          )}
        </p>

        {/* The sentence that stops this being mistaken for a write-off of our own stock. It is not our
            loss to absorb — it is the provider's equipment and their charge, and the person pressing
            this needs to know a bill follows. */}
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--muted)]">
          This is the provider&rsquo;s equipment, not ours. Declaring it lost does not agree any charge
          — record what they invoice on their damage note. If it turns up later you can book it back in.
        </p>

        {/* Asked ONLY when there is something to ask. A single hire is taken silently — see the target
            type's note — so the ordinary case is three fields, not four. */}
        {hires.length > 1 && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
              Which hire <span className="text-[var(--neg)]">*</span>
            </span>
            <select
              value={hire?.lineId ?? ""}
              onChange={(e) => {
                setLineId(e.target.value);
                // Everything below depends on the hire, so it cannot survive the hire changing — a
                // quantity valid for one order is not valid for another.
                setEngineerId("");
                setQuantity(1);
              }}
              className={fieldCls}
            >
              <option value="">Select a hire…</option>
              {hires.map((h) => (
                <option key={h.lineId} value={h.lineId}>
                  {h.poCode} — {h.itemName} ({h.qty} out)
                </option>
              ))}
            </select>
          </label>
        )}

        {hires.length > 1 && !hire ? null : holders.length === 0 ? (
          <p className="text-xs text-[var(--neg)]">
            Nothing from this hire is out with an engineer, so there is nothing to declare lost.
          </p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
                Who was holding it <span className="text-[var(--neg)]">*</span>
              </span>
              <select
                value={chosen?.engineerId ?? ""}
                onChange={(e) => {
                  setEngineerId(e.target.value);
                  setQuantity(1);
                }}
                className={fieldCls}
              >
                {holders.length > 1 && <option value="">Select an engineer…</option>}
                {holders.map((h) => (
                  <option key={h.engineerId} value={h.engineerId}>
                    {h.engineerName} — holding {h.quantity}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
                How many are lost <span className="text-[var(--neg)]">*</span>
              </span>
              <input
                type="number"
                min={1}
                max={max || 1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className={fieldCls}
              />
              {/* The cap is the server's, restated so the number is refused here rather than at the
                  end of a form. */}
              <span className="mt-1 block text-[11px] text-[var(--faint)]">
                {chosen ? `${chosen.engineerName} is holding ${max}.` : "Choose who was holding it first."}
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
                Reason <span className="text-[var(--neg)]">*</span>
              </span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className={fieldCls}>
                <option value="">Select a reason…</option>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
                Notes {reason === "other" && <span className="text-[var(--neg)]">*</span>}
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={reason === "other" ? "Describe what happened" : "Anything the provider will ask about"}
                className={fieldCls}
              />
            </label>
          </>
        )}

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
            disabled={invalid || busy}
            className="rounded-lg bg-[var(--neg)] px-3 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Recording…" : "Declare lost"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
