"use client";

import * as React from "react";
import { AlertTriangle, Ban, PackageX, Receipt, RotateCcw, Undo2 } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { canSettleHires } from "@/components/dashboard/rentals/hireActions";
import { formatDate } from "@/lib/formatDate";
import { formatMoney } from "./poStatus";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { AttachmentList } from "@/components/dashboard/goods-in/DeliveryDocuments";
import { UNTYPED_IMAGE } from "@/components/dashboard/goods-in/docPicker";
import type { HireCustodyExit } from "@/types/rental";

/**
 * What happened to the provider's equipment while we had it — the order's ONE record of it.
 *
 * Deliveries and returns already had one; damage and loss did not, and the gap was the whole problem.
 * Both were being recorded in full — quantity, reason, photograph, which job, which engineer, who
 * signed it off — and every screen was blind to all of it. A unit was declared lost and the order page
 * still read "100 ordered · on hire · £300", which is the page somebody opens holding the invoice.
 *
 * Its own panel rather than rows inside Hire movements, because these are NOT movements: a delivery
 * starts the hire and a return ends it, and neither of those describes a fault. Damage reports and loss
 * settlements used to be listed there AS WELL as here, so one fault filled two cards on one page and
 * the page grew twice as fast as the hire's history did. They belong to the record, and the record
 * carries the note's code, its charge and its actions — one place instead of two.
 *
 * ── Why it is grouped, and short ───────────────────────────────────────────────────────────────
 *
 * Three things end up in this list and they are not the same work. Damage an ENGINEER reported comes
 * with a job, a name and a photograph and is somebody else's account; damage found HERE was written by
 * whoever is reading; a LOSS is not damage at all. Rendered as one undifferentiated column of cards,
 * the only visible difference was whether a job number happened to be present — which reads as an
 * accident rather than a distinction. A hire with a dozen reports then pushed everything below it off
 * the screen.
 *
 * So: one line per record, grouped by where it came from, most recent few shown, and the detail behind
 * a click. The work — what still needs a charge agreed — is counted in the header so it survives the
 * collapsing.
 */

/** Where a record came from. The axis the reader actually thinks in — see the note above. */
type Source = "job" | "here" | "loss";

export function sourceOf(e: HireCustodyExit): Source {
  if (e.kind === "loss") return "loss";
  // A job number is what an engineer's report carries and a warehouse's does not. It is the same
  // signal the old list showed by accident; here it decides the group instead of being left to notice.
  return e.jobNumber ? "job" : "here";
}

const SOURCE_LABEL: Record<Source, string> = {
  job: "From a job",
  here: "Found here",
  loss: "Lost",
};
const CUSTODY_LABEL: Record<string, string> = {
  held_damaged: "Damaged, still here",
  returned_to_supplier: "Damaged, gone back",
  withdrawn: "Report withdrawn",
  lost: "Lost",
  recovered: "Found and booked back in",
};

/**
 * A LOSS carries one of the shared write-off reasons — the same enum company stock is written off
 * against — so the row must print the words, not the stored key. Damage carries the engineer's own
 * sentence and falls through unchanged.
 */
const LOSS_REASON_LABEL: Record<string, string> = {
  not_returned: "Not returned by the engineer",
  lost_in_transit: "Lost in transit",
  engineer_left: "Engineer left the company holding it",
  site_theft: "Stolen from site or van",
  other: "Other",
};

const SETTLEMENT_LABEL: Record<string, string> = {
  unsettled: "Not yet charged",
  settled: "Charged",
  dismissed: "Nothing owed",
};

/**
 * The settlement tag a record shows — and, when the two disagree, what the EQUIPMENT is doing.
 *
 * "Nothing owed" alone is a half-truth on a dismissed damage report, and the dangerous half. It says
 * the money question is closed, and a reader carries that straight over to the kit: dismissed sounds
 * like withdrawn, withdrawn puts units back into the issuable pool, so "Nothing owed" on its own reads
 * as "fixed, back on the shelf". It is not — `fieldDamageQty` still counts that unit and
 * `hireIssuable` still subtracts it, exactly as before the charge was dropped.
 *
 * That gap matters more here than anywhere else in the panel, because the Damaged Stock pane filters
 * on `unsettled` and so drops a dismissed row (just as it already drops a charged one). This timeline
 * is unfiltered by design, which makes it the ONE screen that still lists these units — so it is the
 * one screen that has to say what state they are in.
 *
 * Only `dismissed` is qualified. `unsettled` and `settled` both already imply a live record, and a
 * dismissed report whose units have been WITHDRAWN or RECOVERED genuinely owes nothing and holds
 * nothing — those are the cases where "Nothing owed" is the whole truth.
 */
export const settlementTag = (e: Pick<HireCustodyExit, "settlementState" | "custodyState">): string => {
  if (e.settlementState !== "dismissed") return SETTLEMENT_LABEL[e.settlementState] ?? e.settlementState;
  if (e.custodyState === "held_damaged") return "No charge · still damaged";
  // Gone back to the provider broken, with nothing charged for it. The units are not ours to account
  // for any more, so "still damaged" would be describing equipment we do not have.
  if (e.custodyState === "returned_to_supplier") return "No charge · returned damaged";
  return SETTLEMENT_LABEL.dismissed;
};

/** How many rows the panel shows before it asks. Enough to see the shape, few enough to stay short. */
const COLLAPSED = 4;

/**
 * Is this record still owed an answer from the office?
 *
 * A withdrawn report never happened and a recovered loss is back on the shelf — neither owes the
 * provider anything, however unsettled its settlement column looks. The header count, the row tag and
 * the action all read this one predicate so they cannot disagree about what the work is.
 */
