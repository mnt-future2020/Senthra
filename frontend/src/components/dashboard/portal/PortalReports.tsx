"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, FileSpreadsheet, FileText, Loader2, Play } from "lucide-react";

import * as customerService from "@/services/customer.service";
import type { CustomReportResult, CustomReportType, CustomerReportQuery } from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { downloadCsv } from "@/lib/csvExport";
import { toolbarActionsCls, toolbarBtn, toolbarDateCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { CELL_ONE_LINE, tableMinWidth, type ColWidth } from "@/components/ui/tableLayout";
import type { Msg } from "@/components/ui/types";

import { EmptyState, TableCard, TableCardSkeleton } from "./portalUi";

// ── Customer portal — Reports (FLOW 9) ─────────────────────────────────────────────────────────
//
// "Customer generates report · Filter: Date range, item type, project · Export: Excel / CSV ·
//  NO pricing shown in customer reports."
//
// Every call goes to /customer/reports/*, which takes the customer id from the SESSION. This screen
// has no customerId to send and no control that could produce one — the isolation is structural, not
// a matter of remembering to scope a request.
//
// It also never touches the staff /reports/custom/* endpoints. Those sit behind staff permissions and
// their results may carry money; the customer-safe result is a different shape from a different route,
// which is why nothing here needs to hide a column.

/** Only the filters FLOW 9 names. The server rejects anything a report does not declare anyway. */
const FILTER_LABEL: Record<string, string> = {
  dateFrom: "From",
  dateTo: "To",
  projectId: "Project",
};

/**
 * Filters the portal never renders.
 *
 * `customerId` / `warehouseId` / `engineerId` / `itemKind` are FORCED by the server from the session,
 * so a control for them would be a lie.
 *
 * `irmItemId` is here for a different and less comfortable reason: it is an ObjectId filter with no
 * customer-facing source for the ids. It shipped as a free-text box placeheld "Reference", so a
 * customer typing an item name — the only thing they could reasonably type — sent a non-ObjectId to
 * an equality filter and got a database error rendered as a failed report. The staff screen solves
 * this with a catalogue picker; the portal has no catalogue to pick from (the customer's own stock
 * view carries SKUs and names, not IRM ids), so the honest move is to offer the filter the report is
 * actually keyed on — the date range — and let the export carry every item column for filtering in
 * Excel. Restoring it needs a customer-safe item lookup, not a text box.
 */
const PORTAL_HIDDEN_FILTERS = new Set(["customerId", "warehouseId", "engineerId", "itemKind", "irmItemId"]);

/** Rows per request. The screen pages; the EXPORT still carries every matching row. */
const PAGE = 100;

const widthOf = (header: string, numeric?: boolean): ColWidth => {
  if (numeric) return "narrow";
  if (/date|code|source|movement|job/i.test(header)) return "narrow";
  if (/item|project|site|warehouse|reference/i.test(header)) return "wide";
  return "normal";
};

export function PortalReports() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [types, setTypes] = React.useState<CustomReportType[] | null>(null);
  const [result, setResult] = React.useState<CustomReportResult | null>(null);
  const [rows, setRows] = React.useState<Record<string, string | number>[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg | null>(null);

  const reportKey = searchParams.get("type") ?? "";
  const active = types?.find((t) => t.key === reportKey) ?? types?.[0];
  const visibleFilters = React.useMemo(
    () => (active?.filters ?? []).filter((f) => !PORTAL_HIDDEN_FILTERS.has(f)),
    [active],
  );

  // Filters live in the URL so a report survives a refresh and can be shared — the same convention
  // every other portal list uses.
  const query = React.useMemo<CustomerReportQuery>(() => {
    const q: CustomerReportQuery = { report: active?.key ?? "" };
    for (const f of visibleFilters) {
      const v = searchParams.get(f);
      if (v) (q as unknown as Record<string, string>)[f] = v;
    }
    return q;
  }, [active, visibleFilters, searchParams]);

  const patch = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") params.delete(k);
      else params.set(k, v);
    }
    router.replace(`/dashboard/portal/reports?${params.toString()}`, { scroll: false });
  };

  React.useEffect(() => {
    void (async () => {
      try {
        setTypes(await customerService.listOwnReportTypes());
      } catch (e) {
        setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not load your reports." });
        setTypes([]);
      }
    })();
  }, []);

  // A request token, so a slower earlier run cannot overwrite a newer one and a Load more racing a
  // re-run is discarded rather than appended to the wrong report.
  const reqId = React.useRef(0);

  const run = async () => {
    if (!active) return;
    const mine = ++reqId.current;
    setRunning(true);
    setMsg(null);
    try {
      const res = await customerService.runOwnReport({ ...query, report: active.key, limit: PAGE });
      if (mine !== reqId.current) return;
      setResult(res);
      setRows(res.rows);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (e) {
      if (mine !== reqId.current) return;
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not generate that report." });
      setResult(null);
      setRows([]);
      setCursor(null);
      setHasMore(false);
    } finally {
      if (mine === reqId.current) setRunning(false);
    }
  };

  const loadMore = async () => {
    if (!active || !cursor || loadingMore) return;
    const mine = reqId.current;
    setLoadingMore(true);
    try {
      const res = await customerService.runOwnReport({ ...query, report: active.key, cursor, limit: PAGE });
      if (mine !== reqId.current) return;
      setRows((prev) => [...prev, ...res.rows]);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not load more records." });
    } finally {
      if (mine === reqId.current) setLoadingMore(false);
    }
  };

  const download = async (format: "csv" | "xlsx") => {
    if (!active) return;
    setDownloading(true);
    try {
      if (format === "xlsx") {
        const { capped } = await customerService.downloadOwnReportXlsx({ ...query, report: active.key });
        if (capped) setMsg({ type: "warn", text: "Your export was shortened — narrow the dates and try again." });
      } else {
        const { capped } = await downloadCsv(customerService.ownReportCsvUrl({ ...query, report: active.key }), active.key);
        if (capped) setMsg({ type: "warn", text: "Your export was shortened — narrow the dates and try again." });
      }
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not download your report." });
    } finally {
      setDownloading(false);
    }
  };

  if (!types) return <TableCardSkeleton headers={["", "", "", ""]} cells={["h-3 w-24", "h-3 w-32", "h-3 w-16", "h-3 w-20"]} />;

  if (types.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No reports available"
        hint="There are no reports for your account yet. Please contact your account manager."
      />
    );
  }

  const columns = result?.report.columns ?? [];

  return (
    // `h-full flex-col` so TableCard's `fill` has a height to fill — without it the whole page
    // scrolls, taking the toolbar and the sticky column headers with it. Same rule as every other
    // portal list (see portalUi.TableCard).
    <div className="flex h-full flex-col gap-4">
      <Notice msg={msg} />

      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        {/* Same two ZONES as the staff screen, for the same reason: actions pushed right by `ml-auto`
            land correctly only while the row still fits on one line, and there is no way to style the
            case where it wrapped. Side by side above `lg`, stacked and left-aligned below. This row is
            shorter than the staff one (report + two dates), so it holds together a breakpoint sooner. */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Report</span>
            <Select
              size="sm"
              value={active?.key ?? ""}
              onChange={(v) => {
                // Clear the previous report's filters: the server rejects a filter the new report
                // does not accept, so carrying them over would produce a guaranteed error.
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

          {/* Only the filters this report accepts, minus the ones the portal cannot honestly offer. */}
          {visibleFilters.map((f) => (
            <label key={f} className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {FILTER_LABEL[f] ?? f}
              </span>
              <input
                type="date"
                aria-label={FILTER_LABEL[f] ?? f}
                value={searchParams.get(f) ?? ""}
                onChange={(e) => patch({ [f]: e.target.value || null })}
                className={toolbarDateCls}
              />
            </label>
          ))}

        </div>

          <div className={`${toolbarActionsCls} lg:shrink-0`}>
            <button onClick={() => void run()} disabled={running} className={toolbarPrimaryBtn}>
              <Play className="h-3.5 w-3.5" /> {running ? "Generating…" : "Generate report"}
            </button>

            {result && rows.length > 0 ? (
              <>
                <button onClick={() => void download("xlsx")} disabled={downloading} className={toolbarBtn}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                </button>
                <button onClick={() => void download("csv")} disabled={downloading} className={toolbarBtn}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
              </>
            ) : null}
          </div>
        </div>
        {/* The description lives in the empty state below, not here — one sentence, one place. */}
      </div>

      {!result ? (
        // The resting state. Nothing had been run yet, so the page below the filter card was blank —
        // which reads as broken rather than as a report waiting to be generated.
        <EmptyState
          icon={FileText}
          title={active?.label ?? "Report"}
          hint="Choose a date range above, then select Generate report."
        />
      ) : null}

      {result ? (
        rows.length === 0 ? (
          <EmptyState icon={FileText} title="Nothing to show" hint="No records match those filters. Try a wider date range." />
        ) : (
          <>
            {/* The HARD ceiling, stated. A short table the customer believes is complete is the worst
                outcome a report can produce. "There is more" is the Load more control, not this. */}
            {result.capped ? (
              <Notice msg={{ type: "warn", text: "This report has reached the maximum it can return — narrow the dates to see everything." }} />
            ) : null}
            <TableCard
              fill
              minWidth={tableMinWidth(columns.map((c) => widthOf(c.header, c.numeric)))}
              headers={columns.map((c) => c.header)}
              footer={
                <div className="flex flex-col items-center justify-between gap-2 px-4 py-3 sm:flex-row">
                  <span className="text-[11px] text-[var(--muted)]">
                    {/* "so far" while more exists — a bare count under a partial table reads as the
                        whole answer, which is exactly what a report must never imply. */}
                    {rows.length} record(s){hasMore ? " so far" : ""} · generated{" "}
                    {new Date(result.generatedAt).toLocaleString("en-GB")}
                  </span>
                  {hasMore ? (
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                      className={toolbarBtn}
                    >
                      {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Load more
                    </button>
                  ) : null}
                </div>
              }
            >
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {columns.map((c) => {
                    const v = String(row[c.key] ?? "");
                    return (
                      <td
                        key={c.key}
                        title={c.numeric ? undefined : v}
                        className={`px-4 py-2.5 text-[var(--ink)] ${c.numeric ? "text-right tabular-nums" : CELL_ONE_LINE}`}
                      >
                        {v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </TableCard>
          </>
        )
      ) : null}
    </div>
  );
}
