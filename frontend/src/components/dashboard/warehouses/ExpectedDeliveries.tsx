"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronDown, ListFilter, PackageCheck, Truck } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import { listPurchaseOrders } from "@/services/purchase-order.service";
import { useAuth } from "@/hooks/useAuth";
import { PO_PRIORITY_LABELS, PoStatusBadge, formatDate } from "@/components/dashboard/purchase-orders/poStatus";
import type { PurchaseOrder } from "@/types/purchase-order";

const PAGE_SIZE = 20;

// Warehouse Manager worklist: "what's arriving here that I still need to receive?".
// A READ over existing PO data — Sent / Partially-received POs delivering to THIS warehouse with
// outstanding quantity, grouped into ERP time buckets (overdue → future). Each row's Receive
// deep-links into the one GRN pipeline; no stock is posted here. Warehouse-scoping is enforced
// server-side by listPurchaseOrders.
export type Bucket = "overdue" | "nodate" | "today" | "tomorrow" | "upcoming" | "future";

type Row = {
  po: PurchaseOrder;
  ordered: number;
  remaining: number;
  bucket: Bucket;
  daysDiff: number | null; // calendar-days from today (negative = overdue); null = no date at all
  dateIso: string | null; // the date actually planned against (confirmed if the supplier gave one)
  confirmed: boolean; // true = supplier-confirmed, not just our expectation
};

// Only two live tones: urgent (red) and everything else. An earlier four-value scale had "ink"
// render as plain body black, which made the Tomorrow option look MORE prominent than the accented
// Today one — a hierarchy that ran backwards in the middle.
type Tone = "neg" | "neutral";

// Fixed order + labels. Overdue first so the WM sees the urgent work immediately, then No date —
// an order with no ETA is an action item (chase the supplier), NOT the least urgent thing on the
// list, so it sits near the top rather than buried under the dated ones. This order drives BOTH
// the filter menu and the default row sort.
//
// `label: null` means the bucket is never named in the UI. `upcoming`/`future` exist purely to
// sort rows: tagging a row dated 05 Aug as "Future" states the same fact twice, and phrasing it
// two ways ("Future" / "next 7 days") reads as two different things — the confusion that prompted
// this redesign. Null (rather than a flag) makes rendering them accidentally a type error. Their
// rows are still listed under "All" and counted by it — they're just never named.
const BUCKETS: { key: Bucket; label: string | null; tone: Tone }[] = [
  { key: "overdue", label: "Overdue", tone: "neg" },
  { key: "nodate", label: "No date", tone: "neg" },
  { key: "today", label: "Today", tone: "neutral" },
  { key: "tomorrow", label: "Tomorrow", tone: "neutral" },
  { key: "upcoming", label: null, tone: "neutral" },
  { key: "future", label: null, tone: "neutral" },
];

// "All" is a real filter value, not a null — so the menu options, the active state and the filter
// itself all speak one vocabulary rather than juggling `Bucket | null`.
export type Filter = Bucket | "all";

// The single source of row ordering. Rows sort by this so the urgent work leads the first page
// regardless of the active filter.
export const BUCKET_ORDER: Bucket[] = BUCKETS.map((b) => b.key);

const TONE_TEXT: Record<Tone, string> = {
  neg: "text-[var(--neg)]",
  neutral: "text-[var(--muted)]",
};

const DAY_MS = 86_400_000;

// The date the warehouse should actually plan against: once the supplier has CONFIRMED a date that
// promise supersedes the buyer's original expectation, otherwise fall back to what was expected.
// Both fields are kept distinct on the PO (expectation vs. promise) — this only picks which to show.
export function effectiveDate(po: Pick<PurchaseOrder, "expectedDeliveryDate" | "confirmedDeliveryDate">): {
  iso: string | null;
  confirmed: boolean;
} {
  if (po.confirmedDeliveryDate) return { iso: po.confirmedDeliveryDate, confirmed: true };
  return { iso: po.expectedDeliveryDate, confirmed: false };
}

