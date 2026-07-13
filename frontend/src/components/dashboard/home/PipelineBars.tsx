import Link from "next/link";

import { PO_STATUS_LABELS } from "@/components/dashboard/purchase-orders/poStatus";
import type { PoStatus } from "@/types/purchase-order";
import type { PipelinePoint } from "@/services/dashboard.service";

// PO pipeline: current count per non-terminal status, as horizontal bars. Each bar links to the PO
// list filtered to that status. Theme-variable styling; bars scale to the largest count.
export function PipelineBars({ data }: { data: PipelinePoint[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-[var(--ink)]">PO Pipeline</h3>
        <span className="text-xs text-[var(--muted)]">Open orders by stage</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {data.map((d) => {
          const label = PO_STATUS_LABELS[d.status as PoStatus] ?? d.status;
          const pct = Math.round((d.count / max) * 100);
          return (
            <li key={d.status}>
              <Link
                href={`/dashboard/purchase-orders?status=${d.status}`}
                className="group flex items-center gap-3"
              >
                <span className="w-32 shrink-0 truncate text-xs font-medium text-[var(--muted)] group-hover:text-[var(--ink)]">
                  {label}
                </span>
                <span className="relative h-5 flex-1 overflow-hidden rounded bg-[var(--surface-2)]">
                  <span
                    className="absolute inset-y-0 left-0 rounded bg-[var(--accent-10)] group-hover:bg-[var(--accent-12)]"
                    style={{ width: `${Math.max(pct, d.count > 0 ? 6 : 0)}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right text-sm font-bold tabular-nums text-[var(--ink)]">{d.count}</span>
              </Link>
            </li>
          );
        })}
        {data.length === 0 ? <li className="text-sm text-[var(--muted)]">No open orders.</li> : null}
      </ul>
    </div>
  );
}
