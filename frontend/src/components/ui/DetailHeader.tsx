"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { usePersistedCollapse } from "@/hooks/usePersistedCollapse";

// Reusable detail-page header card — the title + status badges + meta line + right-aligned actions
// block that every detail page (Warehouse, Supplier, IRM item, Inventory, GRN…) had copy-pasted with
// identical markup. Centralising it removes that duplication and adds one shared capability: the whole
// card can COLLAPSE to a single compact line, reclaiming vertical space so the content/tab below shows
// more rows before scrolling. Collapsed state persists per `storageKey` (localStorage) so a user's
// choice sticks across visits and across sibling detail pages of the same kind.
//
//   <DetailHeader
//     storageKey="warehouse-detail"
//     title={w.name}
//     badges={<><StatusBadge .../>{w.isDefault && <DefaultPill/>}</>}
//     meta={<><span className="font-mono">{w.code}</span> · <span>{w.type?.name}</span></>}
//     actions={canEdit && <>…buttons…</>}
//   />

export interface DetailHeaderProps {
  title: React.ReactNode;
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  // Optional logo/avatar shown left of the title (Customer is the one record kind that carries one).
  // It receives the current collapsed state so it can shrink with the rest of the header instead of
  // pinning the card to its expanded height — the whole point of collapsing.
  avatar?: (collapsed: boolean) => React.ReactNode;
  // Distinct key per detail-page KIND (not per record) so all warehouses share one remembered state.
  storageKey: string;
}

export function DetailHeader({ title, badges, meta, actions, avatar, storageKey }: DetailHeaderProps) {
  // The `detailHeader:` prefix is part of the STORED key and must stay — dropping it when this moved
  // to the shared hook would have silently reset every user's remembered choice.
  const [isCollapsed, toggle] = usePersistedCollapse(`detailHeader:${storageKey}`);

  return (
    <div
      className={`flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] shadow-xs sm:flex-row sm:items-start sm:justify-between ${isCollapsed ? "px-4 py-2.5" : "p-5"}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={isCollapsed ? "Expand header" : "Collapse header"}
          aria-expanded={!isCollapsed}
          className="shrink-0 rounded p-0.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
        </button>
        {avatar && <div className="shrink-0">{avatar(isCollapsed)}</div>}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className={`truncate font-extrabold tracking-tight text-[var(--ink)] ${isCollapsed ? "text-base" : "text-xl"}`}>{title}</h1>
            {badges}
          </div>
          {meta && !isCollapsed && <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">{meta}</p>}
        </div>
      </div>
      {/* Actions MUST be allowed to wrap (never `shrink-0` + nowrap): an action-heavy header — e.g. a
          `sent` purchase order rendering "Send to supplier" / "Record supplier acceptance" / "Update
          delivery date" — otherwise overflows the card on narrow viewports instead of flowing onto a
          second line. `justify-end` keeps them right-aligned once wrapped. */}
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
