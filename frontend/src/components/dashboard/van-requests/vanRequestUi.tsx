"use client";

import * as React from "react";
import { Check, ExternalLink, Loader2, MapPin, Plus, Search, Trash2 } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockFulfilment, VanStockItemOption, VanStockLine, VanStockRequest } from "@/services/vanStockRequest.service";
import { CopyableCode } from "@/components/ui/CopyableCode";
import { fmtDateTime } from "@/components/dashboard/portal/portalUi";
import { WarehousePickupModal } from "@/components/dashboard/engineer/WarehousePickupModal";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls } from "@/components/ui/styles";

// Shared presentational bits for the Field Stock (VSR) lists — used by BOTH the warehouse board and
// the engineer's own list so the two read as one system. Kept in a neutral module (not either list
// file) to avoid a circular import between them.

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
function lineProgress(l: VanStockLine): { label: string; cls: string } {
  if (l.approvedQty === 0) return { label: "Excluded", cls: "text-[var(--faint)]" };
  const target = l.approvedQty ?? l.requestedQty;
  if (l.fulfilledQty >= target && target > 0) return { label: "Fulfilled", cls: "text-[var(--pos)]" };
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
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Code</th>
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
                <td className={`px-3 py-2 font-semibold ${excluded ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>{l.itemName}</td>
                <td className="px-3 py-2">{l.code ? <CopyableCode code={l.code} /> : <span className="text-[var(--faint)]">—</span>}</td>
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
export function VanStockPostings({ fulfilments, type }: { fulfilments: VanStockFulfilment[]; type: VanStockRequest["type"] }) {
  if (fulfilments.length === 0) return null;
  const verb = type === "return" ? "Received" : "Issued";
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{verb}</p>
      <div className="space-y-1.5">
        {fulfilments.map((f) => (
          <div key={f.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[11px] text-[var(--muted)]">
            <span className="font-bold text-[var(--ink)]">#{f.sequence}</span> · {fmtDateTime(f.postedAt)} · {f.performedBy}
            <div className="mt-1 space-y-0.5">
              {f.lines.map((fl) => (
                <div key={fl.id}>
                  <span className="font-semibold text-[var(--ink)]">{fl.itemName}</span> ×{fl.qty}
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

export function warehouseCaption(r: WarehouseCaptionReq, variant: "reviewer" | "engineer" = "reviewer"): string | null {
  const withCode = (name: string | null, code: string | null) => (name ? (code ? `${name} (${code})` : name) : null);
  if (r.type === "return") {
    const wh = withCode(r.warehouseName, r.warehouseCode);
    return wh ? `Returning to: ${wh}` : null;
  }
  // Restock. Before approval nothing is sourced yet — surface the engineer's collection choice.
  if (r.status === "pending") {
    const pref = withCode(r.preferredWarehouseName, r.preferredWarehouseCode);
    return pref ? `Requested warehouse: ${pref} (pending review)` : null;
  }
  // Approved onward: how many distinct source warehouses actually fulfil this request. The engineer has
  // to GO there, so name the action; the reviewer is watching it ship, so name the accounting.
  const verb = variant === "engineer" ? "Collect from" : "Fulfilled from";
  if (isSplit(r.lines)) {
    const n = new Set(r.lines.map((l) => l.sourceWarehouseId).filter(Boolean)).size;
    return `${verb} ${n} warehouses — see each line below`;
  }
  const wh = withCode(r.warehouseName, r.warehouseCode);
  return wh ? `${verb}: ${wh}` : null;
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
export interface VanStockCartItem {
  irmItemId: string;
  name: string;
  code: string | null;
  qty: number;
  maxQty?: number; // returns: capped at the engineer's on-hand
}

// The cart being composed. Pairs with VanStockItemSearch below: search adds, this edits/removes.
export function VanStockCartTable({
  cart,
  onQty,
  onRemove,
  shelfByItem,
  shelfLabel = "On shelf there",
  emptyText = "No items added yet.",
}: {
  cart: VanStockCartItem[];
  onQty: (irmItemId: string, qty: number) => void;
  onRemove: (irmItemId: string) => void;
  // Restock only: on-hand at the SELECTED collect-from warehouse (advisory).
  shelfByItem?: Map<string, number>;
  // Wording for the on-hand line — "On shelf there" reads for the engineer's collect-from warehouse;
  // the walk-in composer passes "In stock" (the item's on-hand at the issuing counter).
  shelfLabel?: string;
  emptyText?: string;
}) {
  if (cart.length === 0) return <p className="text-xs text-[var(--muted)]">{emptyText}</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-3 py-2">Item</th>
            <th className="w-24 px-3 py-2">Qty</th>
            <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {cart.map((c) => {
            const shelf = shelfByItem?.get(c.irmItemId);
            return (
              <tr key={c.irmItemId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2">
                  <span className="font-semibold text-[var(--ink)]">{c.name}</span>
                  {c.code && <div className="mt-0.5"><CopyableCode code={c.code} /></div>}
                  {/* "Holding N" (returns cap) is redundant when a shelf figure is shown — the shelf line
                      already states the number and colours it — so only render it when there's no shelf. */}
                  {typeof c.maxQty === "number" && typeof shelf !== "number" && <div className="text-[10px] text-[var(--faint)]">Holding {c.maxQty}</div>}
                  {typeof shelf === "number" && (
                    <div className={`text-[10px] font-semibold ${shelf >= c.qty ? "text-[var(--pos)]" : shelf > 0 ? "text-amber-600" : "text-[var(--neg)]"}`}>
                      {shelfLabel}: {shelf}
                      {shelf < c.qty && shelf > 0 && " — less than you're asking"}
                      {shelf === 0 && " — out of stock"}
                    </div>
                  )}
                </td>
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
                      onQty(c.irmItemId, typeof c.maxQty === "number" ? Math.min(raw, c.maxQty) : raw);
                    }}
                    className={`${inputCls} py-1.5`}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button type="button" onClick={() => onRemove(c.irmItemId)} aria-label="Remove item" className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
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
            // Out of stock at THIS warehouse — walk-in can't issue it, so it's pickable in name only.
            const outOfStock = typeof it.quantityOnHand === "number" && it.quantityOnHand <= 0;
            const added = excludeIds.has(it.irmItemId);
            const disabled = added || outOfStock;
            return (
              <button key={it.irmItemId} type="button" disabled={disabled} onClick={() => onAddItem(it)} title={outOfStock ? "Out of stock at this warehouse" : undefined} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${disabled ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
                  {it.code && <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{it.code}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {typeof it.quantityOnHand === "number" && (
                    <span className={`text-[11px] font-semibold tabular-nums ${it.quantityOnHand <= 0 ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                      {it.quantityOnHand <= 0 ? "Out of stock" : `${it.quantityOnHand} in stock`}
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
