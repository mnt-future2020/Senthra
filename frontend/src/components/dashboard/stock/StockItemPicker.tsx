"use client";

import * as React from "react";
import { Check, ChevronDown, PackagePlus, Plus } from "lucide-react";

import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import { inputCls } from "@/components/ui/styles";
import type { CustomerStockEntry, PortalStockEntry } from "@/types/customer";

// Only the five fields the grouping reads, so this serves BOTH callers: the admin modal passes the
// full CustomerStockEntry, the portal passes the narrower PortalStockEntry (which drops the staff
// email and the app's dead tracking columns). Naming the fields rather than either concrete type
// means neither shape can drift into being the one this function silently depends on.
export type StockItemSource = Pick<
  CustomerStockEntry & PortalStockEntry,
  "id" | "itemName" | "sku" | "quantity" | "warehouseName"
>;

// Collapse the raw stock lines (one row per item × warehouse, plus partial-receive
// history) into a deduped product list for the picker. Lines are grouped by item name +
// SKU — the same identity the backend tops up — summing quantity and noting where it's
// held. The representative `id` carries the link; the backend matches by name/sku, so any
// line of the group works.
export function toStockItemOptions(entries: StockItemSource[]): StockItemOption[] {
  const groups = new Map<
    string,
    { id: string; name: string; qty: number; warehouses: Set<string> }
  >();
  for (const e of entries) {
    const key = `${e.itemName.trim().toLowerCase()}␟${e.sku ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.qty += e.quantity;
      if (e.warehouseName) g.warehouses.add(e.warehouseName);
    } else {
      groups.set(key, {
        id: e.id,
        name: e.itemName,
        qty: e.quantity,
        warehouses: new Set(e.warehouseName ? [e.warehouseName] : []),
      });
    }
  }
  return [...groups.values()]
    .map((g) => {
      const where =
        g.warehouses.size === 1
          ? [...g.warehouses][0]
          : g.warehouses.size > 1
            ? `${g.warehouses.size} warehouses`
            : null;
      const detail = [where, `${g.qty} in stock`].filter(Boolean).join(" · ");
      return { id: g.id, name: g.name, detail };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface StockItemOption {
  // A representative existing stock-line id for this product (used to link the top-up).
  id: string;
  name: string;
  // Secondary line, e.g. "London Logistics Hub · 90 in stock".
  detail?: string;
}

export interface StockItemValue {
  // Non-null when an existing line is selected → the submission tops it up. Null when a
  // brand-new item name was typed.
  entryId: string | null;
  name: string;
}

// Item field for a stock submission: pick an EXISTING stock line (so its quantity is
// topped up on receipt instead of spawning a duplicate) OR type a NEW item name. Mirrors
// the CreatableSelect UX, but "new" is just free text (nothing is persisted here — the
// submission is still queued for review).
export function StockItemPicker({
  items,
  value,
  onChange,
  loading,
  invalid,
  disabled,
  describedBy,
  autoFocus,
  onQueryChange,
}: {
  items: StockItemOption[];
  value: StockItemValue;
  onChange: (v: StockItemValue) => void;
  loading?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  // When set, search is server-driven: the picker reports its (debounced) query up so the caller
  // can refetch a fresh page, and it stops filtering `items` locally (the server already did).
  // Omit it for small, fully-loaded lists (client-side filtering over `items`).
  onQueryChange?: (q: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // The panel hangs off this: `AnchoredPanel` places it against the trigger, follows it while it is
  // visible, and owns the click-outside that used to be a wrapper-containment check here.
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listboxId = React.useId();
  const serverFiltered = onQueryChange !== undefined;

  // Server-driven search: debounce the raw input up to the caller (which refetches). Reset to the
  // full list when the field is cleared or the picker closes (query resets on close/pick).
  React.useEffect(() => {
    if (!serverFiltered) return;
    const t = setTimeout(() => onQueryChange(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query, serverFiltered, onQueryChange]);

  const q = query.trim();
  const filtered = q && !serverFiltered
    ? items.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()))
    : items;
  const exact = items.find((o) => o.name.toLowerCase() === q.toLowerCase());
  const showUseNew = q.length > 0 && !exact;

  const pickExisting = (o: StockItemOption) => {
    onChange({ entryId: o.id, name: o.name });
    setOpen(false);
    setQuery("");
  };

  const pickNew = (name: string) => {
    const n = name.trim();
    if (!n) return;
    onChange({ entryId: null, name: n });
    setOpen(false);
    setQuery("");
  };

  const label = value.name || (loading ? "Loading your items…" : "— Select or type an item —");

  return (
    <div>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between gap-2 text-left`}
      >
        <span className={`truncate ${value.name ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
          {label}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)]" />
      </button>

      <AnchoredPanel
        id={listboxId}
        anchorRef={btnRef}
        open={open && !disabled}
        onDismiss={() => {
          setOpen(false);
          setQuery("");
        }}
      >
        <div className="shrink-0 border-b border-[var(--border-2)] p-2">
          {/* Focus is AnchoredPanel's — an `autoFocus` here cannot work: the panel is invisible until
              it has been placed, and the browser declines focus on a hidden element. */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (exact) pickExisting(exact);
                else if (showUseNew) pickNew(q);
              } else if (e.key === "Escape") {
                setOpen(false);
                setQuery("");
              }
            }}
            placeholder="Search your items or type a new name…"
            maxLength={160}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {showUseNew && (
            <button
              type="button"
              onClick={() => pickNew(q)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-10)]"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              Use &ldquo;{q}&rdquo; as a new item
            </button>
          )}

          {filtered.length > 0 && (
            <>
              {items.length > 0 && (
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                  Your existing stock
                </p>
              )}
              {filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => pickExisting(o)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--surface-2)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-[var(--ink)]">{o.name}</span>
                    {o.detail && (
                      <span className="block truncate text-[11px] text-[var(--muted)]">{o.detail}</span>
                    )}
                  </span>
                  {value.entryId === o.id && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  )}
                </button>
              ))}
            </>
          )}

          {filtered.length === 0 && !showUseNew && (
            <p className="px-3 py-3 text-center text-xs text-[var(--muted)]">
              {loading ? "Loading…" : items.length ? "No match." : "No existing stock yet — type a new item name."}
            </p>
          )}
        </div>
      </AnchoredPanel>

      {value.entryId && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--accent)]">
          <PackagePlus className="h-3.5 w-3.5 shrink-0" />
          Tops up existing stock — quantity is added to this item on receipt.
        </p>
      )}
    </div>
  );
}
