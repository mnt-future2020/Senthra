"use client";

import * as React from "react";
import { AlertTriangle, PackageCheck } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { Skeleton } from "@/components/ui/Skeleton";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import type { OnHireLine } from "@/types/rental";
import { netOrdered } from "@/components/dashboard/rentals/hireActions";

// This catalogue item's LIVE HIRES — where it is, on whose order, and when it is due back.
//
// The one operational fact a rental item's page was missing. It matters most because of the label on
// the equipment: a scan resolves to this page, and without this card the answer to "what is this
// thing doing?" was a category, a unit and a barcode — none of which is the question somebody holding
// it is asking.
//
// Read through the SAME on-hire list the board and the badges use, narrowed to one item. A second
// query for "this item's hires" would be a second definition of what counts as live.

const shortDate = (iso: string) =>
  // UTC: a hire date is a calendar day stored as UTC midnight, and formatting it in the viewer's zone
  // shows the previous day for anyone behind UTC.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function RentalItemHires({ rentalItemId }: { rentalItemId: string }) {
  const [rows, setRows] = React.useState<OnHireLine[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    rentalService
      // A catalogue item is on a handful of hires at once, not hundreds — one page is the whole
      // answer, and paging a card that usually holds two rows would cost more than it saves.
      .listOnHire({ status: "all", rentalItemId, pageSize: 50 })
      .then((res) => {
        if (!active) return;
        setRows(res.rows);
        setError(null);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this item's hires."));
    return () => {
      active = false;
    };
  }, [rentalItemId, reloadKey]);

  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  if (error) {
    return <p className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs text-[var(--neg)]">{error}</p>;
  }
  if (rows === null) return <Skeleton className="h-9 w-full rounded-xl" />;

  // NOTHING ON HIRE — one quiet line, not a card.
  //
  // A card with a title, a border, an icon and a paragraph is the right weight for a list of live
  // hires. For an absence it is a 130px empty band at the top of the page, and on a catalogue item
  // created a minute ago that is every item's first impression: a big blank panel reads as something
  // that failed to load rather than as an answer.
  //
  // The wording is precise about what "none" covers: `onHireWhere` excludes anything not yet
  // delivered, so a hire sitting on an order and still to arrive is genuinely absent from here.
  if (rows.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-xs text-[var(--muted)] shadow-xs">
        <PackageCheck className="h-4 w-4 shrink-0 text-[var(--faint)]" aria-hidden />
        <span>
          <strong className="font-bold text-[var(--ink)]">Not on hire.</strong> A hire appears here once
          its delivery is booked in — one still on order and not yet delivered is on its purchase order.
        </span>
      </p>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
      <h3 className="mb-3 text-sm font-extrabold text-[var(--ink)]">On hire now</h3>
      <ul className="divide-y divide-[var(--border)]">
      {rows.map((r) => {
        const held = Math.max(0, r.receivedQuantity - r.returnedQuantity);
        const damaged = Math.min(r.damagedQuantity ?? 0, held);
        return (
          <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <PoCodeLink code={r.purchaseOrderCode} className="font-mono text-xs font-bold text-[var(--accent)]" />
              <span className="ml-2 text-xs text-[var(--muted)]">{r.supplierName ?? "—"}</span>
              {/* Where it physically is. The reason somebody scanning a label opened this page. */}
              <div className="mt-0.5 truncate text-[11px] text-[var(--faint)]" title={r.deliveryLocation.address ?? r.deliveryLocation.label}>
                {r.deliveryAddress ?? r.deliveryLocation.label}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs text-[var(--muted)]">
                {/* Against what the hire will EVER hold — see netOrdered. `r.quantity` would count
                    units already written off, promising kit that is never coming. */}
                <span className="font-semibold text-[var(--ink)]">{held}</span> of {netOrdered(r)} held
              </div>
              <div className="text-[11px] text-[var(--faint)]">
                until {shortDate(r.hireEndDate)}
                {r.window !== "ok" && (
                  <span className={`ml-1 font-bold ${r.window === "overdue" ? "text-[var(--neg)]" : "text-[var(--warn,#d97706)]"}`}>
                    {r.window === "overdue" ? "· overdue" : "· ending soon"}
                  </span>
                )}
              </div>
              {damaged > 0 && (
                <div className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--neg)]">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> {damaged} damaged
                </div>
              )}
            </div>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
