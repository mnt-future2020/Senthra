"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRightLeft, Briefcase, ChevronRight, PackageOpen, Truck } from "lucide-react";

import * as svc from "@/services/stockPosition.service";
import { WorkspaceToolbar } from "@/components/ui/WorkspaceToolbar";
import { Select } from "@/components/ui/Select";
import { Pagination } from "@/components/ui/Pagination";
import type { EngineerInventoryDetail, EngineerOverviewRow } from "@/services/stockPosition.service";
import { CELL_ONE_LINE, tableMinWidth } from "@/components/ui/tableLayout";
import { useAuth } from "@/hooks/useAuth";
import { ExportButton } from "@/components/ui/ExportButton";
import { OwnerTag, TableSkeletonRows } from "./hubUi";
import { AdminTransferBoard } from "./AdminTransferBoard";


// Item · Owner · Qty · Job · Customer · Status, and the per-engineer roll-up beside it. Both sat
// under one flat `min-w-[640px]`, which is far too tight for the first — item and customer names are
// the long values there.
const HOLDINGS_MIN_WIDTH = tableMinWidth(["wide", "normal", "narrow", "normal", "wide", "narrow"]);
const ENGINEERS_MIN_WIDTH = tableMinWidth(["wide", "narrow", "narrow", "narrow"]);
/** One page of engineers. Enough to scan; small enough that the roll-up stays cheap. */
const ENGINEER_PAGE_SIZE = 25;

const TH = "px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]";
const TD = "px-4 py-3";

