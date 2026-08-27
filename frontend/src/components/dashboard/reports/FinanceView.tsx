"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Download, FileSpreadsheet, RefreshCw } from "lucide-react";

import * as reportsService from "@/services/reports.service";
import type { BreakdownRow, FinanceQuery, FinanceSummary, ReportPeriod } from "@/services/reports.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { downloadCsv } from "@/lib/csvExport";
import { listSuppliers } from "@/services/supplier.service";
import { toolbarActionsCls, toolbarBtn, toolbarDateCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { basisLine, bucketLabel, money, moneyCompact, shareOf } from "./financeFormat";

/**
 * The key the server gives the folded remainder of a capped breakdown.
 *
 * Mirrors reports.constants.OTHER_BREAKDOWN_KEY. A key rather than matching the label, which has a
 * count in it and is not something a renderer should be parsing.
 */
const OTHER_BREAKDOWN_KEY = "__other__";

// ── Finance Dashboard + Report — ONE screen, one server-computed payload ──────────────────────
//
// Every figure below comes from `GET /reports/finance/summary`. This component performs no financial
// arithmetic of its own — no summing, no VAT, no percentages of money. The only maths here is the bar
// WIDTHS, which are presentation. That is deliberate and it is the whole point of the module: the
// dashboard, the report and the CSV render the same object, so they cannot disagree about a number.
//
// The CSV downloads carry the screen's current filters, so the file matches what is on screen.

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "muted" }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
      <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</div>
      <div className={`mt-1 text-xl font-extrabold ${tone === "muted" ? "text-[var(--muted)]" : "text-[var(--ink)]"} tabular-nums`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</div> : null}
    </div>
  );
}

