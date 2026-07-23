import { Skeleton } from "@/components/ui/Skeleton";
import { StatCardSkeleton } from "@/components/dashboard/portal/portalUi";

// Full-layout first-load placeholder — mirrors the real dashboard (cards row + next-up + right column)
// so the shell doesn't jump when data lands.
export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl lg:col-span-2" />
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
