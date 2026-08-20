"use client";

import * as React from "react";

type NumberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /**
   * Hold what is typed inside `min`/`max` instead of accepting it and flagging it afterwards.
   *
   * Opt-in, because it is only right where the bound is a real quantity known at the keystroke — how
   * many arrived, how many of those were damaged. A price, a reorder level or an SMTP port has no
   * ceiling worth silently enforcing, and a form that rewrites what you typed for no visible reason
   * is worse than one that explains itself.
   */
  clamp?: boolean;
};

/**
 * The value a bounded field should hold after this keystroke.
 *
 * `max` on a native <input type="number"> binds the SPINNER and native validation and does nothing
 * about typing, so a "of those, damaged" box against one ordered unit accepted 534345 and answered
 * with a red line underneath. Where the ceiling is knowable as the key is pressed, the field should
 * simply not be able to hold a wrong answer.
 *
 * Empty stays empty — clamping "" to the minimum would make the box impossible to clear, since every
 * backspace to empty would spring straight back to 1. Anything unparseable is left for the submit
 * guard: rewriting a half-typed value mid-keystroke fights the user.
 */
export function clampNumberInput(raw: string, min?: number, max?: number): string {
  if (raw.trim() === "") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  const held = Math.min(Math.max(n, lo), hi);
  return held === n ? raw : String(held);
}

// A native <input type="number"> still accepts "e"/"E" (scientific notation), "+"
// and "-", which then sit in the field as an invalid value the parser reads as
// empty/NaN. This wrapper blocks those characters on both keydown and paste so only
// digits and an optional decimal point get in. Negatives are allowed only when the
// caller sets a negative `min`. Every other input prop passes straight through, so
// this is a drop-in replacement for `<input type="number" … />`.
// `min`/`max` arrive as string | number | undefined off InputHTMLAttributes. An absent bound must
// stay absent — `max={receiveNum || undefined}` is a real call site, and reading that as 0 would pin
// the field shut while the quantity above it is still blank.
const num = (v: string | number | readonly string[] | undefined): number | undefined =>
  v === undefined || v === "" ? undefined : Number(v);

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput({ onKeyDown, onPaste, onChange, inputMode, step, clamp, ...props }, ref) {
    const allowNegative = props.min !== undefined && Number(props.min) < 0;
    const blocked = allowNegative ? /[eE+]/ : /[eE+-]/;
    // Decimal keypad when the step permits fractions; numeric otherwise.
    const resolvedMode = inputMode ?? (step !== undefined && String(step) !== "1" ? "decimal" : "numeric");

    return (
      <input
        {...props}
        ref={ref}
        type="number"
        step={step}
        inputMode={resolvedMode}
        onKeyDown={(e) => {
          // Only intercept single-character keys (lets Backspace, Tab, Arrows, and
          // Ctrl/Cmd shortcuts like copy/paste/select-all through untouched).
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && blocked.test(e.key)) {
            e.preventDefault();
          }
          onKeyDown?.(e);
        }}
        onPaste={(e) => {
          if (blocked.test(e.clipboardData.getData("text"))) e.preventDefault();
          onPaste?.(e);
        }}
        onChange={(e) => {
          // Rewrites the field's own value BEFORE handing the event on, so the caller's
          // `onChange={(e) => setX(e.target.value)}` stores the held value — no call site changes.
          if (clamp) {
            const held = clampNumberInput(e.target.value, num(props.min), num(props.max));
            if (held !== e.target.value) e.target.value = held;
          }
          onChange?.(e);
        }}
      />
    );
  },
);
