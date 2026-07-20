"use client";

import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";

import type { PermissionGroup } from "@/types/role";
import { inputCls } from "@/components/ui/styles";

// Shared permission catalog renderer for the role editor and the read-only role
// page. Renders the catalog as collapsible category sections, with search, granted
// badges, per-category bulk actions, per-row all/none, and visual nesting of child
// groups (e.g. the customer sub-entities) under their parent.
//
// State model: the parent owns the granted-keys array. Pass `onChange` to make the
// matrix interactive (it returns the full next array, with all view-implied logic
// already applied); omit it for a read-only view.

interface PermissionMatrixProps {
  groups: PermissionGroup[];
  categories: string[]; // ordered category names (drives section order)
  granted: string[]; // currently-granted permission keys
  onChange?: (next: string[]) => void; // omit → read-only
}

const FALLBACK_CATEGORY = "General";

// "View" action key of a group, if present.
const viewKeyOf = (g: PermissionGroup): string | undefined =>
  g.permissions.find((p) => p.action === "View")?.key;

// Every permission key in a group.
const keysOf = (g: PermissionGroup): string[] => g.permissions.map((p) => p.key);

// --- Permission-set math (kept here so single + bulk toggles stay coherent) ---

// Toggle one action: enabling any action also enables the group's View; disabling
// View clears the whole group (you can't act on what you can't see).
function toggleOne(granted: string[], group: PermissionGroup, key: string): string[] {
  const set = new Set(granted);
  const viewKey = viewKeyOf(group);
  if (!set.has(key)) {
    set.add(key);
    if (viewKey) set.add(viewKey);
    return [...set];
  }
  if (viewKey && key === viewKey) {
    for (const k of keysOf(group)) set.delete(k);
    return [...set];
  }
  set.delete(key);
  return [...set];
}

// Grant or clear every action in a single group (the row "All / None" toggle).
function setGroup(granted: string[], group: PermissionGroup, grant: boolean): string[] {
  const set = new Set(granted);
  for (const k of keysOf(group)) {
    if (grant) set.add(k);
    else set.delete(k);
  }
  return [...set];
}

// Grant just the View of each group in the list (category "Grant view").
function grantViews(granted: string[], groups: PermissionGroup[]): string[] {
  const set = new Set(granted);
  for (const g of groups) {
    const v = viewKeyOf(g);
    if (v) set.add(v);
  }
  return [...set];
}

// Clear every action of every group in the list (category "Clear").
function clearGroups(granted: string[], groups: PermissionGroup[]): string[] {
  const set = new Set(granted);
  for (const g of groups) for (const k of keysOf(g)) set.delete(k);
  return [...set];
}

// min-h-[36px] on pointer-coarse devices keeps chips comfortably tappable without
// inflating the dense desktop layout (WCAG 2.5.5 target size).
const chipBase =
  "inline-flex items-center rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-all [@media(pointer:coarse)]:min-h-[36px] [@media(pointer:coarse)]:px-3";
const chipOn = "border-[var(--accent)] bg-[var(--accent-10)] text-[var(--accent)]";
const chipOffEditable =
  "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-2)] hover:text-[var(--ink)]";
const chipOffReadonly = "border-[var(--border)] text-[var(--faint)] opacity-60";

