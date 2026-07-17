"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { inputCls } from "@/components/ui/styles";

// Toolbar for an OPERATIONAL WORKSPACE TAB rendered inside an entity (e.g. a Warehouse tab). This is
// the WORKSPACE archetype: the tab inherits its identity from the parent entity header, so it starts
// DIRECTLY with search / filters / actions — no page title or description (that would just repeat the
// entity name). Distinct from ListPageHeader (a standalone module page has a title) and DetailHeader
// (one entity, collapsible).
//
// It's a pinned (`shrink-0`) single control row that wraps on small screens:
//   [ search ]  [ …filters ]                                   [ …actions ]
//
//   <WorkspaceToolbar
//     search={{ value, onChange, placeholder: "Search…", ariaLabel: "Search van requests" }}
//     filters={<><Select … /><Select … /></>}
//     actions={<button className={primaryBtn}>…</button>}
//   />
//
// `search`, `filters`, and `actions` are all optional — render only what a given tab needs.

export interface WorkspaceToolbarSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  /** Constrain the search input width on ≥sm (default true → `sm:max-w-xs`). */
  constrained?: boolean;
}

export interface WorkspaceToolbarProps {
  search?: WorkspaceToolbarSearch;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
}

export function WorkspaceToolbar({ search, filters, actions }: WorkspaceToolbarProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {search && (
        <div className={`relative w-full ${search.constrained === false ? "" : "sm:max-w-xs"}`}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
            aria-label={search.ariaLabel}
            className={`${inputCls} pl-9`}
          />
        </div>
      )}
      {filters}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
