"use client";

import * as React from "react";
import { Check, ExternalLink, Loader2, MapPin, Plus, Search, Timer, Trash2 } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockFulfilment, VanStockItemOption, VanStockLine, VanStockLineSource, VanStockPriority, VanStockRequest } from "@/services/vanStockRequest.service";
import { CopyableCode } from "@/components/ui/CopyableCode";
import { useDashboard } from "@/hooks/useDashboard";
import { fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { WarehousePickupModal } from "@/components/dashboard/engineer/WarehousePickupModal";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls } from "@/components/ui/styles";
import { formatHireDate, vanStockItemKey } from "./vanStockLine";
import { VSR_STATUS } from "@/components/dashboard/engineer/EngineerVanStock";

// Shared presentational bits for the Field Stock (VSR) lists — used by BOTH the warehouse board and
// the engineer's own list so the two read as one system. Kept in a neutral module (not either list
// file) to avoid a circular import between them.

// The Field Stock priority scale, rendered identically by the engineer's composer, the counter's
// walk-in and the warehouse queue's filter. One list, because three copies is how "high" survived in
// a filter after it had gone from both composers.
export const VAN_STOCK_PRIORITY_OPTIONS: Array<{ value: VanStockPriority; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "urgent", label: "Urgent" },
];

/** Reads the queue's `?vPriority=` URL parameter, which outlives the scale it was written against.
 *  A bookmark from before "high" was retired still names it; the API answers such a filter with the
 *  urgent rows, so the dropdown must say Urgent too — otherwise the control sits blank above a
 *  filtered list, and the reviewer can't tell what they are looking at. "" is All priorities. */
export function readPriorityParam(param: string): string {
  return param === "high" ? "urgent" : param;
}

// Restock / Return badge.
export function VanStockTypeBadge({ type }: { type: VanStockRequest["type"] }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
      {type === "return" ? "Return" : "Restock"}
    </span>
  );
}

// Walk-in marker — renders nothing for an ordinary engineer request.
//
// It has to ride next to the status chip WHEREVER a request is listed, because a walk-in wears the
// same "Approved" chip as a reviewed request while meaning something different: nobody reviewed it,
// it was created pre-approved at the counter. Without this the reviewer's queue reads as though they
// approved it, and the engineer sees an approved request they never raised.
export function VanStockWalkInBadge({ createdVia }: { createdVia: VanStockRequest["createdVia"] }) {
  if (createdVia !== "walk_in") return null;
  return (
    <span
      title="Created pre-approved at the counter — no review step"
      className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]"
    >
      Walk-in
    </span>
  );
}

// How a request ENDED, when that isn't what its status chip says. Same argument as the walk-in badge
// above and the same placement rule — it rides next to the status wherever a request is listed.
//
// `fulfilled` is this flow's terminal "closed" state, reached three different ways, with
// completionType as the discriminator. So a request the engineer called off with nothing collected
// wears the identical FULFILLED chip as one that was fully handed over. The chip is not wrong (it IS
// closed) but on its own it is unreadable, and completionType was surfaced in exactly one place in
// the whole UI — a note-gated line on the engineer's list, for closed_short only.
//
// `complete` returns null: the chip already says it, and a badge on every finished request would be
// noise that trains people to ignore the badge on the ones that matter.
export function completionBadge(
  completionType: VanStockRequest["completionType"],
  // Needed to tell a request that came to NOTHING from one that mostly landed. completionType records
  // the last ACTION, not the OUTCOME: a request where 3 of 4 items were collected and the remainder
  // called off carries the same `cancelled_remaining` as one where nothing was ever handed over. A
  // flat "Cancelled" on the first reads as though the engineer got nothing, which is simply untrue.
  lines: Pick<VanStockLine, "fulfilledQty">[] = [],
): { label: string; cls: string; title: string } | null {
  const gotSome = lines.some((l) => l.fulfilledQty > 0);
  if (completionType === "cancelled_remaining") {
    return {
      // "Rest cancelled" is the SAME phrasing the per-line progress uses ("2/6 — rest cancelled"), so
      // the row and the lines under it describe the outcome with one vocabulary.
      label: gotSome ? "Rest cancelled" : "Cancelled",
      // Grey, not amber: nobody failed here. The engineer decided they no longer needed it.
      cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
      title: gotSome ? "Collected in part — the engineer cancelled what was left" : "The engineer cancelled the whole request",
    };
  }
  if (completionType === "closed_short") {
    return {
      label: gotSome ? "Rest closed short" : "Closed short",
      cls: "border-amber-500/30 bg-amber-500/10 text-amber-600",
      title: gotSome ? "Collected in part — a warehouse couldn't supply the rest" : "A warehouse couldn't supply any of it",
    };
  }
  return null;
}

