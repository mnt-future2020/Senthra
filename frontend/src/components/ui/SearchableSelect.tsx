"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { AnchoredPanel } from "./AnchoredPanel";
import { multiSelectKey } from "./multiSelectKeys";
import { initialIndex, nextEnabledIndex } from "./searchableSelectKeys";
import type { SelectOption } from "./Select";

// The searchable half of <Select> — same trigger, same value contract, plus a search box in the panel.
//
// It exists because a <select> answers "which of these?" and this control has to answer "where is
// Kansha?". Base UI's Select has type-ahead, but type-ahead is invisible: nothing on screen says you
// may type, so nobody does. The client asked for search on the engineer picker for exactly that
// reason, and every other picker over a list of PEOPLE, customers, suppliers or warehouses has the
// same problem the moment the list outgrows a screen.
//
// Built on AnchoredPanel like the app's other comboboxes (items, master data, departments), so it
// inherits their placement, their dismissal-when-the-trigger-scrolls-away, and their Tab handling
// rather than growing a fourth version of it. <Select> chooses between this and the plain Base UI
// select; call sites just pass `searchable`.

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  triggerCls: string;
  /** `size="sm"` — a toolbar filter pill rather than a full-width form field. */
  compact?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
  describedBy?: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  triggerCls,
  compact,
  disabled,
  invalid,
  required,
  id,
  ariaLabel,
  describedBy,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const optId = React.useId();

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Clamped at render, not corrected in an effect: the list shrinks as the user types, and a
  // setState in an effect is both a wasted render and a lint error (react-hooks/set-state-in-effect).
  const active = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  // Keep the highlighted row in view while arrowing through a list taller than the panel. An effect
  // is right here — it reads layout and scrolls, and writes no state.
  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    // Open ON the current value — see initialIndex. AnchoredPanel focuses the search box once it has
    // placed the panel, so there is no autoFocus here (a hidden element cannot take focus).
    setActiveIndex(initialIndex(options, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    // Focus goes back to the trigger, or it would fall to <body> and Tab would restart at the top of
    // the page — the same contract the app's other comboboxes keep.
    btnRef.current?.focus({ preventScroll: true });
  };

  const commit = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const { action, preventDefault, stopPropagation } = multiSelectKey(e.key, {
      open,
      active,
      count: filtered.length,
      query,
      selectedCount: 0, // no chips in a single select — `removeLast` can never be returned
    });
    if (preventDefault) e.preventDefault();
    // Escape stops HERE while the menu is open: <Modal> listens on `document`, and the App Router
    // hydrates React's delegated listener onto the same target, so only stopImmediatePropagation
    // keeps one press from also throwing away the half-filled form behind this control.
    if (stopPropagation) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    }

    switch (action.type) {
      case "open":
        openMenu();
        break;
      case "move":
        setActiveIndex(nextEnabledIndex(filtered, action.index, action.index > active ? 1 : -1));
        break;
      case "toggle": {
        const opt = filtered[active];
        if (opt) commit(opt);
        break;
      }
      case "close":
        close();
        break;
      default:
        break;
    }
  };

  return (
    <div>
      <button
        ref={btnRef}
        type="button"
        id={id}
        role="combobox"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={`${triggerCls} flex items-center justify-between gap-2 text-left`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
      </button>

      {/* `listId` names the LISTBOX inside, not the panel: that is what `aria-controls` on the
          trigger and on the search box should point at.

          A form field's panel matches its trigger's width. A toolbar pill's does NOT: "All engineers"
          is a 9rem button, and pinning the list to that width truncated the very labels the list
          exists to show ("All engine…"). Content width with a floor and a ceiling instead — measured
          by AnchoredPanel before it places the panel, so the room it needs is the room it asks for. */}
      <AnchoredPanel
        anchorRef={btnRef}
        open={open && !disabled}
        onDismiss={close}
        width={compact ? "content" : "anchor"}
        className={compact ? "min-w-[14rem] max-w-[22rem]" : undefined}
      >
        <div className="shrink-0 border-b border-[var(--border-2)] p-2">
          <input
            type="text"
            value={query}
            aria-label={`Search ${ariaLabel ?? "options"}`}
            aria-controls={listId}
            aria-activedescendant={filtered[active] ? `${optId}-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0); // the filtered list just changed under the highlight
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* No `scrollbar-width` here, deliberately. Chrome drops every `::-webkit-scrollbar` rule for
            an element the moment that property is set, so `thin` swapped the app's own 6px themed bar
            (globals.css) for Chrome's native 10px one — wider despite the name, and drawn LIGHT on the
            dark theme, because nothing in the app declares `color-scheme: dark`. Measured side by side
            on the purchase-request form against the item picker, which never set it. */}
        <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="min-h-0 max-h-64 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-[var(--muted)]">{query ? "No matches." : emptyText}</p>
          ) : (
            filtered.map((o, i) => (
              <div
                key={o.value}
                id={`${optId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active || undefined}
                onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                onClick={() => commit(o)}
                className={`flex items-center justify-between gap-2 px-3 py-2 text-sm text-[var(--ink)] ${
                  o.disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
                } ${i === active && !o.disabled ? "bg-[var(--surface-2)]" : ""} ${
                  o.value === value ? "font-semibold text-[var(--accent)]" : ""
                }`}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
              </div>
            ))
          )}
        </div>
      </AnchoredPanel>
    </div>
  );
}
