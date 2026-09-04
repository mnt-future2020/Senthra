"use client";

// DamagedStockView — renders damaged-stock rows for either a warehouse or a customer.
// Pass exactly one of warehouseId or customerId. No price/cost fields are displayed.
// `fill` switches to the dashboard's inline-scroll contract (bounded parent → the card takes
// the remaining height, only the table body scrolls, sticky header row); without it the view
// keeps its natural height and scrolls with the host page (e.g. the customer detail page).

import * as React from "react";
import { AlertTriangle, History, Search } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import * as gmService from "@/services/goodsManagement.service";
import * as rentalService from "@/services/rental.service";
import * as stockPositionService from "@/services/stockPosition.service";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import type { DamagedHistory, DamagedRow, RentalDamageStatus } from "@/types/goodsManagement";
import type { HireCustodyExit } from "@/types/rental";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
// Three different jobs, three different styles: ghostBtn for the per-row History action (a small
// inline action, its documented use); secondaryBtn for the empty-state Clear, which stands alone in
// the centre of the panel rather than in a filter row; toolbarInputCls for the list search box.
import { ghostBtn, secondaryBtn, toolbarInputCls } from "@/components/ui/styles";
import { formatDate as fmtDate, formatDateTime as fmtDateTime } from "@/lib/formatDate";
// The SAME money formatter the order page prints a hire charge with. A second one here would be a
// second way for the same figure to look, on two screens describing the same note.
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";

const PAGE_SIZE = 20;


// History entries need the TIME too: two reports for the same item on the same day are exactly the
// case this drill-down exists to separate, and a date alone would render them indistinguishable.

// The photo lightbox is opened from two places — a row's latest photo and any entry's photo inside
// the history modal — so it holds its own subject rather than a whole DamagedRow.
interface PhotoSubject {
  url: string;
  itemName: string;
  caption: string | null;
}

// Free-text match over the row's text columns — item, warehouse, and the latest damage reason.
// The whole damaged list arrives in one call and is sliced client-side (see `pageRows`), so
// searching in memory sees every row, not just the page on screen. Exported for its sibling test.
// Only the fields the search reads, so the test doesn't have to build a whole DamagedRow.
export interface SearchableDamagedRow {
  itemName: string;
  warehouseName: string | null;
  reason: string | null;
  /**
   * Rental context — optional, because owned rows have none.
   *
   * A hired row's identity is mostly this: someone hunting it types the order code, the job or the
   * engineer's name, and none of those appear in the item name.
   */
  poCode?: string | null;
  jobNumber?: string | null;
  engineerName?: string | null;
}

export function searchDamagedRows<T extends SearchableDamagedRow>(rows: T[], term: string): T[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.itemName.toLowerCase().includes(q) ||
      (r.warehouseName ?? "").toLowerCase().includes(q) ||
      (r.reason ?? "").toLowerCase().includes(q) ||
      // A rental row's identity is mostly its CONTEXT — someone hunting it types the order code, the
      // job or the engineer, none of which appear in the item name. Undefined on owned rows, so this
      // costs them nothing.
      (r.poCode ?? "").toLowerCase().includes(q) ||
      (r.jobNumber ?? "").toLowerCase().includes(q) ||
      (r.engineerName ?? "").toLowerCase().includes(q),
  );
}

/**
 * A hire's custody exits, rolled up into damaged ROWS.
 *
 * An adapter rather than a second table, because the failure being fixed was two tables: owned damage
 * was listed here and hired damage was not, so an empty pool read as "nothing is broken" while a broken
 * tester sat on a pane two pills away.
 *
 * AGGREGATED, and that is the half that was wrong at first. Every other row in this list is a BALANCE —
 * one line per item with a running quantity, and the individual reports behind it under History. Hired
 * damage was listed event-by-event instead, so one hire reported three times filled three rows with the
 * same item and the same words while the customer row beside it stayed a single line. Same list, two
 * different meanings of "row".
 *
 * Grouped by hire line AND kind: a hire holding one broken unit and one missing one is two different
 * problems with two different exits, and summing them into "2" would describe neither. The newest event
 * supplies the reason, the photograph and the context, exactly as the owned balance shows its latest
 * report beside its running total.
 *
 * Nothing is written anywhere by this — the rows are a view over the hire's own records. A hire is never
 * in `DamagedStockBalance` and must never be: its damage is a charge the provider raises, and putting it
 * in the pool we write off would count one fault twice.
 */