export function PermissionMatrix({ groups, categories, granted, onChange }: PermissionMatrixProps) {
  const readOnly = !onChange;
  const grantedSet = React.useMemo(() => new Set(granted), [granted]);
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  // Bucket the catalog by category, preserving array order within each (so a parent
  // group stays directly above its children).
  const sections = React.useMemo(() => {
    const byCat = new Map<string, PermissionGroup[]>();
    for (const g of groups) {
      const cat = g.category || FALLBACK_CATEGORY;
      const list = byCat.get(cat) ?? [];
      list.push(g);
      byCat.set(cat, list);
    }
    const ordered: string[] = [];
    for (const c of categories) if (byCat.has(c)) ordered.push(c);
    for (const c of byCat.keys()) if (!ordered.includes(c)) ordered.push(c);
    return ordered.map((cat) => ({ cat, groups: byCat.get(cat)! }));
  }, [groups, categories]);

  // Smart initial collapse: a category opens if it holds any granted permission.
  // Computed once when the catalog first loads, then fully user-controlled.
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const initialized = React.useRef(false);
  React.useEffect(() => {
    if (initialized.current || groups.length === 0) return;
    initialized.current = true;
    const init: Record<string, boolean> = {};
    for (const { cat, groups: gs } of sections) {
      init[cat] = gs.some((g) => keysOf(g).some((k) => grantedSet.has(k)));
    }
    setOpen(init);
  }, [sections, groups.length, grantedSet]);

  const matches = React.useCallback(
    (g: PermissionGroup): boolean => {
      if (!q) return true;
      return (
        g.label.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q) ||
        g.category.toLowerCase().includes(q) ||
        g.permissions.some((p) => p.action.toLowerCase().includes(q))
      );
    },
    [q],
  );

  const grantedCountOf = (gs: PermissionGroup[]): number =>
    gs.reduce((n, g) => n + keysOf(g).filter((k) => grantedSet.has(k)).length, 0);

  const visibleSections = sections
    .map((s) => ({ ...s, groups: s.groups.filter(matches) }))
    .filter((s) => s.groups.length > 0);

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search permissions…"
          aria-label="Search permissions"
          className={`${inputCls} pl-9 pr-9`}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--faint)] transition-colors hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {visibleSections.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--faint)]">
          No permissions match “{query}”.
        </p>
      ) : (
        visibleSections.map(({ cat, groups: gs }) => {
          const isOpen = q ? true : (open[cat] ?? false);
          const grantedCount = grantedCountOf(gs);
          return (
            <div key={cat} className="overflow-hidden rounded-xl border border-[var(--border)]">
              {/* Category header */}
              <div className="flex items-center gap-2 bg-[var(--surface-2)] px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [cat]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[var(--muted)] transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  />
                  <span className="truncate text-xs font-bold uppercase tracking-wider text-[var(--ink)]">
                    {cat}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--faint)]">
                    {gs.length} module{gs.length === 1 ? "" : "s"}
                  </span>
                  {grantedCount > 0 && (
                    <span className="shrink-0 rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                      {grantedCount} granted
                    </span>
                  )}
                </button>
                {!readOnly && isOpen && (
                  <div className="flex shrink-0 items-center gap-3 text-[11px] font-bold">
                    <button
                      type="button"
                      onClick={() => onChange!(grantViews(granted, gs))}
                      className="text-[var(--accent)] transition-opacity hover:opacity-70"
                    >
                      Grant view
                    </button>
                    {grantedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => onChange!(clearGroups(granted, gs))}
                        className="text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Module rows */}
              {isOpen && (
                <div className="divide-y divide-[var(--border-2)] border-t border-[var(--border)]">
                  {gs.map((group) => {
                    const isChild = Boolean(group.parent);
                    const allOn = keysOf(group).every((k) => grantedSet.has(k));
                    return (
                      <div
                        key={group.key}
                        className={`flex flex-col gap-2.5 py-3 pr-4 ${
                          isChild ? "pl-10" : "pl-4"
                        }`}
                      >
                        <div className="relative min-w-0">
                          {isChild && (
                            <span
                              aria-hidden
                              className="absolute -left-4 top-1.5 h-3 w-3 rounded-bl-md border-b border-l border-[var(--border-2)]"
                            />
                          )}
                          <p className="text-sm font-bold text-[var(--ink)]">{group.label}</p>
                          <p className="text-[11px] leading-snug text-[var(--muted)]">
                            {group.description}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {group.permissions.map((p) => {
                            const checked = grantedSet.has(p.key);
                            if (readOnly) {
                              return (
                                <span
                                  key={p.key}
                                  title={p.description}
                                  className={`${chipBase} ${checked ? chipOn : chipOffReadonly}`}
                                >
                                  {p.action}
                                </span>
                              );
                            }
                            return (
                              <button
                                type="button"
                                key={p.key}
                                onClick={() => onChange!(toggleOne(granted, group, p.key))}
                                title={p.description}
                                aria-pressed={checked}
                                className={`${chipBase} ${checked ? chipOn : chipOffEditable}`}
                              >
                                {p.action}
                              </button>
                            );
                          })}
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => onChange!(setGroup(granted, group, !allOn))}
                              title={allOn ? "Clear this module" : "Grant all actions"}
                              className={`${chipBase} border-dashed ${
                                allOn
                                  ? "border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                                  : "border-[var(--border-2)] text-[var(--faint)] hover:text-[var(--ink)]"
                              }`}
                            >
                              {allOn ? "None" : "All"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