export function VanStockCompletionBadge({
  completionType,
  lines = [],
}: {
  completionType: VanStockRequest["completionType"];
  lines?: Pick<VanStockLine, "fulfilledQty">[];
}) {
  const b = completionBadge(completionType, lines);
  if (!b) return null;
  return (
    <span title={b.title} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${b.cls}`}>
      {b.label}
    </span>
  );
}

// Compact single-line item summary for the dense worklist row: `CAT6 ×2 • Fibre ×1 • +3 more`.
// Shows up to `max` items inline (truncating the whole line) and rolls the rest into a "+N more"
// pill so the row stays ~one line tall however many items a request has. The full breakdown lives
// in the expandable <VanRequestLinesTable> below. With `showProgress`, an excluded line reads struck-out.
export function VanRequestItemsSummary({ lines, max = 3, showProgress = false, className }: { lines: VanStockLine[]; max?: number; showProgress?: boolean; className?: string }) {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, max);
  const extra = lines.length - shown.length;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)] ${className ?? ""}`}>
      <span className="min-w-0 truncate">
        {shown.map((l, i) => {
          const excluded = showProgress && l.approvedQty === 0;
          return (
            <React.Fragment key={l.id}>
              {i > 0 && <span className="text-[var(--faint)]"> • </span>}
              <span className={excluded ? "text-[var(--faint)] line-through" : ""}>
                {l.itemName} <span className="font-semibold text-[var(--ink)]">×{l.requestedQty}</span>
              </span>
            </React.Fragment>
          );
        })}
      </span>
      {extra > 0 && (
        <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--faint)]">+{extra} more</span>
      )}
    </span>
  );
}

// A request is SPLIT when its lines carry more than one distinct source warehouse — i.e. the engineer
// must visit more than one place. The single source of truth for that question: it decides whether the
// lines table shows a per-line source column, what the caption says, and whether a "collect from X"
// line may name one warehouse at all. If these disagreed, one of them would lie to the engineer.
export function isSplit(lines: Pick<VanStockLine, "sourceWarehouseId">[]): boolean {
  return new Set(lines.map((l) => l.sourceWarehouseId).filter((id): id is string => id !== null)).size > 1;
}

// The ONE warehouse an engineer collects a non-split request from, with its live address — null when
// the request is split (each line names its own, in the table) or nothing is sourced yet (pending).
// Excluded lines (approvedQty 0) carry no source, so they never decide this.
export function singlePickup(lines: VanStockLine[]): VanStockLine["sourceWarehouse"] {
  if (isSplit(lines)) return null;
  return lines.find((l) => l.sourceWarehouse)?.sourceWarehouse ?? null;
}

// Per-line fulfilment state for the engineer's Progress column: excluded (dropped at approval) →
// fulfilled (all approved qty issued) → partial (some issued) → pending (approved, none issued yet).
export function lineProgress(l: VanStockLine): { label: string; cls: string } {
  if (l.approvedQty === 0) return { label: "Excluded", cls: "text-[var(--faint)]" };
  const target = l.approvedQty ?? l.requestedQty;
  if (l.fulfilledQty >= target && target > 0) return { label: "Fulfilled", cls: "text-[var(--pos)]" };
  // Closed short by its warehouse — checked BEFORE the "Awaiting" fallback, which such a line used to
  // land on: the engineer was told stock was still coming when the warehouse had already given up on
  // it, while the request itself read "Done". Partly-issued-then-closed reads as both.
  //
  // "Closed short", never "written off": this app reserves write-off for the goods-management action
  // that really does drain a ledger (job_lost). Nothing leaves a ledger here — the line was approved
  // but never issued, so it was never stock. See the note in customers/CloseShortModal.
  if ((l.closedShortQty ?? 0) > 0) {
    return l.fulfilledQty > 0
      ? { label: `${l.fulfilledQty}/${target} — rest closed short`, cls: "text-amber-600" }
      : { label: "Closed short", cls: "text-amber-600" };
  }
  // Cancelled by the engineer themselves. Also checked before the "Awaiting" fallback, which this
  // used to hit: they cancelled the remainder and were then told it was still on its way, on a
  // request whose own header already said Done.
  if ((l.cancelledQty ?? 0) > 0) {
    return l.fulfilledQty > 0
      ? { label: `${l.fulfilledQty}/${target} — rest cancelled`, cls: "text-[var(--muted)]" }
      : { label: "Cancelled", cls: "text-[var(--muted)]" };
  }
  if (l.fulfilledQty > 0) return { label: `${l.fulfilledQty}/${target} done`, cls: "text-sky-600" };
  return { label: "Awaiting", cls: "text-[var(--muted)]" };
}

