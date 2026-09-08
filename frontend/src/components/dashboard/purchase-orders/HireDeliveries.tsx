"use client";

import * as React from "react";
import { PackageCheck, Receipt, Undo2 } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AttachmentList } from "@/components/dashboard/goods-in/DeliveryDocuments";
import { Skeleton } from "@/components/ui/Skeleton";
import { countPillCls, inputCls } from "@/components/ui/styles";
import { Modal } from "@/components/ui/Modal";
import { NumberInput } from "@/components/ui/NumberInput";
import { formatMoney } from "./poStatus";
import type { RentalReceipt } from "@/types/rental";
import { canMoveHires, canSettleHires, noteReversalBlocker } from "@/components/dashboard/rentals/hireActions";
import type { HireReversalFacts } from "@/components/dashboard/rentals/hireActions";
import { legOf } from "@/components/dashboard/rentals/hireMovementLeg";

// Everything that physically happened to the hired kit on this order — what arrived, what went back,
// and what broke in between, newest first.
//
// The quantities a hire moved on are the sum of these records, so this is where a mistake gets undone:
// a record is REVERSED, not edited, and the reversal gives its units back. Without this panel the only
// correction path was the API, and a mistyped quantity would block the real delivery that followed it
// ("all 3 already received").
//
// One list rather than three tabs, because the question people bring to it is chronological: what has
// happened to this equipment? Splitting arrivals from returns would hide the one comparison the whole
// record exists for — it came scratched, did it go back worse?

