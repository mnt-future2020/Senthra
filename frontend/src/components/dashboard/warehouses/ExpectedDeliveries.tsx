"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Calendar, CalendarClock, CalendarDays, CalendarOff, CalendarRange, PackageCheck, Truck } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
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

type Tone = "neg" | "accent" | "ink" | "muted";

// Fixed render order + labels + accent. Overdue first so the WM sees the urgent work immediately,
// then No date — an order with no ETA is an action item (chase the supplier), NOT the least urgent
// thing on the list, so it sits near the top rather than buried under Future.
// Icons are lucide (matching the rest of the app/design system) — a cohesive calendar family, with
// AlertTriangle flagging overdue; each tinted to its bucket tone in the group header.
const BUCKETS: { key: Bucket; icon: React.ComponentType<{ className?: string }>; label: string; word: string; tone: Tone }[] = [
  { key: "overdue", icon: AlertTriangle, label: "Overdue", word: "overdue", tone: "neg" },
  { key: "nodate", icon: CalendarOff, label: "No delivery date", word: "with no date", tone: "neg" },
  { key: "today", icon: CalendarClock, label: "Today", word: "today", tone: "accent" },
  { key: "tomorrow", icon: CalendarDays, label: "Tomorrow", word: "tomorrow", tone: "ink" },
  { key: "upcoming", icon: CalendarRange, label: "Upcoming (next 7 days)", word: "upcoming", tone: "muted" },
  { key: "future", icon: Calendar, label: "Future", word: "future", tone: "muted" },
];

// The single source of ordering: rows sort by this, and group headers render in this order, so a
// paginated slice can never disagree with the headers above it.
export const BUCKET_ORDER: Bucket[] = BUCKETS.map((b) => b.key);

const TONE_TEXT: Record<Tone, string> = {
  neg: "text-[var(--neg)]",
  accent: "text-[var(--accent)]",
  ink: "text-[var(--ink)]",
  muted: "text-[var(--muted)]",
};
const GROUP_BG: Record<Tone, string> = {
  neg: "bg-[var(--neg)]/10",
  accent: "bg-[var(--accent)]/10",
  ink: "bg-[var(--surface-2)]",
  muted: "bg-[var(--surface-2)]",
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

// ONE authoritative count per bucket across the WHOLE worklist. Both the summary line and the
// table's group headers read from this, so the two can never disagree.
export function countBuckets(rows: Pick<Row, "bucket">[]): Map<Bucket, number> {
  const counts = new Map<Bucket, number>();
  for (const r of rows) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);
  return counts;
}

