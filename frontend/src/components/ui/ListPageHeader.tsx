import * as React from "react";

// Reusable header for standalone MODULE / LIST pages (Jobs, Purchase Orders, Customers, Suppliers,
// Inventory Hub, Audit Log…) — the title + subtitle card that every list screen had copy-pasted with
// identical markup. This is the LIST archetype: a static page identity (never collapsible — a list page
// always shows what it is). Distinct from DetailHeader (one entity, collapsible) and WorkspaceToolbar
// (a tab inside an entity, no title). The optional `right` slot holds whatever sits opposite the title
// on the SAME row — a tab-pill switcher (master-data panels) or a primary action ("New job").
//
//   <ListPageHeader title="Jobs" subtitle="Create and assign installation jobs…" />
//   <ListPageHeader title="Suppliers" subtitle="…" right={<TabPills … />} />
//
// When `right` is present the card lays out as a two-column row (title left, slot right) that stacks on
// small screens; without it, it's just the stacked title + subtitle block.

export interface ListPageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}

export function ListPageHeader({ title, subtitle, right }: ListPageHeaderProps) {
  return (
    <div
      className={`flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs ${right ? "sm:flex-row sm:items-center sm:justify-between" : ""}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{title}</h2>
        {subtitle && <p className="text-xs text-[var(--muted)]">{subtitle}</p>}
      </div>
      {/* Allowed to wrap for the same reason as DetailHeader's actions: a wide slot (tab-pills plus a
          long-labelled action) must flow onto a second line rather than overflow the card. */}
      {right && <div className="flex flex-wrap items-center justify-end gap-2">{right}</div>}
    </div>
  );
}
