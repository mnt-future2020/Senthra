import * as React from "react";
import Link from "next/link";

import { Sparkline } from "./Sparkline";

// A single KPI card: title, big count, optional secondary line (value or "N critical" chip), and an
// optional 8-week created-volume sparkline. The whole card links to the owning list. Visual language
// mirrors reference/tabs/OverviewTab.tsx (CSS-variable themed, hover accent border).
export function StatCard({
  title,
  count,
  secondary,
  spark,
  href,
}: {
  title: string;
  count: number;
  secondary?: React.ReactNode;
  spark?: number[];
  href: string;
}) {
  return (
    <Link
      href={href}
      className="bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between gap-3 transition-colors hover:border-[var(--accent)] hover:shadow-md"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</div>
          <div className="mt-2 text-3xl font-extrabold text-[var(--ink)] tabular-nums">{count}</div>
        </div>
        {spark && spark.length > 0 ? (
          <div className="shrink-0 pt-1">
            <Sparkline data={spark} />
          </div>
        ) : null}
      </div>
      {secondary ? <div className="text-sm text-[var(--muted)]">{secondary}</div> : null}
    </Link>
  );
}
