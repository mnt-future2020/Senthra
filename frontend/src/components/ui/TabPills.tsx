"use client";

import * as React from "react";

/**
 * The pill switcher a module panel uses to move between its own tabs — Users / Roles / Departments /
 * Job titles, Customers / Categories, Suppliers / Types, and so on.
 *
 * Five panels carried this exact markup inline, byte for byte: the same rounded rail, the same
 * accent-filled active pill, the same icon-plus-label button. Nobody had a reason for five copies;
 * they simply grew one at a time. A change to how a selected tab looks now happens once.
 *
 * The caller still owns which tabs exist and which are permitted — this only draws them. It renders
 * nothing for a single tab, because a switcher with one option is a label pretending to be a control.
 */
export interface TabPillItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: React.ElementType;
}

export function TabPills<Id extends string>({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: readonly TabPillItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Names the group for screen readers, e.g. "Users & Roles sections". */
  ariaLabel?: string;
}) {
  if (tabs.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1"
    >
      {tabs.map((t) => {
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(t.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all ${
              selected
                ? "bg-[var(--accent)] text-white shadow-xs"
                : "text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