const dateOnly = (iso: string) =>
  // UTC: a movement date is a calendar day stored as UTC midnight.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function HireDeliveries({
  purchaseOrderId,
  poStatus,
  hireReversalFacts,
  netOrderedByHireLine,
  onChanged,
  onCount,
}: {
  purchaseOrderId: string;
  /** A closed or cancelled order takes no more movements — reversals included. */
  poStatus: string;
  /**
   * What each hire on this order has held back from its deliveries, by hire-line id.
   *
   * Passed in rather than re-fetched: the order's own read already has them. A delivery reversal
   * asserts its units never came, so it is legitimate only while every one of them is still on our
   * shelf, whole and unclaimed — a QUANTITY question, since the same hire can refuse one note and
   * accept another. So the facts come down and the arithmetic happens per note.
   *
   * Gating on the ORDER's status alone left the button offering a reversal the server always refuses;
   * gating on the HIRE's status alone left it offering three more the server refuses for reasons a
   * status cannot express. See `deliveryReversalBlocker`.
   */
  hireReversalFacts: ReadonlyMap<string, HireReversalFacts>;
  /**
   * What each hire line will EVER hold, by id — the denominator its notes print against.
   *
   * A receipt line stores `orderedQuantity` as a SNAPSHOT taken when the note was written, and a
   * short close afterwards makes that snapshot describe units nobody is waiting for: a collection
   * note read "3 of 5" on a hire that will only ever hold 4. The live figure comes from the order,
   * which this panel's host already has.
   */
  netOrderedByHireLine: ReadonlyMap<string, number>;
  onChanged: () => void;
  /** Reported up so the section heading can show how many movements it is heading. */
  onCount?: (n: number) => void;
}) {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  // Two questions, because the answer differs for a warehouse user. Reversing is the COMMERCIAL key: it
  // rewrites how much of a hire moved, after the fact. Curating the evidence on a record is the
  // FLOOR's, and the route agrees — it is the same person who took the photograph.
  // Terminal orders are immutable: reversing one of their records would put quantity back onto a hire
  // the order can no longer service — a live hire on a closed order, chased by the deadline badges,
  // refused by Return hire. The service refuses it; this stops the button offering it.
  const terminal = poStatus === "closed" || poStatus === "cancelled";
  // Reversing a note and setting its damage charge are both CORRECTIONS to a committed record —
  // `settle`, which the warehouse manager who wrote the note holds, scoped to their own sites.
  const canReverse = canSettleHires(can) && !terminal;
  const canCurate = canMoveHires(can);

  const [receipts, setReceipts] = React.useState<RentalReceipt[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [reversing, setReversing] = React.useState<RentalReceipt | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // The note whose damage charge is being recorded, and the boxes for it: pounds per line, keyed by
  // the hire line, plus the supplier's own reference for the whole note.
  const [charging, setCharging] = React.useState<RentalReceipt | null>(null);
  const [chargeLines, setChargeLines] = React.useState<Record<string, string>>({});
  const [chargeRef, setChargeRef] = React.useState("");

  React.useEffect(() => {
    let active = true;
    rentalService
      .listHireDeliveries(purchaseOrderId)
      .then((rows) => {
        if (!active) return;
        // MOVEMENTS ONLY — deliveries and returns. This panel's own sentence says what it is for: a
        // delivery starts the hire, a return ends it. Damage reports and loss settlements move no
        // equipment, and they were being listed here AND as their own record in the Damage & loss panel
        // below, so one fault filled two cards on one page and the page grew twice as fast as the
        // hire's history did.
        //
        // They are not lost by this: the record they belong to carries the note's code, its charge and
        // its actions, which is one place instead of two.
        const movements = rows.filter((r) => r.direction === "in" || r.direction === "out");
        setReceipts(movements);
        onCount?.(movements.length);
        // Cleared on success, or one transient failure would render its message over freshly loaded
        // rows for the rest of the page's life — every reload here is socket-driven, so it happens.
        setError(null);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load hire deliveries."));
    return () => {
      active = false;
    };
  }, [purchaseOrderId, reloadKey, onCount]);

  // Somebody else in the yard books a delivery in while this order is open on a desk. Without this the
  // panel keeps showing the state before it, and the person reading it records the same arrival again.
  useRentalHireStream(
    React.useCallback(
      (poId: string) => {
        // An empty id means a RECONNECT replay, which carries no payload — the one moment a refetch
        // matters most, because it covers everything missed while the socket was down. Only a
        // populated id that belongs to another order is ignored.
        if (poId && poId !== purchaseOrderId) return;
        setReloadKey((k) => k + 1);
        onChanged();
      },
      [purchaseOrderId, onChanged],
    ),
  );

  /**
   * Open the charge dialog on a note, seeded with what is ALREADY on file.
   *
   * Seeded and not blank, unlike the movement form's own damage boxes: this dialog exists to correct
   * and complete a figure, so starting it empty would make every visit look like a fresh claim and
   * make "leave that line alone" impossible to express.
   */
  const openCharge = (r: RentalReceipt) => {
    setCharging(r);
    setChargeRef(r.damageChargeRef ?? "");
    setChargeLines(
      Object.fromEntries(
        r.lines.filter((l) => l.damagedQuantity > 0).map((l) => [l.purchaseOrderRentalLineId, l.damageCharge == null ? "" : String(l.damageCharge)]),
      ),
    );
  };

  const doRecordCharge = async () => {
    if (!charging || busy) return;
    setBusy(true);
    try {
      const updated = await rentalService.recordDamageCharge(charging.id, {
        damageChargeRef: chargeRef.trim(),
        // An emptied box CLEARS the charge (null), it does not set it to zero — a quote that never
        // came has to be removable, and £0.00 on file reads as "they charged us nothing".
        lines: Object.entries(chargeLines).map(([purchaseOrderRentalLineId, v]) => ({
          purchaseOrderRentalLineId,
          damageCharge: v.trim() === "" ? null : Number(v),
        })),
      });
      pushToast(
        updated.damageChargeTotal == null
          ? `Damage charge cleared on ${charging.code}.`
          : `${formatMoney(updated.damageChargeTotal)} recorded on ${charging.code}.`,
        "success",
      );
      setCharging(null);
      setReloadKey((k) => k + 1);
      // The hire register reads this money off the notes, so the page's own copy is now stale.
      onChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not record that charge.", "alert");
    } finally {
      setBusy(false);
    }
  };

  // Per NOTE, not per hire: the same hire can refuse one delivery and accept another, because the
  // question is whether THIS note's units are all still untouched.
  const blockedReason = (r: RentalReceipt): string | null =>
    noteReversalBlocker(r.direction ?? "in", r.lines, hireReversalFacts);

  const doReverse = async () => {
    if (!reversing || busy) return;
    if (reason.trim().length < 3) {
      pushToast("Say why this record is being reversed.", "alert");
      return;
    }
    setBusy(true);
    try {
      await rentalService.reverseHireMovement(reversing.id, reason.trim());
      pushToast(`${reversing.code} reversed.`, "success");
      setReversing(null);
      setReason("");
      setReloadKey((k) => k + 1);
      // The hire quantities and possibly the ORDER's status moved with it, so the page's own copy of
      // the purchase order is now stale.
      onChanged();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not reverse that record.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = async (receiptId: string, attachmentId: string) => {
    try {
      await rentalService.removeHireDeliveryPhoto(receiptId, attachmentId);
      pushToast("Photo removed.", "success");
      setReloadKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not remove the photo.", "alert");
    }
  };

  // The same three states, in the same shapes, as every other list in the app — and the ERROR is
  // asked first. `receipts` stays null when the first load fails, so a skeleton-first order made the
  // error branch unreachable: a user without `rentals.view` (this read is gated on it, the PO page is
  // not) sat in front of two pulsing grey bars for ever, with no message, no retry and no log.
  // ...but only while there is nothing else to show. Reloads here are socket-driven
  // (useRentalHireStream bumps reloadKey), so this branch also caught a BACKGROUND refetch failing —
  // and since `error` is only cleared by a later SUCCESS, one dropped request replaced an
  // already-rendered list of movements with a bare red line, permanently, with no retry and no way
  // back short of leaving the page. `receipts` still holds every valid row at that point; they are
  // rendered below with an inline banner instead.
  if (error && !receipts) return <p className="p-6 text-center text-xs text-[var(--neg)]">{error}</p>;
  if (!receipts) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  // A refetch that failed over rows that are still good. Says so without taking them away — what is
  // rendered below is the last state that loaded, not a claim about the current one. Shown on the
  // empty state too, where "Nothing recorded yet" would otherwise be an outright wrong answer.
  const staleBanner = error ? (
    <p className="border-b border-[var(--border)] bg-[var(--neg)]/5 px-4 py-2 text-[11px] text-[var(--neg)]">
      {error} Showing the last records that loaded.
    </p>
  ) : null;

  if (receipts.length === 0) {
    return (
      <>
        {staleBanner}
        {/* `py-8`, not `p-10`. The panel is its own section now rather than a band inside the rental
            card, so an order with no movements yet renders this and nothing else — and 80px of
            padding around two lines was most of what the reader saw. */}
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <PackageCheck className="h-8 w-8 text-[var(--faint)]" aria-hidden />
          <p className="max-w-sm text-xs text-[var(--muted)]">
            Nothing recorded yet. Recording a delivery is what starts a hire — its return deadline
            only applies once the kit is here.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {staleBanner}
      <div className="divide-y divide-[var(--border)]">
        {receipts.map((r) => {
          const leg = legOf(r.direction);
          return (
          // ONE GRID FOR THE WHOLE ROW — the record's own column boundary, not two different ones.
          // The header line used to be its own `justify-between` flex, so the Reverse control was
          // pinned to the card's right edge (x=1385) while the evidence beneath it started at the
          // 24rem column (x=1010): two right-hand zones on one record, neither aligned to the other,
          // and a different horizontal rhythm on every row depending on which parts it carried.
          // Now both live in column two. LEFT is what moved and what was said about it; RIGHT is the
          // action, the money and the evidence. Below `lg` the two columns stack in reading order.
          <div key={r.id} className={`grid gap-x-6 gap-y-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] ${r.reversedAt ? "opacity-70" : ""}`}>
            <div className="min-w-0 space-y-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-[var(--ink)]">
                  {/* WHICH leg, before the code. Three sequences share this list, and "HRN-0004" only
                      reads as a return to somebody who already knows the prefixes. */}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${leg.tone}`}>
                    {leg.label}
                  </span>
                  <span className={`font-mono ${r.reversedAt ? "line-through opacity-60" : ""}`}>{r.code}</span>
                  {/* The DATE is the second thing scanned on a chronological list and it was drawn in
                      the same weight as the "recorded by" line beneath it. Tabular figures so the
                      column of dates lines up down the list instead of jittering per glyph width. */}
                  <span className="font-medium tabular-nums text-[var(--muted)]">{dateOnly(r.deliveryDate)}</span>
                  {r.reversedAt && (
                    <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                      Reversed
                    </span>
                  )}
                  {/* `/10` + `font-bold`, matching the leg badge beside it. At `/12` + `extrabold`
                      this one chip out-shouted the DELIVERED/RETURNED badge that classifies the whole
                      record, which inverted the reading order of the line. */}
                  {r.direction !== "damage" && r.condition === "damaged" && (
                    <span className="rounded-full bg-[var(--neg)]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--neg)]">
                      Damaged
                    </span>
                  )}
                </p>
                {/* `--muted`, not `--faint`. This is the WHO of the record — the line an argument with
                    the provider turns on — and at #a1a1aa on white it sat around 2.3:1, under half of
                    the 4.5:1 body-text floor. `--muted` clears it at ~4.8:1 and still reads as
                    secondary against the `--ink` line above. Same change on every metadata line in
                    this panel; none of them is decoration. */}
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  {[
                    r.receivedBy && `${r.direction === "out" ? "handed over by" : "recorded by"} ${r.receivedBy}`,
                    r.carrier && `${r.direction === "out" ? "collected by" : "carrier"} ${r.carrier}`,
                    r.deliveryNoteRef && `their note ${r.deliveryNoteRef}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>

              <ul className="space-y-1.5">
                {r.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-[var(--muted)]">
                    {/* The QUANTITY is the value on this line somebody came to read, and it was set in
                        the same weight as the words around it — "new testig rental fiber — 100 of 100"
                        with nothing to fix the eye on. Name and figure now carry different weights, and
                        the figure is tabular so a column of them aligns. */}
                    <span className="font-semibold wrap-break-word text-[var(--ink)]">{l.itemName}</span>
                    <span className="text-[var(--faint)]">—</span>
                    <span className="font-bold tabular-nums text-[var(--ink)]">
                      {l.receivedQuantity}
                      {/* A damage report is not "n of the order" — the ordered figure means nothing to it.
                          The others count against what the hire will EVER hold, taken LIVE from the order
                          rather than from this line's `orderedQuantity` snapshot: a short close after the
                          note was written makes that snapshot include units nobody is waiting for. */}
                      {r.direction !== "damage" && (
                        <span className="font-normal text-[var(--muted)]">
                          {` of ${netOrderedByHireLine.get(l.purchaseOrderRentalLineId) ?? l.orderedQuantity}`}
                        </span>
                      )}
                    </span>
                    {r.direction !== "damage" && l.previouslyReceived > 0 && (
                      <span className="text-[var(--muted)]">({l.previouslyReceived} before this)</span>
                    )}
                    {/* COLOURED TEXT, not a pill. A line already carrying a name, a quantity and
                        a denominator does not need two more filled shapes on it — the pills read
                        as badges of state when they are simply more of the sentence. The `--neg`
                        stays, because damaged units are the one fact here that changes what is
                        owed. */}
                    {r.direction !== "damage" && l.damagedQuantity > 0 && (
                      <span className="font-semibold text-[var(--neg)]">
                        · {l.damagedQuantity} {leg.quantityLabel}
                      </span>
                    )}
                    {/* WHAT THEY ARE CHARGING for it. Beside the units rather than under the note,
                        because a charge is only ever argued at item level: "£450 on this note" is not
                        a claim, "£450 for the tester" is.
                        NEUTRAL, and that is the point: a charge already agreed is settled money, not
                        an outstanding warning. Amber belongs on the note-level box below, which is
                        the one that says a figure is still MISSING. */}
                    {l.damageCharge != null && (
                      <span className="text-[var(--muted)]">
                        · <span className="font-semibold tabular-nums text-[var(--ink)]">{formatMoney(l.damageCharge)}</span> charged
                      </span>
                    )}
                    {/* The supplier's own tags. At collection the only question is whether these are the
                        units they handed over, so they are shown, not buried. */}
                    {l.assetTags.length > 0 && (
                      <span className="font-mono text-[10px] text-[var(--muted)]">{l.assetTags.join(", ")}</span>
                    )}
                    {l.notes && <span className="text-[var(--muted)]">· {l.notes}</span>}
                  </li>
                ))}
              </ul>

                {r.reversedAt && (
                  <p className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
                    Reversed{r.reversedBy ? ` by ${r.reversedBy}` : ""} — {r.reversalReason || "no reason recorded"}. Its quantities
                    were given back; the record is kept so the change is readable.
                  </p>
                )}

                {/* A quoted line, NOT a bordered box on a filled background: that treatment is what an
                    input looks like on every other screen here, and somebody reading a record they cannot
                    edit should not be invited to type into it. */}
                {r.conditionNotes && (
                  <p className="border-l-2 border-[var(--border)] pl-2.5 text-[11px] leading-relaxed text-[var(--muted)]">
                    <span className="font-bold uppercase tracking-wider text-[var(--muted)]">Condition</span>{" "}
                    {r.conditionNotes}
                  </p>
                )}
              </div>

              <div className="min-w-0 space-y-3">
              {/* THE BUTTON, OR WHY THERE ISN'T ONE. A control that silently vanishes reads as a
                  missing feature and sends somebody looking for a step that does not exist — and the
                  reasons here are all things they can act on ("reverse the return first"), so the
                  sentence is worth more than the space it costs. Only shown to the people who would
                  have had the button: to everyone else its absence is a permission, not a puzzle. */}
              {canReverse &&
                !r.reversedAt &&
                (blockedReason(r) === null ? (
                  <button
                    type="button"
                    onClick={() => {
                      setReversing(r);
                      setReason("");
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:border-[var(--neg)] hover:text-[var(--neg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--neg)]/40"
                  >
                    <Undo2 className="h-3.5 w-3.5" aria-hidden /> Reverse
                  </button>
                ) : (
                  // A STATE, drawn like one. It occupies the button's slot, so as loose right-aligned
                  // grey text at 2.3:1 it read as a stray caption floating a screen-width from the
                  // record it describes. The chip says it belongs where the control would have been,
                  // and `--muted` makes it legible enough to act on.
                  <p className="max-w-[18rem] shrink-0 rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--muted)]">
                    Can&apos;t be reversed — {blockedReason(r)}.
                  </p>
                ))}
                {/* THE MONEY LINE, and the one action that can still be taken on a written note.
                    A damage charge is the only value here that does not need a reversal to change: every
                    quantity feeds a running total on the hire line, so editing one would leave a stored
                    figure disagreeing with the records it summarises — a charge feeds nothing. It works
                    that way because of WHEN money arrives: the damage is written down the day it is
                    found, the supplier's quote comes the following week.
                    Shown on the legs where the damage is OURS. An arrival's damage is the supplier's own
                    fault, evidenced on their own note, and the service refuses a charge against it. */}
                {r.direction !== "in" && !r.reversedAt && damagedUnits(r) > 0 && (
                  // The dashed outline stays — it is a slot awaiting a figure, not a record — but the
                  // wrapper is now a two-line block rather than a flat `justify-between` row. Squeezed
                  // into the right column the label and its button were being pushed apart to opposite
                  // edges of a 24rem box; stacked, the action sits directly under the sentence that
                  // explains it, which is what "row actions belong beside their row" means here.
                  <div className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-2">
                    <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                      {r.damageChargeTotal == null ? (
                        // Not "£0.00". A note awaiting a quote and one the supplier settled for nothing
                        // are different facts, and only one of them is somebody's job to chase.
                        <span className="font-semibold text-[var(--warn,#d97706)]">No damage charge recorded yet</span>
                      ) : (
                        <>
                          Damage charge{" "}
                          <span className="font-extrabold tabular-nums text-[var(--ink)]">{formatMoney(r.damageChargeTotal)}</span>
                          {r.damageChargeRef && <span className="text-[var(--muted)]"> · their ref {r.damageChargeRef}</span>}
                        </>
                      )}
                    </p>
                    {canReverse && (
                      <button
                        type="button"
                        onClick={() => openCharge(r)}
                        className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
                      >
                        <Receipt className="h-3.5 w-3.5" aria-hidden /> {r.damageChargeTotal == null ? "Record charge" : "Update charge"}
                      </button>
                    )}
                  </div>
                )}

                {/* The SAME list the movement form stages photos in and the goods receipt files its
                    documents in: a row per file, name as the link, trash on the right.
                    It began as filename chips with a crossed-out-image glyph for "remove" — a control
                    nobody could guess at — then became a 4:3 thumbnail grid, which at a quarter of a wide
                    container gave ONE photo a ~380x285 tile and made six of them unreadable. The row
                    keeps the small preview from that second attempt, because condition evidence is the
                    thing here somebody actually needs to LOOK at and a filename is not a photograph. */}
                <div>
                  <AttachmentList
                    // INLINE when there is nothing to show. The block empty state is a full-width dashed
                    // box with `py-6` padding, and this panel is full-bleed — so on a 1440px order it
                    // drew a ~1300x60px empty rectangle saying "No condition photos on this record."
                    // That single element is the largest piece of blank canvas on the page. The sentence
                    // is worth keeping (nobody can photograph an arrival after the van has gone), the
                    // rectangle is not.
                    emptyVariant="inline"
                    items={r.attachments.map((a) => ({
                      id: a.id,
                      fileName: a.fileName,
                      fileType: a.fileType,
                      fileSizeBytes: a.fileSizeBytes,
                      src: a.url,
                    }))}
                    // Said out loud when there are none, because it cannot be fixed later: nobody can
                    // photograph an arrival after the van has gone.
                    emptyLabel="No condition photos on this record."
                    onRemove={canCurate && !r.reversedAt ? (attachmentId) => removePhoto(r.id, attachmentId) : undefined}
                    // Evidence for a claim against the supplier, and unrepeatable — nobody can
                    // photograph an arrival after the van has gone. It used to delete on the click.
                    removePrompt={{
                      title: "Remove condition photo",
                      message: "Remove this photo from the record? Condition evidence can't be recaptured once the delivery has gone.",
                    }}
                  />
                </div>
              </div>
          </div>
          );
        })}
      </div>

      <Modal open={Boolean(charging)} onClose={() => setCharging(null)} title="Damage charge">
        <div className="space-y-3">
          <p className="text-xs text-[var(--muted)]">
            What the supplier is charging us for the damage on{" "}
            <strong className="font-mono text-[var(--ink)]">{charging?.code}</strong>. Leave a box empty
            if nothing has been quoted yet — that is recorded as{" "}
            <strong className="text-[var(--ink)]">not known</strong>, which is not the same as £0.00.
          </p>
          {charging?.lines
            .filter((l) => l.damagedQuantity > 0)
            .map((l) => (
              <label key={l.id} className="block">
                <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
                  {l.itemName}{" "}
                  <span className="font-normal text-[var(--faint)]">
                    · {l.damagedQuantity} damaged
                    {l.assetTags.length > 0 && ` · ${l.assetTags.join(", ")}`}
                  </span>
                </span>
                <NumberInput
                  className={inputCls}
                  min="0"
                  step="0.01"
                  value={chargeLines[l.purchaseOrderRentalLineId] ?? ""}
                  placeholder="Not known yet"
                  onChange={(e) =>
                    setChargeLines((prev) => ({ ...prev, [l.purchaseOrderRentalLineId]: e.target.value }))
                  }
                />
              </label>
            ))}
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
              Supplier&apos;s quote / invoice reference
            </span>
            <input
              className={inputCls}
              value={chargeRef}
              maxLength={60}
              placeholder="Their document number"
              onChange={(e) => setChargeRef(e.target.value)}
            />
          </label>
          {/* Said plainly, because this is the ONE thing on a movement note that can be changed
              without reversing it, and somebody who has learned that rule deserves to know why it
              does not apply here. Every change is on the order's Audit Trail with both figures. */}
          <p className="text-[11px] text-[var(--faint)]">
            The units on this record are not affected — a charge moves no equipment. Each change is
            recorded on the order&apos;s audit trail with the old figure beside the new one.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setCharging(null)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doRecordCharge}
              disabled={busy}
              className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Save charge
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(reversing)}
        // Names WHAT is being reversed, like every other confirm in the app ("Cancel goods receipt",
        // "Delete rental item", "Mark hire returned") — and the button is then the bare verb, so the
        // two do not say the same words twice.
        title="Reverse hire movement"
        confirmLabel="Reverse"
        danger
        busy={busy}
        onClose={() => setReversing(null)}
        onConfirm={doReverse}
        message={
          <>
            Reverse <strong className="text-[var(--ink)]">{reversing?.code}</strong>?{" "}
            {reversing ? legOf(reversing.direction).reversalNote : ""}
          </>
        }
        field={
          <>
            {/* Required, not decorative: reversing rewrites how much of a hire moved, and "why" is the
                only thing that makes that readable a month later. A TEXTAREA with the house
                placeholder, matching the reason dialogs on the purchase order and the goods receipt. */}
            <textarea
              className={inputCls}
              rows={3}
              value={reason}
              maxLength={500}
              placeholder="Reason (required)"
              onChange={(e) => setReason(e.target.value)}
            />
            {/* The reassurance, kept OUT of the paragraph above: it is the same on all three legs, so
                repeating it inside the per-leg sentence made a two-line question read as four. */}
            <p className="mt-1.5 text-[11px] text-[var(--faint)]">
              The record is kept and marked reversed — nothing is deleted.
            </p>
          </>
        }
      />
    </>
  );
}

/** How many units this note says are damaged — what decides whether a charge can exist on it. */
function damagedUnits(r: RentalReceipt): number {
  return r.lines.reduce((sum, l) => sum + l.damagedQuantity, 0);
}

/**
 * Header for the panel, so the section reads as one thing on the order.
 *
 * Title, count, subtitle — the same three parts every section header on this tab now carries. The
 * icon went for the reason the Damage & loss one did: it decorated a heading that already named
 * itself, and the two sections have to read as siblings.
 */
export function HireDeliveriesHeading({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-extrabold text-[var(--ink)]">Hire movements</h3>
      {/* The house COUNT PILL, not a loose number. It read as a stray digit trailing the heading —
          indistinguishable from a footnote marker — where every other count in the app wears this
          shape. Geometry comes from the shared constant; the quiet tone is this surface's own. */}
      {count > 0 && (
        <span className={`${countPillCls} bg-[var(--surface-2)] text-[var(--muted)]`}>{count}</span>
      )}
    </div>
  );
}