// The request's line items as a compact, aligned table — the expandable detail under a worklist row.
// Mirrors the Jobs kit-list sub-table (same size / border / uppercase headers) so the two read as one
// system. Two variants:
//   • "reviewer"  → approved-vs-requested qty; used by the warehouse board.
//   • "engineer"  → adds a Progress column (excluded / n/m done / fulfilled).
// BOTH see the source-warehouse column on a SPLIT request. The engineer especially: the sources are
// only set at approve, and on a split "collect from <primary>" alone would send them to one warehouse
// for stock that's sitting in another. Mirrors the job kit list, which shows the engineer a per-line
// pickup warehouse for exactly this reason.
export function VanRequestLinesTable({ lines, variant, className }: { lines: VanStockLine[]; variant: "reviewer" | "engineer"; className?: string }) {
  // Every hook runs before the empty-lines bail-out: a socket refresh can swap a request's lines for
  // an empty array and back, and a bail-out ABOVE this hook would change the hook count between those
  // renders ("rendered fewer hooks than expected" — the whole list unmounts).
  const { pushToast } = useDashboard();
  const [pickup, setPickup] = React.useState<VanStockLine["sourceWarehouse"]>(null);
  // The Source column earns its space only on a split; otherwise it's noise (every line ships from the
  // same place, and the caption already names it).
  const showSource = isSplit(lines);
  const showProgress = variant === "engineer";
  if (lines.length === 0) return null;
  return (
    <div className={`overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] ${className ?? ""}`}>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {/* No Code column: the item name copies the code, shows it on hover and names it in the
                "Copied IRM-0004" confirmation, so a permanent column repeated it and cost width this
                table has better uses for. */}
            <th className="px-3 py-2">Item</th>
            {/* The engineer's job is to GO there, so name the action, not the accounting concept. */}
            {showSource && <th className="px-3 py-2">{variant === "engineer" ? "Collect From" : "Fulfilment Source"}</th>}
            {showProgress && <th className="px-3 py-2">Progress</th>}
            <th className="px-3 py-2 text-right">Qty</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const excluded = l.approvedQty === 0;
            const prog = showProgress ? lineProgress(l) : null;
            // Reviewer sees approved qty once set (the trim), falling back to requested; engineer sees requested.
            const qty = variant === "reviewer" ? l.approvedQty ?? l.requestedQty : l.requestedQty;
            return (
              <tr key={l.id} className={`border-b border-[var(--border)] last:border-0 ${excluded ? "opacity-60" : ""}`}>
                {/* Name is the copy target (see VanRequestDetail) — the Code column keeps showing the
                    value but plain, so the row has one copy affordance rather than two identical ones.
                    An EXCLUDED line stays plain text: nothing is being issued for it, so offering a
                    code to scan would invite exactly the action the exclusion just refused. */}
                <td className={`px-3 py-2 font-semibold ${excluded ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {l.code && !excluded ? <CopyableCode code={l.code} label={l.itemName} className="text-left" onCopied={(c) => pushToast(`Copied ${c}`)} /> : l.itemName}
                    {/* Marked on BOTH the engineer's and the reviewer's read of the same line — hired
                        kit carries a return deadline and a bill, and neither side should have to infer
                        that from the item name. */}
                    {l.source === "rental" && <RentalBadge />}
                  </span>
                </td>
                {showSource && (
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {/* For the ENGINEER the warehouse is a destination, so it opens the pickup address
                        (they have no warehouse module to look it up in). A reviewer already has that
                        module, so theirs stays plain text. */}
                    {variant === "engineer" && l.sourceWarehouse && !excluded ? (
                      <button type="button" onClick={() => setPickup(l.sourceWarehouse)} className="inline-flex items-center gap-1 text-left font-semibold text-[var(--accent)] hover:underline" title="View pickup address">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {l.sourceWarehouseName}{l.sourceWarehouseCode ? ` (${l.sourceWarehouseCode})` : ""}
                      </button>
                    ) : (
                      <>{l.sourceWarehouseName ?? "—"}{l.sourceWarehouseCode ? ` (${l.sourceWarehouseCode})` : ""}</>
                    )}
                  </td>
                )}
                {showProgress && prog && <td className={`px-3 py-2 font-semibold ${prog.cls}`}>{prog.label}</td>}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--ink)]">×{qty}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pickup && <WarehousePickupModal wh={pickup} onClose={() => setPickup(null)} />}
    </div>
  );
}

// The ONE place either side is told where the stock moves — shown UNDER the lines table. It never
// duplicates the per-line source column; it states what the table doesn't already show:
//   • pending restock            → "Requested warehouse: X (pending review)"  (nothing sourced yet)
//   • return                     → "Returning to: X"                          (single drop-off warehouse)
//   • approved/fulfilled, 1 src  → "Collect from: X" / "Fulfilled from: X"    (source column hidden)
//   • approved/fulfilled, N srcs → "…from N warehouses — see each line below" (column carries detail)
// Returns `null` when there's nothing meaningful to add (so the caller renders no caption line).
//
// `variant` only swaps the verb: the engineer must GO there, the reviewer is watching it ship. Do not
// add a second "collect from X" line next to this one — one existed, and on a split it named the
// primary warehouse while the lines shipped from elsewhere.
type WarehouseCaptionReq = Pick<
  VanStockRequest,
  "type" | "status" | "warehouseName" | "warehouseCode" | "preferredWarehouseName" | "preferredWarehouseCode"
> & { lines: VanStockLine[] };

// What was ACTUALLY moved, and when — the audit trail of a request, one block per scan-out/scan-in.
//
// The engineer needs this at least as much as the reviewer: it is the only place a RETURN's damaged
// split is visible to them. The warehouse can receive 5 back as "3 good + 2 damaged" with a photo and
// a reason; without this the engineer just sees their van balance drop by 5 and the request close,
// with no record of why 2 didn't count. Same reason the reason text is shown here and not only the
// photo — "Crushed in transit" is the part they'd dispute.
// Postings narrowed to a given set of request lines, dropping any left with nothing. Pulled out of
// the component so the rule is testable: a posting is a whole scan session, and on a split request one
// session can only ever contain ONE warehouse's lines (the scan is warehouse-scoped), but the log
// itself carries no warehouse — the line it points at is the only thing that knows.
export function postingsForLines(fulfilments: VanStockFulfilment[], lineIds?: Set<string>): VanStockFulfilment[] {
  if (!lineIds) return fulfilments;
  return fulfilments
    .map((f) => ({ ...f, lines: f.lines.filter((fl) => lineIds.has(fl.lineId)) }))
    .filter((f) => f.lines.length > 0);
}

export function VanStockPostings({
  fulfilments,
  type,
  lineIds,
}: {
  fulfilments: VanStockFulfilment[];
  type: VanStockRequest["type"];
  // Reviewer only: restrict the log to postings against THESE lines. A warehouse's queue shows only
  // its own lines, so listing every posting under them meant an item that isn't in the table above —
  // issued by another warehouse entirely — appeared in this warehouse's "Issued" history as though
  // it had handed it over. The ENGINEER passes nothing: they collect from every warehouse on the
  // request, so the whole log is theirs to read.
  lineIds?: Set<string>;
}) {
  const shown = postingsForLines(fulfilments, lineIds);
  if (shown.length === 0) return null;
  const verb = type === "return" ? "Received" : "Issued";
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{verb}</p>
      <div className="space-y-1.5">
        {shown.map((f) => (
          <div key={f.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[11px] text-[var(--muted)]">
            <span className="font-bold text-[var(--ink)]">#{f.sequence}</span> · {fmtDateTime(f.postedAt)} · {f.performedBy}
            <div className="mt-1 space-y-0.5">
              {f.lines.map((fl) => (
                <div key={fl.id}>
                  <span className="font-semibold text-[var(--ink)]">{fl.itemName}</span> ×{fl.qty}
                  {/* WHICH HIRE these units actually moved on. The request named a catalogue item;
                      this names the physical hire the warehouse reached for, so the posting can be
                      reconciled against the order it drew from — and so nobody reads the catalogue
                      item as though it were the hired unit itself. A line that split across two
                      hires posts as two rows, each naming its own. */}
                  {fl.source === "rental" && fl.poCode && (
                    <>
                      {" · "}
                      <span className="font-semibold text-[var(--accent)]">{fl.poCode}</span>
                      {fl.hireEndDate && <span> (due {formatHireDate(fl.hireEndDate)})</span>}
                    </>
                  )}
                  {fl.condition === "damaged" ? (
                    <>
                      {" · "}
                      <span className="font-bold text-[var(--neg)]">damaged</span>
                      {fl.damageReason && <span className="italic"> — “{fl.damageReason}”</span>}
                      {fl.damagePhotoUrl && (
                        <a href={fl.damagePhotoUrl} target="_blank" rel="noreferrer" className="ml-1 font-semibold text-[var(--accent)] hover:underline">
                          photo
                        </a>
                      )}
                    </>
                  ) : (
                    <span className="text-[var(--pos)]"> · good</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The photos the engineer attached when raising a request, as a row of clickable THUMBNAILS (open
// full-size in a new tab) — shared by the engineer's own list and the reviewer's detail so both read
// the same. Replaces a bare "#1 #2" link list nobody recognised as clickable: a preview the eye lands
// on is the point of an attachment. Attachments are image uploads (Cloudinary), so a thumbnail is safe.
export function VanStockAttachments({ urls, className }: { urls: string[]; className?: string }) {
  if (urls.length === 0) return null;
  return (
    <div className={className}>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Attachments ({urls.length})</p>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            title={`Open attachment ${i + 1} in a new tab`}
            className="group relative block h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] transition-all hover:border-[var(--accent)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`Attachment ${i + 1}`} className="h-full w-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
              <ExternalLink className="h-4 w-4 text-white" />
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

// The lines a given warehouse actually handles. Every reviewer surface filters through this: a
// warehouse reviews, issues and closes short only its OWN lines, so showing another warehouse's
// stock in its queue is noise it can't act on — and worse, it made the request look bigger and its
// status look wrong. Legacy lines carry no source and belong to whoever opens them.
export function linesForWarehouse<T extends { sourceWarehouseId: string | null; approvedQty: number | null }>(
  lines: T[],
  warehouseId: string,
): T[] {
  return lines.filter((l) => {
    if (l.sourceWarehouseId) return l.sourceWarehouseId === warehouseId;
    // No source. UNDECIDED ⇒ legacy (raised before per-line selection), claimable by whoever opens
    // it. ANSWERED ⇒ excluded by a reviewer back when excluding wiped the source, so it belongs to
    // nobody now — showing it in every warehouse's queue made an item London had already dropped
    // reappear here, and it dragged the Approve gate down with it.
    return l.approvedQty === null;
  });
}

// What THIS warehouse's queue should say about a request, which is not the same thing as the
// request's own status. Each source warehouse now reviews and issues only its own lines, so a
// request can be `approved` overall while this warehouse hasn't looked at it yet — the queue used to
// print that global "Approved" chip and a manager would scroll past work that was still theirs to do.
// Terminal states stay global: a declined/cancelled/fulfilled request has nothing left for anyone.
export function warehouseStatus(
  r: Pick<VanStockRequest, "status" | "lines">,
  warehouseId: string,
): { label: string; cls: string } {
  if (["declined", "cancelled", "fulfilled"].includes(r.status)) return VSR_STATUS[r.status as keyof typeof VSR_STATUS];
  // Legacy lines carry no source and belong to whoever opens them, so they count as this warehouse's.
  const mine = linesForWarehouse(r.lines, warehouseId);
  if (mine.length === 0) return VSR_STATUS[r.status as keyof typeof VSR_STATUS] ?? VSR_STATUS.pending;
  if (mine.some((l) => l.approvedQty === null)) return VSR_STATUS.pending; // still ours to answer
  const outstanding = mine.some((l) => l.remainingQty > 0);
  if (!outstanding) return { cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]", label: "Done here" };
  return mine.some((l) => l.fulfilledQty > 0) ? VSR_STATUS.partially_fulfilled : VSR_STATUS.approved;
}

export function warehouseCaption(r: WarehouseCaptionReq, variant: "reviewer" | "engineer" = "reviewer"): string | null {
  const withCode = (name: string | null, code: string | null) => (name ? (code ? `${name} (${code})` : name) : null);
  if (r.type === "return") {
    const wh = withCode(r.warehouseName, r.warehouseCode);
    return wh ? `Returning to: ${wh}` : null;
  }
  // Restock. Lines ARE sourced from the moment the request exists — the engineer picks a collection
  // warehouse per item at create — so a pending request is read from its LINES, exactly like an
  // approved one. It used to read `preferredWarehouseName`, which is now derived and deliberately null
  // on a split: every split request therefore rendered NO caption at all, a blank where its location
  // belongs, in both the reviewer queue and the engineer's own list.
  const verb = variant === "engineer" ? "Collect from" : r.status === "pending" ? "Requested from" : "Fulfilled from";
  const suffix = r.status === "pending" ? " (pending review)" : "";
  if (isSplit(r.lines)) {
    const n = new Set(r.lines.map((l) => l.sourceWarehouseId).filter(Boolean)).size;
    return `${verb} ${n} warehouses — see each line below${suffix}`;
  }
  // Not split: the one source the lines agree on. Falls back to the request's own warehouse for
  // legacy requests raised before per-line selection, whose lines carry no source at all.
  const lineSource = r.lines.find((l) => l.sourceWarehouseName)
    ? withCode(r.lines.find((l) => l.sourceWarehouseName)!.sourceWarehouseName, r.lines.find((l) => l.sourceWarehouseName)!.sourceWarehouseCode ?? null)
    : null;
  const wh = lineSource ?? withCode(r.warehouseName, r.warehouseCode) ?? withCode(r.preferredWarehouseName, r.preferredWarehouseCode);
  return wh ? `${verb}: ${wh}${suffix}` : null;
}

// Skeleton rows that mirror the compact worklist row (two short lines) so the list doesn't shift
// when data arrives.
export function VanRequestListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="space-y-1.5" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 shadow-xs">
          <div className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-14 rounded-full" />
            <Skeleton className="h-3.5 w-20 rounded-full" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-48" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// One row of a request being composed. Shared by the engineer's composer and the reviewer's walk-in
// issue — both build the same thing (an engineer + a list of items + a reason), so they build it with
// the same parts.
// The identity + payload rules live in vanStockLine.ts — plain TS, so they can be unit-tested without
// dragging JSX into the test. Re-exported here because every call site already imports from this
// module, and the two must never drift into two definitions.
export { vanStockItemKey };

/** The "this is hired equipment" marker. Rental kit must never read as interchangeable with company
 *  stock — it belongs to someone else, it has a return deadline, and it keeps billing. */
export function RentalBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent)] ${className}`}>
      <Timer aria-hidden className="h-3 w-3" />
      Rental
    </span>
  );
}

export interface VanStockCartItem {
  key: string; // vanStockItemKey() — the row's identity across both catalogues
  source: VanStockLineSource;
  irmItemId: string | null;
  rentalItemId: string | null;
  name: string;
  code: string | null;
  qty: number;
  maxQty?: number; // returns: capped at the engineer's on-hand / on-hire
  // Returns only, rental only: the soonest deadline among the hires these units sit on.
  hireEndDate?: string | null;
  overdue?: boolean;
}

// The cart being composed. Pairs with VanStockItemSearch below: search adds, this edits/removes.
export function VanStockCartTable({
  cart,
  onQty,
  onRemove,
  shelfByItem,
  shelfLabel = "On shelf there",
  emptyText = "No items added yet.",
  warehouseCell,
}: {
  cart: VanStockCartItem[];
  // Addressed by the composite KEY, not a raw item id — see vanStockItemKey.
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  // Restock only: availability at the SELECTED collect-from warehouse (advisory), keyed by the same
  // composite key so company stock and hired kit share one map without colliding.
  shelfByItem?: Map<string, number>;
  // Wording for the on-hand line — "On shelf there" reads for the engineer's collect-from warehouse;
  // the walk-in composer passes "In stock" (the item's on-hand at the issuing counter).
  shelfLabel?: string;
  emptyText?: string;
  // Restock only: renders a per-line COLLECTION WAREHOUSE cell, the way a job's kit list names the
  // warehouse each line is picked from. A render-prop rather than options/value/onChange threaded
  // through, so the shared table stays ignorant of availability and the walk-in composer — which
  // issues from ONE counter and has no such choice — simply omits it and gets no column.
  warehouseCell?: (item: VanStockCartItem) => React.ReactNode;
}) {
  const { pushToast } = useDashboard();
  if (cart.length === 0) return <p className="text-xs text-[var(--muted)]">{emptyText}</p>;
  return (
    // overflow-x-AUTO, not overflow-hidden. The fixed columns below come to ~390px on their own, so
    // on a phone — which is where an engineer actually builds a restock — `hidden` CLIPPED the qty
    // box and the remove button with no way to reach them. Auto is also what the other ~50 tables in
    // this app use (EngineerKitRequests, EngineerTransfers, EngineerJobDetail…); this one was the
    // outlier.
    //
    // The min-w has to exceed the column the table actually sits in, or it does nothing and the
    // browser crushes the cells instead of scrolling. This table lives in a form's 2-of-3 column,
    // which is ~580px at a 1280px viewport — measured at 34rem the scroll never engaged, the qty box
    // collapsed to 30px and the item name wrapped over four lines. `w-24`/`w-64` are only hints under
    // auto layout: the "London Logistics Hub (WH-0005) — 109 free" label wins the space and the rest
    // give it up. 42rem clears that column so the scroll takes over before anything is squeezed; the
    // narrower floor is for the walk-in composer, which has no warehouse column.
    // `relative` is load-bearing, not decoration. The "Remove" column's header label is an
    // `sr-only` span, and Tailwind's sr-only is `position:absolute`. With no positioned ancestor its
    // containing block was the INITIAL one, so it escaped this scroll container entirely and sat at
    // the table's full width (~670px) in the document's coordinate space — dragging the whole PAGE
    // into a 176px horizontal scroll on a phone, while every visible element stayed inside the
    // viewport. Making the wrapper a containing block puts the span back under `overflow-x-auto`,
    // where it is clipped like everything else. Verified in-browser: 176px → 0.
    <div className="relative overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className={`w-full text-left text-sm ${warehouseCell ? "min-w-[42rem]" : "min-w-[24rem]"}`}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {/* Floors the name column so a long item never concertinas into a 100px stack. */}
            <th className="min-w-[10rem] px-3 py-2">Item</th>
            {warehouseCell && <th className="w-64 px-3 py-2">Collect from</th>}
            <th className="w-24 px-3 py-2">Qty</th>
            <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {cart.map((c) => {
            const shelf = shelfByItem?.get(c.key);
            const isRental = c.source === "rental";
            return (
              <tr key={c.key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2">
                  <span className="flex flex-wrap items-center gap-1.5 font-semibold text-[var(--ink)]">
                    {c.code ? <CopyableCode code={c.code} label={c.name} className="text-left" onCopied={(t) => pushToast(`Copied ${t}`)} /> : c.name}
                    {isRental && <RentalBadge />}
                  </span>

                  {/* "Holding N" (returns cap) is redundant when a shelf figure is shown — the shelf line
                      already states the number and colours it — so only render it when there's no shelf. */}
                  {typeof c.maxQty === "number" && typeof shelf !== "number" && <div className="text-[10px] text-[var(--faint)]">Holding {c.maxQty}</div>}
                  {typeof shelf === "number" && (
                    <div className={`text-[10px] font-semibold ${shelf >= c.qty ? "text-[var(--pos)]" : shelf > 0 ? "text-amber-600" : "text-[var(--neg)]"}`}>
                      {/* Hired kit is not "on the shelf" — it is a hire the depot can lend out, and
                          saying so is what stops an engineer reading it as stock we own. */}
                      {isRental ? "Free on hire there" : shelfLabel}: {shelf}
                      {shelf < c.qty && shelf > 0 && " — less than you're asking"}
                      {shelf === 0 && (isRental ? " — none free on hire" : " — out of stock")}
                    </div>
                  )}
                  {/* The deadline, on a RETURN row. The one fact that makes hired kit urgent. */}
                  {isRental && c.hireEndDate && (
                    <div className={`text-[10px] font-semibold ${c.overdue ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                      {c.overdue ? "Overdue — due back " : "Due back "}
                      {formatHireDate(c.hireEndDate)}
                    </div>
                  )}
                </td>
                {warehouseCell && <td className="px-3 py-2 align-top">{warehouseCell(c)}</td>}
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={1}
                    max={c.maxQty}
                    step={1}
                    value={c.qty}
                    aria-label={`Quantity for ${c.name}`}
                    onChange={(e) => {
                      const raw = Math.max(1, Math.floor(Number(e.target.value) || 1));
                      onQty(c.key, typeof c.maxQty === "number" ? Math.min(raw, c.maxQty) : raw);
                    }}
                    // min-w, not w: inputCls already carries w-full, and min-width beats it in the
                    // cascade. Without a floor, auto table layout squeezed this to 30px — a number
                    // input too narrow to read its own value, let alone show the spinners.
                    className={`${inputCls} min-w-14 py-1.5`}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button type="button" onClick={() => onRemove(c.key)} aria-label="Remove item" className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A search hit carrying OPTIONAL warehouse stock context — the engineer composer's plain catalogue hit
// has neither field; the walk-in composer's (warehouse-scoped) hit carries both.
export type SearchItemOption = VanStockItemOption & { quantityOnHand?: number; reorderLevel?: number | null };

// Debounced catalogue item-search — shared by the engineer composer and the reviewer walk-in issue.
// A monotonic reqId guards against out-of-order responses. `excludeIds` greys out already-added items.
//
// Two modes, chosen by `warehouseId`:
//   • absent  → engineer composer: warehouse-independent catalogue search (/requestable-item-search),
//               each hit annotated with the item's TOTAL on-hand across warehouses. An item out of
//               stock everywhere still shows — but disabled/"out of stock", non-selectable — since no
//               warehouse could ever fulfil it. No default list — an empty box shows nothing until the
//               engineer types.
//   • present → walk-in composer: warehouse-scoped. With NO query it shows a BROWSE list of everything
//               this warehouse holds (on-hand > 0), so the counter can pick straight off the shelf
//               without typing; typing then searches the whole catalogue, annotating each hit with THIS
//               warehouse's on-hand and disabling anything out of stock. The authoritative block still
//               lives on the server (walkIn) — this is the UX layer over it.
export function VanStockItemSearch({
  excludeIds,
  onAddItem,
  placeholder = "Search the catalogue…",
  warehouseId,
}: {
  excludeIds: Set<string>;
  onAddItem: (it: SearchItemOption) => void;
  placeholder?: string;
  warehouseId?: string;
}) {
  const [search, setSearch] = React.useState("");
  const [results, setResults] = React.useState<SearchItemOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = React.useRef(0);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // One fetch for both the default browse list (empty q, walk-in mode) and typed search. A monotonic
  // reqId drops out-of-order responses. Engineer mode with an empty q resolves to an empty list (no
  // default browse); walk-in mode with an empty q returns the warehouse's on-hand items.
  const fetchItems = React.useCallback(async (q: string) => {
    const myId = ++reqId.current;
    setLoading(true);
    setTouched(true);
    setFailed(false);
    try {
      const items: SearchItemOption[] = warehouseId
        ? await vanStockSvc.searchWalkInItems(warehouseId, q)
        : q
          ? await vanStockSvc.searchRequestableItems(q)
          : [];
      if (myId !== reqId.current) return;
      setResults(items);
    } catch (e) {
      if (myId !== reqId.current) return;
      console.error("Field stock item search failed:", e);
      setResults([]);
      setFailed(true);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [warehouseId]);

  // Walk-in mode: load the default browse list once the warehouse is known, so the dropdown is useful
  // before the reviewer types anything. Deferred a tick so the fetch's setState doesn't fire
  // synchronously inside the effect (which would cascade a render — react-hooks set-state-in-effect).
  React.useEffect(() => {
    if (!warehouseId) return;
    const t = setTimeout(() => { void fetchItems(""); }, 0);
    return () => clearTimeout(t);
  }, [warehouseId, fetchItems]);

  const run = (v: string) => {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    // Engineer mode with an empty box shows nothing; walk-in mode falls back to the browse list.
    if (!q && !warehouseId) { reqId.current++; setResults([]); setTouched(false); setFailed(false); return; }
    timer.current = setTimeout(() => { void fetchItems(q); }, 300);
  };

  const browsing = !!warehouseId && search.trim().length === 0;
  // Walk-in search only ever returns stock this warehouse holds, so an empty result there means "not on
  // this shelf", not "no such item". The engineer's catalogue search keeps the catalogue wording.
  const noResultsText = warehouseId
    ? browsing
      ? "This warehouse has no stock to hand out yet."
      : "No matching stock at this warehouse."
    : "No matching item in the catalogue.";

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input type="search" value={search} onChange={(e) => run(e.target.value)} aria-label="Search items" placeholder={placeholder} className={`${inputCls} pl-9`} />
        {loading && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--faint)]" />}
      </div>

      {touched && !loading && failed && <p className="text-xs font-semibold text-[var(--neg)]">Couldn&apos;t run the search just now. Check your connection and try again.</p>}
      {touched && !loading && !failed && results.length === 0 && (
        <p className="text-xs text-[var(--muted)]">{noResultsText}</p>
      )}

      {results.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-auto">
          {results.map((it) => {
            // Nothing available — walk-in / restock can't fulfil it, so it's pickable in name only.
            const outOfStock = typeof it.quantityOnHand === "number" && it.quantityOnHand <= 0;
            const isRental = it.source === "rental";
            const key = vanStockItemKey(it);
            const added = excludeIds.has(key);
            const disabled = added || outOfStock;
            const emptyLabel = isRental ? "None free on hire" : "Out of stock";
            return (
              <button key={key} type="button" disabled={disabled} onClick={() => onAddItem(it)} title={outOfStock ? emptyLabel : undefined} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${disabled ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
                    {/* Rental hits are marked in the RESULT list, not only after they're added — the
                        engineer has to know what they're picking before they pick it. */}
                    {isRental && <RentalBadge />}
                  </span>
                  {it.code && <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{it.code}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {typeof it.quantityOnHand === "number" && (
                    <span className={`text-[11px] font-semibold tabular-nums ${it.quantityOnHand <= 0 ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                      {it.quantityOnHand <= 0 ? emptyLabel : `${it.quantityOnHand} ${isRental ? "free on hire" : "in stock"}`}
                    </span>
                  )}
                  {added ? <Check className="h-4 w-4 shrink-0 text-[var(--pos)]" /> : !outOfStock && <Plus className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
