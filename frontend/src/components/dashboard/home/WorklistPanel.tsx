import Link from "next/link";

import type { WorklistItemDTO } from "@/services/dashboard.service";
import { AttentionBar } from "@/components/dashboard/shell/AttentionBar";

// "Awaiting Your Action" — the role-aware worklist. A dashboard summary widget, so it shows only the
// most urgent items at a fixed height (no in-widget expand — the enterprise-dashboard convention).
// The server pre-sorts by urgency and returns the top slice; the footer states the full backlog size
// and each row deep-links to its item, where the work is actually done. Overdue rows get a negative
// accent. Read-only.

const KIND_LABELS: Record<string, string> = {
  review_prf: "Review PRF",
  approve_po_fastpath: "Approve PO",
  review_po: "Review PO",
  send_po: "Send to supplier",
  acknowledge_po: "Record acceptance",
  receive_goods: "Receive goods",
  review_kit_request: "Review kit request",
  review_van_stock_request: "Review field stock",
};

const KIND_TONE: Record<string, string> = {
  review_prf: "bg-sky-500/12 text-sky-600",
  approve_po_fastpath: "bg-violet-500/12 text-violet-600",
  review_po: "bg-violet-500/12 text-violet-600",
  send_po: "bg-indigo-500/12 text-indigo-600",
  acknowledge_po: "bg-teal-500/12 text-teal-600",
  receive_goods: "bg-emerald-500/12 text-emerald-600",
  review_kit_request: "bg-amber-500/12 text-amber-600",
  review_van_stock_request: "bg-orange-500/12 text-orange-600",
};

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  const today = new Date();
  return Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) <
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

export function WorklistPanel({
  items,
  total,
  truncated,
}: {
  items: WorklistItemDTO[];
  total: number;
  truncated: boolean;
}) {
  // Total shown (with "+" when the server flagged the count as a floor).
  const totalLabel = `${total}${truncated ? "+" : ""}`;

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-[var(--ink)]">Awaiting Your Action</h3>
        {total > 0 ? (
          <span className="text-xs text-[var(--muted)]">
            {totalLabel} {total === 1 && !truncated ? "item" : "items"}
          </span>
        ) : null}
      </div>

      {/* Whole-backlog counts, including queues this list carries no rows for. Renders nothing when
          there is no pending work, so the "All clear" state below stays clean. */}
      <AttentionBar className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] pb-3" />

      {items.length === 0 ? (
        <div className="py-8 text-center text-sm text-[var(--muted)]">All clear ✓ — nothing needs your action.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((it) => {
            const overdue = isOverdue(it.dueDate);
            return (
              <li key={`${it.kind}:${it.id}`}>
                <Link
                  href={it.href}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-[var(--surface-2)]"
                >
                  <span
                    className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${KIND_TONE[it.kind] ?? "bg-[var(--surface-2)] text-[var(--muted)]"}`}
                  >
                    {KIND_LABELS[it.kind] ?? it.kind}
                  </span>
                  <span className="w-24 shrink-0 truncate font-mono text-xs font-semibold text-[var(--accent)]">{it.code}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{it.title ?? "—"}</span>
                  {it.priority === "high" || it.priority === "urgent" ? (
                    <span className="shrink-0 text-[11px] font-bold uppercase text-amber-600">{it.priority}</span>
                  ) : null}
                  <span className={`w-16 shrink-0 text-right text-xs ${overdue ? "font-bold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                    {overdue ? "overdue" : `${it.ageDays} d`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* Footer: state the full backlog when more items exist than are shown. No in-widget expand —
          each row links to its item, and the busiest queues surface here first as they age. */}
      {items.length > 0 && (truncated || total > items.length) ? (
        <div className="mt-2 border-t border-[var(--border)] pt-2 text-center text-xs text-[var(--faint)]">
          Showing the {items.length} most urgent of {totalLabel} — open an item to act on it.
        </div>
      ) : null}
    </div>
  );
}
