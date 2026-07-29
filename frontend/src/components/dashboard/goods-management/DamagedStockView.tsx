"use client";

// DamagedStockView — renders damaged-stock rows for either a warehouse or a customer.
// Pass exactly one of warehouseId or customerId. No price/cost fields are displayed.
// `fill` switches to the dashboard's inline-scroll contract (bounded parent → the card takes
// the remaining height, only the table body scrolls, sticky header row); without it the view
// keeps its natural height and scrolls with the host page (e.g. the customer detail page).

import * as React from "react";
import { AlertTriangle, History, Search } from "lucide-react";
import Image from "next/image";

import * as gmService from "@/services/goodsManagement.service";
import type { DamagedHistory, DamagedRow } from "@/types/goodsManagement";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";
import { ghostBtn, inputCls } from "@/components/ui/styles";

const PAGE_SIZE = 20;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// History entries need the TIME too: two reports for the same item on the same day are exactly the
// case this drill-down exists to separate, and a date alone would render them indistinguishable.
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The photo lightbox is opened from two places — a row's latest photo and any entry's photo inside
// the history modal — so it holds its own subject rather than a whole DamagedRow.
interface PhotoSubject {
  url: string;
  itemName: string;
  caption: string | null;
}

// Advisory banner for the history modal. The shared <Notice> only models success/error, and neither
// of these is an error: a truncated list and a balance with no ledger rows behind it are both
// "heads up, this view isn't the whole picture".
function WarnBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-[var(--warn)]/10 px-3.5 py-2.5 text-xs font-semibold text-[var(--warn)]">
      <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// Free-text match over the row's text columns — item, warehouse, and the latest damage reason.
// The whole damaged list arrives in one call and is sliced client-side (see `pageRows`), so
// searching in memory sees every row, not just the page on screen. Exported for its sibling test.
// Only the fields the search reads, so the test doesn't have to build a whole DamagedRow.
export interface SearchableDamagedRow {
  itemName: string;
  warehouseName: string | null;
  reason: string | null;
}

export function searchDamagedRows<T extends SearchableDamagedRow>(rows: T[], term: string): T[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.itemName.toLowerCase().includes(q) ||
      (r.warehouseName ?? "").toLowerCase().includes(q) ||
      (r.reason ?? "").toLowerCase().includes(q),
  );
}