// Classify a delivery date against the start of today. A missing date is NOT "far future" — nobody
// has committed to a delivery at all, so it gets its own bucket that sorts near the top.
export function classify(iso: string | null, todayMs: number): { bucket: Bucket; daysDiff: number | null } {
  if (!iso) return { bucket: "nodate", daysDiff: null };
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - todayMs) / DAY_MS);
  if (diff < 0) return { bucket: "overdue", daysDiff: diff };
  if (diff === 0) return { bucket: "today", daysDiff: 0 };
  if (diff === 1) return { bucket: "tomorrow", daysDiff: 1 };
  if (diff <= 7) return { bucket: "upcoming", daysDiff: diff };
  return { bucket: "future", daysDiff: diff };
}

// ONE authoritative count per bucket across the WHOLE worklist. The filter menu reads from this,
// so an option's count always describes the entire worklist — never just the page on screen.
export function countBuckets(rows: Pick<Row, "bucket">[]): Map<Bucket, number> {
  const counts = new Map<Bucket, number>();
  for (const r of rows) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);
  return counts;
}

// Which options the filter menu offers, in fixed urgency order, after "All".
//
// ONLY labelled (= urgent) buckets get an option. This week / Future are deliberately absent:
// naming them anywhere in the UI is what caused the original confusion — a row dated 05 Aug
// labelled "Future" (or 24 Jul labelled "next 7 days") states the same fact twice, and the two
// phrasings read as if they meant different things. Those rows still appear under "All",
// identified by their date.
//
// Empty buckets are dropped too — an option reading "Overdue 0" leads only to an empty table.
//
// "All" derives its count from `totals` rather than taking it as a parameter: the two can't then
// disagree, so All cannot claim a number the bucket options don't add up to.
export function filterOptions(totals: Map<Bucket, number>) {
  const total = [...totals.values()].reduce((n, c) => n + c, 0);
  return [
    { key: "all" as Filter, label: "All", count: total, tone: "neutral" as Tone },
    ...BUCKETS.filter((b) => b.label !== null && (totals.get(b.key) ?? 0) > 0).map((b) => ({
      key: b.key as Filter,
      label: b.label as string,
      count: totals.get(b.key) ?? 0,
      tone: b.tone,
    })),
  ];
}

// Filter + paginate in one place, so the page count can never be computed from a different row set
// than the rows rendered. `page` is clamped rather than trusted: switching to a filter with fewer
// rows while sitting on page 3 must not render a blank table.
export function filterRows<T extends Pick<Row, "bucket">>(
  allRows: T[],
  filter: Filter,
  page: number,
  pageSize = PAGE_SIZE,
): { rows: T[]; totalPages: number; matchCount: number } {
  const matched = filter === "all" ? allRows : allRows.filter((r) => r.bucket === filter);
  const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { rows: matched.slice(start, start + pageSize), totalPages, matchCount: matched.length };
}

// The per-row urgency badge, sitting next to the date.
//
// ONLY overdue. Every other bucket's badge would restate the date cell it sits beside: a "Today"
// badge next to today's date, a "No date" badge next to "Not set", a "Future" badge next to
// 05 Aug. Overdue is the sole case that adds information — *how far* past due, which the date
// alone doesn't give you at a glance. (The bucket is still how you filter; it just isn't repeated
// on the row.)
export function urgencyBadge(row: Pick<Row, "bucket" | "daysDiff">): string | null {
  if (row.bucket !== "overdue" || row.daysDiff == null) return null;
  return `${-row.daysDiff}d late`;
}

// Clear, sized to sit beside FilterMenu's trigger. Deliberately NOT the shared `toolbarBtn` — this
// pool filters with a pill (`rounded-full`, `py-1.5`, 11px) rather than the search + `<Select
// size="sm">` row the rest of the dashboard uses, and a `rounded-lg` button next to a pill reads as
// two unrelated controls. Kept local: this is the only pill toolbar in the app, so there is nothing
// yet to share it with. If a second one appears, promote both this and the trigger into styles.ts.
const filterPillBtn =
  "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]";

