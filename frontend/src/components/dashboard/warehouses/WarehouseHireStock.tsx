"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, PackageCheck, PackageX } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import type { OnHireLine } from "@/types/rental";
import { canMoveHires, damageableNow, groupHiresByItem, heldOnHire, hireCustodySplit, netOrdered } from "@/components/dashboard/rentals/hireActions";
import { DeclareHireLostModal, type DeclareHireLostTarget } from "@/components/dashboard/rentals/DeclareHireLostModal";

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

// "Delivering to", NOT "Held at" — the column carries the DELIVERY address, and the backend field it
// reads is documented as "Where it GOES". Two things followed from the old name: it claimed to answer
// "where is this kit now", which a delivery address does not, and the identical column on the INCOMING
// pane one tab away (AwaitingHireDeliveries) already called the same field "Delivering to". Same
// field, same render, two names, one feature.
//
// "Where is it now" is answered instead by the split under Units held — see the cell.
//
// "Available to issue" is the column this pane most lacked. A hire LINE can hold units that are
// physically here and still cannot go out — its period has ended, or its order was never sent — so
// "units held" and even "here" both overstate what a job can have. One depot read 23 units of a tester
// across eleven rows when SIX were issuable, and the person who promised a job ten of them found out
// at the scan. The figure is computed by the server with the same rule the scan queries with.
const COLUMNS = ["Item", "Order", "Units held", "Available to issue", "Hire ends", "Delivering to", ""] as const;

/**
 * The hover text behind the shelf/van split.
 *
 * States the consequence, not just the numbers: only what is HERE can be handed to a collecting
 * driver, and the rest has to be scanned back in first. That is the rule the server enforces on the
 * Return action, so saying it here is what turns a 409 people used to hit into one they do not.
 */
