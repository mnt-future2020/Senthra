"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, MapPin, ScrollText } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import * as stockPositionService from "@/services/stockPosition.service";
import { useAuth } from "@/hooks/useAuth";
import { useReferenceData } from "@/hooks/useReferenceData";
import { Pagination } from "@/components/ui/Pagination";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  InventoryStatusBadge,
  formatDate,
  formatDateTime,
  formatDelta,
  formatMoney,
  formatTxnType,
} from "@/components/dashboard/inventory/inventoryStatus";
import { OwnerTag } from "@/components/dashboard/inventory/hubUi";
import type { InventoryDetail as InventoryDetailType, InventoryTransaction } from "@/types/inventory";
import type { StockPosition } from "@/types/stock-position";
import type { ItemHolders, ItemJob } from "@/services/stockPosition.service";
import { CopyableCode } from "@/components/ui/CopyableCode";

const TXN_PAGE_SIZE = 20;

// ── primitives ────────────────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
      <div className="mb-4">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">{title}</h2>
        {hint ? <p className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-[var(--ink)]">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-[var(--muted)]">{sub}</p> : null}
    </div>
  );
}

function RowsSkeleton({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-[var(--border)] last:border-0">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-3 py-2.5">
              <Skeleton className="h-3 w-16" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

const TH = "px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]";
const TD = "px-3 py-2.5";

// ── sections ──────────────────────────────────────────────────────────────────

/** Where this item physically is, across every pool — the cross-pool payoff. */
function DistributionSection({
  irmItemId,
  onCount,
}: {
  irmItemId: string;
  onCount: (n: number) => void;
}) {
  const [rows, setRows] = React.useState<StockPosition[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    stockPositionService
      .getItemDistribution(irmItemId)
      .then((r) => {
        if (active) {
          setRows(r);
          onCount(r.length);
        }
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load distribution."));
    return () => {
      active = false;
    };
  }, [irmItemId, onCount]);

  return (
    <Section title="Where it is now" hint="On-hand quantity for this item at every location and owner.">
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className={TH}>Owner</th>
              <th className={TH}>Location</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Available</th>
              <th className={TH}>Last movement</th>
            </tr>
          </thead>
          {!rows && !error ? (
            <RowsSkeleton cols={5} />
          ) : (
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]">
                  <td className={TD}>
                    <OwnerTag ownership={r.ownership} />
                  </td>
                  <td className={`${TD} text-[var(--ink)]`}>{r.locationLabel}</td>
                  <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>
                    {r.quantity.toLocaleString()}
                  </td>
                  <td className={`${TD} text-right text-[var(--muted)]`}>{r.available.toLocaleString()}</td>
                  <td className={`${TD} text-[var(--muted)]`}>{formatDate(r.lastMovementAt)}</td>
                </tr>
              ))}
              {error ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm font-semibold text-[var(--neg)]">
                    {error}
                  </td>
                </tr>
              ) : rows && rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <MapPin className="h-6 w-6 text-[var(--faint)]" />
                      <p className="text-sm font-semibold text-[var(--ink)]">No stock anywhere right now</p>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          )}
        </table>
      </div>
    </Section>
  );
}

