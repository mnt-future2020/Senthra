import { Skeleton } from "@/components/ui/Skeleton";

// First-load placeholder for an audit-trail list (action badge + actor on the left, time on the
// right) — shared by every detail page's Audit trail so they all load with the same skeleton
// instead of a spinner. Mirrors the real <ul>/<li> layout to avoid a shift when entries arrive.
export function AuditTrailSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-3 w-12" />
          </li>
        ))}
      </ul>
    </div>
  );
}