// Loading placeholder for the two engineer-detail tables. They previously rendered a bare
// "Loading…" line, which collapses the card to one row and then snaps to a full table — the layout
// jumps and you can't tell what's coming. Everywhere else in this module (including the engineer
// LIST directly below) shows the real table shell with skeleton rows, so these now do too.
// `rows={3}` rather than the helper's default of 8: these are cards inside a page, not a full list.
function LoadingTable({ headers }: { headers: { label: string; right?: boolean }[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {headers.map((h) => (
              <th key={h.label} className={h.right ? `${TH} text-right` : TH}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <TableSkeletonRows cols={headers.length} rows={3} />
      </table>
    </div>
  );
}

const JOB_STATUS_CLS: Record<string, string> = {
  assigned: "text-[var(--accent)] bg-[var(--accent-10)]",
  accepted: "text-[var(--accent)] bg-[var(--accent-10)]",
  in_progress: "text-[var(--warn)] bg-amber-500/10",
};

function JobStatusBadge({ status }: { status: string }) {
  const cls = JOB_STATUS_CLS[status] ?? "text-[var(--muted)] bg-[var(--surface-2)]";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ── engineer detail (holdings + active jobs) ───────────────────────────────────
function EngineerDetail({ engineer, onBack }: { engineer: EngineerOverviewRow; onBack: () => void }) {
  const router = useRouter();
  const [data, setData] = React.useState<EngineerInventoryDetail | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const d = await svc.getEngineerInventory(engineer.engineerId);
        if (active) setData(d);
      } catch {
        if (active) setData({ holdings: [], jobs: [] });
      }
    })();
    return () => {
      active = false;
    };
  }, [engineer.engineerId]);

  return (
    <div className="h-full space-y-4 overflow-auto">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-all hover:text-[var(--ink)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All engineers
        </button>
        <div>
          <h3 className="text-sm font-extrabold text-[var(--ink)]">{engineer.name}</h3>
          {engineer.email ? <p className="text-[11px] text-[var(--muted)]">{engineer.email}</p> : null}
        </div>
      </div>

      {/* Holdings */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
        <h4 className="mb-3 text-sm font-extrabold text-[var(--ink)]">Holding now</h4>
        {!data ? (
          <LoadingTable headers={[{ label: "Item" }, { label: "Owner" }, { label: "Qty", right: true }]} />
        ) : data.holdings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <PackageOpen className="h-6 w-6 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">No stock on this engineer&apos;s van</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-sm" style={{ minWidth: HOLDINGS_MIN_WIDTH }}>
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className={TH}>Item</th>
                  <th className={TH}>Owner</th>
                  <th className={`${TH} text-right`}>Qty</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h, i) => (
                  <tr key={`${h.itemName}-${i}`} className="border-b border-[var(--border)] last:border-0">
                    <td className={`${TD} ${CELL_ONE_LINE}`} title={h.customerName ? `${h.itemName} · ${h.customerName}` : h.itemName}>
                      <span className="font-semibold text-[var(--ink)]">{h.itemName}</span>
                      {h.customerName ? (
                        <span className="ml-1 text-[11px] text-[var(--faint)]">· {h.customerName}</span>
                      ) : null}
                    </td>
                    <td className={TD}>
                      <OwnerTag ownership={h.ownership} />
                    </td>
                    <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>{h.quantity.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Active jobs */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
        <h4 className="mb-3 text-sm font-extrabold text-[var(--ink)]">Active jobs</h4>
        {!data ? (
          <LoadingTable headers={[{ label: "Job" }, { label: "Customer" }, { label: "Status" }]} />
        ) : data.jobs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Briefcase className="h-6 w-6 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">No active jobs assigned</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className={TH}>Job</th>
                  <th className={TH}>Customer</th>
                  <th className={TH}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr
                    key={j.id}
                    onClick={() => router.push(`/dashboard/jobs/${j.id}`)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className={TD}>
                      <span className="font-semibold text-[var(--ink)]">{j.name}</span>
                      <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{j.jobNumber}</span>
                    </td>
                    <td className={`${TD} text-[var(--muted)]`}>{j.customerName ?? "—"}</td>
                    <td className={TD}>
                      <JobStatusBadge status={j.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── engineers list ─────────────────────────────────────────────────────────────
function EngineersList({
  onSelect,
}: {
  onSelect: (e: EngineerOverviewRow) => void;
}) {
  // Search, "holding only", and PAGING — all resolved at the server. This list took no parameters
  // at all: every engineer, every time, with no way to narrow it and no ceiling as the field team
  // grows. The two numbers it is read by (items held, on-van qty) are computed in the same roll-up
  // the filter runs over, so `total` counts exactly the rows the pager walks.
  const [rows, setRows] = React.useState<EngineerOverviewRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [holdingOnly, setHoldingOnly] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A narrower list makes the old page number meaningless. Adjusted DURING RENDER rather than in an
  // effect: a synchronous setState in an effect body is a cascading render, and the React-Compiler
  // lint rejects it. Same pattern the Jobs list uses to re-seed its search box.
  const filterKey = `${debounced}|${holdingOnly}`;
  const [prevFilterKey, setPrevFilterKey] = React.useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setPage(1);
  }

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await svc.listEngineerInventoryPaged({
          search: debounced || undefined,
          holding: holdingOnly || undefined,
          page,
          pageSize: ENGINEER_PAGE_SIZE,
        });
        if (active) {
          setRows(r.rows);
          setTotal(r.total);
          setTotalPages(r.totalPages);
        }
      } catch {
        if (active) { setRows([]); setTotal(0); setTotalPages(1); }
      }
    })();
    return () => {
      active = false;
    };
  }, [debounced, holdingOnly, page]);

  return (
    <div className="flex h-full flex-col gap-3">
      <p className="shrink-0 text-xs text-[var(--muted)]">
        Field engineers and what they&apos;re carrying. Select an engineer to see their stock and active jobs.
      </p>
      <WorkspaceToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search engineer name or email…",
          ariaLabel: "Search engineers",
        }}
        filters={
          <Select
            size="sm"
            value={holdingOnly ? "holding" : "all"}
            onChange={(v) => setHoldingOnly(v === "holding")}
            options={[
              { value: "all", label: "All engineers" },
              { value: "holding", label: "Holding stock" },
            ]}
            ariaLabel="Filter by whether the engineer holds stock"
          />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: ENGINEERS_MIN_WIDTH }}>
            <thead className="sticky top-0 z-10 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)]">
                <th className={TH}>Engineer</th>
                <th className={`${TH} text-right`}>Items held</th>
                <th className={`${TH} text-right`}>On-van qty</th>
                <th className={`${TH} text-right`}>Active jobs</th>
                <th className={TH} />
              </tr>
            </thead>
            {!rows ? (
              <TableSkeletonRows cols={5} />
            ) : (
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.engineerId}
                    onClick={() => onSelect(e)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className={TD}>
                      <div className="font-semibold text-[var(--ink)]">{e.name}</div>
                      {e.email ? <div className="text-[11px] text-[var(--faint)]">{e.email}</div> : null}
                    </td>
                    <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>{e.itemsHeld}</td>
                    <td className={`${TD} text-right text-[var(--muted)]`}>{e.totalQty.toLocaleString()}</td>
                    <td className={`${TD} text-right`}>
                      {e.activeJobs > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
                          {e.activeJobs}
                        </span>
                      ) : (
                        <span className="text-[var(--faint)]">0</span>
                      )}
                    </td>
                    <td className={`${TD} text-right`}>
                      <ChevronRight className="ml-auto h-4 w-4 text-[var(--faint)]" />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-16">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <Truck className="h-7 w-7 text-[var(--faint)]" />
                        {/* Two different empty states: nothing matches the filters, versus nothing
                            exists. Saying "no engineers yet" to someone who has typed a search would
                            flatly contradict the roster one keystroke away. */}
                        <p className="text-sm font-semibold text-[var(--ink)]">
                          {debounced || holdingOnly ? "No engineers match these filters" : "No field engineers yet"}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>
        <Pagination
          embedded
          page={page}
          totalPages={totalPages}
          total={total}
          label="engineers"
          onPage={setPage}
        />
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

type EngineerView = "list" | "transfers";

export function EngineersOverview() {
  const { can } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const canViewTransfers = can("engineer_stock.view") || can("engineer_stock.transfer");
  const canExport = can("inventory.export");

  const [selected, setSelected] = React.useState<EngineerOverviewRow | null>(null);

  // Sub-view (Engineers / Transfers) lives in ?view= so it survives a refresh and is the landing
  // spot after creating a transfer (the composer returns to ?tab=engineer&view=transfers).
  const view: EngineerView = searchParams.get("view") === "transfers" && canViewTransfers ? "transfers" : "list";
  const setView = (v: EngineerView) => {
    const params = new URLSearchParams(window.location.search);
    if (v === "transfers") params.set("view", "transfers");
    else params.delete("view");
    router.replace(`/dashboard/inventory?${params.toString()}`, { scroll: false });
  };

  if (selected) {
    return <EngineerDetail engineer={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* ONE action bar: sub-nav on the left, the export on the right — the shape the IRM and Rentals
          lenses use in this same hub. The export used to sit in a band of its own below the toggle,
          right-aligned against an otherwise empty row: ~46px of a full-height page (band + the
          layout's gap) to show one button, while the row above it had its whole right half free.
          Rendered only when it would hold something, so a user without either never pays for an
          empty band. */}
      {(canViewTransfers || (view === "list" && canExport)) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canViewTransfers && (
            <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
              <button
                type="button"
                onClick={() => setView("list")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                  view === "list" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <Truck className="h-3.5 w-3.5" /> Engineers
              </button>
              <button
                type="button"
                onClick={() => setView("transfers")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                  view === "transfers" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" /> Transfers
              </button>
            </div>
          )}

          {/* Field-stock reconciliation. The screen below is a ROLL-UP (one row per engineer); the file
              is the per-item detail behind it, which is what a stock count is actually done against.
              It reuses the positions export filtered to `location=engineer` rather than adding an
              endpoint — same rows, same permission, and no second definition of "engineer-held stock"
              to drift from the one the Inventory Hub already uses.
              `ml-auto` rather than the row's `justify-between`, so it still sits hard right when the
              Transfers toggle isn't there to push it. */}
          {view === "list" && canExport && (
            <div className="ml-auto">
              <ExportButton
                label="Export field stock"
                title="Export every item currently held by an engineer to CSV"
                onExport={() => svc.exportPositionsCsv({ location: "engineer" })}
              />
            </div>
          )}
        </div>
      )}

      {view === "list" ? (
        <EngineersList onSelect={setSelected} />
      ) : (
        <AdminTransferBoard />
      )}
    </div>
  );
}
