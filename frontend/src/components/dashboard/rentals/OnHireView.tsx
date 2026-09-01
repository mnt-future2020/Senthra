"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Loader2, Search } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import * as rentalService from "@/services/rental.service";
import type { OnHireFilter, OnHireLine } from "@/types/rental";
import { Modal } from "@/components/ui/Modal";
import { ExportButton } from "@/components/ui/ExportButton";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";
import { listSuppliers } from "@/services/supplier.service";
import { extensionChargePence, periodsFor, type RatePeriod } from "@/lib/rentalPricing";
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import { Skeleton } from "@/components/ui/Skeleton";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { inputCls } from "@/components/ui/styles";
import { CloseHireShortModal, type CloseHireShortTarget } from "./CloseHireShortModal";
import { canManageHires, canMoveHires, canSettleHires, hireTakesDelivery } from "./hireActions";
import { daysRemainingLabel } from "./hireWindow";
import { HireDeadline } from "./rentalHireStatus";

const PAGE_SIZE = 20;

// Item · Order · Qty · Period · Ends · Location (· Actions). Seven columns of hire detail do not fit
// a 1024px laptop; without a declared floor the browser pays for it in WRAPPED rows, which is the one
// direction that costs rows on a screen already short of them. Sideways scrolling is the cheap axis.
//
// One entry per column, and it has to stay that way: the delivery and return legs used to be two
// `wide` columns printing the same address twice, and an array left one longer than the header row
// reserves width for a column nothing renders.
const TABLE_MIN_WIDTH = tableMinWidth(["wide", "normal", "narrow", "wide", "normal", "wide", "normal"]);

// The pills, in the order a hire moves through them. EVERY ONE has a caller: three are what an
// attention badge opens, and the fifth is the only place a finished hire exists at all.
//
// "On hire" and NOT "All", because it is not all of them: the default filter asks for `on_hire` AND
// `fullyReturned: false`, so the rows under the other pills are precisely the ones it leaves out.
// Labelled "All", it made two of its neighbours look broken — pick one, see rows, go back to "All",
// watch them vanish.
//
// `awaiting` — the whole receiving queue — used to sit second and is deliberately gone. No badge
// opened it, and its rows are already answerable elsewhere: a PART-delivered hire is under "On hire"
// (the row carries its own "2 here" marker), one whose start date has passed is under "Late arrival",
// and the warehouse's own intake pane lists the rest per site. What it uniquely showed was a hire
// ordered, undelivered and NOT yet due — which is nobody's work, and it is on the purchase order.
// The filter itself still exists server-side; that pane calls it directly.
const FILTERS: { id: OnHireFilter; label: string }[] = [
  // "All on hire" and not a bare "All", because it is not all of them: this filter asks for `on_hire`
  // AND `fullyReturned: false`, so the rows under the other entries are exactly the ones it leaves
  // out. It keeps the leading "All" that every other register in the app opens with ("All statuses",
  // "All movements") — without it the control read as a lone widget rather than a filter.
  { id: "all", label: "All on hire" },
  // Nothing has arrived and the hire has ALREADY started — what the "Hires not yet received" badge
  // counts, so following that badge lands on exactly its own rows. Named for the state, not the
  // deadline: "Overdue" below is about the RETURN.
  { id: "late", label: "Late arrival" },
  { id: "expiring", label: "Ending soon" },
  { id: "overdue", label: "Overdue" },
  // Damage or loss the office has not finished with — where the "Hire damage & loss to settle" badge
  // lands. The backend has answered `?status=custody` since the badge existed; this list did not, so
  // `OnHireFilter` clamped the unknown value back to "all" and the badge opened the whole register
  // with no pill lit and no way to find the rows it had counted.
  { id: "custody", label: "To settle" },
  // The END of the same life, and the only place a finished hire can be found — the warehouse pane,
  // this list and the item's own page are all live-only by design, so a returned hire used to leave
  // every rental screen at once and survive only inside the movement panel of an order you had to
  // already know the number of.
  { id: "returned", label: "Returned" },
  // Hires that never happened — ordered, nothing ever arrived, closed short with a reason. Kept OUT
  // of "Returned" because that pill is the finance register and this is not hire spend; kept here
  // rather than nowhere because a record you can create and then find on no screen is a record
  // nobody can audit.
  { id: "cancelled", label: "Cancelled" },
];