function custodyTitle(split: { atWarehouse: number; withEngineers: number }, held: number): string {
  const be = (n: number) => (n === 1 ? "is" : "are");
  return (
    `${split.atWarehouse} of the ${held} on hire ${be(split.atWarehouse)} at this warehouse; ` +
    `${split.withEngineers} ${be(split.withEngineers)} out with an engineer on a job. ` +
    `Only what is here can go back to the provider — the rest has to be scanned in first.`
  );
}

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
            <table className="w-full text-left text-sm" style={{ minWidth: 900 }}>
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
  const canMove = canMoveHires(can);
  // The order page is gated on its own key — see PoCodeLink for why this is asked here.
  const canViewPo = can("purchase_orders.view");
  const [rows, setRows] = React.useState<OnHireLine[] | null>(null);
  const [page, setPage] = React.useState(1);
  const [view, setView] = React.useState<View>("all");
  // Which item groups are open. Collapsed by DEFAULT — the whole point is that eleven rows of one
  // tester become one. A group holding a single contract opens itself (see the row): there is nothing
  // to collapse, and a disclosure that reveals one line is a click for no information.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
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

  const [lostTarget, setLostTarget] = React.useState<DeclareHireLostTarget | null>(null);

  // Units actually in our hands, and how many of those are broken AND STILL HERE.
  //
  // `damagedHeldQuantity`, not `damagedQuantity`: the second is the provider-facing lifetime total
  // from their damage notes and counts units that have since gone back, so a pane using it said
  // "2 held, 3 damaged" on a line that was perfectly consistent — which reads as a fault in the pane.
  // This one answers the question the floor actually asks: what is broken and standing here.
  // Clamped anyway, so a drifted counter can never outrun the holding it describes.
  const held = (r: OnHireLine) => heldOnHire(r);
  const damaged = (r: OnHireLine) => Math.min(r.damagedHeldQuantity ?? 0, held(r));
  /**
   * Units of this contract that are GONE — declared lost and not since recovered.
   *
   * Not clamped to `held`, because it is not part of it: `heldOnHire` already subtracts them, which is
   * why the row reads "99 of 100" once one is lost. This is what turns that quiet arithmetic into a
   * sentence — the number was derivable and never stated, so the pane showed a shortfall it never
   * explained.
   *
   * The hire's own pane is where this belongs. It is deliberately NOT in the damaged pool: that pool is
   * "still here and not fit to use", and owned stock keeps loss out of it in exactly the same way.
   */
  const lost = (r: OnHireLine) => Math.max(0, r.lostQuantity ?? 0);
  // WHERE what we hold actually is — the shelf/van split. Lives in hireActions with the other caps
  // this pane's actions run on, so it is unit-tested rather than trapped in a render tree.
  const custody = (r: OnHireLine) => hireCustodySplit(r);

  // A hire whose units are ALL declared lost holds nothing — `heldOnHire` subtracts them — and on a
  // `held > 0` filter alone it left this pane entirely, taking its "declared lost" line and its share
  // of the summary with it. The one pane somebody opens to ask what happened to a hire is the last
  // place its loss should be invisible.
  const heldRows = (rows ?? []).filter((r) => held(r) > 0 || lost(r) > 0);
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
  // ONE ROW PER ITEM, with its contracts underneath. See groupHiresByItem for why the item is the unit
  // a reader thinks in and the hire line is not.
  const groups = groupHiresByItem(matching);
  // Paged over GROUPS, not lines — paging the lines would split one item's contracts across two pages
  // and make the group totals lie about what is under them.
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = groups.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // The depot's answer in one line, above the table, so "what can I give out" needs no scrolling and
  // no expanding. Summed over EVERY matching group rather than the page, because a total that changed
  // as you paged would be a different question each time.
  const summary = groups.reduce(
    (a, g) => ({
      items: a.items + 1,
      held: a.held + g.held,
      availableToIssue: a.availableToIssue + g.availableToIssue,
      withEngineers: a.withEngineers + g.withEngineers,
      overdue: a.overdue + (g.worstWindow === "overdue" ? 1 : 0),
      lost: a.lost + g.lines.reduce((n, l) => n + Math.max(0, l.lostQuantity ?? 0), 0),
    }),
    { items: 0, held: 0, availableToIssue: 0, withEngineers: 0, overdue: 0, lost: 0 },
  );

  const lostModal = (
    <DeclareHireLostModal target={lostTarget} onClose={() => setLostTarget(null)} onDone={() => setReloadKey((k) => k + 1)} />
  );

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

      {/* ── The depot's answer, before any scrolling or expanding ──────────────────────────────
          "What can I give out" is the question this pane is opened with, and it used to require
          summing every row by eye while knowing which of them were expired or unsent. Stated over the
          whole matching set rather than the visible page — a total that changed as you paged would be
          answering a different question each time. */}
      {visible.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2 text-[11px] font-semibold text-[var(--muted)]">
          <span>
            <span className="text-[var(--ink)]">{summary.items}</span> {summary.items === 1 ? "item" : "items"} on hire
          </span>
          <span>
            <span className="text-[var(--ink)]">{summary.held}</span> units held
          </span>
          <span title="What could go out on a new job today. Excludes hires whose period has ended and orders never sent to the supplier.">
            <span className="text-[var(--ink)]">{summary.availableToIssue}</span> available to issue
          </span>
          {summary.withEngineers > 0 && <span>{summary.withEngineers} out on jobs</span>}
          {/* Kept out of "units held" above — they are not held, which is why that figure already
              excludes them. Stated here so the depot's own line accounts for every unit the provider
              delivered rather than leaving the gap to be worked out. */}
          {summary.lost > 0 && (
            <span className="text-[var(--neg)]" title="Declared lost and not recovered. Settled with the provider on the hire's order.">
              {summary.lost} declared lost
            </span>
          )}
          {summary.overdue > 0 && (
            <span className="text-[var(--neg)]">
              {summary.overdue} {summary.overdue === 1 ? "item" : "items"} overdue
            </span>
          )}
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
              <table className="w-full text-left text-sm" style={{ minWidth: 900 }}>
                <thead>
                  <HeaderRow />
                </thead>
                {visible.map((g) => {
                  // A group of ONE opens itself: there is nothing to collapse, and a disclosure that
                  // reveals a single line is a click that buys no information.
                  const open = g.lines.length === 1 || expanded.has(g.key);
                  return (
                <tbody key={g.key} className="border-b border-[var(--border)] last:border-0">
                  {/* ── The item, which is what a reader came to ask about ────────────────────────
                      Its totals are the answer to "how many have I got and how many can I give out",
                      which used to require summing eleven rows by eye and knowing which of them were
                      expired. Collapsed by default; the contracts underneath are where every action
                      still lives, because each is a separate agreement with its own deadline. */}
                  <tr
                    className={`bg-[var(--surface-2)] align-middle ${g.lines.length > 1 ? "cursor-pointer" : ""}`}
                    onClick={g.lines.length > 1 ? () => toggle(g.key) : undefined}
                  >
                    <td className="cell-y px-4">
                      <div className="flex items-center gap-1.5">
                        {g.lines.length > 1 ? (
                          <ChevronRight
                            className={`h-3.5 w-3.5 shrink-0 text-[var(--faint)] transition-transform ${open ? "rotate-90" : ""}`}
                            aria-hidden
                          />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="font-semibold text-[var(--ink)]">{g.itemName}</span>
                        {g.rentalItemCode && (
                          <span className="font-mono text-[11px] text-[var(--faint)]">{g.rentalItemCode}</span>
                        )}
                      </div>
                    </td>
                    <td className="cell-y px-4 text-[11px] text-[var(--muted)]">
                      {g.lines.length === 1 ? "1 hire" : `${g.lines.length} hires`}
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">
                      <span className="font-semibold text-[var(--ink)]">{g.held}</span>
                      {g.withEngineers > 0 && (
                        <div className="mt-0.5 text-[11px] font-semibold" title={custodyTitle(g, g.held)}>
                          <span className="text-[var(--ink)]">{g.atWarehouse} here</span>
                          <span className="mx-1 text-[var(--faint)]">·</span>
                          {g.withEngineers} on a job
                        </div>
                      )}
                    </td>
                    {/* The headline number, and the one this pane existed without. Zero is stated in
                        words rather than as a bare 0: "0" beside a held count of 27 reads as a glitch,
                        where "None" reads as an answer. */}
                    <td className="cell-y px-4">
                      {g.availableToIssue > 0 ? (
                        <span className="font-bold text-[var(--ink)]">{g.availableToIssue}</span>
                      ) : (
                        <span className="text-[11px] font-semibold text-[var(--muted)]">None</span>
                      )}
                    </td>
                    <td className="cell-y px-4 text-[11px] text-[var(--muted)]">
                      {shortDate(g.earliestEnd)}
                      {g.worstWindow !== "ok" && (
                        <span
                          className={`ml-1.5 font-bold ${
                            g.worstWindow === "overdue" ? "text-[var(--neg)]" : "text-[var(--warn,#d97706)]"
                          }`}
                        >
                          {g.worstWindow === "overdue" ? "overdue" : "ending soon"}
                        </span>
                      )}
                    </td>
                    <td className="cell-y px-4" />
                    <td className="cell-y px-4" />
                  </tr>
                  {open &&
                    g.lines.map((r) => (
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
                      {/* Blank, and indented: the item is named once on the group row above. Repeating
                          it on every contract is what made one tester look like eleven. */}
                      <td className="cell-y px-4" />
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
                        {/* Net of anything written off, so the "of N" disappears once the hire holds
                            all it ever will — see netOrdered. */}
                        {netOrdered(r) !== held(r) && <span className="ml-1.5 text-[11px]">of {netOrdered(r)}</span>}
                        {/* The split, and ONLY when it splits something — with nothing out on a job
                            the two figures are the headline number repeated twice, which reads as a
                            pane padding itself. Same rule the damaged sub-line and the "of N" above
                            follow.

                            This is what answers "where is it", and it is the number a collection
                            depends on: only the shelf figure can be handed to a driver. */}
                        {custody(r).withEngineers > 0 && (
                          <div
                            className="mt-0.5 text-[11px] font-semibold text-[var(--muted)]"
                            title={custodyTitle(custody(r), held(r))}
                          >
                            <span className="text-[var(--ink)]">{custody(r).atWarehouse} here</span>
                            <span className="mx-1 text-[var(--faint)]">·</span>
                            {custody(r).withEngineers} on a job
                          </div>
                        )}
                        {damaged(r) > 0 && (
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--neg)]">
                            <AlertTriangle className="h-3 w-3" aria-hidden /> {damaged(r)} damaged with us
                          </div>
                        )}
                        {/* Its own line, not folded into the damaged one: broken and gone are different
                            problems with different exits, and only one of them is still on the shelf. */}
                        {lost(r) > 0 && (
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--neg)]">
                            <PackageX className="h-3 w-3" aria-hidden /> {lost(r)} declared lost
                          </div>
                        )}
                      </td>
                      {/* What THIS contract can put on a job today — and, when that is nothing, WHY.
                          Without the reason the column is a bare 0 next to units the reader can see
                          are physically present, which reads as a broken pane rather than a rule. The
                          way out is named too: extending a hire makes the same units issuable again,
                          and it is one action on the order that nobody would think to look for. */}
                      <td className="cell-y px-4 text-[var(--muted)]">
                        {r.availableToIssue > 0 ? (
                          <span className="font-bold text-[var(--ink)]">{r.availableToIssue}</span>
                        ) : (
                          <>
                            <span className="text-[11px] font-semibold">None</span>
                            {custody(r).atWarehouse > 0 && (
                              <div className="mt-0.5 text-[11px] font-semibold text-[var(--warn,#d97706)]">
                                {r.window === "overdue"
                                  ? "hire ended — extend it to use these"
                                  : "this order can't be issued from"}
                              </div>
                            )}
                          </>
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
                          straight to a site, and the row still belongs to whoever chases it. Those
                          are the rows worth reading — so the ordinary case says "This warehouse"
                          quietly rather than printing the name of the page you are standing on, once
                          per row, which is what buried them.

                          The address itself, not `deliveryAddress`: that field holds only the LINE's
                          own text, so a hire whose ORDER overrides the destination used to render the
                          literal words "Order delivery address" here while going somewhere definite.
                          The resolved leg has the actual address, and the label is its last resort —
                          for a depot with no address on file. */}
                      <td
                        className="cell-y max-w-[16rem] truncate px-4 text-[var(--muted)]"
                        title={r.deliveryLocation.address ?? r.deliveryLocation.label}
                      >
                        {r.deliveryAtWarehouse ? (
                          <span className="text-[var(--faint)]">This warehouse</span>
                        ) : (
                          r.deliveryLocation.address ?? r.deliveryLocation.label
                        )}
                      </td>
                      {/* The actions are their own destinations — a click on one must not ALSO open
                          the order behind it. */}
                      <td className="cell-y px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        {canMove && (
                          // The ORDER, not the row: one collection takes several lines against one
                          // note, and a per-row action would mint a separate record for each.
                          <div className="inline-flex items-center gap-1.5">
                            {/* Hidden once every unit held on this line is already reported: the form
                                would open with nothing to fill in. Same cap the form itself applies,
                                so the button and the screen behind it can never disagree. */}
                            {damageableNow(r) > 0 && (
                              <Link
                                href={`/dashboard/rentals/damage/${r.purchaseOrderCode}`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:border-[var(--neg)] hover:text-[var(--neg)]"
                              >
                                <AlertTriangle className="h-3.5 w-3.5" /> Damage
                              </Link>
                            )}
                            {/* Only offered when units are genuinely out with someone: a hire whose kit
                                is all on the shelf has nothing that can be lost, and the form would
                                open with no engineer to name. */}
                            {(r.holders?.length ?? 0) > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  // One row, one hire — the pane already knows which, so the dialog
                                  // takes it without asking.
                                  setLostTarget({
                                    hires: [
                                      {
                                        purchaseOrderId: r.purchaseOrderId,
                                        lineId: r.id,
                                        poCode: r.purchaseOrderCode ?? "",
                                        itemName: r.itemName,
                                        qty: (r.holders ?? []).reduce((n, h) => n + h.quantity, 0),
                                        holders: r.holders ?? [],
                                      },
                                    ],
                                  })
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:border-[var(--neg)] hover:text-[var(--neg)]"
                              >
                                <PackageX className="h-3.5 w-3.5" /> Lost
                              </button>
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
                  );
                })}
              </table>
            </div>
            <Pagination
              embedded
              page={safePage}
              totalPages={totalPages}
              total={groups.length}
              label="items on hire"
              onPage={setPage}
              // The damaged tally lives here too, so it is on the screen even when the toggle above is
              // not — hiding a control must never hide a fact.
              note={`${damagedCount > 0 ? `${damagedCount} with damage reported while here. ` : ""}Hired equipment stays the supplier's — it is held here, never owned, and never counted as stock.`}
            />
          </div>
        </div>
      )}
      {lostModal}
    </div>
  );
}
