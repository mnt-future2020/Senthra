"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as BaseSelect } from "@base-ui/react/select";

import { inputCls } from "./styles";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  // "default" = full-width input style (forms); "sm" = compact toolbar style (list filters).
  size?: "default" | "sm";
  id?: string;
  ariaLabel?: string;
  describedBy?: string;
  className?: string;
}

// Compact trigger styling for list-view filter toolbars (mirrors the old `selectCls`).
const smTriggerCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

// Theme-aware dropdown built on Base UI's Select primitive (already a project dep).
// Drop-in for a native <select>: pass value / onChange / options. Unlike a native
// select, the OPEN menu is fully styled with the app's theme tokens, so it follows
// light/dark, the brand accent, and the radius setting. Keyboard nav, type-ahead,
// focus management and collision-aware positioning come from the primitive.
// Empty string ("") is treated as "no selection" so it drops in where native selects
// used an empty placeholder <option>.
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  invalid,
  required,
  size = "default",
  id,
  ariaLabel,
  describedBy,
  className,
}: SelectProps) {
  const triggerBase = size === "sm" ? smTriggerCls : inputCls;
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onChange((v ?? "") as string)}
      disabled={disabled}
      required={required}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        className={`${triggerBase} flex items-center justify-between gap-2 text-left ${className ?? ""}`}
      >
        <BaseSelect.Value placeholder={placeholder} className="min-w-0 flex-1 overflow-hidden text-left">
          {(val) => {
            const found = options.find((o) => o.value === val);
            return found ? (
              <span className="block truncate text-[var(--ink)]">{found.label}</span>
            ) : (
              <span className="block truncate text-[var(--faint)]">{placeholder}</span>
            );
          }}
        </BaseSelect.Value>
        <BaseSelect.Icon className="shrink-0 text-[var(--faint)]">
          <ChevronDown className="h-4 w-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} align="start" alignItemWithTrigger={false} className="z-50 outline-none">
          <BaseSelect.Popup
            // Native scrollbar hidden; Base UI shows themed up/down chevrons at the
            // edges when there's more to scroll (it positions + auto-shows them).
            className="relative max-h-72 min-w-[var(--anchor-width)] overflow-y-auto border border-[var(--border)] bg-[var(--surface)] p-1 shadow-2xl outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ borderRadius: "var(--radius)" }}
          >
            <BaseSelect.ScrollUpArrow className="inset-x-0 z-10 flex h-6 items-center justify-center bg-[var(--surface)] text-[var(--muted)]">
              <ChevronUp className="h-4 w-4" />
            </BaseSelect.ScrollUpArrow>
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--surface-2)] data-[selected]:font-semibold data-[selected]:text-[var(--accent)]"
              >
                <BaseSelect.ItemText className="truncate">{o.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator className="shrink-0 text-[var(--accent)]">
                  <Check className="h-3.5 w-3.5" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
            <BaseSelect.ScrollDownArrow className="inset-x-0 z-10 flex h-6 items-center justify-center bg-[var(--surface)] text-[var(--muted)]">
              <ChevronDown className="h-4 w-4" />
            </BaseSelect.ScrollDownArrow>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
