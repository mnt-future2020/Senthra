import { Minus, Plus } from "lucide-react";

// Compact − / number / + quantity stepper. SHARED by the Goods-Management job scan panel and the
// Field-Stock (VSR) scan-out row so the two scan surfaces read as one system. Presentational only —
// the parent owns clamping: `onChange` fires with the raw next value and the caller clamps to its own
// min/max (both call sites already do, against a live per-line cap).
export function QtyStepper({
  value,
  min,
  max,
  onChange,
  uom,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  uom?: string | null;
  ariaLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label="Decrease quantity"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-40"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="w-16 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-center text-sm font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label="Increase quantity"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {uom ? <span className="ml-1 text-xs text-[var(--faint)]">{uom}</span> : null}
    </div>
  );
}
