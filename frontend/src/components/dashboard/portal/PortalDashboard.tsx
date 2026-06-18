"use client";

import * as React from "react";
import Link from "next/link";
import { Boxes, ClipboardList, FolderKanban, MapPin, Activity, ArrowRight } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CustomerOverview } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

import {
  ComingSoon,
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  RequestStatusChip,
  StatCardSkeleton,
} from "./portalUi";

// Customer portal — Dashboard (the landing). A quick read on the things a customer
// cares about: how many requests are awaiting review, how much work is in flight
// (projects/sites), the size of their catalogue, and their most recent requests.
// Cards that need the inventory module (stock movements) ship as honest placeholders.
export function PortalDashboard() {
  const [overview, setOverview] = React.useState<CustomerOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await customerService.getOwnOverview();
        if (active) setOverview(data);
      } catch (err) {
        if (active) {
          setMsg({
            type: "error",
            text: err instanceof Error ? err.message : "Could not load your dashboard.",
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <DashboardSkeleton />;
  if (msg) return <Notice msg={msg} />;
  if (!overview) return null;

  const { customer, counts, recentRequests } = overview;

  return (
    <div className="space-y-6">
      <PortalHeader
        title={`Welcome, ${customer.name}`}
        subtitle="An overview of your projects, sites, stock and requests."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={ClipboardList}
          label="Pending stock submissions"
          value={counts.pendingRequests}
          href="/dashboard/portal/requests"
          accent
        />
        <StatCard
          icon={FolderKanban}
          label="Active projects"
          value={counts.activeProjects}
          sub={counts.totalProjects !== counts.activeProjects ? `${counts.totalProjects} total` : undefined}
          href="/dashboard/portal/projects"
        />
        <StatCard
          icon={MapPin}
          label="Sites"
          value={counts.totalSites}
          href="/dashboard/portal/sites"
        />
        <StatCard
          icon={Boxes}
          label="Stock entries"
          value={0}
          href="/dashboard/portal/stock"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentActivity requests={recentRequests} />

        <div className="space-y-2">
          <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent stock movements</h2>
          <ComingSoon
            icon={Activity}
            title="Stock movements"
            body="Once live inventory is connected, dispatches and deliveries to your sites will show up here."
            compact
          />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  sub?: string;
  href: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--accent)]/40"
    >
      <div className="flex items-center justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl ${
            accent ? "bg-[var(--accent-10)] text-[var(--accent)]" : "bg-[var(--surface-2)] text-[var(--muted)]"
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <ArrowRight className="h-4 w-4 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div>
        <div className="text-2xl font-extrabold tracking-tight text-[var(--ink)] tabular-nums">{value}</div>
        <div className="mt-0.5 text-xs font-semibold text-[var(--muted)]">{label}</div>
        {sub && <div className="mt-0.5 text-[11px] text-[var(--faint)]">{sub}</div>}
      </div>
    </Link>
  );
}

function RecentActivity({ requests }: { requests: CustomerOverview["recentRequests"] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent activity</h2>
        <Link
          href="/dashboard/portal/requests"
          className="text-[11px] font-bold text-[var(--accent)] hover:opacity-80"
        >
          View all
        </Link>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {requests.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--muted)]">
            No stock submissions yet.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[var(--ink)]">
                    {r.name}
                    <span className="ml-1.5 font-mono text-[11px] font-bold text-[var(--muted)]">
                      ×{r.quantity ?? "?"}
                    </span>
                  </div>
                  <div className="text-[11px] text-[var(--faint)]">{fmtDate(r.createdAt)}</div>
                </div>
                <RequestStatusChip value={r.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Layout-matched loading placeholder — header card + 4 stat cards + the two-column
// activity / movements row, so the page doesn't shift when the overview arrives.
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <HeaderCardSkeleton />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-8">
            <Skeleton className="h-10 w-10 rounded-full" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-56 max-w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
