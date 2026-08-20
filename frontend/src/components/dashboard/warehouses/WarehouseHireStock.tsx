"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, PackageCheck, PackageX } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import type { OnHireLine } from "@/types/rental";

// Hired equipment this warehouse is CURRENTLY HOLDING — supplier-owned kit, sitting in our yard.
//
// It belongs on the warehouse page because that is where the responsibility sits: the roles are
// warehouse-scoped, and "what am I holding at my site" is a question a warehouse manager asks about
// everything on the floor, not only about what we own. What it is NOT is a stock pool. Nothing here
// has an inventory balance, a stock movement or a valuation — the numbers come from the hire lines on
// the purchase orders, never from the inventory aggregation, and the backend fails its build if the
// two ever get wired together (modules/__tests__/rental.boundary.test.ts).
//
// Presented exactly as its NEIGHBOURS are — the Company (IRM), Customer and Damaged panes one pill
// away: the same card, header row, table-shaped skeleton, empty and error states. Four panes behind
// one toggle that look like four different apps is the inconsistency a user actually feels.

const PAGE_SIZE = 20;

const shortDate = (iso: string) =>
  // UTC: a hire date is a calendar day stored as UTC midnight, and formatting it in the viewer's zone
  // shows the previous day for anyone behind UTC.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

const COLUMNS = ["Item", "Order", "Units held", "Hire ends", "Held at", ""] as const;

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

/** Mirrors the table so the first load causes no layout shift — the sibling panes' own approach. */
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

/**
 * Held vs damaged — the same split the Company pool gets, on the pool that is not ours.
 *
 * "Damaged with us", not "Damaged": the figure behind it counts damage reported while the equipment
 * has been in our hands, which is the half a supplier will try to charge for. Kit that ARRIVED broken
 * is the supplier's own claim, evidenced on its delivery note, and is deliberately not added in —
 * summing the two would double-count a unit that arrived scratched and was later dropped. The label
 * says which half it is rather than promising both.
 */
const VIEWS = [
  { id: "all", label: "All held" },
  { id: "damaged", label: "Damaged with us" },
] as const;
type View = (typeof VIEWS)[number]["id"];

