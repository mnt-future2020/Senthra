"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { principalCan } from "@/lib/auth";
import { dropdownRadius, dropdownSurfaceCls } from "@/components/ui/styles";

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
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const actions = ACTIONS.filter((a) => principalCan(principal, a.perm));

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
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
      <div className="relative sm:hidden" ref={wrapRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white"
        >
          <Plus className="h-4 w-4" />
          New
        </button>
        {open && (
          <div
            role="menu"
            className={`absolute right-0 z-30 mt-1 w-44 overflow-hidden ${dropdownSurfaceCls}`}
            style={dropdownRadius}
          >
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
        )}
      </div>
    </>
  );
}
