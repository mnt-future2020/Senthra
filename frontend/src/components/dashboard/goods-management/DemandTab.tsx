"use client";

// DemandTab — warehouse "Demand" board. Shows, for THIS warehouse, every item that active jobs plan
// to draw from it: current free stock vs total planned (across all jobs), shortfalls first. Lets the
// warehouse see incoming load and restock / reprioritise before engineers turn up. Read-only.

import * as React from "react";
import { PackageSearch, TriangleAlert } from "lucide-react";

import { getWarehouseDemand } from "@/services/goodsManagement.service";
import type { WarehouseDemandRow } from "@/types/goodsManagement";
import { Skeleton } from "@/components/ui/Skeleton";

const HEADERS = ["Item", "Source", "In stock", "Planned", "Free"];
const SOURCE_LABEL: Record<WarehouseDemandRow["source"], string> = { irm: "IRM item", customer: "Customer stock" };

export function DemandTab({ warehouseId }: { warehouseId: string }) {
  const [rows, setRows] = React.useState<WarehouseDemandRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    getWarehouseDemand(warehouseId).then(
      (r) => { if (active) { setRows(r); setError(null); } },
      (e) => { if (active) setError(e instanceof Error ? e.message : "Could not load demand."); },
    );
    return () => { active = false; };
  }, [warehouseId]);

  const shortCount = rows?.filter((r) => r.free < 0).length ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-extrabold tracking-tight text-[var(--ink)]">Demand from active jobs</h3>
        <p className="mt-0.5 text-xs text-[var(--muted)]">
          Stock that assigned jobs plan to collect from this warehouse but haven&apos;t issued yet — so you can prepare or restock.
          {shortCount > 0 && <span className="font-semibold text-[var(--neg)]"> {shortCount} item{shortCount > 1 ? "s" : ""} short.</span>}
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {HEADERS.map((h, i) => (
                  <th key={h} className={`px-4 py-3 ${i >= 2 ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr><td colSpan={HEADERS.length} className="px-4 py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</td></tr>
              ) : rows === null ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    {HEADERS.map((__, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className={`h-4 ${j >= 2 ? "ml-auto w-12" : "w-32"}`} /></td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={HEADERS.length} className="px-4 py-12">
                    <div className="flex flex-col items-center justify-center gap-2 text-center">
                      <PackageSearch className="h-7 w-7 text-[var(--faint)]" />
                      <p className="text-sm font-semibold text-[var(--ink)]">No open demand</p>
                      <p className="text-xs text-[var(--muted)]">No active job currently plans to draw stock from this warehouse.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const short = r.free < 0;
                  return (
                    <tr key={`${r.itemName}-${i}`} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-4 py-3 font-semibold text-[var(--ink)]">{r.itemName}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{SOURCE_LABEL[r.source]}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--ink)]">{r.inStock}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-indigo-600">{r.planned}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${short ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}>
                        <span className="inline-flex items-center justify-end gap-1">
                          {short && <TriangleAlert className="h-3.5 w-3.5" />}
                          {short ? `${r.free} (short ${Math.abs(r.free)})` : r.free}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
