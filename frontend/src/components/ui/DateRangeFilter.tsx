"use client";

import * as React from "react";

import { Select, type SelectOption } from "@/components/ui/Select";
import { toolbarDateCls } from "@/components/ui/styles";

// ── A From/To calendar-date filter for a list toolbar ──────────────────────────────────────────
//
// The pair was hand-rolled on every screen that had one (hire movements, hire extensions, the audit
// log, the goods queue's closed window, finance). Five copies is where a "To" date starts meaning
// something slightly different on one screen than another, and that difference is invisible: a range
// that quietly excludes its own last day looks like a short list, not like a bug.
//
// So the rules live here, once:
//
//  • The value is a CALENDAR DATE — "YYYY-MM-DD", exactly what `<input type="date">` emits and what
//    every date filter on the API accepts. No time, no timezone, no ISO datetime. Which day that is
//    for a timestamp column is decided by the SERVER, in the company timezone; the browser's clock
//    never gets a say, here or anywhere else in this app.
//  • Both ends are INCLUSIVE. The server widens "To" to the end of that day.
//  • Either end may be left empty — "everything before the 5th" and "everything since the 1st" are
//    both ordinary questions.
//
// Geometry matches `toolbarInputCls` / `<Select size="sm">` so a range sits level with the search box
// and the Selects beside it, and each input is wrapped in a `<label>` carrying the word From or To —
// a bare date input gives no clue which end of the range it is, and a placeholder can't fix that
// because a date input has no placeholder.

export interface DateRangeValue {
  from: string;
  to: string;
}

export interface DateRangeFilterProps {
  from: string;
  to: string;
  /** Called with the FULL next range, so a caller can patch both URL params in one write. */
  onChange: (next: DateRangeValue) => void;
  /**
   * Names the range for screen readers — "Due date", "Received". Rendered as the inputs'
   * accessible names ("Due date from" / "Due date to"); the visible From/To words stay short.
   */
  label: string;
  /** Show the label as visible text before the inputs. Off by default — toolbars are tight. */
  showLabel?: boolean;
  disabled?: boolean;
  /**
   * Optional quick-choice list rendered before the inputs (Today, This week, …).
   *
   * The value is a TOKEN the caller sends to the server as its own parameter — never a from/to pair
   * computed here. "Today" is a company-timezone question and only the server knows that answer;
   * resolving it from the browser's clock is how a laptop in another zone ends up disagreeing with
   * the badge that sent the user to the screen.
   */
  presets?: SelectOption[];
  presetValue?: string;
  onPresetChange?: (value: string) => void;
}

/** Is this range narrowing anything? Used by callers to feed a FilterPopover's active count. */
export function dateRangeActive(from: string, to: string): boolean {
  return Boolean(from || to);
}

const wrapCls = "flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]";

export function DateRangeFilter({
  from,
  to,
  onChange,
  label,
  showLabel = false,
  disabled,
  presets,
  presetValue = "",
  onPresetChange,
}: DateRangeFilterProps) {
  const lower = label.toLowerCase();
  return (
    <>
      {showLabel && (
        <span className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</span>
      )}
      {presets && onPresetChange && (
        <Select
          size="sm"
          value={presetValue}
          onChange={onPresetChange}
          options={presets}
          disabled={disabled}
          ariaLabel={`${label} quick range`}
        />
      )}
      <label className={wrapCls}>
        From
        <input
          type="date"
          value={from}
          // `max` stops the picker offering an inverted range in the first place. It is a UI courtesy,
          // not the guarantee — the server drops an unparseable or inverted range on its own, because
          // these values live in a URL somebody can edit or share.
          max={to || undefined}
          disabled={disabled}
          onChange={(e) => onChange({ from: e.target.value, to })}
          aria-label={`${lower} from`}
          className={`${toolbarDateCls} w-auto`}
        />
      </label>
      <label className={wrapCls}>
        To
        <input
          type="date"
          value={to}
          min={from || undefined}
          disabled={disabled}
          onChange={(e) => onChange({ from, to: e.target.value })}
          aria-label={`${lower} to`}
          className={`${toolbarDateCls} w-auto`}
        />
      </label>
    </>
  );
}
