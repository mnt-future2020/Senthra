"use client";

import * as React from "react";
import { Boxes, ChevronDown, TriangleAlert, Truck, Users } from "lucide-react";

import * as svc from "@/services/stockPosition.service";
import { useAuth } from "@/hooks/useAuth";
import { usePersistedCollapse } from "@/hooks/usePersistedCollapse";
import type { InventorySummary } from "@/types/stock-position";

type Lens = "company" | "customer" | "engineer" | "damaged";

interface SummaryCardsProps {
  active: string;
  onSelect: (l: Lens) => void;
}

export function SummaryCards({ active, onSelect }: SummaryCardsProps) {
  const { can } = useAuth();
  const [s, setS] = React.useState<InventorySummary | null>(null);
  // These four cards cost ~110px above a table that can run to hundreds of rows, and the lens tabs
  // directly beneath them already switch lens — so on a long worklist they are reference data, not
  // navigation you need on screen. Collapsing is remembered, so a user who works mostly in the table
  // gets their rows back on every visit. There is no page header above them to collapse any more:
  // the page name lives in the top bar, and the card that used to repeat it here is gone.
  const [collapsed, toggle] = usePersistedCollapse("inventoryHub:summary");

  // Failure is tracked SEPARATELY from "no data yet". They used to be the same state — the catch set
  // `s` back to null — so a failed summary rendered the loading skeleton, pulsing forever, with no
  // error, no retry and nothing in the console. Loading and broken looked identical, which is the
  // one thing a placeholder must never do: it sent us to the network tab and the database to answer
  // a question the screen should have answered.
  const [failed, setFailed] = React.useState(false);
  // Bumped by Retry. The effect keys off it, so a retry re-runs the same fetch rather than being a
  // second code path that could drift from it.
  const [attempt, setAttempt] = React.useState(0);
  // Set by the Retry CLICK, not by the effect: this project's lint enforces the React-Compiler rule
  // that forbids a synchronous setState in an effect body. An event handler is the right place for
  // it anyway — "the user asked again" is exactly what this flag means.
  const [retrying, setRetrying] = React.useState(false);

  React.useEffect(() => {
    let active2 = true;
    svc
      .getSummary()
      .then((r) => {
        if (!active2) return;
        setS(r);
        setFailed(false);
        setRetrying(false);
      })
      .catch(() => {
        if (!active2) return;
        // `s` is left ALONE. On a retry that fails, the figures already on screen are still the last
        // ones the server gave us — blanking them would trade real (if stale) numbers for nothing.
        setFailed(true);
        setRetrying(false);
      });
    return () => {
      active2 = false;
    };
  }, [attempt]);

  // One line, not four dead cards: the totals are reference data, and the table below them is the
  // page. Says which figures are missing, and offers the retry — the previous version offered
  // neither, so a transient failure needed a full page reload to clear.
  if (failed && !s) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs shadow-xs">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
        <span className="text-[var(--muted)]">Couldn&apos;t load the stock totals.</span>
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            setAttempt((n) => n + 1);
          }}
          className="font-bold text-[var(--accent)] hover:opacity-80 disabled:opacity-60"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
        {/* The lenses still switch — the tabs below do that, and the table itself is unaffected. */}
        <span className="text-[var(--faint)]">The list below is unaffected.</span>
      </div>
    );
  }

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

  const toggleBtn = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
    >
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      {collapsed ? "Show summary" : "Hide summary"}
    </button>
  );

  // Collapsed: ONE line that still carries every figure and stays clickable, so collapsing trades
  // detail (£ value, "27 overdue") for rows — it never costs you the totals or the lens switch.
  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-xs">
        {toggleBtn}
        {cards.map(({ key, label, icon: Icon, value }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)] ${
                isActive ? "text-[var(--accent)]" : "text-[var(--muted)]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="font-semibold">{label}</span>
              <span className="font-extrabold text-[var(--ink)]">{value}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <div className="flex justify-end">{toggleBtn}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
    </div>
  );
}
