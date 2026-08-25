"use client";

// JobScanPanel — per-job scan panel for the Goods Management tab.
// Supports:
//   - Goods Out (issue): scan IRM/customer item → editable qty (capped at remainingIssuable) → Post
//   - Goods In (return): scan item → split the held qty into Good + Damaged portions (each its own
//     stepper, together ≤ held) → damaged portion requires a photo + reason → Post
//   - Close & Reconcile: surfaces any unaccounted items; confirms write-off if needed.

import * as React from "react";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  ImageUp,
  Loader2,
  PackageMinus,
  PackagePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { WriteOffLostModal, type WriteOffTarget } from "./WriteOffLostModal";
import { useDashboard } from "@/hooks/useDashboard";
// The shared calendar-day formatter, NOT a private copy. A hire date is a calendar day stored at UTC
// midnight, so it has to be rendered in UTC or every viewer behind it sees the day before — and on a
// return deadline that is the one number that must not be wrong. That rule now lives in one place,
// with its own tests, rather than being restated wherever a hire date happens to be printed.
import { formatCalendarDay } from "@/lib/formatDate";
import { readFileAsDataUrl, shrinkImage } from "@/lib/image";
import { ScannerInput } from "./ScannerInput";
import { defaultScanDirection, scanDirections } from "./scanDirections";
import { hireList } from "./hireOutstanding";
import { capOf, collapsesByDefault, expandMatch, groupLines, postableLines, stageScan, type ScanLine } from "./scanStaging";
import type {
  CloseReconcileResult,
  MovementLinePayload,
  QueueKitLine,
  ScanMatch,
} from "@/types/goodsManagement";
import { DeclareHireLostModal, type DeclareHireLostTarget } from "@/components/dashboard/rentals/DeclareHireLostModal";
import { canSettleHires } from "@/components/dashboard/rentals/hireActions";
import { useAuth } from "@/hooks/useAuth";
import { inputCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import { QtyStepper } from "@/components/ui/QtyStepper";
import { uploadDirectForUrl } from "@/lib/upload";

// ── Local types ───────────────────────────────────────────────────────────────

type Direction = "issue" | "return";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Total being returned for a line = good + damaged.
function returnTotal(l: ScanLine) {
  return l.goodQty + l.damagedQty;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function JobScanPanel({
  jobId,
  jobNumber,
  jobName,
  jobStatus,
  warehouseId,
  miscLines = [],
  onBack,
}: {
  jobId: string;
  jobNumber: string;
  jobName: string;
  jobStatus: string;
  warehouseId: string;
  miscLines?: QueueKitLine[]; // free-text kit lines — issued by count (no barcode)
  onBack: () => void;
}) {
  const { pushToast } = useDashboard();

  // A cancelled job is return-only — see scanDirections. Computed once at mount: the panel is keyed by
  // job, so a different job remounts it rather than needing this to track a changing prop.
  const directions = scanDirections(jobStatus);
  const [direction, setDirection] = React.useState<Direction>(() => defaultScanDirection(jobStatus));
  const [lines, setLines] = React.useState<ScanLine[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [reconciling, setReconciling] = React.useState(false);

  const { can } = useAuth();
  // Declaring hired kit lost is a HIRE settlement decision, not a goods-management one — it commits us
  // to a conversation with the provider about their equipment. A reconciler without that authority
  // still sees exactly what is outstanding; they just cannot make that call from here.
  const canDeclareLost = canSettleHires(can);

  // ── Reconcile result ──────────────────────────────────────────────────────
  // Two pools, two states, because they have two different exits: company/customer shortfall is written
  // off as our loss, hired kit is declared lost against its hire and settled with the provider. A job
  // can be holding both at once, so neither may stand in for the other.
  const [rentalOutstanding, setRentalOutstanding] = React.useState<CloseReconcileResult["rentalOutstanding"]>([]);
  const [lostTarget, setLostTarget] = React.useState<DeclareHireLostTarget | null>(null);

  /**
   * Every outstanding hire on this job, flattened — what the one Declare lost button acts on.
   *
   * Flattened because the button is ONE action for the whole panel, exactly as the write-off beside it
   * is: the dialog asks which hire when there is more than one, so the panel itself does not have to
   * grow a button per row and stop looking like its twin.
   *
   * A row whose units cannot be traced to a hire contributes nothing here — there is no order to post
   * against — which is why the panel checks this rather than `rentalOutstanding` before offering the
   * action, and says so when the list comes back empty.
   */
  const declarableHires = React.useMemo(
    () =>
      rentalOutstanding.flatMap((r) =>
        r.engineerId
          ? r.hires.map((h) => ({
              purchaseOrderId: h.purchaseOrderId,
              lineId: h.purchaseOrderRentalLineId,
              poCode: h.poCode ?? "",
              itemName: r.itemName,
              qty: h.qty,
              // The units out on THIS job are out with THIS job's engineer — there is no one else it
              // could be, so the dialog never has to ask.
              holders: [{ engineerId: r.engineerId!, engineerName: r.engineerName ?? "This job's engineer", quantity: h.qty }],
            }))
          : [],
      ),
    [rentalOutstanding],
  );
  const [unaccounted, setUnaccounted] = React.useState<
    { itemName: string; itemCode: string | null; qty: number }[] | null
  >(null);
  // The modal owns confirmation now; this just says which job it is confirming for.
  const [writeOffTarget, setWriteOffTarget] = React.useState<WriteOffTarget | null>(null);

  // Damage-photo picker refs (one per line, managed by key via Map)
  const photoRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());

  // ── Direction toggle clears the scan list ─────────────────────────────────
  const setDir = (d: Direction) => {
    setDirection(d);
    setLines([]);
    setUnaccounted(null);
    setRentalOutstanding([]);
    // The overrides describe groups that no longer exist. Keyed by kit line, they would otherwise
    // survive into the other direction — where the same line means different hires — and arrive
    // collapsed for no reason the operator can see.
    setOpenGroups({});
  };

  // ── Scan handler ──────────────────────────────────────────────────────────
  // ⚠️ These scan rules are MIRRORED in van-requests/VanRequestDetail.tsx `onScan` (the non-job van
  // stock flow): in-flight guard → dead-scan message → re-scan bumps qty → otherwise stage a new line.
  // Its good/damaged split + evidence-clearing mirror `setPortion` below. The BEHAVIOUR is shared; the
  // CODE is not — VSR sits on a different document (a VSR line, not a job kit line) and has no
  // issue/return toggle or misc no-barcode lines, so a shared hook would leak. If you change the
  // scan/split rules HERE, change them THERE too. (ScannerInput itself is already shared by both.)
  //
  // The one rule that is NOT mirrored is the rental fan-out below — one scan staging a card per hire.
  // A VSR moves owned van stock, which sits on no order and has no hire to be credited to, so there is
  // nothing there for it to fan out over. Everything else — the in-flight guard, the dead-scan
  // message, the re-scan bump, the good/damaged split — behaves exactly as it does there.
  const onCode = async (code: string) => {
    if (scanning) return;
    setScanning(true);
    try {
      const match = await gmService.scanLookup(jobId, direction, code, warehouseId);
      const isIssue = direction === "issue";

      // Nothing left to move for this item — block it here (before it can be added) with a clear
      // message, instead of letting the user build a line that the backend would reject on Post.
      const staged = expandMatch(match, isIssue).filter((m) => capOf(m, isIssue) > 0);
      if (staged.length === 0) {
        pushToast(
          isIssue
            ? `${match.itemName} is already fully issued — nothing left to issue.`
            : `${match.itemName} has nothing left to return — the engineer isn't holding any.`,
          "alert",
        );
        return;
      }

      const now = Date.now();
      setLines((prev) => stageScan(prev, staged, isIssue, now));
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not look up that code.",
        "alert",
      );
    } finally {
      setScanning(false);
    }
  };

  // ── Line editing helpers ──────────────────────────────────────────────────
  const updateLine = (key: string, patch: Partial<ScanLine>) =>
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );

  const removeLine = (key: string) =>
    setLines((prev) => prev.filter((l) => l.key !== key));

  // Issue qty: clamp to 0..remainingIssuable.
  //
  // Zero is a REAL value here, not a floor to be snapped away from. One scan now stages a card per
  // hire, so a card can be one the operator never asked for — and with a minimum of 1 an accidental
  // "+" on the wrong hire could not be undone except by deleting the card, which is not where anyone
  // looks. That issued a unit off a PO the job never needed, carrying its own return deadline.
  // `postableLines` drops a zero card, so it costs nothing to allow.
  const setIssueQty = (key: string, next: number) =>
    setLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, qty: clamp(next, 0, l.match.remainingIssuable) } : l,
      ),
    );

  // Return portion (good/damaged): clamp to 0..(held − other portion). When the damaged portion
  // drops to 0, clear its photo/reason so a stale photo can't be posted.
  const setPortion = (key: string, field: "goodQty" | "damagedQty", next: number) =>
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const other = field === "goodQty" ? l.damagedQty : l.goodQty;
        const val = clamp(next, 0, Math.max(0, l.match.heldByEngineer - other));
        const patch: Partial<ScanLine> = { [field]: val };
        if (field === "damagedQty" && val === 0) {
          patch.damagePhotoDataUrl = undefined;
          patch.damagePhotoUrl = undefined;
          patch.damagePhotoUploading = undefined;
          patch.damageReason = undefined;
        }
        return { ...l, ...patch };
      }),
    );

  // ── Add a misc kit line (no barcode — issued by count) ────────────────────
  const addMisc = (k: QueueKitLine) => {
    const remaining = k.plannedQty - k.issuedQty;
    if (remaining <= 0) return;
    if (lines.some((l) => l.match.jobKitLineId === k.id)) {
      pushToast(`${k.itemName} is already in the list.`, "alert");
      return;
    }
    const match: ScanMatch = {
      source: "misc",
      jobKitLineId: k.id,
      itemName: k.itemName,
      uom: null,
      plannedQty: k.plannedQty,
      alreadyIssued: k.issuedQty,
      remainingIssuable: remaining,
      heldByEngineer: 0, // misc lines aren't stock-tracked, so they're never returned here
      available: 0,
    };
    setLines((prev) => [
      ...prev,
      { key: `misc-${k.id}-${Date.now()}`, match, qty: 1, goodQty: 0, damagedQty: 0 },
    ]);
  };

  // ── Damage photo pick ─────────────────────────────────────────────────────
  const onPhotoChange = async (
    key: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-picked if needed.
    const input = photoRefs.current.get(key);
    if (input) input.value = "";
    // Downscale once, then use that file for both the preview and the upload — an engineer on a
    // phone would otherwise base64 a multi-MB capture into state just to render a thumbnail.
    const photo = await shrinkImage(file);
    let dataUrl: string;
    try {
      dataUrl = await readFileAsDataUrl(photo);
    } catch {
      pushToast("Could not read the photo.", "alert");
      return;
    }
    // Show preview immediately; mark upload in-flight.
    updateLine(key, {
      damagePhotoDataUrl: dataUrl,
      damagePhotoUrl: undefined,
      damagePhotoUploading: true,
    });
    try {
      const hostedUrl = await uploadDirectForUrl({ purpose: "damage_photo", file: photo });
      updateLine(key, { damagePhotoUrl: hostedUrl, damagePhotoUploading: false });
    } catch (err) {
      // Clear the preview so the user knows the upload failed and must re-pick.
      updateLine(key, {
        damagePhotoDataUrl: undefined,
        damagePhotoUrl: undefined,
        damagePhotoUploading: false,
      });
      pushToast(
        err instanceof Error ? err.message : "Could not upload the damage photo.",
        "alert",
      );
    }
  };

  // Movement lines that WILL be posted (issue → one per line; return → up to two per line).
  // A card sitting at zero contributes none — see postableLines for why that has to be allowed.
  const postLineCount =
    direction === "issue"
      ? postableLines(lines, true).length
      : lines.reduce(
          (n, l) => n + (l.goodQty > 0 ? 1 : 0) + (l.damagedQty > 0 ? 1 : 0),
          0,
        );
  const canPost = postLineCount > 0;

  // ── Post movement ─────────────────────────────────────────────────────────
  const onPost = async () => {
    // The count that MATTERS, not the card count — a list of cards all sitting at zero posts nothing.
    // The button is already disabled on it; this is the same rule where the work is done.
    if (postLineCount === 0) {
      pushToast(
        lines.length === 0
          ? "Scan at least one item."
          : direction === "issue"
            ? "Set a quantity on at least one line before posting."
            : "Set a return quantity on at least one line before posting.",
        "alert",
      );
      return;
    }
    if (direction === "return") {
      // Only the cards being POSTED are validated. A card left at zero is one the operator declined —
      // the panel offers a card per hire from a single scan, so demanding a quantity on every one of
      // them would make a two-hire scan unpostable whenever only one hire's units came back.
      for (const l of postableLines(lines, false)) {
        if (l.damagedQty > 0) {
          if (l.damagePhotoUploading) {
            pushToast(`${l.match.itemName}: photo upload still in progress — please wait.`, "alert");
            return;
          }
          if (!l.damagePhotoUrl) {
            pushToast(`${l.match.itemName}: a damage photo is required for the damaged units.`, "alert");
            return;
          }
          if (!l.damageReason?.trim()) {
            pushToast(`${l.match.itemName}: a damage reason is required for the damaged units.`, "alert");
            return;
          }
        }
      }
    }
    setPosting(true);
    try {
      let payload: MovementLinePayload[];
      if (direction === "issue") {
        payload = postableLines(lines, true).map((l) => ({
          source: l.match.source,
          irmItemId: l.match.irmItemId,
          customerStockEntryId: l.match.customerStockEntryId,
          rentalItemId: l.match.rentalItemId,
          // Echoed back exactly as the scan resolved it: the server picked the hire whose deadline is
          // soonest, and posting without it would leave the units belonging to no particular hire.
          purchaseOrderRentalLineId: l.match.purchaseOrderRentalLineId,
          jobKitLineId: l.match.jobKitLineId,
          qty: l.qty,
        }));
      } else {
        // Each returned item can split into a Good line and a Damaged line.
        payload = [];
        for (const l of postableLines(lines, false)) {
          const base = {
            source: l.match.source,
            irmItemId: l.match.irmItemId,
            customerStockEntryId: l.match.customerStockEntryId,
            rentalItemId: l.match.rentalItemId,
            purchaseOrderRentalLineId: l.match.purchaseOrderRentalLineId,
            jobKitLineId: l.match.jobKitLineId,
          };
          if (l.goodQty > 0) {
            payload.push({ ...base, qty: l.goodQty, condition: "good" });
          }
          if (l.damagedQty > 0) {
            payload.push({
              ...base,
              qty: l.damagedQty,
              condition: "damaged",
              damagePhotoUrl: l.damagePhotoUrl,
              damageReason: l.damageReason,
            });
          }
        }
      }

      if (direction === "issue") {
        await gmService.postIssue(jobId, { warehouseId, lines: payload });
        pushToast("Stock issued successfully.", "success");
      } else {
        await gmService.postReturn(jobId, { warehouseId, lines: payload });
        pushToast("Return posted successfully.", "success");
      }
      setLines([]);
      setOpenGroups({}); // same reason as setDir — the groups these overrides describe are gone
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not post the movement.",
        "alert",
      );
    } finally {
      setPosting(false);
    }
  };

  // ── Close & reconcile ─────────────────────────────────────────────────────
  // Preview only. Anything still held comes back as `unaccounted` and the job stays open; writing it
  // off is a separate, deliberate step through WriteOffLostModal.
  const onReconcile = async () => {
    setReconciling(true);
    try {
      const result = await gmService.closeReconcile(jobId);
      // HIRED KIT FIRST, and before any success is claimed. It never lands in `unaccounted` — a hire is
      // the provider's equipment, so it is never written off as our loss — and the request succeeds
      // whatever else it wrote. But the job did NOT close, and reporting otherwise sent the operator
      // back to a queue where it was still sitting open with a green toast behind them.
      //
      // Rendered as a PANEL, not a toast, for the same reason the unaccounted list below is one: the
      // next move is a decision, and a decision needs the numbers to stay on screen while it is made.
      // A toast told the operator to declare it lost and then vanished, with the only button that does
      // that sitting four clicks away on the warehouse's hire pane.
      //
      // BOTH PANELS, ALWAYS — the two lists are different ownership domains and neither waits on the
      // other. `closeReconcile` was deliberately changed to stop an outstanding hire refusing a
      // write-off of COMPANY stock (see its comment: "ownership domains reconcile independently"), and
      // it returns both lists in the same response. Returning early on the rental one threw the other
      // half away, so the operator with hired kit still out could not book the shortfall on their own
      // items from the panel they were standing in — the server's decoupling undone on the client.
      setRentalOutstanding(result.rentalOutstanding);
      setUnaccounted(result.unaccounted.length > 0 ? result.unaccounted : null);
      // Neither list empty-handed means the job did NOT close, whichever list it was — no success
      // toast, and no sending the operator back to a queue where it is still sitting open.
      if (result.rentalOutstanding.length > 0 || result.unaccounted.length > 0) return;
      pushToast("Job reconciled — stock balanced.", "success");
      onBack();
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : "Could not reconcile this job.",
        "alert",
      );
    } finally {
      setReconciling(false);
    }
  };

  // ── Grouping: one item's hires under one heading ──────────────────────────
  //
  // Open/closed is stored as an OVERRIDE rather than as the state itself, so a group that grows past
  // the threshold on the next scan folds itself without an effect having to notice. Nothing is seeded,
  // nothing is cleaned up when a group disappears, and the default is a pure function of the size.
  const groups = React.useMemo(() => groupLines(lines, direction === "issue"), [lines, direction]);
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({});
  const isOpen = (g: { key: string; lines: unknown[] }) => openGroups[g.key] ?? !collapsesByDefault(g.lines.length);

  // ── One staged card ───────────────────────────────────────────────────────
  // Hoisted out of the list so the list itself can group by kit line (see groupLines): a card is
  // the same thing whether it stands alone or sits inside a multi-hire group.
  const renderCard = (line: ScanLine) => {
    const held = line.match.heldByEngineer;
    const total = returnTotal(line);
    // Where this card sits among the hires the scan resolved to — see the badge below.
    const hireCount = line.match.hires?.length ?? 0;
    // Whether this card is one of several for the same item — see the zero-total copy below.
    const inHireGroup = hireCount > 1;
    // How a screen reader names this card's steppers. The item alone is not enough once a scan fans
    // out: a return group renders two number inputs per hire, all under the same item name, and the PO
    // is the only thing that says which hire the reader is standing on.
    const cardLabel =
      inHireGroup && line.match.hire?.poCode
        ? `${line.match.itemName} on ${line.match.hire.poCode}`
        : line.match.itemName;
    const hireIndex =
      (line.match.hires?.findIndex(
        (h) => h.purchaseOrderRentalLineId === line.match.purchaseOrderRentalLineId,
      ) ?? -1) + 1;
    return (
      <div
        key={line.key}
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-bold text-[var(--ink)]">
              {line.match.itemName}
            </p>
            <p className="text-xs text-[var(--muted)]">
              {direction === "issue" ? (
                <>
                  Planned:{" "}
                  <span className="font-semibold">
                    {line.match.plannedQty}
                  </span>
                  {" · "}Remaining:{" "}
                  <span
                    className={
                      line.match.remainingIssuable <= 0
                        ? "font-bold text-[var(--neg)]"
                        : "font-semibold"
                    }
                  >
                    {line.match.remainingIssuable}
                  </span>
                  {/* Misc lines have no stock — only real items show warehouse availability. */}
                  {line.match.source !== "misc" && (
                    <>
                      {" · "}Available:{" "}
                      <span
                        className={
                          line.match.available <= 0
                            ? "font-bold text-[var(--neg)]"
                            : "font-semibold"
                        }
                      >
                        {line.match.available}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <>
                  Held:{" "}
                  <span className="font-semibold">{held}</span>
                </>
              )}
            </p>
            {/* Which hire is being handed over, and when it has to come back.
                A rental is the only thing on a kit list with a deadline attached, and the
                person physically passing the case across the counter is the last one who can
                still pick a different unit — so the order and the date belong here, not only
                on the hire register nobody has open at that moment. */}
            {line.match.source === "rental" && line.match.hire && (
              <p
                className={`mt-0.5 text-[11px] ${
                  line.match.hire.overdue ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"
                }`}
              >
                Hire {line.match.hire.poCode ?? "—"}
                {line.match.hire.hireEndDate ? (
                  <>
                    {/* This now only ever fires on a RETURN. An expired hire is refused on the
                        way out — by the availability query, by the allocator's candidate list
                        and by the conditional write itself — so an issue scan can no longer
                        resolve one. On a return it is the good news, and saying which hire the
                        scan clears is the whole point of printing it here.

                        It used to fire on both legs, deliberately: the rule was "called out
                        rather than blocked", on the reasoning that the job might genuinely need
                        the kit today and the return trip was a separate logistics problem. It
                        is not separate — the unit the provider is waiting to collect walks out
                        of the building and the breach is already being billed. Extending the
                        hire is the sanctioned way to use it again. */}
                    {line.match.hire.overdue ? " · WAS DUE BACK " : " · back by "}
                    <span className={line.match.hire.overdue ? "font-bold" : "font-semibold text-[var(--ink)]"}>
                      {formatCalendarDay(line.match.hire.hireEndDate)}
                    </span>
                    {line.match.hire.overdue ? " — already overdue for return to the provider" : null}
                  </>
                ) : null}
                {/* Say out loud that this card is one of several for the SAME item. Two cards
                    with the same name and different PO codes is the honest picture, but at a
                    counter it reads like a duplicate — and the operator who deletes the
                    "duplicate" has silently dropped a unit off the return. */}
                {hireCount > 1 ? (
                  <span className="text-[var(--faint)]">
                    {" · hire "}
                    {hireIndex}
                    {" of "}
                    {hireCount}
                    {" for this item"}
                  </span>
                ) : null}
              </p>
            )}
          </div>

          {/* Issue: single qty stepper in the header. Return: steppers move below. */}
          <div className="flex shrink-0 items-center gap-1">
            {direction === "issue" && (
              <QtyStepper
                value={line.qty}
                min={0}
                max={line.match.remainingIssuable}
                onChange={(v) => setIssueQty(line.key, v)}
                uom={line.match.uom}
                ariaLabel={`Quantity for ${cardLabel}`}
              />
            )}
            <button
              type="button"
              onClick={() => removeLine(line.key)}
              className="ml-2 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--faint)] transition-all hover:text-[var(--neg)]"
              title="Remove line"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Return-only: split into Good + Damaged portions */}
        {direction === "return" && (
          <div className="mt-3 space-y-2">
            {/* Good portion */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--pos)]">
                <CheckCircle2 className="h-4 w-4" />
                Good
              </span>
              <QtyStepper
                value={line.goodQty}
                min={0}
                max={held - line.damagedQty}
                onChange={(v) => setPortion(line.key, "goodQty", v)}
                uom={line.match.uom}
                ariaLabel={`Good quantity for ${cardLabel}`}
              />
            </div>

            {/* Damaged portion */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--neg)]">
                  <Trash2 className="h-4 w-4" />
                  Damaged
                </span>
                <QtyStepper
                  value={line.damagedQty}
                  min={0}
                  max={held - line.goodQty}
                  onChange={(v) => setPortion(line.key, "damagedQty", v)}
                  uom={line.match.uom}
                  ariaLabel={`Damaged quantity for ${cardLabel}`}
                />
              </div>

              {/* Damage details — only when there are damaged units */}
              {line.damagedQty > 0 && (
                <div className="mt-2 ml-1 space-y-2 border-l-2 border-[var(--neg)] pl-3">
                  {/* Photo */}
                  <div>
                    <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                      Damage photo <span className="text-[var(--neg)]">*</span>
                    </p>
                    {line.damagePhotoDataUrl ? (
                      <div className="flex items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={line.damagePhotoDataUrl}
                          alt="Damage preview"
                          className="h-16 w-24 rounded-lg object-cover border border-[var(--border)]"
                        />
                        {line.damagePhotoUploading ? (
                          <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Uploading…
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              updateLine(line.key, {
                                damagePhotoDataUrl: undefined,
                                damagePhotoUrl: undefined,
                              })
                            }
                            className="flex items-center gap-1 text-[11px] font-bold text-[var(--neg)] hover:underline"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          photoRefs.current.get(line.key)?.click()
                        }
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]"
                      >
                        <Camera className="h-3.5 w-3.5" />
                        <ImageUp className="h-3.5 w-3.5" />
                        Attach photo
                      </button>
                    )}
                    {/* Hidden file input */}
                    <input
                      ref={(el) => {
                        if (el) photoRefs.current.set(line.key, el);
                        else photoRefs.current.delete(line.key);
                      }}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      aria-hidden
                      tabIndex={-1}
                      onChange={(e) => onPhotoChange(line.key, e)}
                    />
                  </div>

                  {/* Reason */}
                  <div>
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                      Damage reason <span className="text-[var(--neg)]">*</span>
                    </label>
                    <input
                      type="text"
                      value={line.damageReason ?? ""}
                      onChange={(e) =>
                        updateLine(line.key, {
                          damageReason: e.target.value,
                        })
                      }
                      placeholder="Describe the damage…"
                      className={inputCls}
                      maxLength={500}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Total vs held helper */}
            {/* A card at zero is an OFFER THE OPERATOR DECLINED, not a mistake — one scan stages a card
                per hire, and a job whose units came back off only one of them leaves the rest at zero
                on purpose. Colouring that `--neg` and demanding a quantity told them to fix something
                that was already right, twice over on a three-hire scan. It only reads as an error when
                the card is the ONLY one for its item, where zero really does mean nothing was entered. */}
            <p className="text-[11px] text-[var(--faint)]">
              Returning{" "}
              <span
                className={
                  total === 0 && !inHireGroup
                    ? "font-bold text-[var(--neg)]"
                    : "font-bold text-[var(--ink)]"
                }
              >
                {total}
              </span>{" "}
              of <span className="font-semibold">{held}</span> held
              {total === 0 ? (inHireGroup ? " — not returning this hire" : " — set a quantity to return") : ""}
            </p>
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header — back to queue + the job this scan session is for */}
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Queue
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
            <ClipboardList className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-extrabold tracking-tight text-[var(--ink)]">{jobNumber}</h2>
            <p className="truncate text-xs text-[var(--muted)]">{jobName}</p>
          </div>
        </div>
      </div>

      {/* Direction — segmented control: Goods Out (issue) vs Goods In (return) */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-bold text-[var(--muted)]">Direction</span>
        {/* Says WHY there is only one option, without a paragraph explaining a button that isn't there. */}
        {directions.length === 1 && (
          <span className="rounded-full bg-rose-500/12 px-2.5 py-0.5 text-[11px] font-bold text-rose-600">Job cancelled</span>
        )}
        <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {directions.map((d) => {
            const Icon = d === "issue" ? PackageMinus : PackagePlus;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDir(d)}
                aria-pressed={direction === d}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold transition-all ${
                  direction === d
                    ? "bg-[var(--accent)] text-white shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {d === "issue" ? "Goods Out (Issue)" : "Goods In (Return)"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scanner input */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
          Scan item
        </p>
        <ScannerInput
          onCode={onCode}
          disabled={posting || scanning}
          placeholder={
            direction === "issue"
              ? "Scan or type an IRM code / barcode to issue…"
              : "Scan or type an IRM code / barcode to return…"
          }
        />
        {scanning && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Looking up…
          </div>
        )}
      </div>

      {/* Scanned lines */}
      {lines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
            Scanned items ({lines.length})
          </p>
          {groups.map((group) =>
            // A single card needs no chrome around it — that is every IRM, customer and misc line, and
            // a rental drawn off one hire. A group of several is one item split across hires, and gets a
            // header carrying the name and the running total, so the repeated item name below reads as a
            // breakdown rather than as duplicates.
            group.lines.length === 1 ? (
              <React.Fragment key={group.key}>{renderCard(group.lines[0])}</React.Fragment>
            ) : (
              <div key={group.key} className="space-y-3 rounded-2xl border border-[var(--border)] p-3">
                <button
                  type="button"
                  onClick={() =>
                    // Read the CURRENT value out of `prev`, not out of the render closure — two clicks
                    // batched into one render would otherwise both compute the same target and net to
                    // a single toggle.
                    setOpenGroups((prev) => ({
                      ...prev,
                      [group.key]: !(prev[group.key] ?? !collapsesByDefault(group.lines.length)),
                    }))
                  }
                  className="flex w-full items-center justify-between gap-3 text-left"
                  aria-expanded={isOpen(group)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-[var(--ink)]">{group.itemName}</span>
                    <span className="text-xs text-[var(--muted)]">
                      {group.lines.length} hires{" · "}
                      <span className="font-semibold text-[var(--ink)]">{group.staged}</span> of{" "}
                      <span className="font-semibold">{group.cap}</span>{" "}
                      {direction === "issue" ? "to issue" : "to return"}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[var(--faint)] transition-transform ${isOpen(group) ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen(group) && group.lines.map((line) => renderCard(line))}
              </div>
            ),
          )}
        </div>
      )}

      {/* Misc items — free-text, no barcode; add by count (below the scanned list) */}
      {direction === "issue" &&
        miscLines.filter((k) => k.plannedQty - k.issuedQty > 0 && !lines.some((l) => l.match.jobKitLineId === k.id)).length > 0 && (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
              Misc items (no barcode — add by count)
            </p>
            <div className="space-y-2">
              {miscLines
                .filter((k) => k.plannedQty - k.issuedQty > 0 && !lines.some((l) => l.match.jobKitLineId === k.id))
                .map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-[var(--ink)]">{k.itemName}</p>
                      <p className="text-xs text-[var(--muted)]">
                        Planned: <span className="font-semibold">{k.plannedQty}</span>
                        {" · "}Issued: <span className="font-semibold">{k.issuedQty}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => addMisc(k)}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-extrabold text-white transition-all hover:opacity-90"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onPost}
            disabled={posting || !canPost}
            className={primaryBtn}
          >
            {posting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {posting
              ? "Posting…"
              : direction === "issue"
                ? `Post issue (${postLineCount} line${postLineCount !== 1 ? "s" : ""})`
                : `Post return (${postLineCount} line${postLineCount !== 1 ? "s" : ""})`}
          </button>
        )}

        {/* Close & reconcile — only on the Return side; it's the closing step after stock comes back. */}
        {direction === "return" && (
          <button
            type="button"
            onClick={() => onReconcile()}
            disabled={reconciling || posting}
            className={secondaryBtn}
          >
            {reconciling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Close &amp; Reconcile
          </button>
        )}
      </div>

      {/* Hired kit still out — the rental TWIN of the unaccounted panel below, and deliberately the
          same panel down to the button classes. The operator meets one layout for "something did not
          come back"; only the exit differs, because a hire is the provider's equipment and is settled
          with them rather than written off as our shrinkage. Two different-looking panels for the same
          moment would read as two different features. */}
      {rentalOutstanding.length > 0 && (
        <div className="rounded-2xl border border-[var(--neg)] bg-[var(--surface)] p-5 space-y-3">
          <p className="text-sm font-extrabold text-[var(--neg)]">
            Hired kit still out
          </p>
          <p className="text-xs text-[var(--muted)]">
            This equipment belongs to the provider and is never written off as our loss. Scan it back
            in, or declare it lost against its hire — the job stays open until every unit is accounted
            for.
          </p>
          <ul className="space-y-1">
            {rentalOutstanding.map((r, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-[var(--ink)]">
                  {r.itemName}
                </span>
                <span className="text-[var(--neg)] font-bold">
                  {r.qty} still out
                </span>
                {/* The order it sits on, on the SAME line rather than a sub-row: it is context for the
                    row, not a second item, and a nested list would break the shape this panel shares
                    with its twin. Absent when the units cannot be traced to a hire. */}
                {r.hires.length > 0 && (
                  <span className="font-mono text-xs text-[var(--muted)]">
                    {r.hires.map((h) => h.poCode ?? "—").join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* Untraceable units still have to be visible — hiding kit that is genuinely out is the worse
              failure — but nothing can be declared against a hire the records do not name. */}
          {declarableHires.length === 0 && rentalOutstanding.length > 0 && (
            <p className="text-[11px] text-[var(--faint)]">
              Scan these back in — this job&rsquo;s records do not say which hire they came off.
            </p>
          )}
          {!canDeclareLost && declarableHires.length > 0 && (
            <p className="text-[11px] text-[var(--faint)]">
              Declaring hired equipment lost needs hire-settlement access — ask whoever manages this
              warehouse&rsquo;s hires.
            </p>
          )}
          <div className="flex gap-2">
            {/* Hands off to the shared modal, which asks WHICH hire when there is more than one and
                takes the single one silently when there is not — the same "one action, one dialog"
                shape the write-off beside it uses. */}
            {canDeclareLost && declarableHires.length > 0 && (
              <button
                type="button"
                onClick={() => setLostTarget({ hires: declarableHires })}
                className="rounded-xl bg-[var(--neg)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
              >
                Declare lost
              </button>
            )}
            <button type="button" onClick={() => setRentalOutstanding([])} className={secondaryBtn}>
              Leave open
            </button>
          </div>
        </div>
      )}

      {/* Unaccounted items dialog */}
      {unaccounted !== null && unaccounted.length > 0 && (
        <div className="rounded-2xl border border-[var(--neg)] bg-[var(--surface)] p-5 space-y-3">
          <p className="text-sm font-extrabold text-[var(--neg)]">
            Unaccounted stock
          </p>
          <p className="text-xs text-[var(--muted)]">
            The following items were issued but not fully returned or consumed.
            You can write them off as lost or leave the job open.
          </p>
          <ul className="space-y-1">
            {unaccounted.map((u, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-[var(--ink)]">
                  {u.itemName}
                </span>
                <span className="text-[var(--neg)] font-bold">
                  {u.qty} unaccounted
                </span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            {/* Hands off to the shared modal, which shows the same list again alongside the REQUIRED
                reason. The Overdue tab uses the same component, so a write-off asks the same question
                wherever it is started — this panel used to confirm inline with no reason at all. */}
            <button
              type="button"
              onClick={() => setWriteOffTarget({ jobId, jobNumber, unaccounted })}
              className="rounded-xl bg-[var(--neg)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              Write off as lost
            </button>
            <button type="button" onClick={() => setUnaccounted(null)} className={secondaryBtn}>
              Leave open
            </button>
          </div>
        </div>
      )}

      <DeclareHireLostModal
        target={lostTarget}
        onClose={() => setLostTarget(null)}
        // Straight back into the reconcile the operator was already trying to finish. Declaring the
        // last outstanding unit lost is the step that unblocks the close, so making them press
        // Close & Reconcile again would be asking twice for one decision — and leaving the stale panel
        // on screen would show kit that is no longer out.
        onDone={() => {
          setLostTarget(null);
          void onReconcile();
        }}
      />

      <WriteOffLostModal
        target={writeOffTarget}
        onClose={() => setWriteOffTarget(null)}
        // The write-off is what it says on the tin; whether the JOB closed is a separate answer the
        // server gives back, because hired kit still out holds it open however the write-off went.
        onWrittenOff={(result) => {
          if (result.rentalOutstanding.length > 0) {
            // The write-off landed; the JOB did not close. Put the hired kit back on screen with its
            // actions rather than only saying so — the operator is mid-close and the next step is here.
            setUnaccounted(null);
            setRentalOutstanding(result.rentalOutstanding);
            pushToast(
              `Stock written off. Hired kit is still out: ${hireList(result.rentalOutstanding)}.`,
              "alert",
            );
            return;
          }
          pushToast("Job reconciled — stock written off as lost.", "success");
          onBack();
        }}
      />
    </div>
  );
}
