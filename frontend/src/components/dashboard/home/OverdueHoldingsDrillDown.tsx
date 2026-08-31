"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Loader2 } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useAuth } from "@/hooks/useAuth";
import { listOverdueGroups } from "@/services/goodsManagement.service";
import type { OverdueGroup, OverdueGroupsResult } from "@/types/goodsManagement";
import { overdueWarehouseHref } from "./cardDestinations";
import { acceptsResponse, closedDrillDownState, drillDownView } from "./overdueDrillDownState";

// ── "Overdue Holdings — where is it, and who has it?" ──────────────────────────────────────────
//
// The Overview card is a company-wide number: N jobs whose kit has been out longer than the window
// in Settings, across every warehouse the viewer can reach. The WORK is done inside one warehouse's
// Goods → Overdue section, where the row carries the Write-off and the return scan. So the count has
// no single list behind it, and the card used to send people to `/dashboard/warehouses` — the bare
// list, which contains none of the jobs it counted and, for anyone already standing there, navigated
// nowhere at all. That is precisely the destination the attention catalog refuses an href for.
//
// This is the fan-out that makes the number openable without inventing a screen: the SAME server-side
// selection the card counts, folded per warehouse and per engineer, with each warehouse row opening
// that warehouse's own Overdue section. `total` here is the card's own count — one selection, two
// reads — so the breakdown can never sum to a different number than the card it came from.
//
// Bounded by construction: one row per warehouse, never one per job, so a backlog of hundreds is
// still a handful of rows. Nothing is truncated, so nothing has to be apologised for; the list
// scrolls inside the panel instead.
//
// The engineer dimension is a FILTER, not a second destination. There is no cross-warehouse screen
// for "everything Ann is holding" — her kit came out of two different doors and is chased at each —
// so picking her narrows the warehouse rows to hers and carries `gmOvEng` through to the destination,
// which lands on that warehouse's Overdue list already filtered to her. A row that led nowhere would
// be the same broken promise this whole card is fixing.

const dayLabel = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

function GroupRow({ group, href }: { group: OverdueGroup; href: string | null }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate font-semibold text-[var(--ink)]">{group.label}</span>
      <span className="shrink-0 text-xs text-[var(--muted)] tabular-nums">
        oldest {dayLabel(group.oldestDaysOut)}
      </span>
      <span className="w-10 shrink-0 text-right text-sm font-extrabold text-[var(--neg)] tabular-nums">
        {group.count}
      </span>
    </>
  );
  const shared = "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm";
  // No href — the viewer can't open a warehouse detail page, or the issue carries no warehouse at
  // all. Show the number and no affordance: the honest version of a row with nowhere to go.
  if (!href) {
    return (
      <li
        className={`${shared} text-[var(--muted)]`}
        title={`${group.label} — ${group.count}. No warehouse page you can open holds these.`}
      >
        {body}
        <span className="w-4 shrink-0" aria-hidden />
      </li>
    );
  }
  return (
    <li>
      <Link
        href={href}
        className={`${shared} group w-full transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40`}
      >
        {body}
        <ArrowUpRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-[var(--faint)] transition-colors group-hover:text-[var(--accent)]"
        />
      </Link>
    </li>
  );
}