export function DamagedStockView({
  warehouseId,
  customerId,
  fill = false,
}: {
  warehouseId?: string;
  customerId?: string;
  fill?: boolean;
}) {
  const [search, setSearch] = React.useState("");
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
    gmService
      .listDamaged({ warehouseId, customerId })
      .then((data) => {
        if (!active) return;
        setError(null);
        setRows(data);
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
  }, [warehouseId, customerId]);

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
    gmService.getDamagedHistory(historyRow).then(
      (h) => { if (active) setHistory(h); },
      (e) => { if (active) setHistoryError(e instanceof Error ? e.message : "Could not load the damage history."); },
    );
    return () => { active = false; };
  }, [historyRow]);

  // Photo, Item, Owner, [Warehouse], Latest reason, Qty, Last updated, History
  const cols = warehouseId ? 7 : 8;
  const matched = React.useMemo(() => (rows ? searchDamagedRows(rows, search) : null), [rows, search]);
  const total = matched?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  // Only the current page is rendered, so the table stays fast even with a large damaged-stock list.
  const pageRows = matched ? matched.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : [];

  const table = (
    <table className="w-full text-left text-sm" style={{ minWidth: 700 }}>
      <thead className={fill ? "sticky top-0 z-10 bg-[var(--surface)]" : undefined}>
        <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="px-4 py-3">Photo</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Owner</th>
              {warehouseId ? null : <th className="px-4 py-3">Warehouse</th>}
              {/* "Latest" is load-bearing: the row aggregates every report for this item, so the
                  reason shown belongs to the most recent one only. The History column is where the
                  earlier ones live. */}
              <th className="px-4 py-3">Latest reason</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3">Last updated</th>
              <th className="px-4 py-3"><span className="sr-only">History</span></th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={cols} className="px-4 py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</td></tr>
            ) : rows === null ? (
              // Skeleton rows — same layout as real data, so the table doesn't jump when it loads.
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3"><Skeleton className="h-10 w-10 rounded-lg" /></td>
                  {Array.from({ length: cols - 1 }).map((__, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className={`h-4 ${j === cols - 2 ? "w-16" : "w-24"}`} /></td>
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
                        : "Damaged items returned from engineers will appear here."}
                    </p>
                    {search.trim() && (
                      <button type="button" onClick={() => { setSearch(""); setPage(1); }} className={`${ghostBtn} mt-1`}>
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
                  <td className="px-4 py-3">
                    {row.photoUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreview({ url: row.photoUrl!, itemName: row.itemName, caption: row.reason })}
                        className="block h-10 w-10 overflow-hidden rounded-lg border border-[var(--border)] transition-opacity hover:opacity-80"
                        aria-label="View latest damage photo"
                      >
                        <Image src={row.photoUrl} alt="Damage photo" width={40} height={40} className="h-10 w-10 object-cover" unoptimized />
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--faint)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{row.itemName}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${row.ownerType === "company" ? "bg-[var(--accent)]/12 text-[var(--accent)]" : "bg-indigo-500/12 text-indigo-600"}`}>
                      {row.ownerType === "company" ? "Company (IRM)" : "Customer"}
                    </span>
                  </td>
                  {warehouseId ? null : <td className="px-4 py-3 text-xs text-[var(--muted)]">{row.warehouseName ?? "—"}</td>}
                  <td className="max-w-[180px] px-4 py-3 text-xs text-[var(--muted)]">{row.reason ?? <span className="text-[var(--faint)]">—</span>}</td>
                  <td className="px-4 py-3 text-right font-bold text-[var(--neg)]">{row.quantity}</td>
                  <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(row.updatedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
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
        <div className="relative w-full shrink-0 sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search item, reason…"
            aria-label="Search damaged stock"
            className={`${inputCls} pl-9`}
          />
        </div>
      )}

      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="min-h-0 flex-1 overflow-auto">{table}</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">{table}</div>
      )}

      {rows && total > 0 && (
        <div className="shrink-0">
          <Pagination page={safePage} totalPages={totalPages} total={total} label="damaged items" onPage={setPage} />
        </div>
      )}

      {/* Full report history for one damaged row. The list above can only ever show the LATEST
          reason + photo (a damaged balance stores a quantity and nothing else), so this is where
          the evidence captured on every earlier report becomes reachable. */}
      <Modal
        open={historyRow !== null}
        title="Damage history"
        subtitle={
          historyRow
            ? `${historyRow.itemName} — ${historyRow.quantity} damaged unit${historyRow.quantity === 1 ? "" : "s"}${historyRow.warehouseName ? ` at ${historyRow.warehouseName}` : ""}`
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
          <WarnBanner>
            No ledger entries found for this item. The quantity shown may predate damage-history
            tracking.
          </WarnBanner>
        ) : (
          <div className="space-y-3">
            {history.truncated && (
              <WarnBanner>
                Showing the most recent {history.entries.length} entries only — older reports exist
                for this item.
              </WarnBanner>
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
                            <Image src={e.photoUrl} alt="Damage photo" width={80} height={80} className="h-20 w-20 object-cover" unoptimized />
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
                              {isRestore ? "Restored to usable" : "Damage reported"}
                            </span>
                            <span className={`text-sm font-bold ${qtyCls}`}>
                              {units} unit{units === 1 ? "" : "s"}
                            </span>
                          </div>

                          <p className="text-xs text-[var(--muted)]">
                            Total after this: <span className="font-semibold text-[var(--ink)]">{e.balanceAfter} damaged</span>
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
