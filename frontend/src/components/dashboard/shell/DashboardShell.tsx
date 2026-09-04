"use client";

import * as React from "react";

import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { PageActionsSlotContext } from "@/components/ui/PageActions";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Toasts } from "./Toasts";
import { useScrollLock } from "@/hooks/useScrollLock";

// App frame shared by every /dashboard/* route: sidebar + topbar + the route
// content + global toasts.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  // The top bar's page-actions slot. Set by a CALLBACK REF (not an effect), so it lands during the
  // same commit that creates the element and the page's controls appear before the first paint.
  const [actionSlot, setActionSlot] = React.useState<HTMLElement | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = React.useState(false);

  // The drawer is an overlay over a document that now scrolls below `sm` — measured: with the drawer
  // open at 375x667 and focus inside it, End moved the page behind from y=300 to y=558. See
  // scrollLock.ts.
  useScrollLock(isMobileSidebarOpen);

  // One button, two jobs, decided by width — as before. The only change is that the DRAWER half no
  // longer fires on a desktop click.
  //
  // `setIsMobileSidebarOpen(true)` used to run unconditionally, and above `md` that was invisible:
  // the sidebar is `md:translate-x-0` whatever `mobileOpen` says, and the scrim is `md:hidden`. So
  // the flag simply latched on at the first desktop toggle and never cleared. Harmless while it drove
  // nothing — but it now also drives the scroll lock, and a latched flag would mean a desktop user who
  // collapsed the sidebar and then narrowed the window found a page that would not scroll, with the
  // drawer sitting open over it. Making the state mean what its name says is cheaper than teaching the
  // lock to distrust it.
  const handleToggleSidebar = () => {
    if (window.innerWidth >= 768) {
      setIsSidebarCollapsed((v) => !v);
      return;
    }
    setIsMobileSidebarOpen(true);
  };

  return (
    <NavigationGuardProvider>
      {/* ── The workspace is viewport-locked from `sm` UP, and a normal scrolling page below it ──
          The dashboard is a fixed-height workspace: the frame is exactly the viewport, and the list
          inside a page scrolls within its own card under a sticky header. On a desktop that is the
          right shape. On a phone it was not, because the toolbar changes shape at the SAME
          breakpoint: below `sm` it stacks into a column 268-418px tall, and the list had to live in
          whatever was left of a screen that is often only ~553px high.

          Measured in Chrome against the real compiled CSS, at 375x553 (an iPhone SE in Safari) the
          list area came to ZERO rows on Jobs, Purchase Orders and Goods Receipts, and one row on
          Suppliers, Warehouses, IRM Items, Users and Portal Jobs. The page itself could not scroll —
          this element's `overflow-hidden` saw to that — so the only way to reach record two was to
          scroll inside a container a few pixels tall, under a "Total: N" footer that was using more
          of the screen than the records were.

          `sm` is the breakpoint because it is where the toolbar's own height cliff is, and the
          measurements say so: at 639px the toolbar is 268-418px tall and the list shows 5-9 rows; at
          640px the toolbar becomes a row 72-172px tall and the list shows 10-13. Above the cliff the
          fixed-height workspace is doing its job and is left completely alone. `md` was the obvious
          guess and it is wrong — it would throw the workspace away across 640-767px, where it is
          working fine.

          Below `sm` the page becomes an ordinary document: the frame grows with its content, the
          browser scrolls it, and the whole list is reachable by scrolling the page. Verified across
          22 list modules — no collapsed panels, no nested-scroll traps, no horizontal page scroll,
          and byte-identical geometry at every width from 640px up.

          ── What this costs, stated plainly: STICKY TABLE HEADERS DO NOT STICK BELOW `sm` ──

          About twenty list tables put a `sticky top-0` thead inside a `min-h-0 flex-1 overflow-auto`
          scroller. Above `sm` that scroller is the list's viewport and the header pins to it, which
          is the whole point. Below `sm` the scroller is content-height, so there is no vertical
          scrolling INSIDE it and the header travels with the page instead. Measured on Users at
          375x667: scrolling the document 269px moved the thead 269px — it does not pin.

          It cannot be fixed without giving up something bigger, and the reason is CSS, not effort.
          `position: sticky` resolves against the nearest scroll-container ancestor. These tables all
          need to scroll HORIZONTALLY on a phone — measured wrapper 335px against a table of 645px on
          Roles (the simplest list in the app, no minWidth floor at all), 582px Users, 1148px
          Warehouses, 1180px Inventory, 1216px Jobs, 1366px Purchase Orders. Any element that scrolls
          in x is a scroll container in BOTH axes: `overflow-x: auto` computes `overflow-y: visible`
          to `auto` (the same fact already written up in ScheduledReportsView). So the wrapper always
          captures the sticky, and the document can never be what the header pins to. There is no
          combination — `clip`, a sticky `th`, moving the scroller up or down a level — that gives
          horizontal scrolling and document-scoped vertical sticky on one subtree.

          The alternative is to hand the wrapper a bounded height again (`max-h-[70vh]` or similar) so
          it scrolls vertically and the header pins. That is the pre-`sm` architecture wearing a
          larger number: a nested vertical scroller on a phone, the paginator only reachable after
          exhausting it, and the tiny-table failure one short viewport away. Not worth a header.

          So the behaviour below `sm` is deliberate and uniform — the header scrolls away with the
          rest of the card — and it is left as `sticky` rather than rewritten to `sm:sticky` across
          twenty files, because the class is already inert there and the edit would be pure churn.
          Above `sm` nothing about any of this changes. */}
      <div
        className="flex bg-[var(--bg)] text-[var(--ink)] min-h-screen sm:h-screen sm:overflow-hidden tweak-transition"
        id="app"
      >
        <Sidebar
          collapsed={isSidebarCollapsed}
          mobileOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        {isMobileSidebarOpen && (
          <div
            onClick={() => setIsMobileSidebarOpen(false)}
            className="fixed inset-0 bg-black/50 z-30 md:hidden"
          />
        )}

        <main className="flex-1 flex flex-col min-w-0 transition-all duration-300">
          <Topbar onToggleSidebar={handleToggleSidebar} actionSlotRef={setActionSlot} />
          <PageActionsSlotContext value={actionSlot}>
            {/* Becomes the scrolling pane only once the workspace is viewport-locked. Below `sm` it
                is a plain block that grows with the page — `flex-1 min-h-0` there would give a
                content-height column a flex-basis of 0 and collapse the page to nothing. */}
            <div className="w-full space-y-6 p-4 md:p-8 sm:flex-1 sm:min-h-0 sm:overflow-y-auto">
              {children}
            </div>
          </PageActionsSlotContext>
        </main>

        <Toasts />
      </div>
    </NavigationGuardProvider>
  );
}
