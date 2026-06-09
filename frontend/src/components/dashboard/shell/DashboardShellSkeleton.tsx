import { Skeleton } from "@/components/ui/Skeleton";

// Loading placeholder for the whole dashboard frame, shown by AuthGuard while the
// session is being verified. It mirrors the real shell — sidebar (expanded, the
// shell's default), topbar and a neutral content block — at the exact same
// dimensions, so when the verified shell mounts there's no layout shift and no
// jarring spinner→skeleton hop. Purely presentational: no providers, no data.
export function DashboardShellSkeleton() {
  return (
    <div
      className="flex bg-[var(--bg)] text-[var(--ink)] h-screen overflow-hidden"
      aria-busy="true"
      aria-label="Loading"
    >
      {/* Sidebar — off-canvas on mobile (matches the real shell), w-64 expanded. */}
      <aside className="hidden md:flex sticky top-0 left-0 h-screen w-64 px-4 py-6 bg-[var(--surface)] border-r border-[var(--border)] flex-col justify-between shrink-0">
        <div className="space-y-6">
          {/* Brand */}
          <div className="flex items-center gap-3 px-2">
            <Skeleton className="h-9 w-9 rounded-xl" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-24 rounded" />
              <Skeleton className="h-2 w-14 rounded" />
            </div>
          </div>

          {/* Nav */}
          <div className="space-y-2">
            <Skeleton className="mx-3 h-2 w-10 rounded" />
            <div className="space-y-1">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-3 w-28 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer: profile */}
        <div className="flex items-center gap-3 p-2">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28 rounded" />
            <Skeleton className="h-2 w-16 rounded" />
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-30 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3 md:px-8 md:py-4 flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="hidden h-2.5 w-56 rounded sm:block" />
          </div>
        </header>

        {/* Content — a neutral header + toolbar + list that suits any route. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 w-full space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-6 w-48 rounded" />
              <Skeleton className="h-3 w-72 max-w-full rounded" />
            </div>
            <Skeleton className="h-9 w-28 rounded-xl shrink-0" />
          </div>

          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-full max-w-sm rounded-xl" />
            <Skeleton className="h-9 w-24 rounded-xl shrink-0" />
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="h-10 w-10 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-40 max-w-full rounded" />
                  <Skeleton className="h-2.5 w-56 max-w-full rounded" />
                </div>
                <Skeleton className="hidden h-6 w-16 rounded-full sm:block" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
