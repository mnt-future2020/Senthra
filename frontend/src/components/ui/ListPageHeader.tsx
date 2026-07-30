"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { usePersistedCollapse } from "@/hooks/usePersistedCollapse";

// Reusable header for standalone MODULE / LIST pages (Jobs, Purchase Orders, Customers, Suppliers,
// Inventory Hub, Audit Log…) — the title + subtitle card that every list screen had copy-pasted with
// identical markup. This is the LIST archetype: a static page identity. Distinct from DetailHeader
// (one entity, collapsible) and WorkspaceToolbar (a tab inside an entity, no title). The optional
// `right` slot holds whatever sits opposite the title on the SAME row — a tab-pill switcher
// (master-data panels) or a primary action ("New job").
//
// COLLAPSING (opt-in, via `collapsible`). This card used to be documented as "never collapsible — a
// list page always shows what it is", and for a page that SCROLLS NATURALLY that holds: the header
// scrolls away by itself, so it costs nothing after the first scroll. It does NOT hold for a page
// laid out full-height with an internally-scrolling table (the Inventory Hub), where the header is
// pinned and costs its full height on every screen, forever. That is exactly the case DetailHeader's
// collapse was built for, so pages in that shape may opt in with a storage key. Everything else keeps
// the static behaviour by leaving the prop off.
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
  /**
   * Opt in to a persisted collapse toggle by passing a storage key. Key it per PAGE KIND, not per
   * record ("inventoryHub"), matching usePersistedCollapse's convention. Omit for the default
   * static header.
   */
  collapsible?: string;
}

export function ListPageHeader({ title, subtitle, right, collapsible }: ListPageHeaderProps) {
  // Hooks can't be conditional, so this runs either way; with no key it's an unread piece of state.
  // The `listPageHeader:` prefix namespaces it away from DetailHeader's stored keys.
  const [isCollapsed, toggle] = usePersistedCollapse(`listPageHeader:${collapsible ?? ""}`);
  const collapsed = Boolean(collapsible) && isCollapsed;

  return (
    <div
      className={`flex shrink-0 flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] shadow-xs ${collapsed ? "px-4 py-2.5" : "p-5"} ${right ? "sm:flex-row sm:items-center sm:justify-between" : ""}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand header" : "Collapse header"}
            aria-expanded={!collapsed}
            className="shrink-0 rounded p-0.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        )}
        <div className="min-w-0 space-y-0.5">
          {/* Collapsed drops to the same compact size DetailHeader uses, and the subtitle goes —
              it's page description, not state, so it has nothing to say once you've chosen to hide it. */}
          <h2 className={`font-extrabold tracking-tight text-[var(--ink)] ${collapsed ? "text-base" : "text-xl"}`}>{title}</h2>
          {subtitle && !collapsed && <p className="text-xs text-[var(--muted)]">{subtitle}</p>}
        </div>
      </div>
      {/* Allowed to wrap for the same reason as DetailHeader's actions: a wide slot (tab-pills plus a
          long-labelled action) must flow onto a second line rather than overflow the card. */}
      {right && <div className="flex flex-wrap items-center justify-end gap-2">{right}</div>}
    </div>
  );
}
