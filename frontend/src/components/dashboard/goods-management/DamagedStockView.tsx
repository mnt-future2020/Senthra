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
import type { DamagedHistory, DamagedRow } from "@/types/goodsManagement";
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
  // Accumulated oldest-first and then read back by id, so the arithmetic does not depend on the order
  // the list happens to arrive in (newest-first today). The last entry lands on `row.quantity`, which
  // is the same plain sum the card is built from — the two cannot disagree.
  const running = new Map<string, number>();
  let total = 0;
  for (const e of [...exits].sort((a, b) => Date.parse(a.declaredAt) - Date.parse(b.declaredAt))) {
    total += e.qty;
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
      balanceAfter: running.get(e.id) ?? e.qty,
      reason: LOSS_REASON_LABEL[e.reason] ?? e.reason,
      // The context that makes an entry readable months later, folded into the notes line the modal
      // already prints — who was holding it, on what job, and where it stands with the provider.
      notes: [
        // NOT the kind — the badge above already says it, and the row is narrowed to one kind anyway.
        // What belongs here is the context nothing else carries.
        e.jobNumber,
        e.engineerName,
        e.settlementState === "settled" ? "charged to the provider" : e.settlementState === "dismissed" ? "nothing owed" : "not yet charged",
        e.recoveredAt ? "later found and booked back in" : null,
        e.notes,
      ]
        .filter(Boolean)
        .join(" · "),
      photoUrl: e.photoUrl,
      sourceType: "rental_hire",
      sourceCode: e.poCode,
      actor: e.declaredBy,
    })),
    truncated: false,
  };
}

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
      gmService.listDamaged({ warehouseId, customerId }),
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
        // NEWEST FIRST across both sources. Appending the hired rows after the owned ones parked
        // yesterday's broken tester below a write-off from June, purely because of where the data came
        // from — an ordering the reader has no way to guess and no reason to want. The owned query
        // already sorts by recency; this extends the same rule over the merged list.
        setRows(
          [...owned, ...toDamagedRows(exits)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
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
  }, [warehouseId, customerId, hiredEquipmentHref]);

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
  // Counts for the pills come from the UNFILTERED rows — a pill showing "0" is a fact, and hiding it
  // once the pool empties would make the control move under the cursor.
  const ownerCounts = React.useMemo(() => {
    const c = { company: 0, customer: 0, rental: 0 };
    for (const r of rows ?? []) c[r.ownerType] += 1;
    return c;
  }, [rows]);
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
                      {search.trim() ? "No matching damaged stock" : "No damaged stock"}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      {search.trim()
                        ? `${rows.length} damaged item${rows.length === 1 ? "" : "s"} here, none match “${search.trim()}”.`
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
                    {search.trim() && (
                      <button type="button" onClick={() => { setSearch(""); setPage(1); }} className={`${secondaryBtn} mt-1`}>
                        Clear search
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
      {/* Shown once there's data to search — a clean pool gets its empty table, not a dead control. */}
      {rows && rows.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          {/* WHOSE damaged stock. Shown only when the tab actually holds more than one pool — a control
              that cannot change the list is a control the reader has to test to learn that. Ordered
              company → customer → rental, the same order as the Inventory pills above it, so the two
              rows of controls do not disagree about what this warehouse is made of. */}
          {(ownerCounts.company > 0 ? 1 : 0) + (ownerCounts.customer > 0 ? 1 : 0) + (ownerCounts.rental > 0 ? 1 : 0) > 1 && (
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
              {([
                ["all", "All", (rows ?? []).length],
                ["company", "Company (IRM)", ownerCounts.company],
                ["customer", "Customer", ownerCounts.customer],
                ["rental", "Rental (hired in)", ownerCounts.rental],
              ] as const).map(([id, label, count]) =>
                // A pool this warehouse has never had is not offered at all; one that is merely empty
                // right now still is, so the reader can see it is empty rather than wonder where it went.
                id !== "all" && count === 0 ? null : (
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

              The search box filters the loaded rows in memory, so it is NOT sent. */}
          {can("inventory.export") && (
            <ExportButton
              label="Export damaged"
              // OWNED stock only. The export walks the stock-position ledger, which a hire has no row
              // in by design, so the title says so rather than handing someone a file that looks like
              // the whole screen and quietly is not.
              title={warehouseId || customerId ? "Export this warehouse's owned damaged stock to CSV (hired equipment is on its own order)" : "Export every owned damaged-stock holding to CSV (hired equipment is on its own order)"}
              onExport={() => stockPositionService.exportPositionsCsv({ location: "damaged", warehouse: warehouseId, customer: customerId })}
            />
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
                // Green = units came BACK to usable, red = units went INTO the damaged pool.
                const dotCls = isRestore ? "bg-[var(--pos)]" : "bg-[var(--neg)]";
                const badgeCls = isRestore
                  ? "bg-[var(--pos)]/12 text-[var(--pos)]"
                  : "bg-[var(--neg)]/12 text-[var(--neg)]";
                const qtyCls = isRestore ? "text-[var(--pos)]" : "text-[var(--neg)]";
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
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeCls}`}>
                              {isRestore ? "Restored to usable" : historyRow?.exitKind === "loss" ? "Declared lost" : "Damage reported"}
                            </span>
                            <span className={`text-sm font-bold ${qtyCls}`}>
                              {units} unit{units === 1 ? "" : "s"}
                            </span>
                          </div>

                          <p className="text-xs text-[var(--muted)]">
                            Total after this:{" "}
                            <span className="font-semibold text-[var(--ink)]">
                              {e.balanceAfter} {historyRow?.exitKind === "loss" ? "lost" : "damaged"}
                            </span>
                          </p>

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
