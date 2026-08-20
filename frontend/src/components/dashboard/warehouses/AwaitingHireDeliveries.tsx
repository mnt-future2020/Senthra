"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, PackageCheck } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import type { OnHireLine } from "@/types/rental";

// The warehouse's HIRE receiving queue: supplier-owned equipment on its way here, waiting for somebody
// to confirm it arrived.
//
// A separate pane from Company (GRN) on purpose, and the label says so. A goods receipt ends in an
// inventory balance and a stock movement; hired kit never becomes our stock, so it is booked in as a
// hire delivery instead. Putting the two behind one pill would be the first step towards a GRN for
// equipment we do not own — which is the boundary the backend enforces at build time.
//
// Presented as its NEIGHBOUR is — ExpectedDeliveries, the Company pane one pill away: the same card,
// the same header row, a table-shaped skeleton, and the same empty and error states. Two panes behind
// one toggle that look like two different apps is the inconsistency a user actually feels.

const PAGE_SIZE = 20;

const shortDate = (iso: string) =>
  // UTC: a hire date is a calendar day stored as UTC midnight, and formatting it in the viewer's zone
  // shows the previous day for anyone behind UTC.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

const COLUMNS = ["Item", "Order", "Hire from", "Delivering to", "Expected units", ""] as const;

function HeaderRow() {
  return (
    <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
      {COLUMNS.map((c, i) => (
        <th key={i} className="cell-y px-4">
          {c}
        </th>
      ))}
    </tr>
  );
}

/** Mirrors the table so the first load causes no layout shift — the sibling pane's own approach. */
function QueueSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <HeaderRow />
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {COLUMNS.map((_c, j) => (
                    <td key={j} className="cell-y px-4">
                      <Skeleton className="h-3 w-20" />
                    </td>
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

// MUST be mounted with `key={warehouseId}` — the rows, error and page below are per-warehouse, and
// remounting is how they reset. Resetting inside the load effect would be a setState in an effect
// body, i.e. a cascading render on every warehouse switch.
export function AwaitingHireDeliveries({ warehouseId }: { warehouseId: string }) {
  const { can } = useAuth();
  // Either hire-floor key — the same pair every /rental-receipts write route accepts.
  const canReceive = can("rentals.hire.receive") || can("rentals.hire.manage");
  const [rows, setRows] = React.useState<OnHireLine[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // The pane the stream exists for. Two receivers on the same warehouse page, one books the delivery
  // in — without this the other's Receive button still opens a form whose quantities the server has
  // just started refusing.
  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  React.useEffect(() => {
    let active = true;
    rentalService
      .listOnHire({ status: "awaiting", warehouseId, page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setRows(res.rows);
        setTotal(res.total);
        setError(null);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load hire deliveries."));
    return () => {
      active = false;
    };
  }, [warehouseId, page, reloadKey]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <AlertTriangle className="h-7 w-7 text-[var(--neg)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">Could not load hire deliveries</p>
        <p className="text-xs text-[var(--muted)]">{error}</p>
      </div>
    );
  }
  if (rows === null) return <QueueSkeleton />;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <PackageCheck className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No hires waiting to arrive</p>
        <p className="max-w-md text-xs text-[var(--muted)]">
          Equipment hired against this warehouse appears here until somebody confirms it turned up —
          including the lines going straight to a site, with their destination shown.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
            <thead>
              <HeaderRow />
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="cell-y px-4">
                    <span className="font-semibold text-[var(--ink)]">{r.itemName}</span>
                    {r.rentalItemCode && (
                      <span className="ml-1.5 font-mono text-[11px] text-[var(--faint)]">{r.rentalItemCode}</span>
                    )}
                  </td>
                  <td className="cell-y px-4">
                    <PoCodeLink code={r.purchaseOrderCode} />
                    <div className="text-[11px] text-[var(--muted)]">{r.supplierName}</div>
                  </td>
                  {/* The hire START, not the end: what matters here is whether the kit is late
                      arriving, and the end date is a deadline that has not begun to run. */}
                  <td className="cell-y px-4 text-[var(--muted)]">{shortDate(r.hireStartDate)}</td>
                  {/* WHERE it is actually going. A hire raised against this warehouse can carry its own
                      site address, and those rows used to be filtered out — an order simply vanished
                      from its warehouse's queue with nothing saying where it had gone. */}
                  <td
                    className="cell-y max-w-[16rem] truncate px-4 text-[var(--muted)]"
                    title={r.deliveryLocation.address ?? r.deliveryLocation.label}
                  >
                    {r.deliveryAddress ?? <span className="text-[var(--faint)]">{r.deliveryLocation.label}</span>}
                  </td>
                  <td className="cell-y px-4 text-[var(--muted)]">
                    {r.quantity - r.receivedQuantity}
                    {r.receivedQuantity > 0 && (
                      <span className="ml-1.5 text-[11px] text-[var(--faint)]">
                        of {r.quantity} · {r.receivedQuantity} already here
                      </span>
                    )}
                  </td>
                  <td className="cell-y px-4 text-right">
                    {canReceive && (
                      // The ORDER, not the row: one van arrives with several lines on one delivery
                      // note, and a per-row action would mint a separate delivery record for each.
                      <Link
                        href={`/dashboard/rentals/receive/${r.purchaseOrderCode}`}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                      >
                        <PackageCheck className="h-3.5 w-3.5" /> Receive
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <Pagination
            embedded
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            total={total}
            label="hires"
            onPage={setPage}
            note="Hired equipment stays the supplier's — receiving it starts the hire and adds nothing to stock."
          />
        </div>
      </div>
    </div>
  );
}