/** Full movement ledger for this balance (company warehouse). */
function MovementHistorySection({ balanceId }: { balanceId: string }) {
  const [data, setData] = React.useState<inventoryService.PagedTransactions | null>(null);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      setError(null);
      try {
        const r = await inventoryService.listInventoryTransactions(balanceId, page, TXN_PAGE_SIZE);
        if (active) setData(r);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load history.");
      }
    })();
    return () => {
      active = false;
    };
  }, [balanceId, page]);

  return (
    <Section title="Movement history" hint="Every stock event for this item at this warehouse.">
      <div className="space-y-3">
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className={TH}>Date</th>
                <th className={TH}>Type</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Balance</th>
                <th className={TH}>Reference</th>
                <th className={TH}>By</th>
              </tr>
            </thead>
            {!data && !error ? (
              <RowsSkeleton cols={6} />
            ) : (
              <tbody>
                {(data?.transactions ?? []).map((t: InventoryTransaction) => (
                  <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                    <td className={`${TD} text-[var(--muted)]`}>{formatDateTime(t.date)}</td>
                    <td className={`${TD} capitalize text-[var(--ink)]`}>{formatTxnType(t.type)}</td>
                    <td
                      className={`${TD} text-right font-semibold ${t.quantityDelta < 0 ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}
                    >
                      {formatDelta(t.quantityDelta)}
                    </td>
                    <td className={`${TD} text-right text-[var(--ink)]`}>{t.balanceAfter}</td>
                    <td className={`${TD} font-mono text-[11px] text-[var(--muted)]`}>{t.reference ?? "—"}</td>
                    <td className={`${TD} text-[var(--muted)]`}>{t.createdBy ?? "—"}</td>
                  </tr>
                ))}
                {error ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm font-semibold text-[var(--neg)]">
                      {error}
                    </td>
                  </tr>
                ) : data && data.transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <ScrollText className="h-6 w-6 text-[var(--faint)]" />
                        <p className="text-sm font-semibold text-[var(--ink)]">No movements yet</p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>
        {data && data.total > TXN_PAGE_SIZE && (
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="movements" onPage={setPage} />
        )}
      </div>
    </Section>
  );
}

/** Holders + jobs — fetched once, each block shown ONLY when it has data. */
function ActivityBlocks({ irmItemId }: { irmItemId: string }) {
  const [holders, setHolders] = React.useState<ItemHolders | null>(null);
  const [jobs, setJobs] = React.useState<ItemJob[] | null>(null);

  useReferenceData(
    [
      { label: "stock holders", load: () => stockPositionService.getItemHolders(irmItemId), onData: (r) => setHolders(r) },
      { label: "jobs", load: () => stockPositionService.getItemJobs(irmItemId), onData: (r) => setJobs(r) },
    ],
    [irmItemId],
  );

  const engineers = holders?.engineers ?? [];
  const customers = holders?.customers ?? [];
  const activeJobs = jobs ?? [];

  return (
    <>
      {engineers.length > 0 && (
        <Section title="Engineers holding this item">
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className={TH}>Engineer</th>
                  <th className={`${TH} text-right`}>Qty</th>
                  <th className={TH}>Last movement</th>
                </tr>
              </thead>
              <tbody>
                {engineers.map((e) => (
                  <tr key={e.engineerId} className="border-b border-[var(--border)] last:border-0">
                    <td className={`${TD} text-[var(--ink)]`}>{e.locationLabel.replace(/^Eng:\s*/, "")}</td>
                    <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>{e.quantity}</td>
                    <td className={`${TD} text-[var(--muted)]`}>{formatDate(e.lastMovementAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {customers.length > 0 && (
        <Section title="Customer holdings">
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className={TH}>Customer</th>
                  <th className={TH}>Location</th>
                  <th className={`${TH} text-right`}>Qty</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c, i) => (
                  <tr key={`${c.customerId ?? "none"}-${i}`} className="border-b border-[var(--border)] last:border-0">
                    <td className={`${TD} text-[var(--ink)]`}>{c.customerName ?? "—"}</td>
                    <td className={`${TD} text-[var(--muted)]`}>{c.locationLabel}</td>
                    <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>{c.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeJobs.length > 0 && (
        <Section title="Jobs using this item">
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className={TH}>Job</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Customer</th>
                  <th className={`${TH} text-right`}>Kit qty</th>
                </tr>
              </thead>
              <tbody>
                {activeJobs.map((j) => (
                  <tr key={j.id} className="border-b border-[var(--border)] last:border-0">
                    <td className={`${TD}`}>
                      <span className="font-semibold text-[var(--ink)]">{j.name}</span>
                      <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{j.jobNumber}</span>
                    </td>
                    <td className={`${TD} capitalize text-[var(--muted)]`}>{j.status.replace(/_/g, " ")}</td>
                    <td className={`${TD} text-[var(--muted)]`}>{j.customerName ?? "—"}</td>
                    <td className={`${TD} text-right font-semibold text-[var(--ink)]`}>
                      {j.kitLines.reduce((n, l) => n + l.qty, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export function InventoryDetailPage({ initial }: { initial: InventoryDetailType }) {
  const router = useRouter();
  const { can } = useAuth();
  const inv = initial;
  const [locations, setLocations] = React.useState<number | null>(null);

  // Return to wherever the user came from (preserving the lens tab); fall back to the hub if this
  // page was opened directly (no in-app history).
  const onBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/dashboard/inventory");
  };

  const canMove = can("inventory.move") && inv.available > 0 && !inv.trackSerialNumbers && !inv.trackBatchNumbers;

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to inventory
      </button>
      <DetailHeader
        storageKey="inventory-detail"
        title={inv.itemName}
        badges={<InventoryStatusBadge status={inv.status} />}
        meta={
          <>
            <CopyableCode code={inv.itemCode} className="text-xs text-[var(--muted)]" />
            {inv.sku && (
              <>
                <span aria-hidden>·</span>
                <span>SKU {inv.sku}</span>
              </>
            )}
            {inv.categoryName && (
              <>
                <span aria-hidden>·</span>
                <span>{inv.categoryName}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>
              {inv.warehouseName} ({inv.warehouseCode})
            </span>
          </>
        }
        actions={
          canMove && (
            <button
              onClick={() => router.push(`/dashboard/inventory/move?item=${inv.irmItemId}&from=${inv.warehouseId}`)}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <ArrowLeftRight className="h-4 w-4" /> Move stock
            </button>
          )
        }
      />

      {/* KPIs — at this warehouse */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="On hand"
          value={`${inv.onHand.toLocaleString()}${inv.baseUnit ? ` ${inv.baseUnit}` : ""}`}
          sub="at this warehouse"
        />
        <Stat label="Available" value={inv.available.toLocaleString()} sub={inv.reserved ? `${inv.reserved} reserved` : "nothing reserved"} />
        <Stat label="Stock value" value={formatMoney(inv.value, inv.currency)} sub={`@ ${formatMoney(inv.unitCostPence / 100, inv.currency)} unit`} />
        <Stat
          label="Locations"
          value={locations === null ? "—" : String(locations)}
          sub={inv.incoming ? `${inv.incoming} incoming on POs` : "across all pools"}
        />
      </div>

      {/* Where it is now — the cross-pool view */}
      <DistributionSection irmItemId={inv.irmItemId} onCount={setLocations} />

      {/* Movement history */}
      <MovementHistorySection balanceId={inv.id} />

      {/* Engineers / Customer holdings / Jobs — only render when they have data */}
      <ActivityBlocks irmItemId={inv.irmItemId} />
    </div>
  );
}
