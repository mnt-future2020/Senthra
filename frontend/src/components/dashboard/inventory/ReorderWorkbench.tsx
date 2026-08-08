"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftRight, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Loader2, RefreshCw, Search } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import * as prfService from "@/services/purchase-request.service";
import type { ReorderReason, ReorderSuggestion } from "@/services/inventory.service";
import type { GenerateReorderResult } from "@/services/purchase-request.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Modal } from "@/components/ui/Modal";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { tableMinWidth } from "@/components/ui/tableLayout";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatMoney } from "./inventoryStatus";

// The Reorder workbench — the Inventory Hub "Reorder" lens. Shows what should be BOUGHT per
// item × warehouse (server-netted against reservations, incoming POs and open PRFs), lets the user
// tune quantities, and generates DRAFT Purchase Requests grouped supplier × warehouse through the
// existing PRF → approval → PO pipeline. The server re-validates every row at generate time, so
// this surface never has to be perfectly fresh to be safe.

// Item · Warehouse · six numeric columns · Reason · Supplier. Only the first, Reason and Supplier
// carry text; `min-w-[1160px]` across twelve columns left every one of them ~97px.
const TABLE_MIN_WIDTH = tableMinWidth(["wide", "wide", "narrow", "narrow", "narrow", "narrow", "narrow", "narrow", "narrow", "narrow", "normal", "normal"]);

const REASON_LABELS: Record<ReorderReason, string> = {
  negative_stock: "Negative stock",
  out_of_stock: "Out of stock",
  below_reorder: "Below reorder level",
  planned_demand: "Planned demand",
};
const REASON_CLASSES: Record<ReorderReason, string> = {
  negative_stock: "bg-[var(--neg)]/12 text-[var(--neg)]",
  out_of_stock: "bg-[var(--neg)]/12 text-[var(--neg)]",
  below_reorder: "bg-amber-500/15 text-amber-600",
  planned_demand: "bg-indigo-500/15 text-indigo-600",
};