// Client-side pagination: slice the flat rows array for the current page, then re-group the slice
// so bucket headers only appear for buckets present on that page. Each group carries its FULL
// bucket count as `total` — a header counting only the current page contradicts the summary line
// above it ("Overdue (20)" on page 1 and "(7)" on page 2 for the same 27 orders).
export function paginateGroups<T extends Pick<Row, "bucket">>(
  allRows: T[],
  page: number,
  totals: Map<Bucket, number>,
  pageSize = PAGE_SIZE,
): { pagedGroups: ((typeof BUCKETS)[number] & { rows: T[]; total: number })[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = allRows.slice(start, start + pageSize);
  const pagedGroups = BUCKETS.map((b) => ({
    ...b,
    rows: slice.filter((r) => r.bucket === b.key),
    total: totals.get(b.key) ?? 0,
  })).filter((g) => g.rows.length > 0);
  return { pagedGroups, totalPages };
}

// Urgency tag next to the date — ONLY for overdue, where it adds the "how late" detail the
// group header can't convey. Today/Tomorrow/Upcoming/Future would just repeat their section
// header, so no tag there (avoids redundant "Tomorrow · Tomorrow").
function relTag(row: Row): { text: string; tone: Tone } | null {
  if (row.bucket === "overdue" && row.daysDiff != null) return { text: `${-row.daysDiff}d late`, tone: "neg" };
  return null;
}

// First-load placeholder mirroring the worklist (summary card + table) so there's no layout shift,
// and the loading style matches the sibling Received/GRN list (skeleton rows, not a spinner).
function WorklistSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="mt-2 h-4 w-48" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Purchase order</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Remaining</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ExpectedDeliveries({ warehouseId, warehouseCode }: { warehouseId: string; warehouseCode?: string }) {
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

  React.useEffect(() => {
    let active = true;
    const statuses = ["sent", "supplier_accepted", "partially_received"];
    (async () => {
      try {
        // Load EVERY open PO for this warehouse — not just the first page. The backend caps pageSize
        // at 100, so page through (pages 2..N fetched in parallel) instead of silently truncating the
        // worklist and miscounting the Delivery Summary when a warehouse has >100 open POs.
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
          // Sort by BUCKET first, then by date within the bucket. Sorting on date alone can't
          // place undated rows correctly (any sentinel puts them either above Overdue or below
          // Future), and because pagination slices this flat array, a row's page must match the
          // group order it renders in — so the two must derive from the same ordering.
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
  }, [warehouseId]);

  const bucketTotals = React.useMemo(() => countBuckets(rows ?? []), [rows]);

  // Non-empty buckets in fixed order — drives the summary line.
  const groups = React.useMemo(
    () => BUCKETS.map((b) => ({ ...b, count: bucketTotals.get(b.key) ?? 0 })).filter((g) => g.count > 0),
    [bucketTotals],
  );

  const { pagedGroups, totalPages } = React.useMemo(() => paginateGroups(rows ?? [], page, bucketTotals), [rows, page, bucketTotals]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
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

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Delivery Summary — instant situational awareness in plain operational language. */}
      <div className="shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Delivery Summary</h3>
        <p className="mt-1 text-sm">
          {groups.map((b, i) => (
            <React.Fragment key={b.key}>
              {i > 0 && <span className="text-[var(--faint)]"> · </span>}
              <span className={b.key === "overdue" || b.key === "nodate" ? "font-bold text-[var(--neg)]" : `font-semibold ${TONE_TEXT[b.tone === "muted" ? "ink" : b.tone]}`}>
                {b.count} {b.word}
              </span>
            </React.Fragment>
          ))}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Purchase order</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Remaining</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {pagedGroups.map((b) => {
                const groupRows = b.rows;
                const Icon = b.icon;
                return (
                  <React.Fragment key={b.key}>
                    <tr className={GROUP_BG[b.tone]}>
                      <td colSpan={6} className={`px-4 py-2 ${TONE_TEXT[b.tone]}`}>
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider">
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          {b.label}{" "}
                          <span className="opacity-70">
                            ({b.total}
                            {/* Only when this page holds part of the bucket — otherwise the count alone is exact. */}
                            {groupRows.length < b.total ? ` · ${groupRows.length} on this page` : ""})
                          </span>
                        </span>
                      </td>
                    </tr>
                    {groupRows.map((row) => {
                      const { po, ordered, remaining } = row;
                      const tag = relTag(row);
                      return (
                        <tr key={po.id} className="border-b border-[var(--border)] align-top last:border-0">
                          <td className="px-4 py-3">
                            <a href={`/dashboard/purchase-orders/${po.code}`} className="font-mono text-xs font-bold text-[var(--accent)] hover:underline">{po.code}</a>
                            <div className="mt-1"><PoStatusBadge status={po.status} /></div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-[var(--ink)]">{po.supplierName ?? po.supplier?.name ?? "—"}</td>
                          <td className="px-4 py-3">
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
                            {tag && <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${GROUP_BG[tag.tone]} ${TONE_TEXT[tag.tone]}`}>{tag.text}</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-[var(--muted)]">{PO_PRIORITY_LABELS[po.priority]}</td>
                          <td className="px-4 py-3">
                            <span className="font-bold text-[var(--ink)]">{remaining}</span>
                            <span className="text-[var(--muted)]"> / {ordered} remaining</span>
                          </td>
                          <td className="px-4 py-3">
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
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="shrink-0">
        <Pagination
          page={Math.min(page, totalPages)}
          totalPages={totalPages}
          total={rows.length}
          label="deliveries"
          onPage={setPage}
        />
      </div>
    </div>
  );
}
