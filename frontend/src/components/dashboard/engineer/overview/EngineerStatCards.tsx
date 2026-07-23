import Link from "next/link";
import { ArrowRightLeft, Boxes, Inbox, Truck, Users, Wrench, type LucideIcon } from "lucide-react";

import type { CardIcon, StatCardModel } from "./engineerDashboardModel";

// Reference-style stat card grid: tinted icon tile, big number, label + hint; the whole card is a link
// with a hover accent — matches the admin dashboard / reference design language on the shared tokens.
const ICONS: Record<CardIcon, LucideIcon> = { inbox: Inbox, wrench: Wrench, boxes: Boxes, arrowRightLeft: ArrowRightLeft, truck: Truck, users: Users };
const TONES = {
  neutral: "bg-[var(--surface-2)] text-[var(--muted)]",
  accent: "bg-[var(--accent-10)] text-[var(--accent)]",
  amber: "bg-amber-500/15 text-amber-600",
} as const;

export function EngineerStatCards({ cards }: { cards: StatCardModel[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => {
        const Icon = ICONS[c.iconKey];
        return (
          <Link
            key={c.key}
            href={c.href}
            className="group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs transition-all hover:border-[var(--accent)] hover:shadow-md"
          >
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl transition-transform group-hover:scale-105 ${TONES[c.tone]}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">{c.value}</p>
              <p className="mt-0.5 text-xs font-bold text-[var(--ink)]">{c.label}</p>
              <p className={`mt-2 border-t border-[var(--border-2)] pt-2 text-[11px] ${c.hintTone === "red" ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                {c.hint}
              </p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
