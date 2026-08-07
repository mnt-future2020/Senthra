"use client";

import * as React from "react";
import Link from "next/link";
import { Boxes, ClipboardCheck, ClipboardList, FolderKanban, MapPin, ArrowRight, Warehouse } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CustomerOverview } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

import {
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  RequestStatusChip,
  StatCardSkeleton,
} from "./portalUi";

// Customer portal — Dashboard (the landing).
//
// Built around the question a consignment customer actually arrives with: how much of my stock do you
// hold, where is it, and is anything wrong? So: UNITS on hand as the headline, the per-warehouse split
// beside it, a reconciliation line when something was short-closed, and the recent submissions.
//
// It used to lead with "26 Stock entries" — a ROW count. Entries are one line per item × warehouse, so
// that number answers "how many lines are in your list", which nobody asks. Units are the holding.
//
// There is no "recent stock movements" panel, and it isn't an oversight: customer stock at a warehouse
// has no transaction ledger (a known, accepted gap — balances are correct, the per-move history simply
// isn't recorded). The old placeholder promised it was "coming"; a dashboard should show what is true
// now, so the space went to the warehouse split, which is real.
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

  const { customer, counts, stockByWarehouse, recentRequests } = overview;

  return (
    <div className="space-y-6">
      <PortalHeader
        title={`Welcome, ${customer.name}`}
        subtitle="Your stock with us, and the submissions still in flight."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* Units first and accented — the holding, not the row count. `stockEntries` stays as the
            sub-line because it's what the linked page lists, so the click is predictable. */}
        <StatCard
          icon={Boxes}
          label="Units with us"
          value={counts.stockUnits}
          sub={`across ${counts.stockEntries} ${counts.stockEntries === 1 ? "entry" : "entries"}`}
          href="/dashboard/stock"
          accent
        />
        {/* ACTIVE, not total. A lifetime job count only ever grows and stops meaning anything; what
            the customer is checking is what is still coming. Links to the list ALREADY FILTERED —
            `?status=active` resolves through the same status set the count is computed from, so the
            number here and the row count there always agree, exactly like Open submissions. */}
        <StatCard
          icon={ClipboardCheck}
          label="Active jobs"
          value={counts.activeJobs}
          sub="scheduled or in progress"
          href="/dashboard/portal/jobs?status=active"
        />
        {/* Links to the list ALREADY FILTERED to open. `?status=open` resolves through the same
            OPEN_REQUEST_STATUSES the count is computed from, so the number here and the row count
            there always agree — and the customer isn't handed a figure they then have to hunt for. */}
        <StatCard
          icon={ClipboardList}
          label="Open submissions"
          value={counts.openRequests}
          sub="awaiting review or delivery"
          href="/dashboard/portal/requests?status=open"
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
      </div>

      {/* Directly under the unit count it explains, and only when there is something to explain. */}
      {counts.notReceivedUnits > 0 && <NotReceivedNote units={counts.notReceivedUnits} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentActivity requests={recentRequests} />
        <StockByWarehouse rows={stockByWarehouse} total={counts.stockUnits} />
      </div>
    </div>
  );
}

// Reconciliation context for the unit count above, NOT an alert — and the distinction is the whole
// design of this line.
//
// It began as an amber warning banner above the stat row, which was wrong three times over:
//   - It never clears. The figure spans all history with no window and no dismissal, so it only ever
//     grows. A permanent warning is alarm fatigue by construction — within weeks the customer stops
//     reading the row it lives in, including whatever genuinely urgent thing lands there later.
//   - Nothing is actionable. `closed_short` is terminal: the delivery is closed, the reason recorded,
//     the account team already handled it. Warning chrome promises a task that does not exist.
//   - It is usually the customer's OWN decision. The commonest reason is that they shipped fewer than
//     they declared and cancelled the rest. Repeating that back to them in alarm colours, forever,
//     misrepresents a normal business event as a problem.
//
// What the number is actually FOR is reconciliation: "your portal says you hold 648; I sent 729" —
// this explains the gap. That belongs beside the holding, in the same voice as the holding. So: below
// the stat row it annotates, no amber, no alert icon, wording that places it in the past. Still a
// link, because a number the customer cannot trace is a number they have to phone about.
function NotReceivedNote({ units }: { units: number }) {
  return (
    <Link
      href="/dashboard/portal/requests"
      className="group -mt-1 flex items-center gap-1.5 px-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
    >
      <span>
        <span className="font-bold text-[var(--ink)]">
          {units} {units === 1 ? "unit" : "units"} not received
        </span>
        {" "}on earlier submissions — see which, and why
      </span>
      <ArrowRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

// Where the stock physically is. Replaces the old "movements coming soon" placeholder with the part
// of that question we CAN answer from real balances — a customer planning a job needs to know which
// warehouse holds their kit, and that is a live number, not a future feature.
function StockByWarehouse({
  rows,
  total,
}: {
  rows: CustomerOverview["stockByWarehouse"];
  total: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Stock by warehouse</h2>
        {rows.length > 0 && (
          <Link href="/dashboard/stock" className="text-[11px] font-bold text-[var(--accent)] hover:opacity-80">
            View all
          </Link>
        )}
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-[var(--muted)]">
            No stock with us yet. Once a submission is received at a warehouse it will show up here.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {rows.map((r) => {
              // Share of the whole holding, as a bar. `total` is the sum of these rows, so it can only
              // be 0 when every row is 0 — guarded because that would otherwise divide by zero.
              const pct = total > 0 ? Math.round((r.units / total) * 100) : 0;
              return (
                <li key={r.warehouseId}>
                  {/* Straight through to this warehouse's stock. Without the link the panel raised the
                      obvious question — "show me those 310" — and left the customer to find the page,
                      then filter it themselves. By id, so a rename can't break it. */}
                  <Link
                    href={`/dashboard/stock?warehouseId=${encodeURIComponent(r.warehouseId)}`}
                    className="group block px-4 py-3 transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Warehouse className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" />
                        <span className="truncate text-sm font-semibold text-[var(--ink)]">{r.warehouseName}</span>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--faint)]">{r.warehouseCode}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-right">
                        <span>
                          <span className="text-sm font-extrabold tabular-nums text-[var(--ink)]">{r.units}</span>
                          <span className="ml-1 text-[11px] text-[var(--muted)]">
                            {r.units === 1 ? "unit" : "units"}
                          </span>
                        </span>
                        <ArrowRight className="h-3.5 w-3.5 text-[var(--faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </div>
                    {/* Decorative — the number beside it is the accessible value, so the bar is hidden
                        from screen readers rather than announced as an unlabelled progress bar. */}
                    <div aria-hidden className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div className="h-full rounded-full bg-[var(--accent)]/60" style={{ width: `${pct}%` }} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
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

// Layout-matched loading placeholder — header card + 4 stat cards + the two-column activity /
// warehouse row, so the page doesn't shift when the overview arrives.
//
// No placeholder for the not-received line: most customers never have one, so reserving space for it
// would shift the page down on every load and then collapse when the data says there is nothing there.
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <HeaderCardSkeleton />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
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
        {/* Mirrors StockByWarehouse: title row, then name + units + the share bar under each. */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-36" />
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-3.5 w-44" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                <Skeleton className="mt-2 h-1 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
