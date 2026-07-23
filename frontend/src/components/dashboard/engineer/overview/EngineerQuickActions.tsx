"use client";

import Link from "next/link";
import { ArrowRightLeft, Truck, Undo2, type LucideIcon } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";

// Quick actions — the engineer's create verbs (not nav duplicates of the sidebar), gated by permission.
// The whole section hides when no create action is available.
type Action = { label: string; href: string; perm: string; icon: LucideIcon };

const ACTIONS: Action[] = [
  { label: "Request field stock", href: "/dashboard/engineer/van-stock/new", perm: "engineer.van_stock.request", icon: Truck },
  { label: "Return stock", href: "/dashboard/engineer/van-stock/return", perm: "engineer.van_stock.request", icon: Undo2 },
  { label: "Request transfer", href: "/dashboard/engineer/transfers/new", perm: "engineer.transfer", icon: ArrowRightLeft },
];

export function EngineerQuickActions() {
  const { can } = useAuth();
  const actions = ACTIONS.filter((a) => can(a.perm));
  if (actions.length === 0) return null;
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">Quick actions</h2>
      <div className="grid gap-2">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <a.icon className="h-4 w-4" /> {a.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
