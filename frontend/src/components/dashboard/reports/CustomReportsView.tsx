"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Download, FileBarChart, FileSpreadsheet, Loader2, Play } from "lucide-react";

import * as reportsService from "@/services/reports.service";
import type { CustomReportQuery, CustomReportResult, CustomReportType } from "@/services/reports.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { downloadCsv } from "@/lib/csvExport";
import { toolbarActionsCls, toolbarBtn, toolbarDateCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { SitePicker, siteOptionLabel } from "@/components/ui/SitePicker";
import { searchJobSites } from "@/services/job.service";
import { CELL_ONE_LINE, tableMinWidth, type ColWidth } from "@/components/ui/tableLayout";
import { useProjectOptions, useReportFilterOptions, type Option } from "./reportFilterOptions";

// ── Custom Reports (FLOW 10B) ──────────────────────────────────────────────────────────────────
//
// Pick a report type, set the filters it supports, run it. The catalogue — including which filters
// and columns each report has — comes from the SERVER; this screen renders what it is given and never
// names a field of its own. That is what makes "custom" safe: the user composes a request from a
// fixed vocabulary, not a query.
//
// Deliberately NOT Finance. These are stock, project and engineer reports; spend lives at
// /dashboard/finance behind its own permission.

/** Which filter controls a report shows — driven entirely by what the server said it accepts. */
const FILTER_LABEL: Record<string, string> = {
  dateFrom: "From",
  dateTo: "To",
  customerId: "Customer",
  projectId: "Project",
  siteId: "Site",
  warehouseId: "Warehouse",
  irmItemId: "Item",
  engineerId: "Engineer",
  itemKind: "Stock type",
};

/**
 * Rows fetched per request.
 *
 * The screen used to send no limit at all, so it took the server's default of 100 and rendered them
 * under a footer reading "100 row(s)" — with `capped` false (it only trips at the 5,000 export
 * ceiling), no page control, and nothing anywhere to say more existed. A report that silently stops
 * short is the single worst thing this screen can do, and it was doing it on every run of more than
 * a hundred rows while the export beside it quietly returned everything.
 */
const PAGE = 100;

const STOCK_TYPE_OPTIONS = [
  { value: "", label: "All stock" },
  { value: "irm", label: "Company (IRM)" },
  { value: "customer", label: "Customer stock" },
];

/** Widest cells first — the same content-worth sizing every other list in this app declares. */
const widthOf = (header: string, numeric?: boolean): ColWidth => {
  if (numeric) return "narrow";
  if (/date|code|source|movement|job/i.test(header)) return "narrow";
  if (/item|customer|project|site|warehouse|engineer|reference/i.test(header)) return "wide";
  return "normal";
};

export function CustomReportsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [types, setTypes] = React.useState<CustomReportType[] | null>(null);
  const [result, setResult] = React.useState<CustomReportResult | null>(null);
  const [rows, setRows] = React.useState<Record<string, string | number>[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reportKey = searchParams.get("type") ?? "";
  const active = types?.find((t) => t.key === reportKey) ?? types?.[0];

  const lists = useReportFilterOptions();
  const projects = useProjectOptions(searchParams.get("customerId") || undefined);
  // The picked site's label — a search result is not a complete set, so a selected id cannot be
  // looked up in the options afterwards.
  const [siteLabel, setSiteLabel] = React.useState<string | null>(null);
  const customerForSites = searchParams.get("customerId") || undefined;
  const searchSites = React.useCallback(
    (term: string) => searchJobSites(term, customerForSites).then((r) => r.sites),
    [customerForSites],
  );

  // The period is PRIMARY — it is the axis a report is read along and it is set on every run.
  // Everything else is set occasionally and folds behind the Filters trigger.
  const primary = React.useMemo(() => (active?.filters ?? []).filter((f) => f === "dateFrom" || f === "dateTo"), [active]);
  const secondary = React.useMemo(() => (active?.filters ?? []).filter((f) => f !== "dateFrom" && f !== "dateTo"), [active]);

  // What the trigger counts. SECONDARY only: the dates are visible on the row, and counting a filter
  // the user can already see would make the badge read high for no reason anyone could act on.
  const activeFilterCount = React.useMemo(
    () => secondary.filter((f) => searchParams.get(f)).length,
    [secondary, searchParams],
  );

  // Filters live in the URL, so a report a user built is shareable and survives a refresh — the same
  // convention every other filtered screen here uses.
  const query = React.useMemo<CustomReportQuery>(() => {
    const q: CustomReportQuery = { report: active?.key ?? "" };
    for (const f of active?.filters ?? []) {
      const v = searchParams.get(f);
      if (v) (q as unknown as Record<string, string>)[f] = v;
    }
    return q;
  }, [active, searchParams]);

  const patch = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "custom");
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") params.delete(k);
      else params.set(k, v);
    }
    router.replace(`/dashboard/reports?${params.toString()}`, { scroll: false });
  };

  /** Reset the folded filters only — the dates stay, for the same reason they are not counted. */
  const clearFilters = () => patch(Object.fromEntries(secondary.map((f) => [f, null])));

  React.useEffect(() => {
    void (async () => {
      try {
        setTypes(await reportsService.listCustomReportTypes());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the report list.");
      }
    })();
  }, []);

  // A request token, so a second Generate started before the first came back cannot have its result
  // overwritten by the older one — and so a Load more racing a re-run is discarded.
  const reqId = React.useRef(0);

  const run = React.useCallback(async () => {
    if (!active) return;
    const mine = ++reqId.current;
    setRunning(true);
    setError(null);
    try {
      const res = await reportsService.runCustomReport({ ...query, report: active.key, limit: PAGE });
      if (mine !== reqId.current) return;
      setResult(res);
      setRows(res.rows);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (e) {
      if (mine !== reqId.current) return;
      setError(e instanceof Error ? e.message : "Could not run that report.");
      setResult(null);
      setRows([]);
      setCursor(null);
      setHasMore(false);
    } finally {
      if (mine === reqId.current) setRunning(false);
    }
  }, [active, query]);

  const loadMore = async () => {
    if (!active || !cursor || loadingMore) return;
    const mine = reqId.current; // a re-run bumps it and aborts this append
    setLoadingMore(true);
    try {
      const res = await reportsService.runCustomReport({ ...query, report: active.key, cursor, limit: PAGE });
      if (mine !== reqId.current) return;
      setRows((prev) => [...prev, ...res.rows]);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (e) {
      // Keep what we have — the user can retry without losing the rows already on screen.
      pushToast(e instanceof Error ? e.message : "Could not load more rows.", "alert");
    } finally {
      if (mine === reqId.current) setLoadingMore(false);
    }
  };

  const download = async (format: "csv" | "xlsx") => {
    if (!active) return;
    setDownloading(true);
    try {
      if (format === "xlsx") {
        const { capped } = await reportsService.downloadCustomReportXlsx({ ...query, report: active.key });
        if (capped) pushToast("Export truncated — narrow the filters and try again.", "alert");
      } else {
        const { capped } = await downloadCsv(reportsService.customReportCsvUrl({ ...query, report: active.key }), active.key);
        if (capped) pushToast("Export truncated — narrow the filters and try again.", "alert");
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not download the export.", "alert");
    } finally {
      setDownloading(false);
    }
  };

  /** The picker for one id-valued filter, and what it says when it has nothing to offer. */
  const pickerFor = (f: string): { options: Option[]; placeholder: string; disabled?: boolean; hint?: string } => {
    if (f === "customerId") return { options: lists.customers, placeholder: "All customers" };
    if (f === "warehouseId") return { options: lists.warehouses, placeholder: "All warehouses" };
    if (f === "irmItemId") return { options: lists.items, placeholder: "All items" };
    if (f === "engineerId") return { options: lists.engineers, placeholder: "All engineers" };
    // Projects belong to a customer. Asked for in that order rather than offered as a flat list —
    // see useProjectOptions.
    if (!searchParams.get("customerId")) {
      return { options: [], placeholder: "Pick a customer first", disabled: true, hint: "Choose a customer to filter by project" };
    }
    return { options: projects, placeholder: "All projects" };
  };

  if (!types) return <Skeleton className="h-64 rounded-xl" />;
  if (types.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-sm text-[var(--muted)]">
        No report types are available to you.
      </div>
    );
  }

  const columns = result?.report.columns ?? [];

  // The filter CONTROL for one key, without its label — the popover labels its own rows and the
  // inline row uses a `<label>` wrapper, so the control itself must not carry one.
  const controlFor = (f: string) => {
    const label = FILTER_LABEL[f] ?? f;
    if (f === "dateFrom" || f === "dateTo") {
      return (
        <input
          type="date"
          aria-label={label}
          value={searchParams.get(f) ?? ""}
          onChange={(e) => patch({ [f]: e.target.value || null })}
          className={toolbarDateCls}
        />
      );
    }
    // SITE is a type-ahead, not a Select: sites are customer-owned and bulk-imported in the
    // thousands, so a bounded option list would silently truncate. Narrowed to the customer already
    // chosen, which is what makes the shortlist readable.
    if (f === "siteId") {
      return (
        <SitePicker
          value={searchParams.get(f) ?? ""}
          selectedLabel={siteLabel}
          search={searchSites}
          onChange={(id, option) => {
            setSiteLabel(option ? siteOptionLabel(option) : null);
            patch({ [f]: id || null });
          }}
          ariaLabel={label}
        />
      );
    }
    if (f === "itemKind") {
      return (
        <Select
          size="sm"
          value={searchParams.get(f) ?? ""}
          onChange={(v) => patch({ [f]: v || null })}
          options={STOCK_TYPE_OPTIONS}
          ariaLabel={label}
        />
      );
    }
    const { options, placeholder, disabled, hint } = pickerFor(f);
    return (
      <div title={hint}>
        <Select
          size="sm"
          disabled={disabled}
          value={searchParams.get(f) ?? ""}
          onChange={(v) => {
            // Changing the customer invalidates the project chosen under the old one.
            // Changing the customer invalidates BOTH children chosen under the old one.
            if (f === "customerId") patch({ customerId: v || null, projectId: null, siteId: null });
            else patch({ [f]: v || null });
          }}
          options={[{ value: "", label: placeholder }, ...options]}
          ariaLabel={label}
        />
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        {/* ONE row, always.
            
            Eight labelled controls on a `flex-wrap` row spread edge to edge on a wide screen (a
            straggling line of pickers with gaps between them) and, at 1024px, wrapped into three
            rows that filled the viewport — the filter card WAS the page, and the table it filters had
            nowhere left to render.
            
            So the row keeps what a report is actually composed from — the type, and the period it
            covers — and everything else folds behind one trigger carrying the ACTIVE count. That
            count is the bargain: hiding a filter is only safe if you can still see at a glance that
            it is on. Exactly the reasoning (and the component) the Stock Movement feed already uses.
            
            Every control comes from the shared toolbar family (`py-2.5`) so they sit level.

            Two explicit ZONES rather than one wrapping row that pushes the actions right with
            `ml-auto`. `ml-auto` only lands where you want it while everything still fits on ONE line:
            the moment the row wrapped — which it did at 1024px — the button dropped onto a line of its
            own and got shoved to the far right edge, marooned opposite a gap. Wrapping is not
            something CSS lets you style around, so the layout must not depend on whether it happened.
            Zones + `justify-between` give two states and no third: side by side above `xl`, stacked
            and left-aligned below it. */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Report type</span>
            <Select
              size="sm"
              value={active?.key ?? ""}
              onChange={(v) => {
                // Switching report clears the old filters — a report that does not accept them would
                // be REJECTED by the server, and carrying them over would look like a broken screen.
                const cleared: Record<string, string | null> = { type: v };
                for (const f of Object.keys(FILTER_LABEL)) cleared[f] = null;
                patch(cleared);
                setResult(null);
                setRows([]);
                setCursor(null);
                setHasMore(false);
              }}
              options={types.map((t) => ({ value: t.key, label: t.label }))}
              ariaLabel="Report type"
            />
          </label>

          {/* The PERIOD stays on the row: it is the axis a report is read along, it is set on every
              run, and a report that does not accept dates (a position report) simply does not show
              it. Same rule the movement ledger applies to its own date range. */}
          {primary.map((f) => (
            <label key={f} className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {FILTER_LABEL[f] ?? f}
              </span>
              {controlFor(f)}
            </label>
          ))}

          {/* Only rendered when this report HAS secondary filters — a trigger that opens an empty
              panel is worse than no trigger. */}
          {secondary.length > 0 ? (
            <FilterPopover activeCount={activeFilterCount} onClear={clearFilters}>
              {secondary.map((f) => (
                <label key={f} className="block">
                  <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    {FILTER_LABEL[f] ?? f}
                  </span>
                  {controlFor(f)}
                </label>
              ))}
            </FilterPopover>
          ) : null}

        </div>

          {/* Actions: their own zone, so they sit at the right end when there is room and directly
              under the filters when there is not — never half-way between. `shrink-0` keeps the
              buttons at their natural width instead of compressing "Generate report" to fit. */}
          <div className={`${toolbarActionsCls} xl:shrink-0`}>
            <button onClick={() => void run()} disabled={running} className={toolbarPrimaryBtn}>
              <Play className="h-3.5 w-3.5" /> {running ? "Running…" : "Generate report"}
            </button>
            {result && can("reports.export") && (
              <>
                <button onClick={() => void download("xlsx")} disabled={downloading} className={toolbarBtn}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                </button>
                <button onClick={() => void download("csv")} disabled={downloading} className={toolbarBtn}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Fills the same space the table would have, for the same reason the resting state does: a
          one-line error box floating above half a blank screen reads as a second failure. */}
      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm font-semibold text-[var(--neg)]">
          {error}
        </div>
      ) : null}

      {!result && !error ? (
        // The screen's RESTING state, and previously a blank half-page.
        //
        // Nothing had been run yet, so nothing rendered below the filter card and the viewport just
        // stopped — which reads as a broken page rather than a report waiting to be generated. An
        // empty state costs no data and answers the only question a first-time visitor has here.
        //
        // It is also the ONLY place the report's description belongs. The toolbar carried a copy of
        // it too, which put the same sentence twice on one screen and spent a band of the filter card
        // saying what the panel below already said better. Do not re-add it up there.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
          <FileBarChart className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">{active?.label ?? "Custom report"}</p>
          <p className="max-w-md text-xs text-[var(--muted)]">
            {active?.description ?? "Choose a report type."} Set the period and any filters above, then
            select <span className="font-semibold text-[var(--ink)]">Generate report</span>.
          </p>
        </div>
      ) : null}

      {result ? (
        // `min-h-0 flex-1` — the card takes the height the filter row left over, so the table body is
        // what scrolls and the page has no dead space under it. A content-height card left the whole
        // lower half of the screen blank on a report of ten rows.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {/* Truncation is stated, never silent — a short table the user believes is complete is the
              worst possible outcome for a report. This is the HARD ceiling (the export cap); the
              ordinary "there is more" case is the Load more control below, which is not truncation. */}
          {result.capped ? (
            <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] text-[var(--muted)]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              This report has reached the maximum it can return — narrow the filters to see everything.
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="py-16 text-center text-sm text-[var(--muted)]">No rows match those filters.</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table
                className="w-full text-left text-sm"
                style={{ minWidth: tableMinWidth(columns.map((c) => widthOf(c.header, c.numeric))) }}
              >
                <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    {columns.map((c) => (
                      <th key={c.key} className={`px-4 py-3 ${c.numeric ? "text-right" : ""}`}>
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b border-[var(--border)] last:border-0">
                      {columns.map((c) => {
                        const v = row[c.key] ?? "";
                        return (
                          <td
                            key={c.key}
                            // `truncate` + a title: however long an item or site name gets, the row
                            // cannot grow to two lines and cost the screen a row of data.
                            title={c.numeric ? undefined : String(v)}
                            className={`px-4 py-2.5 text-[var(--ink)] ${
                              c.numeric ? "text-right tabular-nums" : CELL_ONE_LINE
                            }`}
                          >
                            {v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ONE footer strip: the count on the left, the next-page control on the right.
              
              Load more had a band of its own — a centred button on a full-width strip — sitting
              directly above a second strip carrying the row count. Two horizontal bands, ~96px of a
              screen already short of rows, for what is one status line about the same thing: how much
              of the result you are looking at. Merged, it costs one band and the button lands where a
              paginator lives on every other list here (see Pagination's `embedded`, and the portal
              report screen, which is already built this way).
              
              Cursor paging, the same control the Stock Movement feed uses — the server has always
              returned `nextCursor`/`hasMore`; this screen simply never asked for the next page. */}
          <div className="flex shrink-0 flex-col items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2 sm:flex-row">
            <span className="text-[11px] text-[var(--muted)]">
              {/* "so far" while more exists — the count is what is on screen, not what matched, and a
                  bare "100 row(s)" under a partial table reads as a complete answer. */}
              {rows.length} row(s){hasMore ? " so far" : ""} · generated{" "}
              {new Date(result.generatedAt).toLocaleString("en-GB")}
              {can("reports.export") && hasMore ? " · exports carry every matching row" : ""}
            </span>
            {hasMore ? (
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={toolbarBtn}>
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Load more
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
