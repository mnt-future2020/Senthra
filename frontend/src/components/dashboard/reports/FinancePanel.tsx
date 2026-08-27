"use client";

import { BarChart3 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { FinanceView } from "./FinanceView";

/**
 * The Finance module shell.
 *
 * FINANCE, not "Reports" — the two are separate concepts in the client's own flow (Finance → Finance
 * Reports → Report, versus Reports & Audit Trails → Custom Reports → Audit Trails). Naming this page
 * "Reports" made the sidebar claim that reporting IS finance, which is wrong the moment a stock or
 * engineer report exists. Custom Reports will live at /dashboard/reports, not here.
 *
 * The empty state below is defensive only: the sidebar no longer offers this page to anyone without
 * the finance right, so it is reached that way only by a direct URL.
 */
export function FinancePanel() {
  const { can } = useAuth();

  // Frontend gating is for NAVIGATION only. Every finance figure is refused server-side for an actor
  // without `reports.finance.view` — a 403, not a blanked payload — so this branch decides what to
  // render, never what is safe to expose.
  if (!can("reports.finance.view")) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <BarChart3 className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">Finance is not available to you</p>
        <p className="max-w-sm text-xs text-[var(--muted)]">
          Viewing spend, VAT and cost breakdowns needs the Finance View permission. Ask an administrator if you need it.
        </p>
      </div>
    );
  }

  return <FinanceView />;
}
