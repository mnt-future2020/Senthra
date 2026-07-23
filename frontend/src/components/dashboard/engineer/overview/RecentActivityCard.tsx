import Link from "next/link";
import { Activity } from "lucide-react";

import { EmptyState, fmtDate } from "@/components/dashboard/portal/portalUi";
import type { Movement } from "@/types/stock-position";

// The engineer's own recent stock movements (company van + customer consignment). "View all" deep-links
// to the Movements tab of their Stock page.
export function RecentActivityCard({ movements }: { movements: Movement[] }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent activity</h2>
        <Link href="/dashboard/engineer/inventory?section=movements" className="text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
          View all →
        </Link>
      </div>
      {movements.length === 0 ? (
        <EmptyState icon={Activity} title="No activity yet" hint="When you collect, use or transfer stock, it'll show here." />
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {movements.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--ink)]">
                  {a.label} · {a.itemName}
                </p>
                <p className="text-[11px] text-[var(--faint)]">
                  {a.itemCode || (a.ownership === "customer" ? "Customer" : "")}
                  {a.reference ? ` · ${a.reference}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`text-sm font-bold ${a.quantityDelta >= 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`}>
                  {a.quantityDelta >= 0 ? "+" : ""}
                  {a.quantityDelta}
                </p>
                <p className="text-[11px] text-[var(--faint)]">{fmtDate(a.date)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
