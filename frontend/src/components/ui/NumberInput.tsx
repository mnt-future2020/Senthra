"use client";

import * as React from "react";

type NumberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

// A native <input type="number"> still accepts "e"/"E" (scientific notation), "+"
// and "-", which then sit in the field as an invalid value the parser reads as
// empty/NaN. This wrapper blocks those characters on both keydown and paste so only
// digits and an optional decimal point get in. Negatives are allowed only when the
// caller sets a negative `min`. Every other input prop passes straight through, so
// this is a drop-in replacement for `<input type="number" … />`.
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput({ onKeyDown, onPaste, inputMode, step, ...props }, ref) {
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
      />
    );
  },
);
