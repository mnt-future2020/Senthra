"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Download, Loader2, Search } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { toolbarActionsCls, toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import type { PagedStockEntries } from "@/services/customer.service";
import {
  clickableRowCls,
  DetailGrid,
  DetailRow,
  EmptyState,
  fmtDate,
  TableCard,
  TableCardSkeleton,
} from "@/components/dashboard/portal/portalUi";
import type { PortalStockEntry } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

const HEADERS = ["Item", "Warehouse", "SKU", "Qty", "Barcode", "Status", "Received"];
const SKELETON_CELLS = ["h-3 w-32", "h-3 w-28", "h-3 w-16", "h-3 w-10", "h-3 w-20", "h-3 w-14", "h-3 w-20"];

// Matches the STATUS column verbatim rather than inventing friendlier words for the filter: an option
// that reads "Awaiting check-in" filtering to rows that say "draft" makes the customer work out that
// the two are the same thing. (Whether `draft`/`active` are the right words to show a customer AT ALL
// is a separate question — they'd have to change in the column and the filter together.)
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
];

// The filters an export was produced under, as one comparable string. `page` is absent on purpose:
// the export deliberately ignores paging ("everything matching what I'm looking at").
const exportFilterKey = (search: string, status: string, warehouseId: string) => `${search}|${status}|${warehouseId}`;

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
        status === "active" ? "bg-[var(--pos)]/12 text-[var(--pos)]" : "bg-amber-500/15 text-amber-600"
      }`}
    >
      {status}
    </span>
  );
}

// Everything the list can't fit. Deliberately does NOT show serial number, high-value or the
// low-stock threshold: no form anywhere in the app collects them (see the NOTE on CustomerStockEntry
// in schema.prisma), so they are permanently blank and the server no longer even sends them to the
// portal — rows that are always "—" teach the customer the panel is broken.
function StockEntryModal({ entry, onClose }: { entry: PortalStockEntry; onClose: () => void }) {
  return (
    <Modal open title={entry.itemName} subtitle={`At ${entry.warehouseName}`} onClose={onClose} size="md">
      <DetailGrid>
        {/* Quantity carries the unit with it. On the list it's a bare number in a narrow column,
            which leaves "25" ambiguous between 25 items and 25 boxes — the customer's own stock
            count is the last thing that should need a guess. */}
        <DetailRow label="Quantity" value={<span className="font-bold">{entry.quantity}{entry.uom ? ` ${entry.uom}` : ""}</span>} />
        <DetailRow label="Status" value={<StatusPill status={entry.status} />} />
        <DetailRow label="Category" value={entry.categoryName} />
        <DetailRow label="SKU" value={entry.sku ? <span className="font-mono text-xs">{entry.sku}</span> : null} />
        <DetailRow label="Warehouse" value={`${entry.warehouseName} (${entry.warehouseCode})`} />
        <DetailRow label="Barcode" value={entry.barcode ? <span className="font-mono text-xs">{entry.barcode}</span> : null} />
        <DetailRow label="Received" value={entry.receivedAt ? fmtDate(entry.receivedAt) : null} />
        <DetailRow label="Added" value={fmtDate(entry.createdAt)} />
      </DetailGrid>
      {/* Full width, below the grid — a description is prose and reads badly in a half-width cell. */}
      {entry.description && (
        <div className="mt-2 border-t border-[var(--border)] pt-3">
          <DetailRow label="Description" value={entry.description} />
        </div>
      )}
    </Modal>
  );
}

// Customer portal — My Stock. Server-paged (consignment entries accumulate forever); the page
// lives in the URL (?page) so it survives a refresh — same pattern as every other list.
export function MyStockView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Filters live in the URL (?q, ?status, ?page) like every other portal list, so a refresh, a
  // back-button press or a pasted link all land on the same view.
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const search = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  // An id, not a name — the dashboard links here with it, and a warehouse rename must not silently
  // turn a saved link into an empty list.
  const warehouseId = searchParams.get("warehouseId") ?? "";

  const [paged, setPaged] = React.useState<PagedStockEntries | null>(null);
  const [loading, setLoading] = React.useState(true);
  // `msg` is for a LOAD failure and blanks the page — there is no list to show. An export failure is
  // separate and renders INLINE: the list on screen is fine, and replacing it with an error would
  // throw away the filters the customer had just set to produce that export.
  const [msg, setMsg] = React.useState<Msg>(null);
  // Stored WITH the filters it was produced under. "Export truncated — narrow the filters and try
  // again" is advice about those filters, so once they change it is not merely stale, it is wrong:
  // it went on telling the customer to narrow the filters after they already had. Kept as data and
  // resolved during render (below) rather than cleared by an effect — this project's lint enforces
  // React-Compiler rules, which forbid setState inside an effect.
  const [exportMsg, setExportMsg] = React.useState<{ msg: Msg; filters: string } | null>(null);
  // The row whose detail panel is open. Holds the ROW, not an id — the list is already loaded, so
  // there is nothing to fetch and no loading state to show inside the modal.
  const [selected, setSelected] = React.useState<PortalStockEntry | null>(null);
  // Fetched ONCE, not from the list: options derived from the current page would only offer the
  // warehouses whose stock happens to be on screen, and picking one would then remove the option that
  // was just used. A failure here leaves the filter hidden rather than breaking the page — the list
  // still works, and an empty dropdown is worse than no dropdown.
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  // Set ONLY on success. A failed options fetch must not look like "this customer has no warehouses",
  // because the correction effect below would then treat a perfectly good `?warehouseId=` as stale and
  // silently drop the customer's filter over an unrelated request failing.
  const [warehousesLoaded, setWarehousesLoaded] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    customerService
      .getOwnStockWarehouses()
      .then((w) => { if (!active) return; setWarehouses(w); setWarehousesLoaded(true); })
      .catch(() => { if (active) setWarehouses([]); });
    return () => { active = false; };
  }, []);

  // The box is typed into freely and only pushed to the URL on a debounce, so every keystroke isn't a
  // fetch AND a history entry. Re-synced from the URL when it changes from outside (Clear, back
  // button) — done during render rather than in an effect so the input never shows a stale term for a
  // frame. Same shape as PortalSites / PortalProjects next door.
  const [searchInput, setSearchInput] = React.useState(search);
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      // A narrower list makes the old page number meaningless — and page 2 of a 1-page result is an
      // empty table that looks like "no stock".
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/stock?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  // A `?warehouseId=` naming a warehouse the customer no longer holds stock at — a bookmarked link, or
  // their stock has since moved — is CLEARED FROM THE URL rather than merely displayed as "All".
  //
  // Displaying a corrected value while still querying the raw one is what went wrong before: the
  // dropdown read "All warehouses" while the server kept filtering on the dead id, so the customer got
  // an empty list and a control that disagreed with it. Correcting the URL instead leaves ONE source of
  // truth — the fetch, the Clear button and the dropdown all read the same `warehouseId`, and the
  // resulting refetch shows the unfiltered list the dropdown is claiming.
  //
  // Cannot loop: clearing sets `warehouseId` to "" and the guard below returns early.
  React.useEffect(() => {
    if (!warehousesLoaded || !warehouseId) return;
    if (!warehouses.some((w) => w.id === warehouseId)) patchParams({ warehouseId: null }, true);
  }, [warehousesLoaded, warehouses, warehouseId, patchParams]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        // Searching SERVER-SIDE, not filtering the page in the browser: consignment history is paged
        // (26 entries is already 2 pages), so an in-memory filter would only ever search the rows that
        // happen to be on screen and quietly report "no matches" for stock sitting on page 2.
        const r = await customerService.getOwnStockEntries({
          q: search || undefined,
          status: status || undefined,
          warehouseId: warehouseId || undefined,
          page,
          pageSize: 20,
        });
        if (active) {
          setPaged(r);
          setMsg(null);
        }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your stock." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [search, status, warehouseId, page]);

  const setPage = (p: number) => patchParams({ page: p > 1 ? String(p) : null });

  // Passes the CURRENT filters, not the page. A capped export is reported rather than silently
  // truncated — a short file the customer believes is complete is worse than no file.
  const onExport = async () => {
    setExporting(true);
    // Stamped at CALL time, not on resolve — these are the filters the file was produced under,
    // even if the customer changes them while it downloads.
    const filters = exportFilterKey(search, status, warehouseId);
    try {
      const { capped } = await customerService.exportOwnStockCsv({
        q: search || undefined,
        status: status || undefined,
        warehouseId: warehouseId || undefined,
      });
      setExportMsg(
        capped
          ? { msg: { type: "error", text: "Export truncated — too many rows. Narrow the filters and try again." }, filters }
          : null,
      );
    } catch (err) {
      setExportMsg({ msg: { type: "error", text: err instanceof Error ? err.message : "Could not export your stock." }, filters });
    } finally {
      setExporting(false);
    }
  };

  const entries = paged?.entries ?? [];
  const filtered = !!search || !!status || !!warehouseId;
  // Shown only while the filters it was produced under still hold — see the state declaration.
  const visibleExportMsg =
    exportMsg && exportMsg.filters === exportFilterKey(search, status, warehouseId) ? exportMsg.msg : null;

  // Only the very first load blanks the page. Afterwards a search keeps the toolbar mounted and swaps
  // the table for a skeleton — pulling the search box out from under someone mid-type would lose focus
  // on every debounce.
  if (loading && paged === null) {
    return (
      <div className="flex h-full flex-col gap-6">
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      </div>
    );
  }

  if (msg?.type === "error") return <Notice msg={msg} />;

  return (
    <div className="flex h-full flex-col gap-6">
      {visibleExportMsg && <Notice msg={visibleExportMsg} />}

      {/* Toolbar — search + status. Same geometry as the Sites and Submissions toolbars. */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search item, SKU or barcode…"
            aria-label="Search your stock"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        {/* Grouped immediately after the search box, NOT pushed to the far right with `ml-auto`.
            Sites, Projects and Stock Submissions all sit their filter next to the search, and this was
            the one page that flung it to the opposite edge — on a wide screen that put the two halves
            of one toolbar a screen apart. The wrapper stays so the selects and Clear wrap together. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Only offered when the stock is actually split — a single-warehouse customer gets a
              dropdown whose only real choice is the one they already see. */}
          {warehouses.length > 1 && (
            <Select
              size="sm"
              // The raw URL value — safe to bind directly because the effect above guarantees it is
              // either a warehouse in these options or empty.
              value={warehouseId}
              onChange={(v) => patchParams({ warehouseId: v || null }, true)}
              options={[
                { value: "", label: "All warehouses" },
                ...warehouses.map((w) => ({ value: w.id, label: w.name })),
              ]}
              ariaLabel="Filter by warehouse"
            />
          )}
          <Select
            size="sm"
            value={status}
            onChange={(v) => patchParams({ status: v || null }, true)}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
          />
          {filtered && (
            <button
              type="button"
              onClick={() => patchParams({ q: null, status: null, warehouseId: null }, true)}
              className={toolbarBtn}
            >
              Clear
            </button>
          )}
        </div>

        {/* Page action, at the right-hand end of the row the list is filtered from — NOT in the top
            bar. Up there it sat against the browser's own chrome, a screen's width from the rows it
            exports. Separated from the filter group so it doesn't read as another filter. */}
        <div className={`${toolbarActionsCls} sm:ml-auto`}>
          {/* Exports the FILTERED set, not the page — so the filters just set carry into the file and
              there is no second place to re-specify them. Disabled on an empty list: a CSV with only
              a header row reads as a broken download. */}
          <button
            type="button"
            onClick={onExport}
            disabled={exporting || entries.length === 0}
            title="Export the filtered list to CSV"
            className={toolbarBtn}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>

      {loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      ) : entries.length === 0 ? (
        // Two DIFFERENT empty states. "No stock entries yet" for a customer whose filters hide
        // everything would tell them we hold nothing of theirs — the one thing this page must never
        // get wrong.
        filtered ? (
          <EmptyState
            icon={Search}
            title="No matching stock"
            hint="Nothing here matches your search. Clear the filters to see everything we hold."
          />
        ) : (
          <EmptyState
            icon={Boxes}
            title="No stock entries yet"
            hint="Once your stock is received at a warehouse, it will appear here."
          />
        )
      ) : (
        <>
          <TableCard
            headers={HEADERS}
            minWidth={750}
            fill
            footer={
              <Pagination
                embedded
                page={paged?.page ?? 1}
                totalPages={paged?.totalPages ?? 1}
                total={paged?.total ?? 0}
                label="entries"
                onPage={setPage}
              />
            }
          >
            {entries.map((e) => (
              // Opens the detail panel. Keyboard-reachable and announced as a button, so the drill-down
              // isn't mouse-only — a <tr> with an onClick and nothing else is invisible to a keyboard.
              <tr
                key={e.id}
                onClick={() => setSelected(e)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelected(e);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`View details for ${e.itemName}`}
                className={clickableRowCls}
              >
                <td className="cell-y px-4 font-semibold text-[var(--ink)]">{e.itemName}</td>
                <td className="cell-y px-4">
                  <div className="text-[var(--ink)]">{e.warehouseName}</div>
                  <div className="font-mono text-[11px] text-[var(--faint)]">{e.warehouseCode}</div>
                </td>
                <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.sku ?? "—"}</td>
                {/* The unit rides with the number here too — a bare count leaves "25" ambiguous. */}
                <td className="cell-y px-4 font-bold text-[var(--ink)]">
                  {e.quantity}
                  {e.uom && <span className="ml-1 text-[11px] font-semibold text-[var(--muted)]">{e.uom}</span>}
                </td>
                <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "—"}</td>
                <td className="cell-y px-4"><StatusPill status={e.status} /></td>
                <td className="cell-y px-4 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
              </tr>
            ))}
          </TableCard>
        </>
      )}

      {selected && <StockEntryModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
