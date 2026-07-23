import Link from "next/link";
import { AlertTriangle, ArrowRightLeft, ChevronRight, Inbox, Truck, Wrench, type LucideIcon } from "lucide-react";

import type { AttentionRowModel, RowIcon } from "./engineerDashboardModel";

// "Needs your attention" — the actionable triage strip. Rendered only when there is at least one row;
// each row deep-links to where the work is done.
const ICONS: Record<RowIcon, LucideIcon> = { inbox: Inbox, alertTriangle: AlertTriangle, truck: Truck, arrowRightLeft: ArrowRightLeft, wrench: Wrench };
const TONES = {
  red: "bg-[var(--neg)]/12 text-[var(--neg)]",
  amber: "bg-amber-500/15 text-amber-600",
  accent: "bg-[var(--accent-10)] text-[var(--accent)]",
} as const;

export function AttentionStrip({ rows }: { rows: AttentionRowModel[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-b border-[var(--border)] px-5 py-3">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Needs your attention</h2>
      </div>
      <ul className="divide-y divide-[var(--border-2)]">
        {rows.map((r) => {
          const Icon = ICONS[r.iconKey];
          const iconEl = (
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONES[r.tone]}`}>
              <Icon className="h-4 w-4" />
            </span>
          );
          const label = <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--ink)]">{r.text}</span>;
          return (
            <li key={r.key}>
              {r.href ? (
                <Link href={r.href} className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--surface-2)]">
                  {iconEl}
                  {label}
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
                </Link>
              ) : (
                // Informational row — no destination, so it's a plain (non-clickable) line with no chevron.
                <div className="flex items-center gap-3 px-5 py-3">
                  {iconEl}
                  {label}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