/** How the actual hire compared with the one that was billed. Null when they agree. */
export function heldVsBilled(daysOnHire: number, hireDays: number): { label: string; over: boolean } | null {
  const diff = daysOnHire - hireDays;
  if (diff === 0) return null;
  return diff > 0 ? { label: `${diff}d over`, over: true } : { label: `${-diff}d early`, over: false };
}

const shortDate = (iso: string) =>
  // Rendered in UTC because a hire date is a CALENDAR DAY stored as UTC midnight — formatting it in
  // the viewer's zone would show the previous day for anyone behind UTC.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Rentals → On hire: every live hire, and the two actions one supports.
 *
 * The `status` filter is resolved SERVER-SIDE through the same predicates the attention badges
 * count, which is what lets a badge reading 3 deep-link here and show exactly those 3 rows.
 */
export function OnHireView() {
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Extending commits money and is the commercial key; recording a physical movement is the floor's,
  // and `manage` is a superset of it. Two questions, because the answer differs for a warehouse user.
  // THREE different answers, because the server now asks three different questions. Extending
  // commits fresh money (`manage`); closing short corrects what the supplier still owes (`settle`,
  // which the warehouse holds); moving kit is the floor's own work.
  const canExtend = canManageHires(can);
  const canSettle = canSettleHires(can);
  const canMove = canMoveHires(can);
  const canAct = canExtend || canSettle || canMove;

  // CLAMPED to a pill this screen actually offers. The server still resolves `awaiting`, which the
  // warehouse's intake pane calls directly — but reached through the URL it would filter the list
  // while no pill lit up, so the strip would say "On hire" and the table would show something else.
  const search = searchParams.get("q") ?? "";
  const requested = searchParams.get("status") as OnHireFilter | null;
  const status: OnHireFilter = FILTERS.some((f) => f.id === requested) ? requested! : "all";
  // A FINISHED hire is read, not worked: no deadline to colour, no next step to offer, and the
  // questions asked of it are what it cost and how long it was really held. Same table, two jobs.
  // Both terminal pills are read-only — a cancelled hire has even less to act on than a returned one.
  const finished = status === "returned" || status === "cancelled";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  // Two DISPLAYED columns that had no filter. `hireEndDate` is a calendar day (the agreed period),
  // and "what comes back this week" is the register's second-most-asked question after "what's late".
  const supplierFilter = searchParams.get("supplier") ?? "";
  const endsFrom = searchParams.get("endsFrom") ?? "";
  const endsTo = searchParams.get("endsTo") ?? "";

  // Memoised because the debounced search effect depends on it — a fresh function every render would
  // restart that timer on every keystroke's re-render, and the box would never settle.
  const patch = React.useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Supplier options — degrades to empty, which reads as "All suppliers".
  const [supplierOptions, setSupplierOptions] = React.useState<{ value: string; label: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    listSuppliers({ status: "active", pageSize: 200 })
      .then((r) => alive && setSupplierOptions(r.suppliers.map((x) => ({ value: x.id, label: x.name }))))
      .catch(() => alive && setSupplierOptions([]));
    return () => { alive = false; };
  }, []);

  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seeded during render when ?q changes outside typing (browser back/forward) — the
  // React-recommended pattern, and no cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [rows, setRows] = React.useState<OnHireLine[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // Closing short needs a REASON, so it is a form rather than a confirm — the reason is the only
  // record that the shortfall was a decision and not an oversight. Shared with the receiving screen,
  // which offers the same decision to the warehouse manager who is the one being told it.
  const [shortClosing, setShortClosing] = React.useState<CloseHireShortTarget | null>(null);
  const [extending, setExtending] = React.useState<OnHireLine | null>(null);
  // The agreed extension charge, in pounds. Left empty it means "whatever the rate calculates".
  /**
   * The Extend dialog's draft, as ONE value.
   *
   * These were two independent `useState`s, and that is precisely how an agreed charge leaked
   * between hires: opening the dialog reset the date but not the charge, and Cancel reset neither —
   * only a SUCCESSFUL extend cleared them. So £150 typed against hire A, then cancelled, was still
   * sitting in the box when the dialog reopened on hire B, reading as a prefill rather than as
   * another hire's number, and it was posted as B's `additionalChargePence`.
   *
   * Bundled, the two can only be written together, and every open and close resets the whole draft —
   * so the leak is not something a future field can reintroduce by being forgotten.
   */
  const [draft, setDraft] = React.useState({ newEndDate: "", extraCharge: "" });
  const { newEndDate, extraCharge } = draft;
  const setNewEndDate = (v: string) => setDraft((d) => ({ ...d, newEndDate: v }));
  const setExtraCharge = (v: string) => setDraft((d) => ({ ...d, extraCharge: v }));
  const openExtend = (r: OnHireLine) => {
    setExtending(r);
    setDraft({ newEndDate: "", extraCharge: "" });
  };
  const closeExtend = () => {
    setExtending(null);
    setDraft({ newEndDate: "", extraCharge: "" });
  };
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => {
      // Only when the box actually diverges from the URL, so a deep-linked ?page survives mount and
      // browser back/forward (patch defaults to resetPage, which would drop it).
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await rentalService.listOnHire({
          status,
          search: search || undefined,
          supplierId: supplierFilter || undefined,
          endsFrom: endsFrom || undefined,
          endsTo: endsTo || undefined,
          page,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        setRows(res.rows);
        setTotal(res.total);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load hires.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, search, supplierFilter, endsFrom, endsTo, page, reloadKey]);

  // Somebody in the yard books a hire in or hands one back while this board is open. Without it the
  // row keeps offering "Receive" for equipment that is already here.
  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  // Mirrors the server's extensionChargePence: reprice the whole hire, subtract the old price.
  const calculatedExtra = React.useMemo(() => {
    if (!extending || !newEndDate || extending.ratePeriod === "total" || extending.ratePence == null) return null;
    return extensionChargePence(
      extending.ratePeriod as RatePeriod,
      extending.ratePence,
      extending.hireStartDate.slice(0, 10),
      extending.hireEndDate.slice(0, 10),
      newEndDate,
    );
  }, [extending, newEndDate]);

  const extraPeriods = React.useMemo(() => {
    if (!extending || !newEndDate || extending.ratePeriod === "total") return null;
    const before = periodsFor(extending.ratePeriod as RatePeriod, extending.hireStartDate.slice(0, 10), extending.hireEndDate.slice(0, 10));
    const after = periodsFor(extending.ratePeriod as RatePeriod, extending.hireStartDate.slice(0, 10), newEndDate);
    if (before == null || after == null) return null;
    return Math.max(0, after - before);
  }, [extending, newEndDate]);

  const doExtend = async () => {
    if (!extending || busy) return;
    if (!newEndDate) {
      pushToast("Select a new hire end date.", "alert");
      return;
    }
    setBusy(true);
    try {
      await rentalService.extendHire(extending.purchaseOrderId, extending.id, {
        hireEndDate: newEndDate,
        // Only sent when it differs from what the rate calculates — otherwise the server's own
        // arithmetic stands, and a figure echoed back from the browser could only disagree with it.
        ...(extraCharge.trim() !== "" && Math.round(Number(extraCharge) * 100) !== (calculatedExtra ?? null)
          ? { additionalChargePence: Math.round(Number(extraCharge) * 100) }
          : {}),
      });
      pushToast("Hire extended.", "success");
      closeExtend();
      setReloadKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not extend the hire.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="stack flex h-full flex-col">
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        {/* One row of controls, no heading block. This tab had the worst case of it: the status
            control and the export are shrink-0, so from `sm` up the text column got whatever was left
            — at 1024px roughly ninety pixels, turning one sentence into a ten-line column taller
            than the table it introduced. The pill directly above already says On hire. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {/* A SELECT, not a strip of pills, and that is the house control: Purchase Orders, Goods In
              and the Movements tab immediately beside this one all filter their register from one.
              This screen was the only list in the app wearing a segmented strip, and it read as a
              second row of tabs directly under the real ones — five of them, each demanding a glance
              before the table could be reached. The values are unchanged; only the control is.
              Every entry here is also somewhere an attention badge LANDS, which is why none of them
              can simply be dropped — the same reason Purchase Orders lists "Delivery overdue" beside
              its real statuses rather than hiding it behind the badge that opens it. */}
          {/* SEARCH FIRST, then the filter, then the export — the order Purchase Orders, Goods In
              and the Movements tab beside this one already use. This screen had no search at all,
              which is why its lone filter control read as a standalone widget rather than as one of
              a row: there was nothing beside it to be one OF. It is also a real gap on a register
              that grows a row per hire — finding one meant reading the table. */}
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search item, order or supplier…"
              className={`${inputCls} pl-9`}
            />
          </div>
          <Select
            size="sm"
            value={status}
            onChange={(v) => patch({ status: v === "all" ? null : v })}
            options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            ariaLabel="Filter hires"
          />
          <FilterPopover
            activeCount={(supplierFilter ? 1 : 0) + (endsFrom || endsTo ? 1 : 0)}
            onClear={() => patch({ supplier: null, endsFrom: null, endsTo: null })}
          >
            <Select
              size="sm"
              value={supplierFilter}
              onChange={(v) => patch({ supplier: v || null })}
              options={[{ value: "", label: "All suppliers" }, ...supplierOptions]}
              ariaLabel="Filter by supplier"
            />
            {/* The hire's END date — a calendar day, so no timezone applies. It NARROWS whichever
                state pill is selected; it never escapes it. */}
            <DateRangeFilter
              label="Hire ends"
              showLabel
              from={endsFrom}
              to={endsTo}
              onChange={({ from, to }) => patch({ endsFrom: from || null, endsTo: to || null })}
            />
          </FilterPopover>
          {can("rentals.export") && (
            <div className="sm:ml-auto">
              <ExportButton
                // EVERY filter, or the file quietly holds more rows than the list it was taken from.
                onExport={() =>
                  rentalService.exportOnHireCsv({
                    status,
                    search: search || undefined,
                    supplierId: supplierFilter || undefined,
                    endsFrom: endsFrom || undefined,
                    endsTo: endsTo || undefined,
                  })
                }
                disabled={rows.length === 0}
                title={
                  finished
                    ? "Export these completed hires — rate, value, the period billed and the days actually held"
                    : "Export the hires in this window to CSV"
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Card is the flex column, table scrolls inside it, footer rides the same surface — so the
          total strip costs no card of its own. Same shape as the catalogue beside it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="p-6 text-center text-xs text-[var(--neg)]">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <CalendarClock className="h-8 w-8 text-[var(--faint)]" />
            <p className="text-xs text-[var(--muted)]">
              {search
                ? "No hire matches that search in this window."
                : status === "all"
                ? "Nothing is out on hire."
                : finished
                  ? "No hire has been completed yet. One appears here once everything ordered has arrived and everything that arrived has gone back."
                  : "Nothing in this window."}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs" style={{ minWidth: TABLE_MIN_WIDTH }}>
            <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
              <tr>
                <th className="cell-y px-4">Item</th>
                <th className="cell-y px-4">Order</th>
                <th className="cell-y px-4">Qty</th>
                <th className="cell-y px-4">Period</th>
                {/* A live hire is asked "when is it due back"; a finished one, "how long did we
                    actually have it". Same column, because they are the same question at the two
                    ends of the hire — and a spare column for each would push the table wider on a
                    screen that already scrolls sideways. */}
                <th className="cell-y px-4">{finished ? "Held" : "Ends"}</th>
                {/* ONE location column, not two.
                    `returnMode` defaults to "delivery" — the kit goes back from wherever it was
                    delivered — so on almost every hire the two resolved to the SAME address, and the
                    table spent two of its widest columns printing one string twice. The return leg is
                    still shown, underneath, on the hires where it actually differs. Same rule the
                    purchase order's own line already follows (see returnLegSummary). */}
                <th className={`cell-y px-4 ${colClass("lg")}`}>Location</th>
                {/* Nothing left to do to a finished hire, so the actions column carries the money
                    instead — the answer this register exists to give. */}
                {finished ? (
                  <th className="cell-y px-4 text-right">Value</th>
                ) : (
                  canAct && <th className="cell-y px-4 text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // The SERVER decided this, in the company timezone, alongside the counts the
                // badges show — so a row's colour cannot disagree with the filter that returned it.
                // Deriving it here previously hardcoded the lead to 0 (every "Ending soon" row
                // rendered neutral) and read "today" from the browser.
                const delivery = r.deliveryLocation.address ?? r.deliveryLocation.label;
                const backTo = r.returnLocation.address ?? r.returnLocation.label;
                return (
                  <tr key={r.id} className="border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-2)]">
                    <td className={`cell-y px-4 text-[var(--ink)] ${CELL_ONE_LINE}`}>
                      {r.itemName}
                      {r.rentalItemCode && <span className="ml-1.5 font-mono text-[10px] text-[var(--faint)]">{r.rentalItemCode}</span>}
                    </td>
                    <td className="cell-y px-4">
                      <PoCodeLink code={r.purchaseOrderCode} />
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">
                      {/* Ordered, with what has actually turned up beside it while the two differ. A
                          part delivery is ordinary, and a bare "3" on a row where one unit is still at
                          the supplier is the row telling a story nobody can act on. */}
                      {r.quantity}
                      {r.receivedQuantity < r.quantity && (
                        <span className="ml-1.5 whitespace-nowrap text-[10px] font-semibold text-[var(--warn,#d97706)]" title="Units actually delivered so far">
                          {r.receivedQuantity} here
                        </span>
                      )}
                      {/* What the row would otherwise not add up to: a line reading "5 · 2 here" that
                          is off the receiving queue looks broken until it says the other three were
                          written off, and why. */}
                      {r.cancelledQuantity > 0 && (
                        <span
                          className="ml-1.5 whitespace-nowrap text-[10px] font-semibold text-[var(--muted)]"
                          title={r.shortCloseReason ? `Closed short: ${r.shortCloseReason}` : "Recorded as never arriving"}
                        >
                          {r.cancelledQuantity} cancelled
                        </span>
                      )}
                      {r.extensionCharge > 0 && (
                        <span className="ml-1.5 whitespace-nowrap text-[10px] font-semibold text-[var(--warn,#d97706)]" title="Charged by extending this hire. Not included in the purchase order's total.">
                          +{formatMoney(r.extensionCharge)}
                        </span>
                      )}
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">
                      {shortDate(r.hireStartDate)} → {shortDate(r.hireEndDate)} ({r.hireDays}d)
                    </td>
                    <td className="cell-y px-4">
                      {finished ? (
                        // Off the movement NOTES, not off when the record was typed — see deliveredOn.
                        // A completed hire with no dates is a hire closed by "Mark returned", which
                        // writes no handover: an em dash is the honest answer, and the title says why.
                        r.deliveredOn && r.collectedOn ? (
                          <span className="whitespace-nowrap text-[var(--muted)]">
                            {shortDate(r.deliveredOn)} → {shortDate(r.collectedOn)}
                            <span className="ml-1.5 font-semibold text-[var(--ink)]">{r.daysOnHire}d</span>
                            {(() => {
                              const v = r.daysOnHire == null ? null : heldVsBilled(r.daysOnHire, r.hireDays);
                              if (!v) return null;
                              // Held longer than billed is the one worth colouring: it is the gap a
                              // supplier invoices into. Coming back early is simply good news.
                              return (
                                <span
                                  className={`ml-1.5 text-[10px] font-bold ${v.over ? "text-[var(--warn,#d97706)]" : "text-[var(--faint)]"}`}
                                  title={`Billed ${r.hireDays} days`}
                                >
                                  {v.label}
                                </span>
                              );
                            })()}
                          </span>
                        ) : (
                          <span className="text-[var(--faint)]" title="No handover was recorded — this hire was closed with Mark returned.">
                            —
                          </span>
                        )
                      ) : (
                        <HireDeadline window={r.window}>{daysRemainingLabel(r.daysRemaining)}</HireDeadline>
                      )}
                    </td>
                    {/* The RESOLVED place, not the line's own text: a hire delivered to its warehouse
                        (or to the order's override address) carries no line address, so this used to
                        read "—" for a delivery that has a definite place.
                        The return leg only appears when it is somewhere ELSE — repeating the same
                        address on a second line says nothing and costs a row of height on every hire. */}
                    <td className={`cell-y max-w-[18rem] px-4 text-[var(--muted)] ${colClass("lg")}`}>
                      <span className="block truncate" title={delivery}>{delivery}</span>
                      {backTo !== delivery && (
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--faint)]" title={backTo}>
                          back to: {backTo}
                        </span>
                      )}
                    </td>
                    {finished && (
                      <td className="cell-y whitespace-nowrap px-4 text-right">
                        <span className="font-semibold text-[var(--ink)]">{formatMoney(r.lineTotal)}</span>
                        {/* Beside the committed value, never added into it: an extension is money
                            agreed after the order was sent and is not part of its totals. */}
                        {r.extensionCharge > 0 && (
                          <span
                            className="ml-1.5 text-[10px] font-semibold text-[var(--warn,#d97706)]"
                            title="Charged by extending this hire. Not included in the purchase order's total."
                          >
                            +{formatMoney(r.extensionCharge)}
                          </span>
                        )}
                        {/* The third kind of money on a hire, and the one nobody plans for. Beside
                            the other two rather than added into either: committed, agreed later, and
                            owed for breaking something are three different questions.
                            A hire with damage and no figure yet says so — £0.00 would close that
                            question without anybody deciding to. */}
                        {r.damagedQuantity > 0 && (
                          <div
                            className={`text-[10px] font-semibold ${r.damageCharge == null ? "text-[var(--faint)]" : "text-[var(--neg)]"}`}
                            title="What the supplier is charging for damage. Not part of the order's total."
                          >
                            {r.damageCharge == null ? "damage charge not known" : `+${formatMoney(r.damageCharge)} damage`}
                          </div>
                        )}
                      </td>
                    )}
                    {canAct && !finished && (
                      <td className="cell-y px-4 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {canExtend && (
                            <button
                              onClick={() => openExtend(r)}
                              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-colors hover:bg-[var(--surface-2)]"
                            >
                              Extend
                            </button>
                          )}
                          {/* The exit for a hire whose outstanding units are never arriving. Offered
                              only when some ARE outstanding — the server refuses it otherwise, and a
                              button that can only fail is not an option. Without it a part- or
                              never-delivered hire had no terminal state at all: it sat on the intake
                              queue forever and its order could never close. */}
                          {canSettle && hireTakesDelivery(r) && (
                            <button
                              onClick={() =>
                                setShortClosing({
                                  purchaseOrderId: r.purchaseOrderId,
                                  lineId: r.id,
                                  poCode: r.purchaseOrderCode,
                                  itemName: r.itemName,
                                  quantity: r.quantity,
                                  receivedQuantity: r.receivedQuantity,
                                  returnedQuantity: r.returnedQuantity,
                                })
                              }
                              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
                            >
                              Close short
                            </button>
                          )}
                          {/* One primary action per row, and it is the NEXT step in the hire's life:
                              kit that has not arrived cannot go back, and the server refuses it — so
                              the button that would fail is not offered.
                              The whole ORDER, not this row: one van carries several lines against one
                              note, and a per-row action would mint a separate record for each. */}
                          {canMove &&
                            (r.hireStatus === "awaiting_delivery" ? (
                              <Link
                                href={`/dashboard/rentals/receive/${r.purchaseOrderCode}`}
                                className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                              >
                                Receive
                              </Link>
                            ) : (
                              <Link
                                href={`/dashboard/rentals/return/${r.purchaseOrderCode}`}
                                className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                              >
                                Return
                              </Link>
                            ))}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {!loading && !error && total > 0 && (
          <Pagination
            embedded
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            total={total}
            label="hires"
            onPage={(p) => patch({ page: p > 1 ? String(p) : null }, false)}
          />
        )}
      </div>

      {/* See CloseHireShortModal for why the wording lives in a component of its own. */}
      <CloseHireShortModal
        target={shortClosing}
        onClose={() => setShortClosing(null)}
        onDone={() => setReloadKey((k) => k + 1)}
      />

      <Modal open={Boolean(extending)} onClose={closeExtend} title="Extend hire">
        <div className="space-y-3">
          <p className="text-xs text-[var(--muted)]">
            {extending?.itemName} currently ends {extending ? shortDate(extending.hireEndDate) : ""}. The reminder is
            recalculated from the new date.
          </p>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">New hire end date</span>
            <input
              type="date"
              value={newEndDate}
              min={extending?.hireEndDate.slice(0, 10)}
              onChange={(e) => setNewEndDate(e.target.value)}
              className={inputCls}
            />
          </label>

          {/* What the extension COSTS, before anyone commits to it.
              The whole hire is repriced and the old price subtracted, so a weekly hire stretched
              inside the week it already paid for adds nothing — pricing the added days on their own
              would invent a block. On the `total` basis there is no rate to calculate from, so the
              figure is typed rather than guessed. */}
          {extending && newEndDate && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">
              {extending.ratePeriod === "total" ? (
                <p>
                  This hire was priced as a total for the period, so there is no rate to extend from — enter the
                  charge agreed for the extra time, or leave it blank if there is none.
                </p>
              ) : (
                <p>
                  {extraPeriods != null && (
                    <>
                      <strong className="text-[var(--ink)]">
                        +{extraPeriods} {extending.ratePeriod}
                        {extraPeriods === 1 ? "" : "s"}
                      </strong>{" "}
                      at {formatMoney((extending.ratePence ?? 0) / 100)}/{extending.ratePeriod} ·{" "}
                    </>
                  )}
                  calculated{" "}
                  <strong className="text-[var(--ink)]">
                    {formatMoney((calculatedExtra ?? 0) / 100)} per unit
                  </strong>{" "}
                  · {extending.quantity} unit{extending.quantity === 1 ? "" : "s"} ={" "}
                  <strong className="text-[var(--ink)]">
                    {formatMoney(((calculatedExtra ?? 0) * extending.quantity) / 100)}
                  </strong>
                </p>
              )}
            </div>
          )}

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-[var(--muted)]">
              Agreed additional charge, per unit (£)
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={extraCharge}
              placeholder={calculatedExtra != null ? (calculatedExtra / 100).toFixed(2) : "0.00"}
              onChange={(e) => setExtraCharge(e.target.value)}
              className={inputCls}
            />
            <span className="mt-1 block text-[11px] text-[var(--faint)]">
              Leave blank to use the calculated figure. This is recorded against the hire — it does NOT change the
              purchase order&apos;s total.
            </span>
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={closeExtend}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
            <button
              onClick={doExtend}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Extend hire
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
