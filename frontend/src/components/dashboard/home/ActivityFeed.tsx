import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { actionTone, TONE_CLASSES, actionLabel, relativeTime, absoluteTime } from "@/components/dashboard/audit/auditDisplay";
import type { ActivityDTO } from "@/services/dashboard.service";

// Recent Activity — the last ~10 audit events rendered as an operational feed (tone dot + humanized
// action + entity code + relative time). Sourced from audit alone. Read-only.

// Map an audit event to its detail route. Link by the entity's DB id (always route-valid — the
// detail pages accept id OR code), NOT the display code: kit-request events carry targetType "job"
// with a JKR-#### label but the job's id, so linking by id lands on the right job while the row still
// shows the meaningful JKR/PO/PRF code. Returns null for types with no dedicated detail page.
function entityHref(type: string, id: string): string | null {
  if (!id) return null;
  switch (type) {
    case "purchase_order":
      return `/dashboard/purchase-orders/${id}`;
    case "purchase_request":
      return `/dashboard/purchase-requests/${id}`;
    case "job":
      return `/dashboard/jobs/${id}`;
    default:
      return null;
  }
}

export function ActivityFeed({ items }: { items: ActivityDTO[] }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-[var(--ink)]">Recent Activity</h3>
        <Link
          href="/dashboard/audit"
          className="flex shrink-0 items-center gap-0.5 text-xs font-bold text-[var(--accent)] hover:opacity-80"
        >
          View all <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-sm text-[var(--muted)]">No recent activity.</div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((a) => {
            const href = entityHref(a.entity.type, a.entity.id);
            // TWO LINES on a phone, one row from `sm` up — the same shape, and the same reason, as
            // the worklist rows next door. The action badge is `shrink-0` and `actionLabel` builds
            // it from the audit action, so it is routinely long ("Purchase Order · Exported"):
            // with the code and timestamp also unshrinkable, the actor cell was squeezed away and
            // the timestamp pushed clean out of the card — measured at a 320px viewport, it sat at
            // x=336 in a 240px row and dragged a horizontal scrollbar across the page.
            // `sm:contents` dissolves both wrappers from 640px up, so the desktop row is the one
            // that was always there. `flex-wrap` on the first line is the safety valve for an
            // action label longer than any today: the timestamp drops below it rather than out.
            return (
              <li key={a.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:contents">
                  <span className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASSES[actionTone(a.action)]}`}>
                    {actionLabel(a.action)}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-[var(--faint)] sm:order-last sm:ml-0" title={absoluteTime(a.at)}>
                    {relativeTime(a.at)}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-2 sm:contents">
                  {a.entity.code ? (
                    href ? (
                      <Link href={href} className="shrink-0 font-mono text-xs font-semibold text-[var(--accent)] hover:underline">
                        {a.entity.code}
                      </Link>
                    ) : (
                      <span className="shrink-0 font-mono text-xs font-semibold text-[var(--muted)]">{a.entity.code}</span>
                    )
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--muted)]">{a.actorName}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
