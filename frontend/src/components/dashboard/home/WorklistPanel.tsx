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
                {/* TWO LINES on a phone, one row from `sm` up.

                    As a single row this did not fit and did not degrade: four of the five cells are
                    `shrink-0` (the badge is also `whitespace-nowrap`, and the code and age cells
                    carry fixed widths), so the only cell that could give way was the title. Measured
                    on the dashboard at a 320px viewport — 240px of usable row — the row asked for
                    335px and the title was handed exactly ZERO of it: the item's own name, the thing
                    that says which supplier or job the work is for, was not rendered at all, and the
                    95px left over pushed a horizontal scrollbar across the whole page.

                    So the phone gets the badge and the age on one line and the code, title and
                    priority on the next, where the title has ~140px to be read in. `sm:contents`
                    dissolves both wrappers at 640px and up, which leaves the five cells as direct
                    flex children of this link exactly as before — the desktop row is unchanged, not
                    a second layout to keep in step. The age cell is last in the row there and first
                    on the phone, hence `sm:order-last` against its mobile `ml-auto`. */}
                <Link
                  href={it.href}
                  className="flex flex-col gap-1 py-2.5 transition-colors hover:bg-[var(--surface-2)] sm:flex-row sm:items-center sm:gap-3"
                >
                  {/* `flex-wrap`: the age drops below rather than out, should a future KIND_LABEL
                      run longer than "Record acceptance" (the longest today, measured at 115px). */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:contents">
                    <span
                      className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${KIND_TONE[it.kind] ?? "bg-[var(--surface-2)] text-[var(--muted)]"}`}
                    >
                      {KIND_LABELS[it.kind] ?? it.kind}
                    </span>
                    <span
                      className={`ml-auto shrink-0 text-right text-xs sm:order-last sm:ml-0 sm:w-16 ${overdue ? "font-bold text-[var(--neg)]" : "text-[var(--muted)]"}`}
                    >
                      {overdue ? "overdue" : `${it.ageDays} d`}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 sm:contents">
                    <span className="shrink-0 truncate font-mono text-xs font-semibold text-[var(--accent)] sm:w-24">{it.code}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{it.title ?? "—"}</span>
                    {it.priority === "high" || it.priority === "urgent" ? (
                      <span className="shrink-0 text-[11px] font-bold uppercase text-amber-600">{it.priority}</span>
                    ) : null}
                  </div>
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