function ReasonBadge({ reason }: { reason: ReorderReason }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${REASON_CLASSES[reason]}`}>
      {REASON_LABELS[reason]}
    </span>
  );
}

export const rowKey = (s: { irmItemId: string; warehouseId: string }) => `${s.irmItemId}|${s.warehouseId}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Header "select all" applies to the VISIBLE rows only and MERGES into the existing selection.
// Selection is global (it deliberately survives filter changes — `chosen` is computed over every
// suggestion, not the filtered subset), so replacing the set here would silently discard rows the
// user ticked under a different filter and generate fewer PRFs than the confirm dialog implied.
export function mergeVisibleSelection(prev: ReadonlySet<string>, visibleKeys: readonly string[], deselect: boolean): Set<string> {
  const next = new Set(prev);
  for (const k of visibleKeys) {
    if (deselect) next.delete(k);
    else next.add(k);
  }
  return next;
}

// Expanded row: the calculation breakdown (why this number) + a surplus panel showing other
// warehouses that hold the item — each with a one-click "Create Transfer" that opens the existing
// Move Stock form PREFILLED (never auto-creates; the user reviews + submits; the endpoint's own
// validation stays the enforcement layer).
function BreakdownRow({ s }: { s: ReorderSuggestion }) {
  const router = useRouter();
  const { can } = useAuth();
  const [others, setOthers] = React.useState<{ warehouseId: string; warehouseName: string; available: number }[] | null>(null);
  React.useEffect(() => {
    let active = true;
    inventoryService.listItemWarehouseStock(s.irmItemId).then(
      (rows) => {
        if (!active) return;
        setOthers(rows.filter((r) => r.warehouseId !== s.warehouseId && r.available > 0).map((r) => ({ warehouseId: r.warehouseId, warehouseName: r.warehouseName, available: r.available })));
      },
      () => active && setOthers([]),
    );
    return () => { active = false; };
  }, [s.irmItemId, s.warehouseId]);

  // Transfers are only offered when they'd genuinely substitute a purchase: an actionable row, a
  // transferable item (the move endpoint rejects serial/batch tracking), and the mover permission.
  const canTransfer = can("inventory.move") && !s.covered && s.suggestedQty > 0 && !s.trackSerialNumbers && !s.trackBatchNumbers;

  const line = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-6"><span className="text-[var(--muted)]">{label}</span><span className="font-semibold text-[var(--ink)]">{value}</span></div>
  );
  return (
    <div className="flex flex-wrap gap-8 px-4 py-3 text-xs">
      <div className="min-w-[220px] space-y-1">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">How this was calculated</p>
        {line("Available (on hand − reserved)", s.available)}
        {line("On order (open POs)", `+${s.incoming}`)}
        {line("Already on open PRFs", `+${s.openPrf}`)}
        {s.plannedDemand > 0 ? line("Planned job demand", `−${s.plannedDemand}`) : null}
        <div className="flex justify-between gap-6 border-t border-[var(--border)] pt-1">
          <span className="text-[var(--muted)]">Projected position</span><span className="font-bold text-[var(--ink)]">{s.projected}</span>
        </div>
        {line("Replenish to", s.target)}
        {s.packSize ? line("Pack size", s.packSize) : null}
        <div className="flex justify-between gap-6"><span className="text-[var(--muted)]">Suggested</span><span className="font-extrabold text-[var(--accent)]">{s.suggestedQty}</span></div>
      </div>
      <div className="min-w-[200px] space-y-1">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Held elsewhere</p>
        {others === null ? (
          <p className="text-[var(--faint)]">Checking…</p>
        ) : others.length === 0 ? (
          <p className="text-[var(--faint)]">No other warehouse holds this item.</p>
        ) : (
          others.map((o) => (
            <div key={o.warehouseId} className="flex items-center justify-between gap-3">
              <p className="text-[var(--muted)]">
                <span className="font-semibold text-[var(--ink)]">{o.warehouseName}</span> holds {o.available} — a transfer may beat a purchase.
              </p>
              {canTransfer && (
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/dashboard/inventory/move?item=${s.irmItemId}&from=${o.warehouseId}&to=${s.warehouseId}&qty=${Math.max(1, Math.min(s.suggestedQty, o.available))}`,
                    )
                  }
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] font-bold text-[var(--accent)] transition-all hover:border-[var(--accent)]"
                  title={`Open the Move Stock form prefilled: ${o.warehouseName} → ${s.warehouseName}`}
                >
                  <ArrowLeftRight className="h-3 w-3" /> Create Transfer
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ReorderWorkbench() {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const searchParams = useSearchParams();
  const canGenerate = can("purchase_requests.create");
  // A row can only become a PRF line if it's actionable (not merely "covered" by the pipeline) AND
  // its primary supplier is set and still active — an inactive supplier would be rejected by the
  // server at generate time, so we disable it here too (the generate-time skip stays as the
  // concurrency fallback for a supplier deactivated mid-review).
  const orderable = (s: ReorderSuggestion) => !s.covered && s.primarySupplier?.status === "active";

  const [data, setData] = React.useState<{ suggestions: ReorderSuggestion[]; calculatedAt: string } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // Selection + per-row edited quantity, keyed item|warehouse. Editing a qty does NOT auto-select.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [qtyOverrides, setQtyOverrides] = React.useState<Record<string, string>>({});
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [warehouseFilter, setWarehouseFilter] = React.useState("");
  const [supplierFilter, setSupplierFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [reasonFilter, setReasonFilter] = React.useState("");
  // Seeded from ?critical=1, which is where the "Critical stock" badge lands. That badge counts
  // exactly the rows this checkbox leaves on screen (getReorderSummary's criticalCount is
  // `actionable.filter(s => s.critical)`), so arriving with the box already ticked is what makes the
  // number and the list the same set. It is a normal filter afterwards — untick and the URL is not
  // rewritten, because the user is now browsing, not following a badge.
  const [criticalOnly, setCriticalOnly] = React.useState(() => searchParams.get("critical") === "1");
  const [showCovered, setShowCovered] = React.useState(false);

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [requiredBy, setRequiredBy] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [result, setResult] = React.useState<GenerateReorderResult | null>(null);

  // Loads on mount and whenever Refresh bumps reloadKey. The loading reset lives in the refresh
  // handler (an event), so the effect body holds no synchronous setState — initial render already
  // starts in the loading state (useState(true)).
  React.useEffect(() => {
    let active = true;
    inventoryService.getReorderSuggestions().then(
      (r) => { if (active) { setData(r); setError(null); setLoading(false); } },
      (e) => { if (active) { setError(e instanceof Error ? e.message : "Could not calculate reorder suggestions."); setLoading(false); } },
    );
    return () => { active = false; };
  }, [reloadKey]);

  const refresh = () => {
    setSelected(new Set());
    setQtyOverrides({});
    setExpanded(null);
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  const rows = React.useMemo(() => {
    const all = data?.suggestions ?? [];
    const term = search.trim().toLowerCase();
    return all.filter(
      (s) =>
        (!term || s.itemName.toLowerCase().includes(term) || s.itemCode.toLowerCase().includes(term) || (s.sku ?? "").toLowerCase().includes(term)) &&
        (!warehouseFilter || s.warehouseId === warehouseFilter) &&
        (!supplierFilter || s.primarySupplier?.id === supplierFilter) &&
        (!categoryFilter || s.categoryId === categoryFilter) &&
        (!reasonFilter || s.reason === reasonFilter) &&
        (!criticalOnly || s.critical) &&
        (showCovered || !s.covered), // covered rows are informational — hidden unless toggled on
    );
  }, [data, search, warehouseFilter, supplierFilter, categoryFilter, reasonFilter, criticalOnly, showCovered]);

  const warehouseOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data?.suggestions ?? []) seen.set(s.warehouseId, `${s.warehouseName} (${s.warehouseCode})`);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [data]);

  const supplierOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data?.suggestions ?? []) if (s.primarySupplier) seen.set(s.primarySupplier.id, s.primarySupplier.name);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const categoryOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data?.suggestions ?? []) if (s.categoryId && s.categoryName) seen.set(s.categoryId, s.categoryName);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const coveredCount = React.useMemo(() => (data?.suggestions ?? []).filter((s) => s.covered).length, [data]);

  const qtyOf = (s: ReorderSuggestion): number => {
    const raw = qtyOverrides[rowKey(s)];
    const n = raw === undefined || raw === "" ? s.suggestedQty : Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : s.suggestedQty;
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const selectableRows = rows.filter(orderable);
  const allSelected = selectableRows.length > 0 && selectableRows.every((s) => selected.has(rowKey(s)));
  const toggleAll = () =>
    setSelected((prev) => mergeVisibleSelection(prev, selectableRows.map(rowKey), allSelected));

  const chosen = (data?.suggestions ?? []).filter((s) => selected.has(rowKey(s)) && orderable(s));
  // The confirm-dialog preview: one draft PRF per supplier × warehouse.
  const groups = React.useMemo(() => {
    const map = new Map<string, { supplierName: string; warehouseName: string; rows: ReorderSuggestion[] }>();
    for (const s of chosen) {
      const key = `${s.primarySupplier!.id}|${s.warehouseId}`;
      const g = map.get(key);
      if (g) g.rows.push(s);
      else map.set(key, { supplierName: s.primarySupplier!.name, warehouseName: s.warehouseName, rows: [s] });
    }
    return [...map.values()];
  }, [chosen]);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await prfService.generateReorderPrfs(
        chosen.map((s) => ({
          irmItemId: s.irmItemId,
          warehouseId: s.warehouseId,
          supplierId: s.primarySupplier!.id,
          quantity: qtyOf(s),
          itemName: s.itemName,
          warehouseName: s.warehouseName,
        })),
        requiredBy || undefined,
      );
      setConfirmOpen(false);
      setResult(res);
      if (res.created.length > 0) pushToast(`${res.created.length} draft purchase request${res.created.length === 1 ? "" : "s"} created.`, "success");
      else pushToast("Nothing was generated — every selected row was already covered.", "alert");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate purchase requests.", "alert");
    } finally {
      setGenerating(false);
    }
  };

  // ── Post-generation summary: what was created, skipped and adjusted ─────────
  if (result) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-2xl space-y-5 py-4">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--pos)]/10 text-[var(--pos)] ring-8 ring-[var(--pos)]/5">
              <ClipboardList className="h-7 w-7" />
            </span>
            <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">
              {result.created.length} draft purchase request{result.created.length === 1 ? "" : "s"} created
            </h2>
            <p className="max-w-md text-sm text-[var(--muted)]">Each request now goes through the normal review — submit, approve, then generate the purchase order.</p>
          </div>

          {result.created.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="divide-y divide-[var(--border)]">
                {result.created.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => router.push(`/dashboard/purchase-requests/${c.code}`)}
                    className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-sm font-bold text-[var(--ink)]">{c.code}</span>
                      <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                        {c.supplierName} · {c.warehouseName} · {c.lineCount} line{c.lineCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-bold text-[var(--ink)]">{formatMoney(c.totalPence / 100)}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {result.adjusted.length > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="mb-1.5 text-xs font-bold text-amber-600">Quantities adjusted — stock changed while you were reviewing</p>
              <ul className="space-y-1 text-xs text-[var(--muted)]">
                {result.adjusted.map((a, i) => (
                  <li key={i}><span className="font-semibold text-[var(--ink)]">{a.itemName}</span> at {a.warehouseName}: requested {a.requestedQty} → ordered {a.finalQty}.</li>
                ))}
              </ul>
            </div>
          )}

          {result.skipped.length > 0 && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
              <p className="mb-1.5 text-xs font-bold text-[var(--ink)]">Skipped</p>
              <ul className="space-y-1 text-xs text-[var(--muted)]">
                {result.skipped.map((s, i) => (
                  <li key={i}><span className="font-semibold text-[var(--ink)]">{s.itemName}</span> at {s.warehouseName}: {s.reason}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-center">
            <button type="button" onClick={() => { setResult(null); refresh(); }} className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)]">
              <RefreshCw className="h-3.5 w-3.5" /> Back to workbench
            </button>
            <button type="button" onClick={() => router.push("/dashboard/purchase-requests")} className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90">
              View purchase requests
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Freshness + filters + generate */}
      {/* lg:flex-wrap is load-bearing — without it this becomes a single unwrappable row at lg and
          above, and with a search box, four selects, two checkboxes, a timestamp and two buttons it
          overflowed the card at 1024px: "Critical only" and "Show covered" were clipped off the
          right edge with no way to reach them. Wrapping costs a second line; clipping costs the
          control entirely. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item, code or SKU…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <Select size="sm" value={warehouseFilter} onChange={setWarehouseFilter} options={[{ value: "", label: "All warehouses" }, ...warehouseOptions]} ariaLabel="Filter by warehouse" />
        {supplierOptions.length > 0 && (
          <Select size="sm" value={supplierFilter} onChange={setSupplierFilter} options={[{ value: "", label: "All suppliers" }, ...supplierOptions]} ariaLabel="Filter by supplier" />
        )}
        {categoryOptions.length > 0 && (
          <Select size="sm" value={categoryFilter} onChange={setCategoryFilter} options={[{ value: "", label: "All categories" }, ...categoryOptions]} ariaLabel="Filter by category" />
        )}
        <Select size="sm" value={reasonFilter} onChange={setReasonFilter} options={[{ value: "", label: "All reasons" }, ...(Object.keys(REASON_LABELS) as ReorderReason[]).map((r) => ({ value: r, label: REASON_LABELS[r] }))]} ariaLabel="Filter by reason" />
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--muted)]" title="Show only items at or below their critical level">
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} className="h-4 w-4 accent-[var(--neg)]" />
          Critical only
        </label>
        {coveredCount > 0 && (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--muted)]" title="Also show items that are low but already covered by incoming stock — nothing to buy">
            <input type="checkbox" checked={showCovered} onChange={(e) => setShowCovered(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Show covered ({coveredCount})
          </label>
        )}
        <div className="flex items-center gap-2 lg:ml-auto">
          {/* The timestamp and the Refresh label drop below xl. Both are the least load-bearing things
              in this row — the timestamp is informational, and Refresh keeps its icon, title and
              aria-label — so shedding them buys width for the controls that actually filter. */}
          {data && <span className="hidden whitespace-nowrap text-[11px] text-[var(--faint)] xl:inline">Last calculated {fmtTime(data.calculatedAt)}</span>}
          <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60" title={data ? `Recalculate suggestions — last calculated ${fmtTime(data.calculatedAt)}` : "Recalculate suggestions"}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} <span className="hidden xl:inline">Refresh</span>
          </button>
          {canGenerate && (
            <button type="button" onClick={() => { setRequiredBy(""); setConfirmOpen(true); }} disabled={chosen.length === 0} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-50">
              {/* The COUNT always shows — it's the feedback for what you've selected — but the long
                  label shortens below xl. "Generate Purchase Requests (12)" is the single widest
                  thing in this row. */}
              <ClipboardList className="h-4 w-4" />{" "}
              <span className="hidden xl:inline">Generate Purchase Requests</span>
              <span className="xl:hidden">Generate</span>
              {chosen.length > 0 ? ` (${chosen.length})` : ""}
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {loading && !data ? (
          <div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => (<Skeleton key={i} className="h-8 w-full" />))}</div>
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <CheckCircle2 className="h-8 w-8 text-[var(--pos)]" />
            {(() => {
              const all = data?.suggestions ?? [];
              // Nothing at all triggered — every item is comfortably above its reorder level.
              if (all.length === 0)
                return (
                  <>
                    <p className="text-sm font-semibold text-[var(--ink)]">Everything is above reorder level</p>
                    <p className="text-xs text-[var(--muted)]">No purchase requests required.</p>
                  </>
                );
              // Something triggered but nothing is on screen. If there ARE actionable rows, the user's
              // filters are hiding them; if there are none, the only rows are "covered" (low but already
              // on the way) — hidden by default, reachable via the Show-covered toggle, NOT the filters.
              const hasActionable = all.some((s) => !s.covered);
              if (!hasActionable)
                return (
                  <>
                    <p className="text-sm font-semibold text-[var(--ink)]">Nothing needs reordering right now</p>
                    <p className="text-xs text-[var(--muted)]">
                      {coveredCount > 0 && !showCovered
                        ? `${coveredCount} low item${coveredCount === 1 ? "" : "s"} already covered by incoming stock — turn on “Show covered” to view.`
                        : "Every low item is already covered by incoming stock."}
                    </p>
                  </>
                );
              return (
                <>
                  <p className="text-sm font-semibold text-[var(--ink)]">No suggestions match the filters</p>
                  <p className="text-xs text-[var(--muted)]">Clear the filters to see the full list.</p>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="w-10 px-3 py-3">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" className="h-4 w-4 accent-[var(--accent)]" />
                  </th>
                  <th className="px-3 py-3">Item</th>
                  <th className="px-3 py-3">Warehouse</th>
                  <th className="px-3 py-3 text-right">On hand</th>
                  <th className="px-3 py-3 text-right">Available</th>
                  <th className="px-3 py-3 text-right">On order</th>
                  <th className="px-3 py-3 text-right">Open PRF</th>
                  <th className="px-3 py-3 text-right" title="Active jobs' planned-but-unissued kit quantity drawing from this warehouse">Planned</th>
                  <th className="px-3 py-3 text-right">Projected</th>
                  <th className="px-3 py-3 text-right">Reorder lvl</th>
                  <th className="px-3 py-3">Suggested</th>
                  <th className="px-3 py-3">Reason</th>
                  <th className="px-3 py-3">Supplier</th>
                  <th className="w-8 px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const key = rowKey(s);
                  const selectable = orderable(s);
                  const isOpen = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr className={`border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]/60 ${s.covered ? "opacity-60" : ""}`}>
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                            disabled={!selectable}
                            aria-label={`Select ${s.itemName}`}
                            title={
                              selectable
                                ? undefined
                                : s.covered
                                  ? "Already covered by incoming stock — nothing to order"
                                  : s.primarySupplier
                                    ? "Primary supplier is inactive — reactivate it or set another on the item"
                                    : "Set a primary supplier on the item first"
                            }
                            className="h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-[var(--ink)]">{s.itemName}</div>
                          <div className="font-mono text-[11px] text-[var(--faint)]">{s.itemCode}{s.sku ? ` · ${s.sku}` : ""}</div>
                        </td>
                        <td className="px-3 py-2.5 text-[var(--muted)]">{s.warehouseName}</td>
                        <td className={`px-3 py-2.5 text-right font-semibold ${s.onHand < 0 ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>{s.onHand}</td>
                        <td className="px-3 py-2.5 text-right text-[var(--muted)]">{s.available}</td>
                        <td className="px-3 py-2.5 text-right text-[var(--muted)]">{s.incoming > 0 ? `+${s.incoming}` : "—"}</td>
                        <td className="px-3 py-2.5 text-right text-[var(--muted)]">{s.openPrf > 0 ? s.openPrf : "—"}</td>
                        <td className="px-3 py-2.5 text-right text-[var(--muted)]">{s.plannedDemand > 0 ? `−${s.plannedDemand}` : "—"}</td>
                        <td className={`px-3 py-2.5 text-right font-semibold ${s.projected < 0 ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>{s.projected}</td>
                        <td className="px-3 py-2.5 text-right text-[var(--muted)]">{s.reorderLevel ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          {s.covered ? (
                            <span className="text-[var(--faint)]" title="Already covered by incoming stock — nothing to order">—</span>
                          ) : (
                            <NumberInput
                              className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                              min={1}
                              step={1}
                              value={qtyOverrides[key] ?? String(s.suggestedQty)}
                              onChange={(e) => setQtyOverrides((prev) => ({ ...prev, [key]: e.target.value }))}
                              aria-label={`Quantity for ${s.itemName}`}
                            />
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {s.covered ? (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-[var(--pos)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--pos)]" title="Physically low but already covered by incoming stock">Covered</span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              {s.critical && s.reason !== "negative_stock" && s.reason !== "out_of_stock" && (
                                <span className="inline-flex whitespace-nowrap rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--neg)]" title="At or below the item's critical level">Critical</span>
                              )}
                              <ReasonBadge reason={s.reason} />
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {s.primarySupplier ? (
                            s.primarySupplier.status === "active" ? (
                              <span className="text-[var(--muted)]">{s.primarySupplier.name}</span>
                            ) : (
                              <span className="text-[11px] font-semibold text-[var(--warn,#d97706)]" title="Primary supplier is inactive — reactivate it or set another on the item to enable generation.">
                                {s.primarySupplier.name} · inactive
                              </span>
                            )
                          ) : (
                            <span className="text-[11px] font-semibold text-[var(--warn,#d97706)]" title="This item has no primary supplier — set one on the IRM item to enable generation.">No supplier</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <button type="button" onClick={() => setExpanded(isOpen ? null : key)} aria-label="Show calculation" className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]">
                            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]/40 last:border-0">
                          <td colSpan={14} className="p-0"><BreakdownRow s={s} /></td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirm — preview the supplier × warehouse grouping before anything is created. */}
      <Modal
        open={confirmOpen}
        title="Generate purchase requests?"
        subtitle="One draft request per supplier × warehouse. Every row is re-checked against live stock on generation."
        onClose={generating ? () => {} : () => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={generating} className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60">
              Cancel
            </button>
            <button type="button" onClick={generate} disabled={generating || groups.length === 0} className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60">
              {generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Generate {groups.length} draft{groups.length === 1 ? "" : "s"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
            {groups.map((g, i) => (
              <div key={i} className="px-3.5 py-2.5 text-xs">
                <p className="font-bold text-[var(--ink)]">{g.supplierName} → {g.warehouseName}</p>
                <p className="mt-0.5 text-[var(--muted)]">
                  {g.rows.map((r) => `${r.itemName} × ${qtyOf(r)}`).join(" · ")}
                </p>
              </div>
            ))}
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-[var(--ink)]">Required-by date (optional)</label>
            <input type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
            <p className="mt-1 text-[11px] text-[var(--faint)]">Leave blank to use each supplier&apos;s lead time (fallback 14 days). Editable on the draft afterwards.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
