"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, ArrowRightLeft, Boxes, ClipboardList } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { useAuth } from "@/hooks/useAuth";
import { Notice } from "@/components/ui/Notice";
import { EmptyState, fmtDate, PortalHeader, StatCardSkeleton } from "@/components/dashboard/portal/portalUi";
import type { EngineerOverview } from "@/types/engineer";
import type { Movement } from "@/types/stock-position";
import type { Msg } from "@/components/ui/types";

// Engineer Portal dashboard — read-only cards (Stock, Dispatches, Recent Activity) over the engineer's
// own data. The Recent Activity feed is the unified stock ledger scoped to this engineer (company van +
// customer consignment), so transfers, job issues/returns and consumption all surface here.
export function EngineerDashboard() {
  const { can } = useAuth();
  const [overview, setOverview] = React.useState<EngineerOverview | null>(null);
  const [recent, setRecent] = React.useState<Movement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [ov, mv] = await Promise.all([
          engineerService.getOwnOverview(),
          engineerService.getOwnMovements({ limit: 6 }).catch(() => ({ movements: [], nextCursor: null, hasMore: false })),
        ]);
        if (active) { setOverview(ov); setRecent(mv.movements); }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your dashboard." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Dashboard" subtitle="Your held stock, dispatches and recent activity." />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalHeader title="Dashboard" subtitle="Your held stock, dispatches and recent activity." />
      {msg && <Notice msg={msg} />}

      {overview && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={Boxes}
              value={`${overview.stock.totalQuantity}`}
              label="Stock"
              hint={`${overview.stock.lines} item${overview.stock.lines === 1 ? "" : "s"} on hand`}
            />
            <StatCard icon={Activity} value={`${recent.length}`} label="Recent Activity" hint="latest stock movements" />
          </div>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">Quick actions</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <QuickAction href="/dashboard/engineer/inventory" icon={Boxes} label="View Stock" />
              <QuickAction href="/dashboard/engineer/jobs" icon={ClipboardList} label="Open Jobs" />
              {can("engineer.transfer") && (
                <QuickAction href="/dashboard/engineer/transfers" icon={ArrowRightLeft} label="Transfers" />
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent activity</h2>
              <Link href="/dashboard/engineer/inventory" className="text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
                View all →
              </Link>
            </div>
            {recent.length === 0 ? (
              <EmptyState icon={Activity} title="No activity yet" hint="When you collect, use or transfer stock, it'll show here." />
            ) : (
              <ul className="divide-y divide-[var(--border-2)]">
                {recent.map((a) => (
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
        </>
      )}
    </div>
  );
}

// Dashboard quick-link tile.
function QuickAction({ href, icon: Icon, label }: { href: string; icon: React.ElementType; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <Icon className="h-4 w-4" /> {label}
    </Link>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
  hint,
}: {
  icon: React.ElementType;
  value: string;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent-10)] text-[var(--accent)]">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-extrabold text-[var(--ink)]">{value}</p>
        <p className="text-xs font-bold text-[var(--ink)]">{label}</p>
        <p className="text-[11px] text-[var(--muted)]">{hint}</p>
      </div>
    </div>
  );
}