// MUST be mounted with `key={warehouseId}` — the rows, error and page below are per-warehouse, and
// remounting is how they reset. Resetting inside the load effect would be a setState in an effect
// body, i.e. a cascading render on every warehouse switch.
export function WarehouseHireStock({ warehouseId }: { warehouseId: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const canMove = can("rentals.hire.receive") || can("rentals.hire.manage");
  // The order page is gated on its own key — see PoCodeLink for why this is asked here.
  const canViewPo = can("purchase_orders.view");
  const [rows, setRows] = React.useState<OnHireLine[] | null>(null);
  const [page, setPage] = React.useState(1);
  const [view, setView] = React.useState<View>("all");
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    // `all` on the on-hire predicate means every LIVE hire — on hire, and not everything we hold
    // already handed back. That is precisely "what is in the yard", so no second filter is invented
    // here: the badge, the list and this pane resolve through the one predicate.
    //
    // The whole set, not a page of it. The damaged split below is applied IN MEMORY, and a server page
    // would make it speak for 20 rows while the footer counted the warehouse: click "Damaged with us"
    // with the damaged rows on page 2 and the pane says "No damaged hire equipment here" — a false
    // all-clear about the supplier's broken kit. A warehouse's live hires are a desk-sized set, which
    // is what makes taking them whole the honest option.
    rentalService
      .listOnHire({ status: "all", warehouseId, page: 1, pageSize: 200 })
      .then((res) => {
        if (!active) return;
        setRows(res.rows);
        setError(null);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load hired equipment."));
    return () => {
      active = false;
    };
  }, [warehouseId, reloadKey]);

  // Somebody hands a hire back, or reports one damaged, while this pane is open on a desk.
  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  // Units actually in our hands, and how many of those are on record as damaged. The damaged figure is
  // CLAMPED to what is held: a line can be reported damaged and then partly collected, and a pane
  // saying "2 held, 3 damaged" would be read as a fault in the pane rather than in the arithmetic.
  const held = (r: OnHireLine) => Math.max(0, r.receivedQuantity - r.returnedQuantity);
  const damaged = (r: OnHireLine) => Math.min(r.damagedQuantity ?? 0, held(r));

  const heldRows = (rows ?? []).filter((r) => held(r) > 0);
  const damagedCount = heldRows.filter((r) => damaged(r) > 0).length;
  /**
   * Show the split ONLY when it splits something.
   *
   * With every held row damaged — or none of them — both tabs render the identical table, and a
   * control that changes nothing reads as a broken control: the user presses it, the rows do not
   * move, and they are left wondering which view they are looking at. The damaged count is on each
   * row and in the footer either way, so nothing is hidden by hiding the toggle; only a choice that
   * has no consequence is.
   */
  const splits = damagedCount > 0 && damagedCount < heldRows.length;
  // A filter that stops applying must not leave the pane silently narrowed — the control that would
  // let anyone get back out is the one that just disappeared.
  const activeView: View = splits ? view : "all";

  // Filtered in memory, deliberately: a server filter would need its own predicate — a second
  // definition of "damaged" for the same rows.
  const matching = heldRows.filter((r) => activeView === "all" || damaged(r) > 0);
  // Paged over what the FILTER matched, so the footer's count and the rows under it are the same set.
  const totalPages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = matching.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <AlertTriangle className="h-7 w-7 text-[var(--neg)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">Could not load hired equipment</p>
        <p className="text-xs text-[var(--muted)]">{error}</p>
      </div>
    );
  }
  if (rows === null) return <QueueSkeleton />;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* The damaged split, on the pane rather than as a fifth pill: damaged hire kit is not a separate
          POOL — it is the same equipment, in our hands, with a fault recorded against it. A pool would
          promise a place it had been moved to, and there is no such place: it stays on hire. */}
      {splits && (
        <div className="flex shrink-0 items-center gap-1 self-start rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setView(v.id);
                // Page 1, or switching filters can land on a page the new set does not reach — and the
                // pagination control lives inside the non-empty branch, so there would be no way back.
                setPage(1);
              }}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                activeView === v.id ? "bg-[var(--surface)] text-[var(--ink)] shadow-xs" : "text-[var(--muted)]"
              }`}
            >
              {v.label}
              {v.id === "damaged" && <span className="ml-1.5 tabular-nums text-[var(--neg)]">{damagedCount}</span>}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <PackageCheck className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">
            {activeView === "damaged" ? "No damaged hire equipment here" : "No hired equipment here"}
          </p>
          <p className="max-w-md text-xs text-[var(--muted)]">
            {activeView === "damaged"
              ? "Equipment damaged while held at this warehouse appears here until it goes back. Kit that arrived damaged is on its own delivery note — that is the supplier's claim, not ours."
              : "Equipment hired against this warehouse appears here once it has been booked in, and leaves when it goes back. It is the supplier's — it never becomes stock."}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" style={{ minWidth: 760 }}>
                <thead>
                  <HeaderRow />
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.id}
                      // Clickable, exactly as the Customer pool's rows are. A hire LINE has no page of
                      // its own — the order is where it lives, alongside its period, its movements,
                      // the condition photos and the actions. Sending the row there is the same move
                      // the customer pane makes to its stock entry.
                      //
                      // Inert for an actor who cannot open a purchase order: a row that looks clickable
                      // and lands on the padlock panel is worse than a row that never offered.
                      className={`border-b border-[var(--border)] align-top transition-colors last:border-0 ${
                        canViewPo ? "cursor-pointer hover:bg-[var(--surface-2)]" : ""
                      }`}
                      onClick={
                        canViewPo ? () => router.push(`/dashboard/purchase-orders/${r.purchaseOrderCode}`) : undefined
                      }
                    >
                      <td className="cell-y px-4">
                        <span className="font-semibold text-[var(--ink)]">{r.itemName}</span>
                        {r.rentalItemCode && (
                          <span className="ml-1.5 font-mono text-[11px] text-[var(--faint)]">{r.rentalItemCode}</span>
                        )}
                      </td>
                      <td className="cell-y px-4">
                        {/* A real link even though the whole row navigates: a `tr` with an onClick is
                            mouse-only, and this is the one element in the row a keyboard can tab to —
                            and the only way to open the order in a new tab. It goes where the row
                            goes, so the two cannot disagree, and both fall silent together for an
                            actor who cannot open a purchase order. */}
                        <PoCodeLink code={r.purchaseOrderCode} />
                        <div className="text-[11px] text-[var(--muted)]">{r.supplierName}</div>
                      </td>
                      <td className="cell-y px-4 text-[var(--muted)]">
                        <span className="font-semibold text-[var(--ink)]">{held(r)}</span>
                        {r.quantity !== held(r) && <span className="ml-1.5 text-[11px]">of {r.quantity}</span>}
                        {damaged(r) > 0 && (
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--neg)]">
                            <AlertTriangle className="h-3 w-3" aria-hidden /> {damaged(r)} damaged with us
                          </div>
                        )}
                      </td>
                      {/* The deadline, because that is the thing that costs money if it passes — and
                          the same clock the deadline badges run on. */}
                      <td className="cell-y px-4 text-[var(--muted)]">
                        {shortDate(r.hireEndDate)}
                        {r.window !== "ok" && (
                          <span
                            className={`ml-1.5 text-[11px] font-bold ${
                              r.window === "overdue" ? "text-[var(--neg)]" : "text-[var(--warn,#d97706)]"
                            }`}
                          >
                            {r.window === "overdue" ? "overdue" : "ending soon"}
                          </span>
                        )}
                      </td>
                      {/* Not always this warehouse: an order raised here can carry a line delivered
                          straight to a site, and the row still belongs to whoever chases it. */}
                      <td
                        className="cell-y max-w-[16rem] truncate px-4 text-[var(--muted)]"
                        title={r.deliveryLocation.address ?? r.deliveryLocation.label}
                      >
                        {r.deliveryAddress ?? <span className="text-[var(--faint)]">{r.deliveryLocation.label}</span>}
                      </td>
                      {/* The actions are their own destinations — a click on one must not ALSO open
                          the order behind it. */}
                      <td className="cell-y px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        {canMove && (
                          // The ORDER, not the row: one collection takes several lines against one
                          // note, and a per-row action would mint a separate record for each.
                          <div className="inline-flex items-center gap-1.5">
                            {/* Hidden once every unit held on this line is already reported: the form
                                would open with nothing to fill in. */}
                            {held(r) - (r.damagedQuantity ?? 0) > 0 && (
                              <Link
                                href={`/dashboard/rentals/damage/${r.purchaseOrderCode}`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:border-[var(--neg)] hover:text-[var(--neg)]"
                              >
                                <AlertTriangle className="h-3.5 w-3.5" /> Damage
                              </Link>
                            )}
                            <Link
                              href={`/dashboard/rentals/return/${r.purchaseOrderCode}`}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                            >
                              <PackageX className="h-3.5 w-3.5" /> Return
                            </Link>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              embedded
              page={safePage}
              totalPages={totalPages}
              total={matching.length}
              label="hires"
              onPage={setPage}
              // The damaged tally lives here too, so it is on the screen even when the toggle above is
              // not — hiding a control must never hide a fact.
              note={`${damagedCount > 0 ? `${damagedCount} with damage reported while here. ` : ""}Hired equipment stays the supplier's — it is held here, never owned, and never counted as stock.`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