export const isOpen = (e: HireCustodyExit): boolean =>
  e.settlementState === "unsettled" && e.custodyState !== "withdrawn" && e.custodyState !== "recovered";

/**
 * Is this record ON a provider document that carries no figure yet?
 *
 * A note raised without a price is not a mistake, it is the normal order of events: the damage is
 * written down the day it is found, and the provider's quote arrives the following week. `settledAt`
 * says the claim has been PUT to them; `settledCharge` says whether they have answered.
 *
 * The office's errand is the SAME one as an unsettled record's — nobody knows what this costs — which
 * is why the header folds the two into one count. Only the mechanism differs: an unsettled record
 * needs a note raising, this one needs a figure adding to the note it already has.
 *
 * Withdrawn and recovered are excluded, and not as tidiness: neither is waiting for a price. A
 * recovered loss is waiting for the opposite — see `needsCredit`.
 */
export const awaitingQuote = (e: HireCustodyExit): boolean =>
  e.settlementState === "settled" &&
  e.settledCharge == null &&
  e.custodyState !== "withdrawn" &&
  e.custodyState !== "recovered";

/**
 * Has this record been PAID FOR and then turned out not to be owed?
 *
 * The one case, and it is a real one: a unit is declared lost, the provider charges us for it, and
 * then it turns up behind the racking. The equipment comes back on its own — `recoverHireLoss` puts it
 * straight back on the shelf — but the money does not. Somebody has to claim the credit or withdraw
 * the charge, and until they do, the record shows a settled figure for equipment we have.
 *
 * NOT the same as a damage charge on kit the provider has collected. That one is settled and stays
 * settled: they took away something we broke, and the charge was for breaking it.
 *
 * `isOpen` deliberately says false here — this is not waiting for a figure, it is waiting for one to
 * come back — so the panel counts and labels it separately or it would be invisible.
 */
export const needsCredit = (e: HireCustodyExit): boolean =>
  e.custodyState === "recovered" && e.settlementState === "settled";

/**
 * Can this record be answered with "nothing is owed"?
 *
 * The third outcome beside charging it and withdrawing the note behind it, and the only one a
 * JOB-reported damage record can reach — its source is a return movement, not a document, so there is
 * nothing to withdraw and the charge was previously its only exit.
 *
 * `isOpen` carries the settlement half (unsettled, and not already withdrawn or recovered — none of
 * which is waiting for an answer). What this adds is DAMAGE ONLY: a loss written off without charging
 * is a decision about the whole hire rather than about one report, and the server refuses it — so the
 * button must not be offered for one.
 *
 * Exported and shared with the panel for the same reason `isOpen` is: a condition written twice is a
 * condition that eventually disagrees with itself.
 */
export const canDismiss = (e: HireCustodyExit): boolean => isOpen(e) && e.kind === "damage";

const pillCls = (active: boolean) =>
  `rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
    active ? "bg-[var(--surface)] text-[var(--ink)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"
  }`;

const openTagCls = "shrink-0 rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--neg)]";
const quietTagCls = "shrink-0 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--faint)]";

// `neg` is for taking a record BACK, and it is deliberately the quietest of the three: withdrawing a
// report or a charge is a correction, not a step forward, and it should not compete with the action
// the panel exists to prompt.
// `plain` is the NEUTRAL tone, and dismissal is the reason it exists: answering a report with
// "nothing is owed" is neither the money action (accent), nor equipment coming back (pos), nor an undo
// (neg). Giving it any of those three would colour it as one of them on the one row where the whole
// point is that it is a different kind of answer.
const rowBtnCls = (tone: "accent" | "pos" | "neg" | "plain") =>
  `inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-bold text-[var(--muted)] transition-colors disabled:opacity-50 ${
    tone === "accent"
      ? "hover:border-[var(--accent)] hover:text-[var(--accent)]"
      : tone === "pos"
        ? "hover:border-[var(--pos)] hover:text-[var(--pos)]"
        : tone === "plain"
          ? "hover:border-[var(--ink)] hover:text-[var(--ink)]"
          : "hover:border-[var(--neg)] hover:text-[var(--neg)]"
  }`;