/** A breakdown table. Same component for supplier / project / item — they are the same shape. */
function Breakdown({ title, rows, labelCol, totalPence }: { title: string; rows: BreakdownRow[]; labelCol: string; totalPence: number }) {
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
      <h3 className="mb-3 text-sm font-bold text-[var(--ink)]">{title}</h3>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--muted)]">No spend in this period.</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="py-2 pr-3">{labelCol}</th>
                <th className="py-2 pr-3 text-right">Net</th>
                <th className="py-2 pr-3 text-right">VAT</th>
                <th className="py-2 text-right">POs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // The server folds everything below the screen's row cap into ONE row rather than
                // dropping it, so this column still totals to the headline above. Styled as the
                // summary it is — not a supplier called "18 more" — and without the share bar, which
                // would compare a bucket of many against individuals.
                const isFold = r.key === OTHER_BREAKDOWN_KEY;
                return (
                <tr
                  key={r.key}
                  className={`border-b border-[var(--border)] last:border-0 ${isFold ? "bg-[var(--surface-2)]/60" : ""}`}
                >
                  <td className="py-2 pr-3">
                    <div className={`truncate font-semibold ${isFold ? "text-[var(--muted)] italic" : "text-[var(--ink)]"}`}>
                      {r.label}
                    </div>
                    {r.sublabel ? <div className="truncate font-mono text-[10px] text-[var(--muted)]">{r.sublabel}</div> : null}
                    {/* Share bar — the only arithmetic on this screen, and it is layout, not money. */}
                    {isFold ? null : (
                    <div className="mt-1 h-1 w-full rounded-full bg-[var(--surface-2)]">
                      <div className="h-1 rounded-full bg-[var(--accent)]" style={{ width: `${shareOf(r.netPence, totalPence) * 100}%` }} />
                    </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums text-[var(--ink)]">{money(r.netPence)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-[var(--muted)]">{money(r.vatPence)}</td>
                  <td className="py-2 text-right tabular-nums text-[var(--muted)]">{r.poCount}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Spend trend. Hand-rolled bars rather than a chart library — it is a bar per bucket, nothing more. */
function Trend({ summary }: { summary: FinanceSummary }) {
  const max = Math.max(1, ...summary.trend.points.map((p) => p.netPence));

  /**
   * Show one label every `stride` buckets.
   *
   * A month of daily buckets is 28–31 labels. Rendered on every column they collided into an
   * unreadable grey smear ("1 Aug 2 Aug 3 Aug 4 Aug…" with no gaps) AND drove the column width — each
   * label is ~28px against an 18px bar — which is what put a horizontal scrollbar under a chart that
   * otherwise fits. Roughly ten labels is what a strip this wide can show legibly.
   *
   * Thinning the LABELS only. Every bucket keeps its bar and its hover title, so no data is hidden —
   * the exact date and figure for any bar are still one hover away, which is what an axis is for.
   */
  const stride = Math.max(1, Math.ceil(summary.trend.points.length / 10));
  const labelled = (i: number) => i % stride === 0 || i === summary.trend.points.length - 1;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
      <h3 className="mb-3 text-sm font-bold text-[var(--ink)]">Spend trend</h3>
      {/* NO `items-end` on this row.
          
          It was here, and it meant the columns were never stretched: each one collapsed to its content
          height — 18px, the date label — inside a 160px row. The bar's wrapper is `flex-1`, so with an
          unstretched column it had nothing to fill, and the bar's `height: N%` resolved against an
          indefinite parent, i.e. `auto`, i.e. zero. Every bar rendered at its `minHeight` of 2px and a
          zero-value bucket rendered at nothing, so the chart was a row of identical hairlines whatever
          the numbers said. Measured in the browser: row 160px, columns 18px, tallest bar 2px.
          
          Default `items-stretch` gives each column the full 160px, which is what the percentage needs.
          The bars still sit on the baseline — that is the `items-end` on each column's own bar box
          below, which is where it always belonged. */}
      {/* NO `gap` between columns — the separation is PADDING inside each one instead.
          
          A gap is dead space: it belongs to the row, the row carries no `title`, and the tooltip lives
          on the column. Measured, 4px gaps across 27 buckets left 12% of the chart un-hoverable, which
          is exactly the "sometimes it shows, sometimes it doesn't" you get when the target you are
          aiming at is separated by strips of nothing.
          
          With the spacing moved inside, each column's hit area is its full share of the width while
          the bar stays visually inset by the same 2px — identical appearance, no holes. */}
      <div className="flex h-40 overflow-x-auto">
        {summary.trend.points.map((p, i) => (
          <div key={p.bucket} className="flex min-w-[6px] flex-1 cursor-default flex-col items-center gap-1 px-[2px]" title={`${p.bucket} — ${money(p.netPence)} · ${p.poCount} PO(s)`}>
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t bg-[var(--accent)] transition-all"
                style={{ height: `${(p.netPence / max) * 100}%`, minHeight: p.netPence > 0 ? 2 : 0 }}
              />
            </div>
            {/* Fixed-height box with the label absolutely positioned inside it, so a label wider than
                its column overflows into the blank space either side rather than widening the column.
                That is what keeps the columns even.

                The two EDGE labels are anchored rather than centred. Centred, the first bled past the
                left edge and the last past the right, and that right-hand bleed is real overflow —
                which is what still put a scrollbar under a chart whose bars fit comfortably. */}
            <span className="relative block h-3 w-full">
              {labelled(i) ? (
                <span
                  // `leading-3` pins the text box to the 12px `h-3` container above.
                  //
                  // Without it the span is 13.5px (9px font at the default 1.5 line-height) inside a
                  // 12px box — 1.5px of overflow. `overflow-x-auto` on the row computes overflow-y to
                  // `auto` as well, so that 1.5px was enough to summon a full-height VERTICAL
                  // scrollbar down the right edge of the chart, which read as a stray grey bar at the
                  // last bucket. Two pixels of text metrics, one scrollbar.
                  className={`absolute whitespace-nowrap text-[9px] leading-3 text-[var(--faint)] ${
                    i === 0
                      ? "left-0"
                      : i === summary.trend.points.length - 1
                        ? "right-0"
                        : "left-1/2 -translate-x-1/2"
                  }`}
                >
                  {bucketLabel(p.bucket, summary.trend.grain)}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">Peak {moneyCompact(max)} · net of VAT</p>
    </div>
  );
}

export function FinanceView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const period = (searchParams.get("period") as ReportPeriod) ?? "month";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const supplierId = searchParams.get("supplierId") ?? "";
  const query: FinanceQuery = React.useMemo(
    () => ({
      period,
      ...(period === "custom" ? { from: from || undefined, to: to || undefined } : {}),
      ...(supplierId ? { supplierId } : {}),
    }),
    [period, from, to, supplierId],
  );

  // Suppliers for the filter. `supplierId` was already honoured end-to-end — the service typed it,
  // the query string carried it and the repository scoped on it — with NO control anywhere that could
  // set it, so the only way to reach it was to hand-edit the URL. Degrades to an empty list (and so
  // to "All suppliers" alone) for a finance user without `suppliers.view`.
  const [suppliers, setSuppliers] = React.useState<{ value: string; label: string }[]>([]);
  React.useEffect(() => {
    let active = true;
    void (async () => {
      const rows = await listSuppliers({ status: "active", pageSize: 200 })
        .then((r) => r.suppliers.map((x) => ({ value: x.id, label: x.name })))
        .catch(() => []);
      if (active) setSuppliers(rows);
    })();
    return () => {
      active = false;
    };
  }, []);

  const [summary, setSummary] = React.useState<FinanceSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  const patch = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) params.delete(k);
        else params.set(k, v);
      }
      router.replace(`/dashboard/finance?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Monotonic guard: a slow earlier response must never overwrite a newer one.
  const seq = React.useRef(0);
  const load = React.useCallback(async (q: FinanceQuery) => {
    const mine = ++seq.current;
    await Promise.resolve();
    if (mine !== seq.current) return;
    // `loading` was only ever set FALSE — it started true for the first paint and stayed false
    // forever after, so no request after the first one had an in-flight state at all. That is why
    // Refresh looked dead: it fetched, it succeeded, and nothing on screen moved.
    setLoading(true);
    try {
      const s = await reportsService.getFinanceSummary(q);
      if (mine !== seq.current) return;
      setSummary(s);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "Could not load the finance report.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  /**
   * `?period=custom` with no dates is an incoherent URL, so it is NORMALISED away.
   *
   * The load effect below skips a half-open custom range — correct, because asking the server for a
   * window the user has not finished choosing would 400. But `loading` starts `true` and only the
   * load clears it, so arriving at that URL directly (a bookmark, a refresh, a shared link) left the
   * page on the skeleton branch forever: no toolbar, no date inputs, and therefore no way to supply
   * the bounds that would release it.
   *
   * Dropping the parameter falls back to the default period, which renders a working page with the
   * period picker on it. Recovering by hand is not something a user can be expected to discover.
   */
  React.useEffect(() => {
    if (period === "custom" && (!from || !to) && !summary) {
      const params = new URLSearchParams(window.location.search);
      params.delete("period");
      router.replace(`/dashboard/finance?${params.toString()}`, { scroll: false });
    }
  }, [period, from, to, summary, router]);

  React.useEffect(() => {
    // A custom range with only one bound would ask the server for a window the user has not finished
    // choosing; wait until both are set.
    if (period === "custom" && (!from || !to)) return;
    void (async () => {
      await load(query);
    })();
  }, [load, query, period, from, to]);

  // One handler for all three downloads: they share the screen's period and filters, so the file a
  // user gets always matches what they are looking at. Only the container differs.
  const download = async (kind: "summary" | "lines" | "workbook") => {
    setDownloading(true);
    try {
      if (kind === "workbook") {
        await reportsService.downloadFinanceWorkbook(query);
      } else {
        const url = kind === "summary" ? reportsService.financeSummaryCsvUrl(query) : reportsService.financeLinesCsvUrl(query);
        const { capped } = await downloadCsv(url, `finance-${kind}`);
        if (capped) pushToast("Export truncated — narrow the period and try again.", "alert");
      }
    } catch (e) {
      // The API client surfaces a 403 as a readable message; nothing internal reaches the user.
      pushToast(e instanceof Error ? e.message : "Could not download the export.", "alert");
    } finally {
      setDownloading(false);
    }
  };

  if (loading && !summary) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm font-semibold text-[var(--neg)]">
        {error}
      </div>
    );
  }
  if (!summary) return null;

  const t = summary.totals;
  const k = summary.tracking;
  const r = summary.rental;
  const hasRental = r.hireNetPence > 0 || r.extensionChargePence > 0 || r.damageChargePence > 0 || r.lossChargePence > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Filters + the basis statement. The basis is on screen, not buried: "spend" is a business
          definition and the reader must be able to see which one produced these figures. */}
      {/* PINNED while the page scrolls.
          
          Finance is read top to bottom — tiles, trend, three breakdowns, rental — and the period and
          supplier that produced every one of those figures were scrolling away with them, so changing
          the period from the bottom of the page meant scrolling back up to find the control.
          
          The negative offsets are the same trick AddStockEntryPage's header bar uses, and they are
          required rather than decorative: this sits inside the shell's `p-4 md:p-8` scroll container,
          so `-top-*` cancels that padding to pin flush under the top bar, `-mx-*` full-bleeds it, and
          `-mt-*` pulls it up into the padding it just escaped. The wrapper carries `bg-[var(--bg)]` —
          the PAGE colour, not the card's — because the card is rounded, and without an opaque backdrop
          the tiles scroll visibly through the gaps at its corners.
          
          `z-20` sits under the top bar (z-30) and well under any dropdown or modal. */}
      <div className="sticky -top-4 z-20 -mx-4 -mt-4 bg-[var(--bg)] px-4 pb-3 pt-4 md:-top-8 md:-mx-8 md:-mt-8 md:px-8 md:pt-8">
      {/* Two ZONES, and the longest toolbar in the module — period, an optional date pair, an
          optional supplier picker, the basis block and up to four buttons. `lg:flex-row` put all of
          that on one line at exactly 1024px, where it does not fit: the controls compressed and the
          buttons crushed against the right edge. `xl` is where it genuinely fits; below that the
          controls and the actions are separate stacked blocks, which is a state that looks
          deliberate rather than one that depends on where the browser happened to wrap. */}
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          value={period}
          onChange={(v) => patch({ period: v, ...(v === "custom" ? {} : { from: null, to: null }) })}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          ariaLabel="Report period"
        />
        {period === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              aria-label="From date"
              value={from}
              onChange={(e) => patch({ from: e.target.value || null })}
              className={toolbarDateCls}
            />
            <span className="text-xs text-[var(--muted)]">to</span>
            <input
              type="date"
              aria-label="To date"
              value={to}
              onChange={(e) => patch({ to: e.target.value || null })}
              className={toolbarDateCls}
            />
          </div>
        )}
        {suppliers.length > 0 ? (
          <div className="w-56">
            <Select
              size="sm"
              value={supplierId}
              onChange={(v) => patch({ supplierId: v || null })}
              options={[{ value: "", label: "All suppliers" }, ...suppliers]}
              ariaLabel="Filter by supplier"
            />
          </div>
        ) : null}
        </div>

        {/* Actions in their own zone — at the right end when there is room, stacked under the
            controls when there is not, and never shrunk to fit. */}
        <div className={`${toolbarActionsCls} xl:shrink-0`}>
        {/* Spins and disables while in flight. Without this the button was indistinguishable from a
            dead one: the figures it re-fetches are usually IDENTICAL, so a successful refresh changed
            nothing on screen and the only honest signal — that a request happened at all — was in the
            network tab. */}
        <button
          onClick={() => void load(query)}
          disabled={loading}
          className={toolbarBtn}
          title="Re-fetch the figures for this period"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {/* Export is its own permission — viewing a figure and walking out with the file differ. */}
        {can("reports.export") && (
          <>
            <button
              onClick={() => void download("workbook")}
              disabled={downloading}
              title="Multi-sheet Excel workbook: summary, supplier, project, item and PO detail"
              className={toolbarPrimaryBtn}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" /> {downloading ? "Preparing…" : "Excel"}
            </button>
            <button
              onClick={() => void download("summary")}
              disabled={downloading}
              className={toolbarBtn}
            >
              <Download className="h-3.5 w-3.5" /> Summary CSV
            </button>
            <button
              onClick={() => void download("lines")}
              disabled={downloading}
              className={toolbarBtn}
            >
              <Download className="h-3.5 w-3.5" /> Lines CSV
            </button>
          </>
        )}
        </div>
      </div>
      </div>

      {/* The BASIS — which period, and what "spend" was taken to mean. Deliberately NOT inside the
          pinned bar above.
          
          It lived there, and at 1024px (below the `xl` where the toolbar is one row) it stacked the
          bar to 230px — 27% of the viewport, permanently, on a page you scroll. A pinned bar has to
          earn its height in CONTROLS; this is context, it does not change while you read, and it
          belongs with the figures it describes. So the controls pin and the basis scrolls, which is
          also how the Reports tabs pin only their filter row.
          
          Still on screen rather than buried: "spend" is a business definition and the reader must be
          able to see which one produced these numbers. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Finance Reports</span>
        <span className="text-sm font-bold text-[var(--ink)]">{summary.period.label}</span>
        <span className="text-[11px] text-[var(--muted)]">{basisLine(summary)}</span>
        {/* When the numbers come back unchanged — the common case — a spinner that lasted 80ms is no
            evidence that anything happened. This stamp is: it moves on every successful load, so a
            refresh is confirmed even when nothing else on the page differs. Server-generated, so it
            is the moment the FIGURES were computed, not the moment this component rendered. */}
        <span className="text-[11px] tabular-nums text-[var(--faint)]">
          Updated {new Date(summary.generatedAt).toLocaleTimeString("en-GB")}
        </span>
      </div>

      {/* Money. Net is the headline because it is what "spend" means before tax; VAT and gross sit
          beside it rather than replacing it, pending the client's answer on presentation. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Net spend" value={money(t.netPence)} hint="IRM purchases, excludes rental" />
        <Tile label="VAT" value={money(t.vatPence)} />
        <Tile label="Gross" value={money(t.grossPence)} />
        <Tile label="Purchase orders" value={String(k.poCount)} hint={`${k.supplierCount} supplier(s)`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Ordered" value={money(k.orderedPence)} />
        <Tile label="Received" value={money(k.receivedPence)} hint={`${k.partiallyReceivedLines} part-received line(s)`} />
        <Tile label="Outstanding" value={money(k.outstandingPence)} hint="Committed, not yet delivered" />
        {/* Both readings of "PO raised" are visible — the narrower one is one subtraction away. */}
        <Tile
          label="Awaiting issue"
          value={money(k.preIssueNetPence)}
          hint={`${k.preIssuePoCount} order(s) not yet sent to a supplier`}
          tone="muted"
        />
      </div>

      <Trend summary={summary} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="Spend by supplier" rows={summary.bySupplier} labelCol="Supplier" totalPence={t.netPence} />
        <Breakdown title="Spend by project" rows={summary.byProject} labelCol="Project" totalPence={t.netPence} />
      </div>
      <Breakdown title="Spend by item" rows={summary.byItem} labelCol="Item" totalPence={t.netPence} />

      {/* Hire is a separate section, never folded into the totals above. The two undecided treatments
          say so on their own face so nobody assumes they are already counted somewhere. */}
      {hasRental && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
          <h3 className="mb-1 text-sm font-bold text-[var(--ink)]">Rental / hire</h3>
          <p className="mb-3 text-[11px] text-[var(--muted)]">
            Reported separately — hire is the supplier&apos;s equipment and is not included in the IRM spend above.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Hire net" value={money(r.hireNetPence)} hint={`${r.hireLineCount} hire line(s)`} />
            <Tile label="Hire VAT" value={money(r.hireVatPence)} />
            <Tile label="Extension charges" value={money(r.extensionChargePence)} hint="Treatment not yet defined" tone="muted" />
            <Tile
              label="Damage charges"
              value={money(r.damageChargePence)}
              hint={`${r.damageChargeLines} quoted · treatment not yet defined`}
              tone="muted"
            />
            {/* Loss is its own figure: kit that is gone, charged at replacement. Folding it into
                damage would say a missing tester was merely broken — the same conflation the rental
                module keeps two note directions to avoid. */}
            <Tile
              label="Loss charges"
              value={money(r.lossChargePence)}
              hint={`${r.lossChargeLines} quoted · treatment not yet defined`}
              tone="muted"
            />
          </div>
        </div>
      )}

      {/* Excluded orders are surfaced, not hidden. A headline that silently omits cancelled orders
          with no acknowledgement is how a finance reader stops trusting the report. */}
      {(summary.excluded.draftPoCount > 0 || summary.excluded.cancelledPoCount > 0) && (
        <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] text-[var(--muted)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>
            Excluded from every figure above: <strong className="text-[var(--ink)]">{summary.excluded.draftPoCount}</strong> draft and{" "}
            <strong className="text-[var(--ink)]">{summary.excluded.cancelledPoCount}</strong> cancelled purchase order(s) dated in this period.
          </span>
        </div>
      )}
    </div>
  );
}
