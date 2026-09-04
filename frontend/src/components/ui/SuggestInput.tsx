"use client";

import * as React from "react";

import { dropdownRadius, dropdownSurfaceCls, inputCls } from "./styles";
import { listScrollTop, suggestInputKey, suggestMatches } from "./suggestInputKeys";

/**
 * A FREE-TEXT input that offers suggestions — the themed replacement for `<input list>` + `<datalist>`.
 *
 * The distinction from `Select` / `CreatableSelect` is the whole reason this exists. Those two COMMIT
 * a choice: Select only accepts a value from its list, CreatableSelect commits an option ID and its
 * "Create …" row means "persist a new master-data record". Industry, country and project type are
 * none of those — they are plain strings stored on the record, where the list is a convenience and
 * typing something absent from it is the ordinary case, not a fallback. So the input stays a real
 * text input and the list only suggests.
 *
 * What it replaces is the POPUP. A native `<datalist>` is drawn by the browser, not the page: it
 * ignores the theme, the accent and the corner-radius setting, and Chrome, Firefox and Safari each
 * render it differently — the same complaint as a native `<select>`, and the reason both are gone
 * from this app.
 */
interface SuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  /** The offered strings. Filtered case-insensitively against what's typed. */
  suggestions: readonly string[];
  placeholder?: string;
  maxLength?: number;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}

export function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  maxLength,
  id,
  ariaLabel,
  disabled,
  invalid,
  describedBy,
  className,
}: SuggestInputProps) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listboxId = React.useId();

  const matches = React.useMemo(() => suggestMatches(suggestions, value), [suggestions, value]);

  const showList = open && !disabled && matches.length > 0;

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row on screen. Scrolls the LIST and nothing else — see `listScrollTop` for
  // why `scrollIntoView` is the wrong tool inside a dialog.
  React.useEffect(() => {
    if (!showList || active < 0) return;
    const list = listRef.current;
    const row = list?.children[active] as HTMLElement | undefined;
    if (!list || !row) return;
    list.scrollTop = listScrollTop(list.scrollTop, row.offsetTop, row.offsetHeight, list.clientHeight);
  }, [active, showList]);

  const commit = (s: string) => {
    onChange(s);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const r = suggestInputKey(e.key, { listVisible: showList, active, count: matches.length });
    if (r.preventDefault) e.preventDefault();
    if (r.stopPropagation) e.stopPropagation();
    switch (r.action.type) {
      case "open":
        setOpen(true);
        setActive(r.action.index);
        break;
      case "move":
        setActive(r.action.index);
        break;
      case "commit":
        commit(matches[r.action.index]);
        break;
      case "close":
        setOpen(false);
        setActive(-1);
        break;
    }
  };

  return (
    <div
      className="relative"
      ref={wrapRef}
      // Focus leaving the component closes the list. Without it, tabbing on from the field left the
      // popup hanging over the controls below it, where a click aimed at the next one landed on a
      // suggestion instead. React's onBlur is focusout, so this fires for the input and the rows
      // alike; a null relatedTarget (window blur, click on nothing) counts as leaving.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        disabled={disabled}
        className={`${inputCls} ${className ?? ""}`}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {showList && (
        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          // Same popup shell as `Select` — surface, border, shadow, and the radius token so it
          // follows Appearance → Corner radius like every other dropdown.
          className={`absolute z-50 mt-1 max-h-56 w-full overflow-y-auto p-1 ${dropdownSurfaceCls}`}
          style={dropdownRadius}
        >
          {matches.map((s, i) => (
            <button
              key={s}
              id={`${listboxId}-${i}`}
              type="button"
              role="option"
              aria-selected={s === value}
              // OUT of the tab sequence. A `role="option"` is reached with the arrow keys and named
              // to assistive tech through `aria-activedescendant`, never by tabbing — and `Modal`'s
              // focus trap re-queries `button:not([disabled])` on every Tab, so leaving these
              // tabbable spliced six suggestions into the dialog's tab order.
              tabIndex={-1}
              // The input keeps focus: blur before the click lands would close the list first.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(s)}
              className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                i === active ? "bg-[var(--surface-2)]" : ""
              } ${s === value ? "font-semibold text-[var(--accent)]" : "text-[var(--ink)]"}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
