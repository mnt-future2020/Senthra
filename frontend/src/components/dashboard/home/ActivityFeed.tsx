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
            return (
              <li key={a.id} className="flex items-center gap-3">
                <span className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASSES[actionTone(a.action)]}`}>
                  {actionLabel(a.action)}
                </span>
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
                <span className="shrink-0 text-xs text-[var(--faint)]" title={absoluteTime(a.at)}>
                  {relativeTime(a.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
