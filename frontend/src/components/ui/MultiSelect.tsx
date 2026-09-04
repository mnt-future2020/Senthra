"use client";

import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { multiSelectKey } from "./multiSelectKeys";
import { dropdownRadius, dropdownSurfaceCls } from "./styles";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  describedBy?: string;
  emptyText?: string;
}

// Theme-aware multi-select: selected items render as removable chips inside the control, with a
// searchable, keyboard-navigable checkbox list in the popup. Returns a string[] of selected values.
// Keyboard: type to filter; ↑/↓ move the active option; Enter toggles it; Backspace on an empty query
// removes the last chip; Esc closes. Click-outside closes. Styled with the app's theme tokens.
export function MultiSelect({
  values,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  disabled,
  invalid,
  ariaLabel,
  describedBy,
  emptyText = "No options.",
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const selected = React.useMemo(() => new Set(values), [values]);
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Active option, clamped to the current filtered range at render (the list can shrink as the user
  // types). Reset to 0 on each query change in the input handler — no synchronous setState in effects.
  const active = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const toggle = (value: string) => {
    onChange(selected.has(value) ? values.filter((v) => v !== value) : [...values, value]);
  };

  const removeChip = (value: string) => onChange(values.filter((v) => v !== value));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const { action, preventDefault, stopPropagation } = multiSelectKey(e.key, {
      open,
      active,
      count: filtered.length,
      query,
      selectedCount: values.length,
    });
    if (preventDefault) e.preventDefault();
    // Escape while the menu is open stops HERE — see multiSelectKeys.ts. Without it <Modal>'s own
    // document-level Escape listener also fires and the dialog closes with the form still in it.
    //
    // Both calls are needed. React's synthetic stopPropagation halts React handlers above this one,
    // but the App Router hydrates onto `document`, so React's delegated listener and Modal's own
    // addEventListener sit on the SAME target — and same-target listeners are only stopped by
    // stopImmediatePropagation.
    if (stopPropagation) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    }

    switch (action.type) {
      case "open":
        openMenu();
        break;
      case "move":
        setActiveIndex(action.index);
        break;
      case "toggle":
        toggle(filtered[active]!.value);
        break;
      case "close":
        setOpen(false);
        break;
      case "removeLast":
        removeChip(values[values.length - 1]!);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Control */}
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-disabled={disabled || undefined}
        onClick={openMenu}
        className={`flex min-h-[2.6rem] w-full flex-wrap items-center gap-1.5 border bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none transition-all ${
          invalid ? "border-[var(--neg)]" : open ? "border-[var(--accent)]" : "border-[var(--border)]"
        } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-text"}`}
        style={{ borderRadius: "var(--radius)" }}
      >
        {values.map((v) => {
          const opt = byValue.get(v);
          return (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-10)] py-0.5 pl-2 pr-1 text-xs font-semibold text-[var(--accent)]"
            >
              {opt?.label ?? v}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${opt?.label ?? v}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(v);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--accent)]/20"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0); // reset highlight as the filtered list changes (event, not effect)
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={values.length === 0 ? placeholder : searchPlaceholder}
          className="min-w-[6rem] flex-1 bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
        />
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-[var(--faint)]" />
      </div>

      {/* Popup */}
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          className={`absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto p-1 outline-none [scrollbar-width:thin] ${dropdownSurfaceCls}`}
          style={dropdownRadius}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--faint)]">{query ? "No matches." : emptyText}</p>
          ) : (
            filtered.map((o, i) => {
              const isSelected = selected.has(o.value);
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => toggle(o.value)}
                  className={`flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                    i === active ? "bg-[var(--surface-2)]" : ""
                  } ${isSelected ? "font-semibold text-[var(--accent)]" : "text-[var(--ink)]"}`}
                >
                  <span className="truncate">{o.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
