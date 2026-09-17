"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { principalCan } from "@/lib/auth";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";

// Quick Actions — permission-gated links into the owning modules' create routes. Desktop shows them
// as individual buttons; narrow viewports collapse them into a single "+ New" dropdown (the label ERP
// users recognize). Every target already has a dedicated /new route, so these are plain links.

type Action = { label: string; href: string; perm: string };

const ACTIONS: Action[] = [
  { label: "New PRF", href: "/dashboard/purchase-requests/new", perm: "purchase_requests.create" },
  { label: "New PO", href: "/dashboard/purchase-orders/new", perm: "purchase_orders.create" },
  { label: "New Job", href: "/dashboard/jobs/new", perm: "jobs.create" },
  { label: "Goods In", href: "/dashboard/goods-in/new", perm: "goods_in.create" },
];

export function QuickActions() {
  const { principal } = useAuth();
  const [open, setOpen] = React.useState(false);
  // The menu is placed against the trigger BUTTON; AnchoredPanel owns the click-outside.
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const actions = ACTIONS.filter((a) => principalCan(principal, a.perm));

  React.useEffect(() => {
    if (!open) return;
    // Escape only: the click-outside is AnchoredPanel's now.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // AFTER the hooks — an early return above them changes the hook count between renders.
  if (actions.length === 0) return null;

  return (
    <>
      {/* Desktop: individual buttons */}
      <div className="hidden items-center gap-2 sm:flex">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <Plus className="h-4 w-4" />
            {a.label}
          </Link>
        ))}
      </div>

      {/* Mobile: a single "+ New" dropdown.
          
          State-driven rather than a `<details>`, which is why this costs a hook. `<details>` owns its
          own open flag, and nothing here could close it: not clicking away, not Escape, and — the one
          that actually bit — not following a link. This bar lives in the dashboard shell, so a client
          navigation never unmounts it, and the menu stayed hanging open over the page you had just
          navigated to. */}
      <div className="sm:hidden">
        <button
          ref={btnRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white"
        >
          <Plus className="h-4 w-4" />
          New
        </button>
        {/* A MENU: its own width, pinned to the button's right edge, portalled and placed — see
            AnchoredPanel. As an `absolute` child it could be clipped by the page's scroll container
            and, being z-30, could paint over the sticky top bar. */}
        <AnchoredPanel
          anchorRef={btnRef}
          open={open}
          onDismiss={() => setOpen(false)}
          width="content"
          align="end"
          className="w-44"
          panelHeight={160}
        >
          {/* `min-h-0 flex-1 overflow-auto`, as every other AnchoredPanel list has: the panel is
              `overflow-hidden` and wears the room its side had as a max-height, so a list that
              cannot scroll inside that just loses its last rows. Measured on a 240px-tall window:
              the cap came out at 113px against 144px of content and "Goods In" was unreachable —
              and a fifth quick action would overflow the 160px cap on any screen at all. */}
          <div role="menu" className="min-h-0 flex-1 overflow-auto">
            {actions.map((a) => (
              <Link
                key={a.href}
                href={a.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
              >
                {a.label}
              </Link>
            ))}
          </div>
        </AnchoredPanel>
      </div>
    </>
  );
}
