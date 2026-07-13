"use client";

import Link from "next/link";
import { Plus } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { principalCan } from "@/lib/auth";

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
  const actions = ACTIONS.filter((a) => principalCan(principal, a.perm));
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

      {/* Mobile: a single "+ New" dropdown (no JS state needed) */}
      <details className="relative sm:hidden">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white">
          <Plus className="h-4 w-4" />
          New
        </summary>
        <div className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-md">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="block px-3 py-2 text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
            >
              {a.label}
            </Link>
          ))}
        </div>
      </details>
    </>
  );
}