export function OverdueHoldingsDrillDown({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  // The destination is the warehouse DETAIL page, which is gated on `warehouse.view` — a separate
  // grant from the `goods_management.view` that put this count on the dashboard. Without it the rows
  // render as plain numbers rather than links to a screen that would refuse them; the counts stay,
  // because the work is still theirs and knowing it exists is the point. Same rule the attention
  // service applies through `hrefPerms`.
  const canOpenWarehouse = can("warehouse.view");

  const [data, setData] = React.useState<OverdueGroupsResult | null>(null);
  // The engineer options, kept from the UNFILTERED load: once narrowed to one engineer the response
  // only knows about that one, and the picker would collapse to a single choice with no way back.
  const [engineers, setEngineers] = React.useState<OverdueGroup[]>([]);
  const [engineerId, setEngineerId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Monotonic guard — the same one the Overview itself uses: a slow earlier response must never
  // overwrite a newer one when the engineer filter is changed twice quickly.
  const seqRef = React.useRef(0);

  React.useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    void (async () => {
      // Yield one microtask first so no state is set synchronously inside the effect body — the same
      // shape OverviewView's own loader uses (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (!acceptsResponse(seq, seqRef.current)) return;
      setLoading(true);
      try {
        const res = await listOverdueGroups(engineerId ? { engineerId } : {});
        if (!acceptsResponse(seq, seqRef.current)) return;
        setData(res);
        // Only the unfiltered load defines the roster.
        if (!engineerId) setEngineers(res.byEngineer);
        setError(null);
      } catch (e) {
        if (!acceptsResponse(seq, seqRef.current)) return;
        setError(e instanceof Error ? e.message : "Couldn't load the overdue breakdown.");
      } finally {
        if (acceptsResponse(seq, seqRef.current)) setLoading(false);
      }
    })();
  }, [open, engineerId]);

  // Reset on the way OUT, not in an effect watching `open`: every close path — the X, Escape, the
  // backdrop — goes through Modal's onClose, so wrapping it covers all three.
  //
  // EVERYTHING resets, not just the filter. Clearing `engineerId` alone left the previous request's
  // RESULT underneath it: reopen after narrowing to an engineer holding 2 and the picker read "All
  // engineers" over a subtitle reading "2 jobs", under a card saying 7 — a contradiction in the one
  // place this whole panel exists to make consistent. A stale `error` outlived the close the same
  // way, so a request that failed once showed its banner on the next open before anything was tried.
  //
  // Bumping `seqRef` is the third half of it: a response still in flight from the previous open can
  // no longer land, so it cannot repopulate what was just cleared.
  const close = React.useCallback(() => {
    seqRef.current += 1;
    const reset = closedDrillDownState();
    setEngineerId(reset.engineerId);
    setEngineers(reset.engineers);
    setData(reset.data);
    setError(reset.error);
    onClose();
  }, [onClose]);

  // One decision for what the body shows — see drillDownView for why it is never keyed on `loading`.
  const view = drillDownView({ data, error });

  const subtitle = data
    ? `${data.total} job${data.total === 1 ? "" : "s"} with stock out more than ${dayLabel(data.days)}`
    : "Loading…";

  const engineerOptions = [
    { value: "", label: `All engineers${engineers.length ? ` (${engineers.length})` : ""}` },
    ...engineers.map((e) => ({ value: e.id, label: `${e.label} — ${e.count}` })),
  ];

  return (
    <Modal open={open} title="Overdue holdings" subtitle={subtitle} onClose={close} size="md" scrollBody>
      <div className="flex flex-col gap-3">
        {/* Only worth offering when there is a choice to make. One engineer holding everything needs
            no picker, and an empty backlog needs neither. */}
        {engineers.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              Held by
            </span>
            <Select
              size="sm"
              value={engineerId ?? ""}
              onChange={(v) => setEngineerId(v || null)}
              options={engineerOptions}
              ariaLabel="Filter the breakdown by the engineer still holding the stock"
              className="min-w-[12rem]"
            />
            {engineerId ? (
              <button
                type="button"
                onClick={() => setEngineerId(null)}
                className="rounded px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}

        {view === "error" ? (
          <p className="flex items-center gap-2 text-sm text-[var(--neg)]">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </p>
        ) : view === "loading" ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the breakdown…
          </p>
        ) : view === "empty" ? (
          <p className="py-8 text-center text-sm text-[var(--muted)]">
            {engineerId ? "Nothing overdue for that engineer." : "Nothing has been out too long. ✓"}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between px-2.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <span>Warehouse it went out from</span>
              <span>Jobs</span>
            </div>
            <ul className={`divide-y divide-[var(--border)] ${loading ? "opacity-60" : ""}`}>
              {data?.byWarehouse.map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  // `code` is null for the rare issue with no warehouse recorded — there is no page
                  // to send it to, so it renders as a plain row rather than a broken link.
                  href={canOpenWarehouse && g.code ? overdueWarehouseHref(g.code, engineerId) : null}
                />
              ))}
            </ul>
            <p className="px-2.5 text-xs text-[var(--faint)]">
              Each row opens that warehouse&apos;s Goods → Overdue list, where the kit is chased back
              or written off.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
