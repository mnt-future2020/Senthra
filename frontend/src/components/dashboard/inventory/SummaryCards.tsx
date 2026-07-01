"use client";

import * as React from "react";
import { Boxes, TriangleAlert, Truck, Users } from "lucide-react";

import * as svc from "@/services/stockPosition.service";
import { useAuth } from "@/hooks/useAuth";
import type { InventorySummary } from "@/types/stock-position";

type Lens = "company" | "customer" | "engineer" | "damaged";

interface SummaryCardsProps {
  active: string;
  onSelect: (l: Lens) => void;
}

export function SummaryCards({ active, onSelect }: SummaryCardsProps) {
  const { can } = useAuth();
  const [s, setS] = React.useState<InventorySummary | null>(null);

  React.useEffect(() => {
    let active2 = true;
    svc
      .getSummary()
      .then((r) => active2 && setS(r))
      .catch(() => active2 && setS(null));
    return () => {
      active2 = false;
    };
  }, []);

  if (!s) {
    return (
      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[88px] animate-pulse rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]"
          />
        ))}
      </div>
    );
  }

  const cards: { key: Lens; label: string; icon: React.ElementType; value: string; sub?: string }[] = [
    {
      key: "company",
      label: "IRM — in warehouse",
      icon: Boxes,
      value: s.company.units.toLocaleString(),
      sub: can("inventory.view") ? `£${s.company.value.toLocaleString()} value` : undefined,
    },
    {
      key: "customer",
      label: "Customer consignment",
      icon: Users,
      value: s.customer.units.toLocaleString(),
      sub: `${s.customer.customersHolding} ${s.customer.customersHolding === 1 ? "customer" : "customers"}`,
    },
    {
      key: "engineer",
      label: "With engineers",
      icon: Truck,
      value: s.engineer.units.toLocaleString(),
      sub: [
        `${s.engineer.engineersHolding} ${s.engineer.engineersHolding === 1 ? "engineer" : "engineers"}`,
        s.engineer.overdue ? `${s.engineer.overdue} overdue` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    {
      key: "damaged",
      label: "Damaged",
      icon: TriangleAlert,
      value: s.damaged.units.toLocaleString(),
      sub: s.damaged.thisMonthUnits ? `+${s.damaged.thisMonthUnits} this month` : undefined,
    },
  ];

  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map(({ key, label, icon: Icon, value, sub }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`group rounded-2xl border bg-[var(--surface)] p-4 text-left shadow-xs transition-all hover:border-[var(--accent)] ${
              isActive ? "border-[var(--accent)] ring-1 ring-[var(--accent)]" : "border-[var(--border)]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</span>
              <Icon
                className={`h-4 w-4 ${isActive ? "text-[var(--accent)]" : "text-[var(--faint)] group-hover:text-[var(--accent)]"}`}
              />
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-2xl font-extrabold text-[var(--ink)]">{value}</span>
              <span className="text-[11px] text-[var(--faint)]">units</span>
            </div>
            <div className="mt-0.5 h-4 text-[11px] text-[var(--muted)]">{sub ?? ""}</div>
          </button>
        );
      })}
    </div>
  );
}