// Single-select bucket filter. A dropdown rather than a row of chips: chips needed a full row
// of their own directly above the table, while the toolbar row above them sat half-empty — and the
// counts they carried are reference data, not something you read on every glance. Collapsed, the
// trigger states only the ACTIVE filter; the counts live one click away, all visible at once.
//
// Keyboard: ↑/↓ move the active option, Enter/Space selects, Esc closes, Home/End jump. Click
// outside closes. Follows MultiSelect's conventions (useId, mousedown-to-close, --radius).
function FilterMenu({
  options,
  value,
  onChange,
}: {
  options: ReturnType<typeof filterOptions>;
  value: Filter;
  onChange: (f: Filter) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  const selectedIndex = Math.max(0, options.findIndex((c) => c.key === value));
  const current = options[selectedIndex] ?? options[0];
  // Clamp at render — `options` shrinks as buckets empty out, so a stored index can outlive its option.
  const active = Math.min(activeIndex, Math.max(0, options.length - 1));

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    setActiveIndex(selectedIndex); // highlight starts on the current filter, not the top
    setOpen(true);
    queueMicrotask(() => listRef.current?.focus());
  };

  const choose = (f: Filter) => {
    onChange(f);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openMenu();
      else setActiveIndex(Math.min(active + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (open) setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && options[active]) choose(options[active].key);
      else if (!open) openMenu();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Filter deliveries: ${current?.label ?? "All"}`}
        className={`inline-flex items-center gap-1.5 rounded-full border bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-bold transition-all ${
          open ? "border-[var(--accent)]" : "border-[var(--border)] hover:border-[var(--muted)]"
        } ${current && current.key !== "all" ? TONE_TEXT[current.tone] : "text-[var(--muted)]"}`}
      >
        <ListFilter className="h-3.5 w-3.5 shrink-0" />
        {current?.label ?? "All"}
        <span className="opacity-70">{current?.count ?? 0}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="Filter deliveries"
          onKeyDown={onKeyDown}
          className="absolute right-0 z-50 mt-1.5 min-w-[13rem] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-2xl outline-none"
          style={{ borderRadius: "var(--radius)" }}
        >
          {options.map((c, i) => {
            const isSelected = c.key === value;
            return (
              <div
                key={c.key}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(c.key)}
                className={`flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs transition-colors ${
                  i === active ? "bg-[var(--surface-2)]" : ""
                } ${c.key !== "all" ? TONE_TEXT[c.tone] : "text-[var(--ink)]"} ${isSelected ? "font-bold" : "font-semibold"}`}
              >
                <span className="inline-flex items-center gap-1.5 truncate">
                  <Check className={`h-3.5 w-3.5 shrink-0 ${isSelected ? "opacity-100" : "opacity-0"}`} />
                  {c.label}
                </span>
                <span className="shrink-0 tabular-nums opacity-70">{c.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// First-load placeholder mirroring the table so there's no layout shift, and matching the sibling
// Received/GRN list's loading style (skeleton rows, not a spinner). No placeholder for the filter
// menu: it lives in the parent's toolbar row, which is already laid out and doesn't reflow when
// the menu appears.
function WorklistSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="cell-y px-4">Purchase order</th>
                <th className="cell-y px-4">Supplier</th>
                <th className="cell-y px-4">Delivery date</th>
                <th className="cell-y px-4">Priority</th>
                <th className="cell-y px-4">Remaining</th>
                <th className="cell-y px-4" />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// MUST be mounted with `key={warehouseId}` — all state below (rows, error, page, filter) is
// per-warehouse, and remounting is how it resets. Resetting it inside the load effect instead
// would mean setState in an effect body, i.e. a cascading render on every warehouse switch.
//
// `filterSlot` is an element in the parent's toolbar row to portal the filter menu into. The menu
// belongs to this component — only it has the rows the option counts are derived from — but it
// reads better up in the toolbar's empty middle than on a row of its own above the table. Null
// (slot not mounted yet, or caller doesn't offer one) falls back to rendering it in place.
export function ExpectedDeliveries({
  warehouseId,
  warehouseCode,
  filterSlot,
}: {
  warehouseId: string;
  warehouseCode?: string;
  filterSlot?: HTMLElement | null;
}) {
  // Where the GRN form returns to when opened from here — back to THIS warehouse's Incoming-stock
  // tab, not the global GRN list (so a warehouse user never gets dumped out of their warehouse).
  const returnTo = warehouseCode ? `/dashboard/warehouses/${warehouseCode}?tab=incoming` : undefined;
  const receiveHref = (poId: string) =>
    `/dashboard/goods-in/new?po=${poId}&warehouse=${warehouseId}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  const router = useRouter();
  const { can } = useAuth();
  const canReceive = can("goods_in.create");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  // Always "all" on open — a view that silently preselects a filter makes an empty-looking table
  // ambiguous ("no deliveries" vs. "none in this bucket"), and the menu puts the urgent work one
  // click away regardless.
  const [filter, setFilter] = React.useState<Filter>("all");
  // Bumped by Retry to re-run the load effect. A transient network failure shouldn't cost the user
  // a full page reload to recover from.
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    const statuses = ["sent", "supplier_accepted", "partially_received"];
    (async () => {
      try {
        // Load EVERY open PO for this warehouse — not just the first page. The backend caps pageSize
        // at 100, so page through (pages 2..N fetched in parallel) instead of silently truncating the
        // worklist and undercounting the filter menu when a warehouse has >100 open POs.
        const first = await listPurchaseOrders({ warehouse: warehouseId, statuses, pageSize: 100, page: 1 });
        let pos = first.purchaseOrders;
        if (first.totalPages > 1) {
          const rest = await Promise.all(
            Array.from({ length: first.totalPages - 1 }, (_, i) =>
              listPurchaseOrders({ warehouse: warehouseId, statuses, pageSize: 100, page: i + 2 }),
            ),
          );
          pos = pos.concat(...rest.map((r) => r.purchaseOrders));
        }
        if (!active) return;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayMs = today.getTime();
        const built = pos
          .map((po): Row => {
            const ordered = po.items.reduce((s, i) => s + i.quantity, 0);
            const remaining = po.items.reduce((s, i) => s + Math.max(0, i.quantity - i.receivedQuantity), 0);
            const { iso, confirmed } = effectiveDate(po);
            const { bucket, daysDiff } = classify(iso, todayMs);
            return { po, ordered, remaining, bucket, daysDiff, dateIso: iso, confirmed };
          })
          .filter((r) => r.remaining > 0)
          // Sort by BUCKET first, then by date within the bucket. Sorting on date alone can't place
          // undated rows correctly — any sentinel date puts them either above the overdue rows or
          // below the furthest-out ones, when they belong near the top as an action item. Sorting
          // this way also keeps the urgent work on page 1 of the unfiltered view.
          .sort((a, b) => {
            const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
            if (byBucket !== 0) return byBucket;
            return (a.dateIso ? Date.parse(a.dateIso) : 0) - (b.dateIso ? Date.parse(b.dateIso) : 0);
          });
        setRows(built);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load expected deliveries.");
      }
    })();
    return () => { active = false; };
  }, [warehouseId, reloadKey]);

  const bucketTotals = React.useMemo(() => countBuckets(rows ?? []), [rows]);

  const options = React.useMemo(() => filterOptions(bucketTotals), [bucketTotals]);

  // A realtime reload can empty the currently-selected bucket; its option then vanishes. Derive the
  // filter actually in effect so the rows shown and the trigger label always agree — falling back to
  // "all" when the stored pick has no option. (Derived, not stored: if the bucket refills the pick
  // comes back, and the explicit "Show all" control still resets it for good.)
  const effectiveFilter: Filter = options.some((o) => o.key === filter) ? filter : "all";

  // One reset used by both the toolbar's Clear and the filtered-empty row's "Show all", so the two
  // can't drift apart.
  const clearFilter = () => {
    setFilter("all");
    setPage(1);
  };

  const { rows: pageRows, totalPages, matchCount } = React.useMemo(
    () => filterRows(rows ?? [], effectiveFilter, page),
    [rows, effectiveFilter, page],
  );

  // Matches the empty state's card treatment rather than a bare line of red text, and offers the
  // retry that a transient fetch failure calls for.
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <AlertTriangle className="h-7 w-7 text-[var(--neg)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">Could not load expected deliveries</p>
        <p className="text-xs text-[var(--muted)]">{error}</p>
        <button
          type="button"
          onClick={() => { setError(null); setReloadKey((k) => k + 1); }}
          className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }
  if (rows === null) return <WorklistSkeleton />;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <Truck className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No expected deliveries</p>
        <p className="text-xs text-[var(--muted)]">Purchase orders sent to this warehouse will appear here to receive.</p>
      </div>
    );
  }

  // Only offered when there's more than one thing to pick — with a single bucket the menu would
  // offer just "All", i.e. a control that can't change anything.
  //
  // The Clear button appears only while a bucket is actually in effect. Without it the only way
  // back to the full worklist was to reopen the menu and pick "All" — fine, but two steps for the
  // most common thing you do after filtering, and the Customer pool beside this one clears in a
  // single click. Keyed off `effectiveFilter`, not `filter`, so it never offers to clear a pick
  // that has already fallen back to "all" because its bucket emptied.
  const menu = options.length > 1
    ? (
      <div className="flex items-center gap-2">
        <FilterMenu options={options} value={effectiveFilter} onChange={(f) => { setFilter(f); setPage(1); }} />
        {effectiveFilter !== "all" && (
          <button type="button" onClick={clearFilter} className={filterPillBtn}>
            Clear
          </button>
        )}
      </div>
    )
    : null;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Into the parent's toolbar when it lends us a slot, otherwise in place above the table. */}
      {menu && (filterSlot ? createPortal(menu, filterSlot) : <div className="flex shrink-0 justify-end">{menu}</div>)}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="cell-y px-4">Purchase order</th>
                <th className="cell-y px-4">Supplier</th>
                <th className="cell-y px-4">Delivery date</th>
                <th className="cell-y px-4">Priority</th>
                <th className="cell-y px-4">Remaining</th>
                <th className="cell-y px-4" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const { po, ordered, remaining } = row;
                const badge = urgencyBadge(row);
                return (
                  <tr key={po.id} className="border-b border-[var(--border)] align-top last:border-0">
                    <td className="cell-y px-4">
                      <PoCodeLink code={po.code} className="font-mono text-xs font-bold text-[var(--accent)]" />
                      <div className="mt-1"><PoStatusBadge status={po.status} /></div>
                    </td>
                    <td className="cell-y px-4 font-semibold text-[var(--ink)]">{po.supplierName ?? po.supplier?.name ?? "—"}</td>
                    <td className="cell-y px-4">
                      {row.dateIso ? (
                        <>
                          <span className={row.bucket === "overdue" ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}>{formatDate(row.dateIso)}</span>
                          {/* Distinguish a date the supplier actually committed to from our own estimate. */}
                          {row.confirmed && (
                            <span className="ml-1.5 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--muted)]" title="Confirmed by the supplier">
                              Confirmed
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="font-semibold text-[var(--neg)]">Not set</span>
                      )}
                      {/* Carries the urgency the group header used to convey — now per row, so it
                          survives filtering and sorting without a header to anchor it. */}
                      {badge && <span className="ml-1.5 rounded-full bg-[var(--neg)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--neg)]">{badge}</span>}
                    </td>
                    <td className="cell-y px-4 text-xs text-[var(--muted)]">{PO_PRIORITY_LABELS[po.priority]}</td>
                    <td className="cell-y px-4">
                      <span className="font-bold text-[var(--ink)]">{remaining}</span>
                      <span className="text-[var(--muted)]"> / {ordered} remaining</span>
                    </td>
                    <td className="cell-y px-4">
                      {canReceive && (
                        <button
                          type="button"
                          onClick={() => router.push(receiveHref(po.id))}
                          className="flex items-center gap-1.5 rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90"
                        >
                          <PackageCheck className="h-3.5 w-3.5" /> Receive
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {/* Only reachable via the filter — the whole-worklist empty case returns earlier. Says
                  which filter is hiding the rows, so it never reads as "nothing to receive". */}
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--muted)]">
                    No deliveries in this view.{" "}
                    <button type="button" onClick={clearFilter} className="font-semibold text-[var(--accent)] hover:underline">
                      Show all
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <Pagination
            embedded
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            total={matchCount}
            label="deliveries"
            onPage={setPage}
          />
        </div>
      </div>
    </div>
  );
}
