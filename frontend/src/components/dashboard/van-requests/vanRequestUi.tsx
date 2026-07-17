"use client";

import * as React from "react";
import { Check, Loader2, Plus, Search } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockItemOption, VanStockLine, VanStockRequest } from "@/services/vanStockRequest.service";
import { CopyableCode } from "@/components/ui/CopyableCode";
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
//   • "reviewer"  → shows a Source-warehouse column ONLY when the request is split (lines span >1
//                   source), and an approved-vs-requested qty; used by the warehouse board.
//   • "engineer"  → shows a Progress column (excluded / n/m done / fulfilled) instead; the engineer
//                   never sees per-warehouse sourcing, so no Source column.
export function VanRequestLinesTable({ lines, variant, className }: { lines: VanStockLine[]; variant: "reviewer" | "engineer"; className?: string }) {
  if (lines.length === 0) return null;
  // A request is "split" only when its lines carry more than one distinct (non-null) source warehouse —
  // then the Source column earns its space; otherwise it's noise (every line ships from the same place).
  const sources = new Set(lines.map((l) => l.sourceWarehouseId).filter((id): id is string => id !== null));
  const showSource = variant === "reviewer" && sources.size > 1;
  const showProgress = variant === "engineer";
  return (
    <div className={`overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] ${className ?? ""}`}>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Code</th>
            {showSource && <th className="px-3 py-2">Fulfilment Source</th>}
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
                {showSource && <td className="px-3 py-2 text-[var(--muted)]">{l.sourceWarehouseName ?? "—"}{l.sourceWarehouseCode ? ` (${l.sourceWarehouseCode})` : ""}</td>}
                {showProgress && prog && <td className={`px-3 py-2 font-semibold ${prog.cls}`}>{prog.label}</td>}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--ink)]">×{qty}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Context-aware warehouse caption shown UNDER the lines table — never duplicates the per-line
// Fulfilment-Source column. It states the business fact that the table doesn't already show:
//   • pending restock            → "Requested warehouse: X (pending review)"  (no source column yet)
//   • return                     → "Returning to: X"                          (single drop-off warehouse)
//   • approved/fulfilled, 1 src  → "Fulfilled from: X"                        (source column hidden)
//   • approved/fulfilled, N srcs → "Fulfilled from N warehouses"             (source column carries detail)
// Returns `null` when there's nothing meaningful to add (so the caller renders no caption line).
type WarehouseCaptionReq = Pick<
  VanStockRequest,
  "type" | "status" | "warehouseName" | "warehouseCode" | "preferredWarehouseName" | "preferredWarehouseCode"
> & { lines: VanStockLine[] };

export function warehouseCaption(r: WarehouseCaptionReq): string | null {
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
  // Approved onward: how many distinct source warehouses actually fulfil this request.
  const sources = new Set(r.lines.map((l) => l.sourceWarehouseId).filter((id): id is string => id !== null));
  if (sources.size > 1) return `Fulfilled from ${sources.size} warehouses`;
  const wh = withCode(r.warehouseName, r.warehouseCode);
  return wh ? `Fulfilled from: ${wh}` : null;
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

// Debounced catalogue item-search — shared by the engineer composer and the reviewer walk-in modal
// (the /item-search endpoint serves both perms). A monotonic reqId guards against out-of-order
// responses. `excludeIds` greys out already-added items.
export function VanStockItemSearch({
  excludeIds,
  onAddItem,
  placeholder = "Search the catalogue…",
}: {
  excludeIds: Set<string>;
  onAddItem: (it: VanStockItemOption) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = React.useState("");
  const [results, setResults] = React.useState<VanStockItemOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = React.useRef(0);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = (v: string) => {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    reqId.current++;
    if (!q) { setResults([]); setTouched(false); setFailed(false); return; }
    timer.current = setTimeout(async () => {
      const myId = ++reqId.current;
      setLoading(true);
      setTouched(true);
      setFailed(false);
      try {
        const items = await vanStockSvc.searchVanStockItems(q);
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
    }, 300);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input type="search" value={search} onChange={(e) => run(e.target.value)} aria-label="Search items" placeholder={placeholder} className={`${inputCls} pl-9`} />
        {loading && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--faint)]" />}
      </div>

      {touched && !loading && failed && <p className="text-xs font-semibold text-[var(--neg)]">Couldn&apos;t run the search just now. Check your connection and try again.</p>}
      {touched && !loading && !failed && results.length === 0 && <p className="text-xs text-[var(--muted)]">No matching item in the catalogue.</p>}

      {results.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-auto">
          {results.map((it) => {
            const added = excludeIds.has(it.irmItemId);
            return (
              <button key={it.irmItemId} type="button" disabled={added} onClick={() => onAddItem(it)} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${added ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
                  {it.code && <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{it.code}</span>}
                </span>
                {added ? <Check className="h-4 w-4 shrink-0 text-[var(--pos)]" /> : <Plus className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