export function HireCustodyTimeline({
  purchaseOrderId,
  reloadKey,
  onChanged,
}: {
  purchaseOrderId: string;
  /** Bumped by the page when a hire action lands, so this refetches with everything else. */
  reloadKey?: number;
  onChanged?: () => void;
}) {
  const { pushToast } = useDashboard();
  const { can } = useAuth();
  const canSettle = canSettleHires(can);
  const [exits, setExits] = React.useState<HireCustodyExit[] | null>(null);
  const [recovering, setRecovering] = React.useState<string | null>(null);
  /** Which kind of record the reader is looking at, and whether the list is opened out. */
  const [filter, setFilter] = React.useState<"all" | Source>("all");
  const [expanded, setExpanded] = React.useState(false);
  /** The record whose full account is open — the photograph, the words, and what became of it. */
  const [detail, setDetail] = React.useState<HireCustodyExit | null>(null);
  /**
   * The record whose charge is being entered, and the two boxes that entry needs.
   *
   * A DIALOG, not a form, and the difference is what has already happened. Damage found at the
   * warehouse is reported on a form because nobody has written it down yet; damage found on a job was
   * written down by the engineer, on the day, with a photograph. Reopening a report form over that
   * asked somebody to describe, date and count it again from memory. All that is missing is the money.
   */
  const [charging, setCharging] = React.useState<HireCustodyExit | null>(null);
  /**
   * Which of the two money jobs the dialog is doing.
   *
   * `raise` puts the claim to the provider for the first time — it CREATES their document from the
   * record. `quote` fills in a figure on a document that already exists, which is the ordinary next
   * step a week later when their price arrives.
   *
   * Both ask for the same two things, so they share one dialog; they are different requests and
   * different sentences, so the dialog has to know which. Modelled here rather than derived from the
   * record's state at render time — the state changes underneath an open dialog when someone else
   * settles it, and the dialog must not change what it is halfway through being filled in.
   */
  const [chargeMode, setChargeMode] = React.useState<"raise" | "quote">("raise");
  const [charge, setCharge] = React.useState("");
  const [chargeRef, setChargeRef] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  /**
   * The undo being confirmed, and WHICH of the two it is.
   *
   * Two different notes hang off one record and reversing them means opposite things. Withdrawing the
   * REPORT says the damage never happened — the units go back on the shelf as fit. Withdrawing the
   * CHARGE says the money was wrong while the tester stays broken — the record returns to the worklist
   * and nothing about the equipment changes. Modelled as one state carrying the kind rather than two
   * booleans, so the confirm can never be opened for both at once.
   */
  const [undoing, setUndoing] = React.useState<{ exit: HireCustodyExit; kind: "report" | "charge" } | null>(null);
  const [undoReason, setUndoReason] = React.useState("");
  /**
   * The damage report being answered with "nothing is owed", and why.
   *
   * A THIRD state and not a mode of `undoing`, because it is not an undo. Withdrawing says the damage
   * never happened and puts units back on the shelf; this says the damage DID happen, the equipment is
   * still broken, and nobody is being billed for it. Folding them together is how a dismissal would
   * end up quietly restoring stock.
   */
  const [dismissing, setDismissing] = React.useState<HireCustodyExit | null>(null);
  const [dismissReason, setDismissReason] = React.useState("");
  /**
   * The loss being booked back in, and where it turned up.
   *
   * Confirmed rather than fired on click. Booking a find in is not a view change: it puts units back
   * on the shelf, takes them off the write-off, and — when the provider has already been paid for
   * them — leaves a charge standing that somebody now has to claim back. A button that did all that
   * between a click and a toast gave nobody a chance to read the last part.
   */
  const [finding, setFinding] = React.useState<HireCustodyExit | null>(null);
  const [recoveryNotes, setRecoveryNotes] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    void rentalService
      .listOrderCustodyExits(purchaseOrderId)
      .then((r) => alive && setExits(r.exits))
      // Empty rather than an error banner: this is a supporting panel on a page that has already
      // loaded, and a failure here must not make the order look broken.
      .catch(() => alive && setExits([]));
    return () => {
      alive = false;
    };
  }, [purchaseOrderId, reloadKey]);

  const recover = async () => {
    const exit = finding;
    if (!exit || recovering) return;
    setRecovering(exit.id);
    try {
      await rentalService.recoverHireLoss(purchaseOrderId, exit.id, {
        quantity: exit.qty,
        // Where it turned up. Optional, and worth asking for: "found behind the racking" is the whole
        // explanation of a write-off that reversed itself, and nothing else on the record carries it.
        ...(recoveryNotes.trim() ? { notes: recoveryNotes.trim() } : {}),
      });
      setFinding(null);
      pushToast(`${exit.qty} unit${exit.qty === 1 ? "" : "s"} booked back in.`, "success");
      const refreshed = await rentalService.listOrderCustodyExits(purchaseOrderId);
      setExits(refreshed.exits);
      onChanged?.();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not book the equipment back in.", "alert");
    } finally {
      setRecovering(null);
    }
  };

  /**
   * Take a photograph off the note it was filed on.
   *
   * Kept available here because it used to live on the movements list, and moving damage notes out of
   * that list must not quietly remove the ability to correct a wrong file — a capability that vanishes
   * when a panel is reorganised is a regression nobody reports.
   */
  const removePhoto = async (receiptId: string, attachmentId: string) => {
    try {
      await rentalService.removeHireDeliveryPhoto(receiptId, attachmentId);
      pushToast("Photo removed.", "success");
      const refreshed = await rentalService.listOrderCustodyExits(purchaseOrderId);
      setExits(refreshed.exits);
      setDetail((d) => (d ? refreshed.exits.find((e) => e.id === d.id) ?? null : null));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not remove the photo.", "alert");
    }
  };

  /**
   * Answer a report with "nothing is owed".
   *
   * The third outcome, and the one a JOB-reported record could not reach: it has no note behind it, so
   * there is nothing to withdraw, and the only action it was offered raised a provider document. This
   * closes it without one.
   *
   * The list is refetched rather than patched locally: the server decides the resulting state, and the
   * header counts read it back through the same predicates every other action here refreshes.
   */
  const doDismiss = async () => {
    if (!dismissing || saving) return;
    const reason = dismissReason.trim();
    if (!reason) {
      pushToast("Say why nothing is being charged.", "alert");
      return;
    }
    setSaving(true);
    try {
      await rentalService.dismissCustodyExit(purchaseOrderId, dismissing.id, { reason });
      pushToast("Marked as no charge.", "success");
      setDismissing(null);
      setDismissReason("");
      setDetail(null);
      const refreshed = await rentalService.listOrderCustodyExits(purchaseOrderId);
      setExits(refreshed.exits);
      onChanged?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not dismiss that.", "alert");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Withdraw one of the two notes behind a record.
   *
   * Restores what moving damage notes out of the movements list took away. That list was the ONLY
   * place a mistaken damage report could be withdrawn from, and filtering it to deliveries and
   * returns removed the path without removing the need — the comment there promises the record
   * "carries the note's code, its charge and its actions", and this is the actions half of it.
   *
   * The server decides both outcomes; this only names the note. Withdrawing a report moves its record
   * to `withdrawn`/`dismissed` and gives the units back to the issuable pool; withdrawing a charge
   * moves the record back to `unsettled` and leaves the equipment exactly where it was.
   */
  const doUndo = async () => {
    if (!undoing || saving) return;
    const reason = undoReason.trim();
    if (!reason) {
      pushToast("Say why this is being withdrawn.", "alert");
      return;
    }
    const receiptId = undoing.kind === "report" ? undoing.exit.sourceReceiptId : undoing.exit.settledByReceiptId;
    if (!receiptId) return;
    setSaving(true);
    try {
      await rentalService.reverseHireMovement(receiptId, reason);
      pushToast(undoing.kind === "report" ? "Report withdrawn." : "Charge withdrawn.", "success");
      setUndoing(null);
      setDetail(null);
      const refreshed = await rentalService.listOrderCustodyExits(purchaseOrderId);
      setExits(refreshed.exits);
      onChanged?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not withdraw that.", "alert");
    } finally {
      setSaving(false);
    }
  };

  /**
   * How many OTHER records the same note would take with it.
   *
   * One damage note is not always one record. The report form consumes any open job-reported damage on
   * the line before it opens fresh records of its own, so a single HDM can be the source of one and the
   * settlement of another — and reversing it undoes both. A confirm that names only the record you
   * clicked from would be telling the truth about a third of what is about to happen.
   */
  const alsoAffected = (receiptId: string, exceptId: string): number =>
    (exits ?? []).filter(
      (e) => e.id !== exceptId && (e.sourceReceiptId === receiptId || e.settledByReceiptId === receiptId),
    ).length;

  const openRecover = (exit: HireCustodyExit) => {
    setDetail(null);
    setRecoveryNotes("");
    setFinding(exit);
  };

  const openUndo = (exit: HireCustodyExit, kind: "report" | "charge") => {
    setDetail(null);
    setUndoReason("");
    setUndoing({ exit, kind });
  };

  /**
   * `setDetail(null)` FIRST, like every sibling above, and it is not cosmetic. The detail Modal and the
   * ConfirmDialog each install a document-level focus trap; leaving both mounted puts two on the page,
   * so Tab is yanked back to the textarea and the confirm button cannot be reached from the keyboard,
   * while Escape closes both at once. A helper rather than an inline handler for exactly that reason —
   * the ordering is the contract, and it belongs where the other three keep it.
   */
  const openDismiss = (exit: HireCustodyExit) => {
    setDetail(null);
    setDismissReason("");
    setDismissing(exit);
  };

  const openCharge = (e: HireCustodyExit, mode: "raise" | "quote" = "raise") => {
    setDetail(null);
    setCharging(e);
    setChargeMode(mode);
    setCharge("");
    setChargeRef("");
  };

  const saveCharge = async () => {
    if (!charging || saving) return;
    setSaving(true);
    try {
      // ADDING A FIGURE TO AN EXISTING NOTE IS NOT A REVERSAL, and that is the module's own rule: every
      // quantity on a note feeds a running total on the hire line, so editing one would leave a stored
      // figure disagreeing with the records it summarises — a charge feeds nothing, so it can simply be
      // corrected. Without this the dialog that invites an empty box had no way to fill it in later.
      if (chargeMode === "quote") {
        if (!charging.settledByReceiptId) return;
        await rentalService.recordDamageCharge(charging.settledByReceiptId, {
          lines: [
            {
              purchaseOrderRentalLineId: charging.purchaseOrderRentalLineId,
              ...(charge.trim() ? { damageCharge: Number(charge) } : { damageCharge: null }),
            },
          ],
          ...(chargeRef.trim() ? { damageChargeRef: chargeRef.trim() } : {}),
        });
        pushToast(`${charging.settledByCode} updated.`, "success");
      } else {
        const { receipt } = await rentalService.chargeCustodyExit(charging.id, {
          // An empty box is "no figure agreed yet", recorded as NOT KNOWN — never as £0.00, which reads
          // as the provider charging us nothing.
          ...(charge.trim() ? { charge: Number(charge) } : {}),
          ...(chargeRef.trim() ? { chargeRef: chargeRef.trim() } : {}),
        });
        pushToast(`Put to the provider on ${receipt.code}.`, "success");
      }
      setCharging(null);
      const refreshed = await rentalService.listOrderCustodyExits(purchaseOrderId);
      setExits(refreshed.exits);
      onChanged?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not record that charge.", "alert");
    } finally {
      setSaving(false);
    }
  };

  if (exits === null || exits.length === 0) return null;

  // Counted over EVERY record, not the visible ones — a total that changed as you expanded a group
  // would be a different question each time it was read.
  const shown = filter === "all" ? exits : exits.filter((e) => sourceOf(e) === filter);
  const counts = { all: exits.length, job: 0, here: 0, loss: 0 };
  let toCharge = 0;
  let toCredit = 0;
  let charged = 0;
  for (const e of exits) {
    counts[sourceOf(e)] += 1;
    // The WORK: a record nobody has put to the provider yet. A withdrawn report and a recovered loss
    // owe nothing, so neither is work however unsettled it looks.
    // ONE COUNT for one errand. "Nobody has put this to the provider" and "the provider has not
    // priced it" are the same job on the office's list — find out what this costs — and splitting
    // them into two pills would make the reader work out that they add up.
    if (isOpen(e) || awaitingQuote(e)) toCharge += 1;
    // The OTHER work, and the one that goes unnoticed: money paid for equipment that came back.
    if (needsCredit(e)) toCredit += 1;
    if (e.settledCharge != null) charged += e.settledCharge;
  }
  const visible = expanded ? shown : shown.slice(0, COLLAPSED);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-[var(--neg)]" />
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Damage &amp; loss</h3>
        <span className="text-[11px] text-[var(--muted)]">{exits.length}</span>
        {/* The two numbers this panel exists to answer, kept in the header so collapsing the list
            cannot hide them: what is still owed an answer, and what has been agreed so far. */}
        {toCharge > 0 && (
          <span className="rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--neg)]">
            {toCharge} to charge
          </span>
        )}
        {/* Its own count, not folded into "to charge". They are opposite errands — one owes the
            provider money, the other is owed it — and a single number would send somebody to raise a
            charge on a record that already has one. */}
        {toCredit > 0 && (
          <span className="rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--neg)]">
            {toCredit} to credit
          </span>
        )}
        {charged > 0 && (
          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">
            {formatMoney(charged)} charged
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] text-[var(--muted)]">
        What happened to this equipment while we held it. Nothing here is written off as our stock — a
        hire stays theirs, and what we owe is agreed on their own note.
      </p>

      {/* Offered only when there is more than one kind to tell apart. A control that cannot change the
          list is one the reader has to press to learn that. */}
      {(["job", "here", "loss"] as const).filter((k) => counts[k] > 0).length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {(["all", "job", "here", "loss"] as const).map((k) =>
            k !== "all" && counts[k] === 0 ? null : (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setFilter(k);
                  setExpanded(false);
                }}
                aria-pressed={filter === k}
                className={pillCls(filter === k)}
              >
                {k === "all" ? "All" : SOURCE_LABEL[k]}
                <span className="ml-1 text-[var(--faint)]">{counts[k]}</span>
              </button>
            ),
          )}
        </div>
      )}

      <ul className="divide-y divide-[var(--border)]">
        {visible.map((e) => {
          const isLoss = e.kind === "loss";
          const open = isOpen(e);
          const recoverable = isLoss && e.custodyState === "lost" && canSettle;
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              {isLoss ? (
                <PackageX className="h-3.5 w-3.5 shrink-0 text-[var(--neg)]" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--neg)]" />
              )}
              <button
                type="button"
                onClick={() => setDetail(e)}
                className="min-w-0 flex-1 truncate text-left hover:underline"
                title="Open the full record"
              >
                <span className="font-bold text-[var(--ink)]">
                  {e.qty} × {isLoss ? "declared lost" : "damaged"}
                </span>
                <span className="ml-2 text-[11px] text-[var(--muted)]">
                  {[e.jobNumber, e.engineerName].filter(Boolean).join(" · ") || CUSTODY_LABEL[e.custodyState] || ""}
                </span>
              </button>

              {/* A settled record says what it was settled ON — the note is the document the money
                  lives on, and a bare figure with nothing to look it up by is not an answer to an
                  accountant. */}
              {e.settledByCode ? (
                // NOT struck through. A strike would say the charge had been cancelled, and it has
                // not — it is standing, on equipment we have, which is precisely the problem. The
                // figure stays legible and the colour and the suffix say what is wrong with it.
                <span
                  className={`shrink-0 text-[11px] font-semibold ${
                    needsCredit(e)
                      ? "text-[var(--neg)]"
                      : awaitingQuote(e)
                        ? "text-[var(--warn,#d97706)]"
                        : "text-[var(--pos)]"
                  }`}
                >
                  {/* "no charge" READ AS "they are not charging us", which is a different fact and the
                      one nobody has to chase. A note awaiting a quote and one the provider settled for
                      nothing are not the same thing — the note-level UI was careful about exactly this
                      and the row had lost it. */}
                  {e.settledCharge != null ? `${formatMoney(e.settledCharge)} · ` : "awaiting a quote · "}
                  <span className="font-mono">{e.settledByCode}</span>
                  {needsCredit(e) && " · to credit"}
                </span>
              ) : (
                <span className={open ? openTagCls : quietTagCls}>
                  {settlementTag(e)}
                </span>
              )}

              <span className="shrink-0 text-[11px] text-[var(--faint)]">{formatDate(e.declaredAt)}</span>

              {/* The one action that IS the work stays on the row; everything else lives behind the
                  record, because a row carrying four buttons is no shorter than the card it replaced. */}
              {open && canSettle && (
                <button type="button" onClick={() => openCharge(e)} className={rowBtnCls("accent")}>
                  <Receipt className="h-3.5 w-3.5" />
                  Record charge
                </button>
              )}
              {/* The same errand one step later: the claim is already on their document and their price
                  has now arrived. SAME LABEL, deliberately — "record what they are charging" is one job
                  to the person doing it, and whether that writes a new note or fills in one already
                  raised is plumbing. The two states are mutually exclusive, so one label is never
                  ambiguous; two made the reader stop and work out which they wanted. */}
              {!open && awaitingQuote(e) && canSettle && (
                <button type="button" onClick={() => openCharge(e, "quote")} className={rowBtnCls("accent")}>
                  <Receipt className="h-3.5 w-3.5" />
                  Record charge
                </button>
              )}
              {!open && recoverable && (
                <button type="button" onClick={() => openRecover(e)} disabled={recovering === e.id} className={rowBtnCls("pos")}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {recovering === e.id ? "Booking in…" : "Found it"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {shown.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[11px] font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
        >
          {expanded ? "Show fewer" : `Show all ${shown.length}`}
        </button>
      )}

      {/* THE FULL ACCOUNT, behind a click.
          Rows are one line so a dozen reports do not push the order off the screen, and everything the
          row had to drop lives here: the engineer's words, the photograph that is worth more than any
          of them, and what became of the equipment afterwards. */}
      {/* `scrollBody` keeps the heading and the actions in place while the middle scrolls — a record
          carrying a dozen photographs is the normal case for a badly damaged item, and without it the
          "Record charge" button leaves the screen behind the pictures. Same modal behaviour as the
          IRM and customer history it sits beside. */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.kind === "loss" ? "Loss record" : "Damage record"}
        scrollBody
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-[var(--ink)]">
                {detail.qty} × {detail.itemName}
              </span>
              <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">
                {CUSTODY_LABEL[detail.custodyState] ?? detail.custodyState}
              </span>
              <span className={isOpen(detail) ? openTagCls : quietTagCls}>
                {settlementTag(detail)}
              </span>
            </div>

            {/* WHO and WHERE — the two facts a conversation with the provider turns on. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]">
              {detail.jobNumber && <span className="font-mono">{detail.jobNumber}</span>}
              {detail.engineerName && <span>{detail.engineerName}</span>}
              <span>{formatDate(detail.declaredAt)}</span>
              {detail.declaredBy && <span className="text-[var(--faint)]">recorded by {detail.declaredBy}</span>}
            </div>

            <p className="text-xs text-[var(--ink)]">
              {(detail.kind === "loss" && LOSS_REASON_LABEL[detail.reason]) || detail.reason}
            </p>
            {detail.notes && <p className="text-[11px] text-[var(--muted)]">{detail.notes}</p>}

            {/* EVERY picture behind this record, from either place one can live: the engineer's own,
                taken at the moment they saw the fault, and the files on a warehouse report's note.
                Rendered by the SAME list the delivery notes use — thumbnail, click to open — because a
                photograph is the thing somebody needs to LOOK at and a filename is not one. */}
            {/* A LOSS HAS NO PICTURE TO TAKE. Nothing is in front of anybody: `declareHireLost` writes no
                `photoUrl` and its form has no upload, so "No photos on this record." was stating the
                obvious on every loss ever recorded. A DAMAGE record keeps the empty state — evidence is
                expected there, and its absence is worth knowing before arguing a charge.

                Rendered when the record DOES hold something, whatever its kind: a file can still reach
                an HLS note through the upload API, and evidence that exists must never be invisible. */}
            {(detail.kind !== "loss" || detail.photoUrl || detail.attachments.length > 0) && (
            <AttachmentList
              items={[
                // The engineer's photo has no file record of its own — it was captured on the return
                // scan and kept as a bare URL — so it is named for what it is rather than left
                // unlabelled, and typed only as far as the record actually knows.
                ...(detail.photoUrl
                  ? [{ id: "engineer-photo", fileName: "Damage photo", fileType: UNTYPED_IMAGE, fileSizeBytes: 0, src: detail.photoUrl }]
                  : []),
                ...detail.attachments.map((a) => ({
                  id: a.id,
                  fileName: a.fileName,
                  fileType: a.fileType,
                  fileSizeBytes: a.fileSizeBytes,
                  src: a.url,
                })),
              ]}
              // Said out loud when there are none, because it cannot be fixed later: nobody photographs
              // a fault after the equipment has gone back.
              emptyLabel="No photos on this record."
              // Removal stays with the note's own files. The engineer's photo has no file record to
              // delete, and a settled record's evidence is what a supplier charge is argued from.
              onRemove={
                canSettle && detail.attachmentsReceiptId
                  ? (attachmentId) =>
                      attachmentId === "engineer-photo" ? undefined : removePhoto(detail.attachmentsReceiptId!, attachmentId)
                  : undefined
              }
              removePrompt={{
                title: "Remove photo",
                message: "Remove this photo from the record? Damage evidence can't be recaptured once the equipment has gone back.",
              }}
            />
            )}

            {detail.settledByCode && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--muted)]">
                Put to the provider on <span className="font-mono text-[var(--ink)]">{detail.settledByCode}</span>
                {detail.settledCharge != null
                  ? ` — ${formatMoney(detail.settledCharge)} charged.`
                  : " — no figure quoted yet."}
              </p>
            )}

            {detail.recoveredAt && (
              <p className="text-[11px] text-[var(--pos)]">
                Found {formatDate(detail.recoveredAt)}
                {detail.recoveredBy ? ` · ${detail.recoveredBy}` : ""}
                {detail.recoveryNotes ? ` — ${detail.recoveryNotes}` : ""}
              </p>
            )}

            {/* THE MONEY DID NOT COME BACK WITH THE EQUIPMENT. A charge already agreed does not
                un-agree itself because the tester turned up — that is an accounting decision, not a
                custody one, and it is the half of a recovery that goes unnoticed because everything
                else about the record now reads as resolved. Given its own block rather than a clause
                at the end of the green line: it is the one thing here somebody still has to do. */}
            {needsCredit(detail) && (
              <p className="rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/8 px-3 py-2 text-[11px] font-semibold text-[var(--neg)]">
                {detail.settledCharge != null ? formatMoney(detail.settledCharge) : "A charge"} was settled with
                the provider on <span className="font-mono">{detail.settledByCode}</span> for equipment we now
                have. Claim the credit, or withdraw the charge below.
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {isOpen(detail) && canSettle && (
                <button
                  type="button"
                  onClick={() => {
                    const target = detail;
                    setDetail(null);
                    openCharge(target);
                  }}
                  className={rowBtnCls("accent")}
                >
                  <Receipt className="h-3.5 w-3.5" />
                  Record charge
                </button>
              )}
              {/* THE OTHER ANSWER, and it belongs beside the charge rather than under the undos.
                  Both buttons close the same question — "what does the provider get for this?" — and
                  the two answers are "an invoice" and "nothing". Putting this among the withdrawals
                  would file it as a correction, which it is not: nothing here was entered wrongly.

                  DAMAGE only. A loss dismissed without a charge is a decision about the whole hire,
                  not about one report, and the server refuses it — so the button is not offered. */}
              {canDismiss(detail) && canSettle && (
                <button
                  type="button"
                  onClick={() => openDismiss(detail)}
                  className={rowBtnCls("plain")}
                >
                  <Ban className="h-3.5 w-3.5" />
                  No charge
                </button>
              )}
              {!isOpen(detail) && awaitingQuote(detail) && canSettle && (
                <button type="button" onClick={() => openCharge(detail, "quote")} className={rowBtnCls("accent")}>
                  <Receipt className="h-3.5 w-3.5" />
                  Record charge
                </button>
              )}
              {detail.kind === "loss" && detail.custodyState === "lost" && canSettle && (
                <button
                  type="button"
                  onClick={() => openRecover(detail)}
                  className={rowBtnCls("pos")}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  It turned up — book back in
                </button>
              )}

              {/* THE TWO UNDOS, and they are not the same undo. Withdrawing the REPORT says the damage
                  never happened — the units go back on the shelf as fit. Withdrawing the CHARGE says
                  the figure was wrong while the tester stays broken. Offering one button for both, or
                  labelling either of them "Reverse", is how somebody puts a damaged unit back into the
                  issuable pool while meaning to correct an invoice.

                  ONE NOTE, ONE BUTTON. A warehouse damage report SETTLES ITS OWN RECORD — the report
                  path opens the exit and immediately marks it settled against the same note — so on
                  every record found here, `sourceReceiptId` and `settledByReceiptId` are the same
                  document. Offering both then gave two buttons that reverse one note, with confirms
                  describing opposite outcomes: "the equipment does not change" was simply false, since
                  withdrawing that note withdraws the report along with the charge. Withdrawing the
                  report is the honest name for what happens, so it is the one that stays.

                  Damage found on a JOB has no report to withdraw: its source is a movement on the
                  return, not a note — which is why `sourceReceiptId` is null there, and the charge
                  undo is the only one it can offer. */}
              {canSettle &&
                detail.settledByReceiptId &&
                detail.settlementState === "settled" &&
                detail.settledByReceiptId !== detail.sourceReceiptId && (
                  <button type="button" onClick={() => openUndo(detail, "charge")} className={rowBtnCls("neg")}>
                    <Undo2 className="h-3.5 w-3.5" />
                    Withdraw the charge
                  </button>
                )}
              {/* Offered on kit ALREADY COLLECTED too, and that is the case that matters: a wrong
                  report is usually found when the provider disputes their invoice, weeks after they
                  took the equipment away. */}
              {canSettle &&
                detail.sourceReceiptId &&
                (detail.custodyState === "held_damaged" || detail.custodyState === "returned_to_supplier") && (
                  <button type="button" onClick={() => openUndo(detail, "report")} className={rowBtnCls("neg")}>
                    <Undo2 className="h-3.5 w-3.5" />
                    Withdraw this report
                  </button>
                )}
            </div>
          </div>
        )}
      </Modal>

      {/* THE SAME DIALOG the warehouse leg uses, asking the same two questions. What differs is only
          where the rest of the record came from: there, a form the user had just filled in; here, the
          engineer's own report. */}
      {/* ONE SENTENCE, then the boxes — the shape every other dialog in the app uses (see
          WriteOffLostModal, DeclareHireLostModal). This had grown two paragraphs and a bordered note
          before the first field, and most of it explained MECHANICS: that a charge feeds no running
          total, that nothing is reported twice. True, and none of it is a decision the person typing a
          number has to make. What they need is what is being charged and where it lands.

          The "empty is not £0.00" rule moved to a hint under the box it is about, which is where this
          project puts such notes and where it will actually be read. */}
      <Modal
        open={Boolean(charging)}
        onClose={() => setCharging(null)}
        title={charging?.kind === "loss" ? "Loss charge" : "Damage charge"}
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--ink)]">
            What the provider is charging for{" "}
            <strong>
              {charging?.qty} × {charging?.itemName}
            </strong>
            {chargeMode === "quote" ? (
              <>
                , on <span className="font-mono">{charging?.settledByCode}</span>.
              </>
            ) : charging?.jobNumber ? (
              <> reported on {charging.jobNumber}. This raises their {charging?.kind === "loss" ? "settlement" : "damage report"}.</>
            ) : (
              <>. This raises their {charging?.kind === "loss" ? "settlement" : "damage report"}.</>
            )}
          </p>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">Charge (£)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={charge}
              onChange={(ev) => setCharge(ev.target.value)}
              placeholder="Leave empty if not yet quoted"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
            />
            {/* A missing quote and a provider charging nothing are different facts, and only one of
                them is somebody's job to chase. Said here rather than in the paragraph above: it is a
                rule about THIS box. */}
            <span className="mt-1 block text-[11px] text-[var(--faint)]">
              Empty is recorded as <strong className="text-[var(--muted)]">not known</strong> — not £0.00.
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">Supplier&rsquo;s quote / invoice reference</span>
            <input
              value={chargeRef}
              onChange={(ev) => setChargeRef(ev.target.value)}
              maxLength={60}
              placeholder="Their document number"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
            />
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCharging(null)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveCharge()}
              disabled={saving}
              className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save charge"}
            </button>
          </div>
        </div>
      </Modal>

      {/* THE MONEY IS THE PART THAT NEEDS SAYING OUT LOUD, and it is said BEFORE the click commits.
          Booking a find in puts the units back on the shelf, which is the easy half. The half nobody
          remembers is that we may already have paid the provider for equipment we now have — and that
          money does not come back on its own. Warned here, at the moment of the decision, rather than
          left for whoever reads the record next month. */}
      <ConfirmDialog
        open={Boolean(finding)}
        title="Book found equipment back in"
        confirmLabel="Book it in"
        busy={Boolean(recovering)}
        onClose={() => setFinding(null)}
        onConfirm={recover}
        message={
          <>
            Book {finding?.qty} {finding?.qty === 1 ? "unit" : "units"} of{" "}
            <strong className="text-[var(--ink)]">{finding?.itemName}</strong> back in? It stops being a
            write-off and goes back to the provider with the rest of the hire.
          </>
        }
        field={
          <>
            {finding?.settlementState === "settled" && (
              <p className="mb-2 rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/8 px-3 py-2 text-[11px] font-semibold text-[var(--neg)]">
                {finding.settledCharge != null ? formatMoney(finding.settledCharge) : "A charge"} was already
                settled with the provider on <span className="font-mono">{finding.settledByCode}</span> for these
                units. Booking them in does not undo that — claim the credit, or withdraw the charge from the
                record.
              </p>
            )}
            <textarea
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              rows={2}
              value={recoveryNotes}
              maxLength={500}
              placeholder="Where was it found? (optional)"
              onChange={(e) => setRecoveryNotes(e.target.value)}
            />
            {/* Optional, unlike the withdrawal reasons. A find needs no justifying — the equipment is
                on the bench — but "behind the racking" is the whole explanation of a write-off that
                reversed itself, and nothing else on the record carries it. */}
          </>
        }
      />

      {/* SAYS WHAT EACH ONE DOES TO THE EQUIPMENT, because that is the half a reader gets wrong.
          "Withdraw" sounds like one action; withdrawing a report puts units back into the issuable
          pool, and withdrawing a charge does not touch them at all. The note is named too, since both
          are reversals of a document somebody can go and look at. */}
      <ConfirmDialog
        open={Boolean(undoing)}
        title={undoing?.kind === "report" ? "Withdraw damage report" : "Withdraw charge"}
        confirmLabel="Withdraw"
        danger
        busy={saving}
        onClose={() => setUndoing(null)}
        onConfirm={doUndo}
        message={
          undoing?.kind === "report" ? (
            <>
              Withdraw <strong className="text-[var(--ink)]">{undoing?.exit.sourceCode}</strong>? The damage
              stops counting against this hire
              {/* What happens to the EQUIPMENT depends on whether it is still here, and promising a
                  return to the issuable pool for kit the provider has already collected would be
                  describing units nobody can send anywhere. */}
              {undoing?.exit.custodyState === "held_damaged"
                ? ` and the ${undoing.exit.qty === 1 ? "unit goes" : "units go"} back into what can be sent out.`
                : " — the equipment has already gone back, so nothing returns to the shelf."}
            </>
          ) : (
            <>
              Withdraw the charge on{" "}
              <strong className="text-[var(--ink)]">{undoing?.exit.settledByCode}</strong>? The equipment does
              not change — the record goes back on the list waiting for a figure.
            </>
          )
        }
        field={
          <>
            {undoing &&
              (() => {
                const receiptId =
                  undoing.kind === "report" ? undoing.exit.sourceReceiptId : undoing.exit.settledByReceiptId;
                const others = receiptId ? alsoAffected(receiptId, undoing.exit.id) : 0;
                return others > 0 ? (
                  <p className="mb-2 rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/8 px-3 py-2 text-[11px] font-semibold text-[var(--neg)]">
                    This note also covers {others} other record{others === 1 ? "" : "s"} on this order — {others === 1 ? "it" : "they"}{" "}
                    will be undone with it.
                  </p>
                ) : null;
              })()}
            {/* Required for the same reason the movement reversal requires one: this rewrites what a
                hire is recorded as owing, and "why" is the only thing that makes it readable later. */}
            <textarea
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              rows={3}
              value={undoReason}
              maxLength={500}
              placeholder="Reason (required)"
              onChange={(e) => setUndoReason(e.target.value)}
            />
            <p className="mt-1.5 text-[11px] text-[var(--faint)]">
              The note is kept and marked reversed — nothing is deleted.
            </p>
          </>
        }
      />

      {/* SPELLS OUT THE HALF THAT IS COUNTER-INTUITIVE. "No charge" sounds like the record goes away,
          and the equipment is the thing people assume follows the money. It does not: the tester is
          still broken, still off the issuable pool, and still has to go back to the provider. Saying
          so here is what stops this being used as a tidy-up button on the damaged list.

          Not `danger`. Nothing is destroyed and nothing is reversed — this is one of the two ordinary
          answers to an open report, and colouring it red would read as an undo. */}
      <ConfirmDialog
        open={Boolean(dismissing)}
        title="No supplier charge"
        confirmLabel="Mark as no charge"
        busy={saving}
        onClose={() => setDismissing(null)}
        onConfirm={doDismiss}
        message={
          <>
            Close this report with nothing owed to the provider? No damage note is raised and the{" "}
            {dismissing?.qty === 1 ? "unit is" : "units are"} not billed
            {/* Where the equipment actually is decides the second half of the sentence, exactly as it
                does on the withdrawal above — promising kit stays on our shelf when the provider has
                already collected it would be describing units we do not have. */}
            {dismissing?.custodyState === "returned_to_supplier"
              ? " — the equipment has already gone back to them."
              : ` — but ${dismissing?.qty === 1 ? "it stays" : "they stay"} recorded as damaged and out of what can be sent out.`}
          </>
        }
        field={
          <>
            {/* Required, and it is the ONLY record of the decision: a charge leaves its note behind
                and a withdrawal leaves a reversal reason, while this leaves neither. */}
            <textarea
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              rows={3}
              value={dismissReason}
              maxLength={500}
              placeholder="Why is nothing being charged? (required)"
              onChange={(e) => setDismissReason(e.target.value)}
            />
            <p className="mt-1.5 text-[11px] text-[var(--faint)]">
              The engineer&rsquo;s report, photo and quantity are kept exactly as they are.
            </p>
          </>
        }
      />
    </div>
  );
}