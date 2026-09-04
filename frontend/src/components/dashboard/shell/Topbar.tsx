"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { resolvePageTitle } from "@/lib/pageTitle";

// This is the only place a dashboard page states what it is: the per-page title card each list
// screen used to render underneath is gone, because saying it twice cost ~110px of a laptop screen
// before any content appeared. Titles live in lib/pageTitle.ts with a test tying them to the nav.
export function Topbar({
  onToggleSidebar,
  actionSlotRef,
}: {
  onToggleSidebar: () => void;
  /** Callback ref for the page-actions slot — see PageActions. */
  actionSlotRef: (el: HTMLDivElement | null) => void;
}) {
  const { principal } = useAuth();
  const pathname = usePathname();

  const title = resolvePageTitle(pathname);

  return (
    // Wraps rather than overflows: a four-pill switcher next to a long page name has nowhere to go on
    // a phone, so it drops to a second line inside the header instead of pushing the title off-screen.
    <header className="sticky top-0 z-30 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3 md:px-8 md:py-4 flex flex-wrap items-center justify-between gap-3 backdrop-blur-md bg-opacity-95">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] cursor-pointer"
          title="Expand/Collapse panel"
        >
          <Menu className="w-5 h-5 stroke-2" />
        </button>
        <div className="leading-tight">
          <h1 className="font-extrabold text-lg md:text-xl tracking-tight text-[var(--ink)]">
            {title}
          </h1>
          <p className="text-xs text-[var(--muted)] hidden sm:block">
            {principal?.email} &middot;{" "}
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      {/* Portal target for the current page's tabs / actions. `empty:hidden` keeps it from claiming
          a share of the header's gap on a page that has none.

          `min-w-0` is load-bearing, not tidying. A flex item's automatic minimum size is the
          min-content size of what's inside it, so without this the slot refused to go narrower than
          the tab rail's widest possible layout (441px for the four Users & Roles pills) — on a 360px
          phone it simply stuck out past the header, and `#app`'s `overflow-hidden` clipped the far
          end with no scrollbar to say so. The rail's own horizontal scrolling can only help once its
          container is allowed to be narrower than its contents. */}
      <div ref={actionSlotRef} className="flex min-w-0 flex-wrap items-center justify-end gap-2 empty:hidden" />
    </header>
  );
}