export function toDamagedRows(exits: HireCustodyExit[]): DamagedRow[] {
  const groups = new Map<string, HireCustodyExit[]>();
  for (const e of exits) {
    const key = `${e.purchaseOrderRentalLineId}|${e.kind}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  return [...groups.values()].map((group) => {
    // Newest first, so `latest` is the report the row speaks with.
    const sorted = [...group].sort((a, b) => Date.parse(b.declaredAt) - Date.parse(a.declaredAt));
    const latest = sorted[0]!;
    return {
      // The HIRE LINE and kind, not an event id — the row is the group, and its History drill-down is
      // keyed on the same thing.
      id: `${latest.purchaseOrderRentalLineId}|${latest.kind}`,
      warehouseId: latest.warehouseId,
      warehouseName: null,
      ownerType: "rental" as const,
      irmItemId: null,
      customerStockEntryId: null,
      customerId: null,
      itemName: latest.itemName,
      quantity: sorted.reduce((n, e) => n + e.qty, 0),
      updatedAt: latest.declaredAt,
      reason: LOSS_REASON_LABEL[latest.reason] ?? latest.reason,
      photoUrl: latest.photoUrl,
      poCode: latest.poCode,
      jobNumber: latest.jobNumber,
      engineerName: latest.engineerName,
      exitKind: latest.kind,
      hireLineId: latest.purchaseOrderRentalLineId,
      /** How many reports are behind the total — what History opens. */
      reportCount: sorted.length,
    };
  });
}

/**
 * Does this custody event still count toward the row's CURRENT damaged quantity?
 *
 * A HAND-MIRRORED COPY of the server filter the damaged list is built with —
 * `findOpenByWarehouses` in `backend/src/modules/purchase-order/hireCustodyExit.repository.ts`. The
 * card's quantity comes from that query; the history modal is handed EVERY event on the hire line and
 * has to reach the same number from the larger set, so the rule has to be stated identically in both
 * places or the two disagree. `DamagedStockView.rentalHistory.test.ts` writes the server's rule out
 * longhand rather than importing this, so widening one without the other fails there.
 *
 * Both dimensions matter, and for different reasons:
 *   • `settlementState` must be `unsettled` — a charged or dismissed report has been answered, and the
 *     list is the worklist of what still needs one.
 *   • `withdrawn` / `recovered` / `returned_to_supplier` are excluded on CUSTODY grounds — the report
 *     never happened, the unit came back, or the provider has collected it. None is broken equipment
 *     standing in this building, which is what this pool counts.
 */
export function countsAsCurrentDamage(e: Pick<HireCustodyExit, "custodyState" | "settlementState">): boolean {
  return (
    e.settlementState === "unsettled" &&
    e.custodyState !== "withdrawn" &&
    e.custodyState !== "recovered" &&
    e.custodyState !== "returned_to_supplier"
  );
}

/**
 * The two independent state columns, resolved into the one word a reader of the history needs.
 *
 * CUSTODY IS READ FIRST, deliberately. A withdrawn report and a unit the provider has collected are
 * facts nothing else on the entry carries, whereas the money is printed beside it anyway (the charge
 * and its note code have their own line). Reading settlement first would label a withdrawn report
 * "No charge", which states the least important half of a record that was retracted outright.
 */
export function rentalEntryStatus(e: Pick<HireCustodyExit, "custodyState" | "settlementState">): RentalDamageStatus {
  if (e.custodyState === "withdrawn") return "withdrawn";
  if (e.custodyState === "recovered") return "recovered";
  if (e.custodyState === "returned_to_supplier") return "returned";
  if (e.settlementState === "settled") return "charged";
  if (e.settlementState === "dismissed") return "no_charge";
  return "active";
}

/**
 * A hire's custody events, shaped as the damaged-stock history the modal already renders.
 *
 * Same adapter idea as `toDamagedRows`, one level down: the question ("everything that ever happened to
 * this") is identical, only the ledger behind it differs. `quantityDelta` is positive on every entry
 * because a hire has no "restore to usable" — the units go back to the provider, they do not rejoin our
 * stock — and a negative delta is what the modal colours green as units returning to usable, which
 * would be a plain lie about somebody else's equipment.
 */
export function hireHistory(row: DamagedRow, exits: HireCustodyExit[]): DamagedHistory {
  // A RUNNING TOTAL, not this entry's own quantity — the modal prints it as "Total after this: N",
  // which is a claim about the standing tally and not about the event. Set to `e.qty` it made every
  // report agree with itself and none of them agree with the card: three reports of one unit each
  // printed "Total after this: 1" three times, under a heading that said 3.
  //
  // ONLY EVENTS THAT STILL COUNT ADVANCE IT, and that is the half this got wrong. The card is built
  // from the OPEN events at this warehouse; the modal is handed EVERY event on the hire line. Summing
  // all of them made the same number mean two different things: a hire with one open report beside two
  // already charged printed "Total after this: 3 damaged" under a heading that said 1. The heading was
  // right. A charged, dismissed, withdrawn or collected event is history — it is listed, labelled with
  // what became of it, and contributes nothing to a total that describes what is broken here NOW.
  //
  // Accumulated oldest-first and then read back by id, so the arithmetic does not depend on the order
  // the list happens to arrive in (newest-first today). The newest counting entry lands on
  // `row.quantity`, which is the same sum the card is built from — the two cannot disagree.
  const running = new Map<string, number>();
  let total = 0;
  for (const e of [...exits].sort((a, b) => Date.parse(a.declaredAt) - Date.parse(b.declaredAt))) {
    if (countsAsCurrentDamage(e)) total += e.qty;
    running.set(e.id, total);
  }

  return {
    warehouseId: row.warehouseId,
    ownerType: "rental",
    irmItemId: null,
    customerStockEntryId: null,
    itemName: row.itemName,
    quantity: row.quantity,
    entries: exits.map((e) => ({
      id: e.id,
      date: e.declaredAt,
      type: "write_off" as const,
      quantityDelta: e.qty,
      balanceAfter: running.get(e.id) ?? 0,
      reason: LOSS_REASON_LABEL[e.reason] ?? e.reason,
      // The context that makes an entry readable months later, folded into the notes line the modal
      // already prints — who was holding it and on what job.
      //
      // WHERE IT STANDS IS NO LONGER RETYPED HERE. It used to be appended as prose ("charged to the
      // provider", "nothing owed"), which the badge beside it now says in its own words; keeping both
      // printed the same fact twice on one entry. It moved to `status` — a value the modal can colour,
      // count and test, rather than a sentence it can only display.
      notes: [
        // NOT the kind — the badge above already says it, and the row is narrowed to one kind anyway.
        // What belongs here is the context nothing else carries.
        e.jobNumber,
        e.engineerName,
        e.notes,
      ]
        .filter(Boolean)
        .join(" · "),
      photoUrl: e.photoUrl,
      sourceType: "rental_hire",
      sourceCode: e.poCode,
      actor: e.declaredBy,
      status: rentalEntryStatus(e),
      countsToTotal: countsAsCurrentDamage(e),
      // Straight off the payload the API already sends. Both were arriving and being dropped here,
      // which left the one screen a warehouse reads unable to say what a fault had cost — while the
      // order page two clicks away printed the figure and its note code.
      settledCharge: e.settledCharge,
      settledByCode: e.settledByCode,
    })),
    truncated: false,
  };
}

/**
 * Labels for `RentalDamageStatus`. `active` is deliberately absent: what an event that still counts
 * should be called depends on its KIND ("Damage reported" / "Declared lost"), which is the wording the
 * modal already used before any of these existed and is resolved at the call site.
 */
const RENTAL_STATUS_LABEL: Record<Exclude<RentalDamageStatus, "active">, string> = {
  charged: "Charged to provider",
  no_charge: "No charge",
  withdrawn: "Report withdrawn",
  returned: "Returned to provider",
  recovered: "Found and booked back in",
};


/**
 * A LOSS carries one of the shared write-off reasons, so the row prints the words rather than the
 * stored key. Damage carries the engineer's own sentence and falls through unchanged.
 */
const LOSS_REASON_LABEL: Record<string, string> = {
  not_returned: "Not returned by the engineer",
  lost_in_transit: "Lost in transit",
  engineer_left: "Engineer left the company holding it",
  site_theft: "Stolen from site or van",
  other: "Other",
};

/**
 * Whether the damaged-stock export may run, why not when it may not, and what its tooltip says.
 *
 * ONE decision behind three pieces of UI, so the greyed button, the visible reason and the tooltip
 * cannot drift apart.
 *
 * TWO independent reasons to stand down:
 *
 *   · an ACTIVE SEARCH, because this box and the export search different things. The box matches
 *     item name, damage reason, order and job; the stock-position ledger the export reads matches
 *     item name, SKU and item code — and a damaged position carries neither a reason nor a code.
 *     Forwarding the term would answer a different question in silence.
 *   · NOTHING TO EXPORT, the convention every other export in this dashboard follows.
 *
 * `reason` is returned as text for the PAGE, not only as a tooltip: a disabled button cannot take
 * focus and nothing hovers on the warehouse tablet this screen is used on, so a `title` alone leaves
 * a greyed control with no explanation anyone can reach.
 */
export function damagedExportState(input: {
  /** The DEBOUNCED search term — the one the list actually queried with. */
  search: string;
  /** Rows the file would hold: the OWNED pools only, since a hire has no position row. */
  exportableCount: number;
  /** Whether this instance is pinned to one warehouse or customer (changes the wording only). */
  scoped: boolean;
}): { disabled: boolean; reason: string | null; title: string } {
  if (input.search.trim()) {
    return {
      disabled: true,
      reason: "Export can’t match reason, order or job — clear the search to export.",
      title: "Clear the search to export — it matches damage details the export cannot carry",
    };
  }
  if (input.exportableCount === 0) {
    return { disabled: true, reason: null, title: "Nothing to export in this pool" };
  }
  return {
    disabled: false,
    reason: null,
    title: input.scoped
      ? "Export this warehouse's owned damaged stock to CSV (hired equipment is on its own order)"
      : "Export every owned damaged-stock holding to CSV (hired equipment is on its own order)",
  };
}

export function DamagedStockView({
  warehouseId,
  customerId,
  fill = false,
  hiredEquipmentHref,
}: {
  warehouseId?: string;
  customerId?: string;
  /**
   * Where hired-in equipment's damage lives, when this pane is shown somewhere that has such a pane.
   *
   * This pool is OWNED stock only — a hire is the provider's, its damage is their charge rather than
   * our write-off, and mixing the two would double-count one fault against a bill they raise once. But
   * "not in this pool" must never read as "not damaged": a warehouse manager looking for the broken
   * tester an engineer brought back yesterday would find an empty table and conclude nothing was
   * wrong. So the pane says where that equipment is instead of staying silent about it.
   *
   * Omitted on the customer page, which has no hire pool to point at.
   */
  hiredEquipmentHref?: string;
  fill?: boolean;
}) {
  const { can } = useAuth();
  const [search, setSearch] = React.useState("");
  // The term the SERVER is asked for. The box updates on every keystroke (the owned pool is filtered
  // server-side now), so without this each letter would be a request.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  /**
   * Which pool the reader is looking at.
   *
   * Three sources sit in one list now, and "damaged" means something different in each: company stock
   * we write off, a customer's consignment we answer to them for, and a hire we are billed for. Someone
   * reconciling one of those does not want the other two in the way — and the pills also make it plain
   * that the tab holds all three, which the merged list alone does not.
   */
  const [owner, setOwner] = React.useState<"all" | "company" | "customer" | "rental">("all");
  const [rows, setRows] = React.useState<DamagedRow[] | null>(null);
  // Per-pool totals for the OWNED pools, from the response — stable whichever pool is selected. The
  // hire count is derived from the exits below, which are fetched unfiltered by owner for the same
  // reason: a pool switcher whose options depend on the current selection cannot be navigated.
  const [ownedCounts, setOwnedCounts] = React.useState<{ company: number; customer: number }>({ company: 0, customer: 0 });
  const [rentalCount, setRentalCount] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<PhotoSubject | null>(null); // open damage-photo lightbox
  const [page, setPage] = React.useState(1);
  // The row whose full history is open — also the fetch key for the drill-down below.
  const [historyRow, setHistoryRow] = React.useState<DamagedRow | null>(null);
  const [history, setHistory] = React.useState<DamagedHistory | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    Promise.all([
      // Owner and search are applied SERVER-side now, after the warehouse scope — the pool used to
      // arrive whole and be narrowed in the browser. The hire side below is a different source with
      // its own scope, so its rows are filtered against the same two values once merged.
      gmService.listDamaged({
        warehouseId,
        customerId,
        ownerType: owner === "company" || owner === "customer" ? owner : undefined,
        search: debouncedSearch || undefined,
        // Looking at the HIRE pool: those rows come from the custody-exit source below, so the owned
        // query is asked for its COUNTS ONLY. That is what keeps the pool switcher populated without
        // transferring rows this view will not draw — and without inventing an ownerType that means
        // "neither", which is a filter that breaks the moment the real values are validated.
        countsOnly: owner === "rental",
      }),
      // The hire side, folded into the SAME list. Fetched only where there is a hire pool to belong to
      // — the customer page has none — and a failure here yields an empty list rather than taking the
      // owned pool down with it: two sources, and one being unavailable must not hide the other.
      hiredEquipmentHref
        ? rentalService
            // DAMAGE ONLY, and the exclusion is the point: this pool is "still here, and not fit to
            // use". Owned stock behaves exactly so — a unit written off as LOST leaves no row here at
            // all, it becomes an event in the movement ledger — and hired kit listing its losses beside
            // its damage made one source in the list obey a different rule from the other two.
            //
            // A lost hire is not hidden by this. It is still money owed on somebody else's asset, so it
            // lives where that work is done: on the hire's own pane, on its order's custody timeline,
            // on the settle badge and in the audit trail. What it is not is stock standing in a pool.
            //
            // The PANE's warehouse, not merely the caller's permission scope. Without it an
            // unrestricted actor was shown every depot's hired damage beside this depot's owned stock.
            .listOpenCustodyExits({ warehouseId, kind: "damage" })
            .then((r) => r.exits)
            .catch(() => [])
        : Promise.resolve([]),
    ])
      .then(([owned, exits]) => {
        if (!active) return;
        setError(null);
        // Counts come from the RESPONSE, computed across both owned pools before ownerType narrowed
        // anything. Deriving them from the rows on screen is what made the switcher delete itself:
        // pick Company and the other pools read zero, so the row that offers them stopped rendering.
        setOwnedCounts(owned.counts);
        setRentalCount(toDamagedRows(exits).length);
        // NEWEST FIRST across both sources. Appending the hired rows after the owned ones parked
        // yesterday's broken tester below a write-off from June, purely because of where the data came
        // from — an ordering the reader has no way to guess and no reason to want. The owned query
        // already sorts by recency; this extends the same rule over the merged list.
        setRows(
          [...owned.rows, ...toDamagedRows(exits)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        );
        setPage(1); // reset paging when the scope (warehouse/customer) changes
      })
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Could not load damaged stock.",
        );
      });
    return () => {
      active = false;
    };
    // `hiredEquipmentHref` is in here because it decides WHETHER the hire side is fetched at all — it
    // is the "this context has a hire pool" signal, not decoration. Leaving it out would leave the
    // rental rows missing on a re-render that turned it on.
  }, [warehouseId, customerId, hiredEquipmentHref, owner, debouncedSearch]);

  // Opening a row clears the previous row's result HERE rather than in the effect below: an event
  // handler may setState freely, whereas a synchronous setState in an effect body triggers a
  // cascading render (and the React Compiler lint rejects it). Without the reset, switching rows
  // would briefly show the previous item's history under the new item's title.
  const openHistory = (row: DamagedRow) => {
    setHistory(null);
    setHistoryError(null);
    setHistoryRow(row);
  };

  // Fetch the full report history for the opened row. Keyed on the row itself, so opening a
  // different row refetches — and a slow response for a row the user already closed or switched
  // away from is discarded rather than landing in the wrong modal.
  React.useEffect(() => {
    if (!historyRow) return;
    let active = true;
    // SAME modal, same question, different source. Owned stock is a walk of the damaged-stock
    // transaction ledger; a hire has no row in that ledger by design, so its history is its own custody
    // record. Branching here rather than at the button keeps every row in the list behaving alike.
    const load: Promise<DamagedHistory> =
      historyRow.ownerType === "rental"
        ? rentalService
            .listHireCustodyHistory(historyRow.hireLineId ?? "")
            // NARROWED TO THIS ROW'S KIND. The endpoint returns everything that ever happened to the
            // hire, and the row is one problem on it — so a "1 damaged unit" drill-down was listing the
            // LOSS beside it, under a "Damage reported" badge. One row, one question.
            .then((r) => hireHistory(historyRow, r.exits.filter((e) => e.kind === (historyRow.exitKind ?? "damage"))))
        : gmService.getDamagedHistory(
            historyRow as { warehouseId: string; ownerType: "company" | "customer"; irmItemId: string | null; customerStockEntryId: string | null },
          );
    load.then(
      (h) => { if (active) setHistory(h); },
      (e) => { if (active) setHistoryError(e instanceof Error ? e.message : "Could not load the damage history."); },
    );
    return () => { active = false; };
  }, [historyRow]);

  // Photo, Item, Owner, [Warehouse], Latest reason, Qty, Last updated, History
  const cols = warehouseId ? 7 : 8;
  // Counts for the pills, and the pills' own right to exist, come from the RESPONSE — never from the
  // rows on screen.
  //
  // They used to be counted off `rows`, which is the set AFTER the owner filter. Selecting Company
  // therefore zeroed the customer and rental counts, and the switcher (which only renders when more
  // than one pool is non-empty) removed itself — leaving the reader inside a filter with no control
  // to leave it by. The server now returns owned counts computed before `ownerType` is applied, and
  // the hire side is fetched unfiltered by owner, so these numbers do not move when the pick does.
  const ownerCounts = React.useMemo(
    () => ({ company: ownedCounts.company, customer: ownedCounts.customer, rental: rentalCount }),
    [ownedCounts, rentalCount],
  );

  /**
   * How many rows the export would actually hold — the OWNED pools only, since a hire has no
   * position row to export.
   *
   * Read off the counts the list already returned rather than the rows on screen: those are paged,
   * and the counts are computed server-side across both owned pools before `ownerType` narrows
   * anything. No extra query, and it is correct on the "rental" pool too, where the file is the owned
   * stock the screen is not currently showing.
   */
  const exportableCount =
    owner === "company" ? ownedCounts.company : owner === "customer" ? ownedCounts.customer : ownedCounts.company + ownedCounts.customer;

  const exportState = damagedExportState({
    search: debouncedSearch,
    exportableCount,
    scoped: Boolean(warehouseId || customerId),
  });
  /** Is the reader looking at a narrowed view? Drives every "you can still get back" affordance. */
  const anyFilterActive = owner !== "all" || search.trim() !== "";
  /** Anything at all to show, before this filter narrowed it. */
  const hasAnyDamage = ownerCounts.company + ownerCounts.customer + ownerCounts.rental > 0 || (rows?.length ?? 0) > 0;
  /** Every pool the SEARCHED set contains, plus whichever is selected — see the switcher below. */
  const poolsPresent =
    (ownerCounts.company > 0 ? 1 : 0) + (ownerCounts.customer > 0 ? 1 : 0) + (ownerCounts.rental > 0 ? 1 : 0);
  // The OWNED rows already arrive filtered — this pass exists for the HIRE rows, which come from a
  // different endpoint and are merged in the browser. It is idempotent on the owned ones, and it also
  // keeps the list honest while a keystroke is still in flight to the server.
  const matched = React.useMemo(
    () => (rows ? searchDamagedRows(owner === "all" ? rows : rows.filter((r) => r.ownerType === owner), search) : null),
    [rows, search, owner],
  );
  const total = matched?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  // Only the current page is rendered, so the table stays fast even with a large damaged-stock list.
  const pageRows = matched ? matched.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : [];

  const table = (
    <table className="w-full text-left text-sm" style={{ minWidth: 700 }}>
      <thead className={fill ? "sticky top-0 z-10 bg-[var(--surface)]" : undefined}>
        <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="cell-y px-4">Photo</th>
              <th className="cell-y px-4">Item</th>
              <th className="cell-y px-4">Owner</th>
              {warehouseId ? null : <th className="cell-y px-4">Warehouse</th>}
              {/* "Latest" is load-bearing: the row aggregates every report for this item, so the
                  reason shown belongs to the most recent one only. The History column is where the
                  earlier ones live. */}
              <th className="cell-y px-4">Latest reason</th>
              <th className="cell-y px-4 text-right">Qty</th>
              <th className="cell-y px-4">Last updated</th>
              <th className="cell-y px-4"><span className="sr-only">History</span></th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={cols} className="px-4 py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</td></tr>
            ) : rows === null ? (
              // Skeleton rows — same layout as real data, so the table doesn't jump when it loads.
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="cell-y px-4"><Skeleton className="h-10 w-10 rounded-lg" /></td>
                  {Array.from({ length: cols - 1 }).map((__, j) => (
                    <td key={j} className="cell-y px-4"><Skeleton className={`h-4 ${j === cols - 2 ? "w-16" : "w-24"}`} /></td>
                  ))}
                </tr>
              ))
            ) : total === 0 ? (
              <tr>
                <td colSpan={cols} className="px-4 py-14">
                  {/* Keyed off the MATCHED count so a search that misses doesn't render an empty
                      table, and worded so it never reads as "this pool is clean". */}
                  <div className="flex flex-col items-center justify-center gap-2 text-center">
                    <AlertTriangle className="h-7 w-7 text-[var(--faint)]" />
                    <p className="text-sm font-semibold text-[var(--ink)]">
                      {anyFilterActive ? "No matching damaged stock" : "No damaged stock"}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      {anyFilterActive
                        ? `Nothing here matches ${[search.trim() && `“${search.trim()}”`, owner !== "all" && "this pool"].filter(Boolean).join(" in ")}.`
                        : "Damaged company and customer stock returned from engineers will appear here."}
                    </p>
                    {/* Hired equipment is damaged in the same building by the same people, and it is
                        the FIRST thing someone checks here for. The section below lists it; this says
                        so, because an empty OWNED table must never read as "nothing is broken". */}
                    {!search.trim() && hiredEquipmentHref && (
                      <Link href={hiredEquipmentHref} className="mt-1 text-xs font-semibold text-[var(--accent)] underline-offset-2 hover:underline">
                        Hired-in equipment is listed separately below, and on its hire
                      </Link>
                    )}
                    {/* An owner filter can empty this table with no search involved — that dead end
                        used to offer nothing at all, because only a search got a way out. */}
                    {anyFilterActive && (
                      <button
                        type="button"
                        onClick={() => { setSearch(""); setOwner("all"); setPage(1); }}
                        className={`${secondaryBtn} mt-1`}
                      >
                        {search.trim() && owner !== "all" ? "Clear filters" : search.trim() ? "Clear search" : "Show all pools"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.id} className="border-b border-[var(--border)] align-middle last:border-0">
                  {/* Photo thumbnail — opens the in-app preview modal */}
                  <td className="cell-y px-4">
                    {row.photoUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreview({ url: row.photoUrl!, itemName: row.itemName, caption: row.reason })}
                        className="block h-10 w-10 overflow-hidden rounded-lg border border-[var(--border)] transition-opacity hover:opacity-80"
                        aria-label="View latest damage photo"
                      >
                        {/* h-full w-full so the image fills the button's CONTENT box. Sizing it to
                            the outer 40px instead left the width clamped to 38px by preflight's
                            `img { max-width: 100% }` (the 1px border) while the height stayed 40 —
                            one dimension modified, the other not, which is exactly what next/image
                            warns about in dev. */}
                        <Image src={row.photoUrl} alt="Damage photo" width={40} height={40} className="h-full w-full object-cover" unoptimized />
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--faint)]">—</span>
                    )}
                  </td>
                  <td className="cell-y px-4 font-semibold text-[var(--ink)]">
                    {row.itemName}
                    {/* WHAT happened and WHERE, under the item — never instead of it. This column shows
                        an item on every other row, and a rental row printing "Damaged on hire" there
                        put two different facts in one place and read as a bug. The job and the engineer
                        are the two things a conversation with the provider turns on. */}
                    {row.ownerType === "rental" && (
                      <div className="mt-0.5 text-[11px] font-normal text-[var(--faint)]">
                        {[
                          row.exitKind === "loss" ? "Lost — never came back" : "Damaged while on hire",
                          row.jobNumber,
                          row.engineerName,
                          // Says out loud that the total is made of several reports, so a "3" is not
                          // misread as one report of three units. History opens all of them.
                          (row.reportCount ?? 1) > 1 ? `${row.reportCount} reports` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="cell-y px-4">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        row.ownerType === "company"
                          ? "bg-[var(--accent)]/12 text-[var(--accent)]"
                          : row.ownerType === "rental"
                            ? "bg-[var(--neg)]/12 text-[var(--neg)]"
                            : "bg-indigo-500/12 text-indigo-600"
                      }`}
                    >
                      {row.ownerType === "company" ? "Company (IRM)" : row.ownerType === "rental" ? "Rental (hired in)" : "Customer"}
                    </span>
                    {/* Not decoration: it is where this row is settled. A hire's damage is charged on
                        its order, so the row has to be able to send you there. */}
                    {row.ownerType === "rental" && row.poCode && (
                      <Link
                        href={`/dashboard/purchase-orders/${row.poCode}`}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 block font-mono text-[11px] font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        {row.poCode}
                      </Link>
                    )}
                  </td>
                  {warehouseId ? null : <td className="cell-y px-4 text-xs text-[var(--muted)]">{row.warehouseName ?? "—"}</td>}
                  <td className="max-w-[180px] cell-y px-4 text-xs text-[var(--muted)]">{row.reason ?? <span className="text-[var(--faint)]">—</span>}</td>
                  <td className="cell-y px-4 text-right font-bold text-[var(--neg)]">{row.quantity}</td>
                  <td className="cell-y px-4 text-xs text-[var(--muted)]">{fmtDate(row.updatedAt)}</td>
                  <td className="cell-y px-4">
                    <div className="flex justify-end">
                      {/* ONE button, one word, on every row. A hire has no row in the damaged-stock
                          ledger this walks for owned items — its history is its own custody record —
                          but that is a difference in SOURCE, and the person clicking it is asking the
                          same question. Sending only rental rows off to another page made one row in
                          the list behave unlike all the others. */}
                      <button
                        type="button"
                        onClick={() => openHistory(row)}
                        className={ghostBtn}
                        aria-label={`View every damage report for ${row.itemName}`}
                      >
                        <History className="h-3.5 w-3.5" />
                        History
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
  );

  return (
    <div className={fill ? "flex h-full flex-col gap-4" : "space-y-4"}>
      {/* Shown once there is data to search — a genuinely clean pool gets its empty table, not a row
          of dead controls — OR whenever a filter is active, whatever that filter left behind.
          
          That second clause is the whole point. This used to be `rows.length > 0`, which was fine
          while `rows` meant "everything in this pool": now the owner and the search are applied at
          the server, so a filter that matches nothing emptied `rows` and took the entire toolbar —
          pills, search box and all — off screen with it. A filter must never be able to remove the
          controls that clear it. */}
      {/* `sm:flex-wrap` for the same reason listToolbarCls carries it — but NOT listToolbarCls itself.
          This is an inner filter ROW, not a toolbar card: it has no surface, no border, no shadow and
          no padding of its own, because it sits directly on the page above the table's card. Adopting
          the shared constant would draw a card here that has never been here.

          Without the wrap the row cannot reflow, and its first child is a `shrink-0` pill group, so
          the squeeze lands entirely on the search box and Export. Measured in Chrome against the
          running app at a 768px viewport, on a warehouse where the pool pills were not even rendered:
          the row's content already needed 474px inside a 448px box — 26px over, with `flex-wrap:
          nowrap`. With all four pool pills present there is another ~350px of rigid content to place.
          One `sm:flex-wrap` lets the row drop to a second line instead; a row that fits still renders
          as one line, so nothing changes on the widths where it was already fine. */}
      {rows && (hasAnyDamage || anyFilterActive) && (
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* WHOSE damaged stock. Shown only when the tab actually holds more than one pool — a control
              that cannot change the list is a control the reader has to test to learn that. Ordered
              company → customer → rental, the same order as the Inventory pills above it, so the two
              rows of controls do not disagree about what this warehouse is made of. */}
          {/* Rendered whenever there is more than one pool to choose between — OR whenever a pool is
              already selected. That second clause is the escape hatch: a filter must never be able to
              remove the control that clears it, and a search narrow enough to leave one pool standing
              would otherwise do exactly that. */}
          {(poolsPresent > 1 || owner !== "all") && (
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
              {([
                ["all", "All", ownerCounts.company + ownerCounts.customer + ownerCounts.rental],
                ["company", "Company (IRM)", ownerCounts.company],
                ["customer", "Customer", ownerCounts.customer],
                ["rental", "Rental (hired in)", ownerCounts.rental],
              ] as const).map(([id, label, count]) =>
                // A pool this warehouse has never had is not offered — unless it is the one currently
                // selected, which must stay visible so the reader can see what they picked and unpick it.
                id !== "all" && count === 0 && owner !== id ? null : (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { setOwner(id); setPage(1); }}
                    aria-pressed={owner === id}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                      owner === id ? "bg-[var(--surface)] text-[var(--ink)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {label}
                    <span className="ml-1 text-[var(--faint)]">{count}</span>
                  </button>
                ),
              )}
            </div>
          )}
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search item, reason, order, job…"
              aria-label="Search damaged stock"
              className={`${toolbarInputCls} pl-9`}
            />
          </div>
          {/* Damaged stock IS exportable — it is a position like any other — but only from the
              Inventory screen with the right filter set, which nobody standing on this page would
              think to do. Reuses the positions export filtered to `location=damaged` rather than
              adding an endpoint, exactly as the engineer lens does: same rows, same permission, no
              second definition of "damaged stock" to drift from the one the Hub already uses.

              The page's OWN scope goes with it. This component is embedded in CustomerDetail and
              WarehouseDetail, and the table above is loaded with that id — an export that sent only
              `location=damaged` handed the operator every OTHER customer's damaged stock from a
              button sitting on one customer's page. The service's params are `warehouse`/`customer`,
              not the prop names, which is exactly how the omission went unnoticed.

              The OWNER pool goes with it too — company/customer map one-for-one onto the positions
              ledger's `ownership`, so selecting a pool and exporting no longer returns both. "Rental"
              is not sent because a hire has no position row at all; the file is owned-stock only and
              the title says so.

              SEARCH is deliberately NOT sent, and it is the one filter that cannot be forwarded
              honestly. This box searches item name, damage REASON, order and job (see its
              placeholder); the positions ledger the export reads searches item name, SKU and item
              code — and a damaged position carries neither a reason nor a code, so most of what this
              box matches simply does not exist on the other side. Forwarding the term would be a
              SECOND interpretation of one control: "cracked screen" would come back empty and look
              like a bug in the data rather than in the query. Making it match for real means joining
              the damage TRANSACTION for its reason on every exported row, which is a query this
              download does not otherwise need.

              So the export stands down while a search is active — and SAYS SO IN THE PAGE. A `title`
              alone was not enough: this screen is used on a warehouse tablet, where nothing hovers, a
              disabled button cannot take focus, and a greyed control with no visible reason reads as
              broken. The note below is real text in the flow, so it is announced in document order
              and legible on a phone. */}
          {can("inventory.export") && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:ml-auto">
              {exportState.reason && (
                // Real text in the flow, not a tooltip — see damagedExportState for why.
                <span className="text-xs leading-snug text-[var(--muted)]">{exportState.reason}</span>
              )}
              <ExportButton
                label="Export damaged"
                // Disabled state and wording from one decision — see damagedExportState.
                title={exportState.title}
                disabled={exportState.disabled}
                onExport={() =>
                  stockPositionService.exportPositionsCsv({
                    location: "damaged",
                    warehouse: warehouseId,
                    customer: customerId,
                    ownership: owner === "company" || owner === "customer" ? owner : undefined,
                  })
                }
              />
            </div>
          )}
        </div>
      )}

      {/* Both scroll containers below are `relative`, and it is load-bearing: the "History" column's
          header label is an sr-only span, Tailwind's sr-only is position:absolute, and with no
          positioned ancestor it resolves against the initial containing block. It then escapes the
          scroll container at the table's full width and drags the whole PAGE into a horizontal
          scroll on a phone, while every visible element stays inside the viewport. See the note in
          van-requests/vanRequestUi.tsx. */}
      {/* Pagination lives INSIDE the card in both layouts — as a card of its own it paid a second
          border, a shadow and the parent's flex gap for a footer belonging to the table above it. */}
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="relative min-h-0 flex-1 overflow-auto">{table}</div>
          {rows && total > 0 ? (
            <Pagination embedded page={safePage} totalPages={totalPages} total={total} label="damaged items" onPage={setPage} />
          ) : null}
        </div>
      ) : (
        <div className="relative rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {/* Scroller inside, so the footer isn't dragged sideways with a wide table. */}
          <div className="overflow-x-auto">{table}</div>
          {rows && total > 0 ? (
            <Pagination embedded page={safePage} totalPages={totalPages} total={total} label="damaged items" onPage={setPage} />
          ) : null}
        </div>
      )}

      {/* Full report history for one damaged row. The list above can only ever show the LATEST
          reason + photo (a damaged balance stores a quantity and nothing else), so this is where
          the evidence captured on every earlier report becomes reachable. */}
      <Modal
        open={historyRow !== null}
        // A LOSS is not damage, and the heading is the first thing read. Titling a missing tester's
        // record "Damage history" contradicted every line inside it.
        title={historyRow?.exitKind === "loss" ? "Loss history" : "Damage history"}
        subtitle={
          historyRow
            ? `${historyRow.itemName} — ${historyRow.quantity} ${historyRow.exitKind === "loss" ? "unit" : "damaged unit"}${historyRow.quantity === 1 ? "" : "s"}${historyRow.exitKind === "loss" ? " declared lost" : ""}${historyRow.warehouseName ? ` at ${historyRow.warehouseName}` : ""}`
            : undefined
        }
        onClose={() => setHistoryRow(null)}
        size="lg"
        scrollBody
      >
        {historyError ? (
          <Notice msg={{ type: "error", text: historyError }} />
        ) : history === null ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : history.entries.length === 0 ? (
          // Defensive: a balance always has at least one report behind it, so an empty list means
          // the ledger and the balance have diverged — say so plainly rather than showing nothing.
          <Notice
            size="sm"
            msg={{ type: "warn", text: "No ledger entries found for this item. The quantity shown may predate damage-history tracking." }}
          />
        ) : (
          <div className="space-y-3">
            {history.truncated && (
              <Notice
                size="sm"
                msg={{ type: "warn", text: `Showing the most recent ${history.entries.length} entries only — older reports exist for this item.` }}
              />
            )}

            {/* Vertical timeline, newest first. The connector runs BEHIND the dots (absolute, inset
                to the dot's centre) and is hidden on the last entry so the line stops at the oldest
                report rather than trailing into empty space. */}
            <ol className="space-y-0">
              {history.entries.map((e, i) => {
                const isRestore = e.type === "restore";
                const units = Math.abs(e.quantityDelta);
                const isLast = i === history.entries.length - 1;
                /**
                 * A RENTAL event that has been answered — charged, dismissed, withdrawn or collected.
                 *
                 * It is still history and still listed, but it is not what is broken here now, so it
                 * loses the alarm colouring: a withdrawn report rendered in the same red as a live one
                 * says the equipment is broken when the record says it never was. Undefined on owned
                 * entries, which have no settlement lifecycle and keep exactly the colours they had.
                 */
                const historic = e.status != null && e.status !== "active";
                // Green = units came BACK to usable, red = units went INTO the damaged pool, grey =
                // a rental event that no longer describes current damage.
                const dotCls = isRestore
                  ? "bg-[var(--pos)]"
                  : historic
                    ? "bg-[var(--faint)]"
                    : "bg-[var(--neg)]";
                const badgeCls = isRestore
                  ? "bg-[var(--pos)]/12 text-[var(--pos)]"
                  : historic
                    ? "bg-[var(--surface-2)] text-[var(--muted)]"
                    : "bg-[var(--neg)]/12 text-[var(--neg)]";
                const qtyCls = isRestore
                  ? "text-[var(--pos)]"
                  : historic
                    ? "text-[var(--muted)]"
                    : "text-[var(--neg)]";
                return (
                  <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {/* Connector + dot */}
                    <div className="relative flex w-4 shrink-0 justify-center">
                      {!isLast && (
                        <span
                          aria-hidden
                          className="absolute top-4 -bottom-5 w-px bg-[var(--border)]"
                        />
                      )}
                      <span
                        aria-hidden
                        className={`relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-[var(--surface)] ${dotCls}`}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      {/* The reason IS the headline — it's the evidence this whole screen exists to
                          surface, so it leads at full size rather than sitting under a badge. */}
                      <p className="wrap-break-word text-sm font-semibold text-[var(--ink)]">{e.reason}</p>

                      <div className="mt-2 flex gap-3">
                        {e.photoUrl ? (
                          <button
                            type="button"
                            onClick={() => setPreview({ url: e.photoUrl!, itemName: history.itemName, caption: e.reason })}
                            className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] transition-opacity hover:opacity-80"
                            aria-label={`View the damage photo from ${fmtDateTime(e.date)}`}
                          >
                            {/* h-full w-full — same reason as the row thumbnail above. */}
                            <Image src={e.photoUrl} alt="Damage photo" width={80} height={80} className="h-full w-full object-cover" unoptimized />
                          </button>
                        ) : (
                          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[10px] text-[var(--faint)]">
                            No photo
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-1.5">
                          {/* Plain English, no arithmetic signs. "+2" beside "Written off" read as a
                              contradiction — an increase labelled as a removal — so the quantity is
                              spelled out and the running total is stated rather than arrowed. */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {/* WORDS, not a colour, carry the difference — the badge reads the same to
                                somebody who cannot tell the grey from the red. A rental event that has
                                been answered says what became of it; everything else keeps the wording
                                it always had. */}
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeCls}`}>
                              {isRestore
                                ? "Restored to usable"
                                : historic
                                  ? RENTAL_STATUS_LABEL[e.status as Exclude<RentalDamageStatus, "active">]
                                  : historyRow?.exitKind === "loss"
                                    ? "Declared lost"
                                    : "Damage reported"}
                            </span>
                            <span className={`text-sm font-bold ${qtyCls}`}>
                              {units} unit{units === 1 ? "" : "s"}
                            </span>
                          </div>

                          {/* THE RUNNING TOTAL IS A CLAIM ABOUT NOW, so an event that no longer counts
                              must not appear to have moved it. Owned entries never set `countsToTotal`
                              and keep the line unchanged — their `balanceAfter` is the ledger's own
                              stored balance, which a restore genuinely does move. */}
                          {e.countsToTotal === false ? (
                            <p className="text-xs text-[var(--muted)]">No longer in the damaged total</p>
                          ) : (
                            <p className="text-xs text-[var(--muted)]">
                              Total after this:{" "}
                              <span className="font-semibold text-[var(--ink)]">
                                {e.balanceAfter} {historyRow?.exitKind === "loss" ? "lost" : "damaged"}
                              </span>
                            </p>
                          )}

                          {/* WHAT IT COST AND ON WHICH DOCUMENT — rental only, and the reason this
                              modal can now answer an accountant. A note raised before the provider has
                              quoted carries no figure, which is a different fact from a charge of zero
                              and is said in words rather than shown as "£0.00". */}
                          {e.settledByCode && (
                            <p className="text-xs text-[var(--muted)]">
                              {e.settledCharge != null ? formatMoney(e.settledCharge) : "Awaiting a quote"} ·{" "}
                              <span className="font-mono text-[11px] text-[var(--ink)]">{e.settledByCode}</span>
                            </p>
                          )}

                          {e.notes && <p className="wrap-break-word text-xs text-[var(--muted)]">{e.notes}</p>}

                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--faint)]">
                            {e.sourceCode && (
                              <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                                {e.sourceCode}
                              </span>
                            )}
                            <span>{fmtDateTime(e.date)}</span>
                            {e.actor && <span className="truncate">· {e.actor}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </Modal>

      {preview && (
        <ImageLightbox
          src={preview.url}
          alt={`Damage photo — ${preview.itemName}`}
          caption={
            <>
              <span className="font-semibold text-white">{preview.itemName}</span>
              {preview.caption ? <> · {preview.caption}</> : null}
            </>
          }
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
