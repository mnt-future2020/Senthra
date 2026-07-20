"use client";

import * as React from "react";
import { Barcode, Loader2, Printer } from "lucide-react";

import { MAX_LABEL_COPIES } from "@/lib/printBarcode";
import { cn } from "@/lib/utils";
import { inputCls } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";

// Shared barcode UI for an IRM item: renders the item's Code128 image (which permanently encodes
// the item code, e.g. IRM-0004) and the generate/print action. Used by the IRM item detail page,
// the Add Stock form and the GRN receive form so they stay visually and behaviourally identical.
//
// Generate is a ONE-TIME action; once a barcode exists only "Reprint Label" is offered (reuses the
// stored image — never a new value/number). Callers own the busy/handler state so they can wire it
// to their own service calls and keep the source-of-truth item in sync.
//
// `copies` is OPTIONAL: pass it (with onCopiesChange) where one print run needs one sticker per
// physical unit — GRN receive, where a line can bring in 100 boxes. Omit it and the panel prints a
// single label, which is what the item-detail and Add Stock callers want.
export function BarcodePanel({
  code,
  barcodeDataUri,
  canManage,
  busy,
  onGenerate,
  onPrint,
  copies,
  onCopiesChange,
  copiesPlaceholder,
  copiesError,
}: {
  code: string;
  barcodeDataUri: string | null;
  canManage: boolean;
  busy: boolean;
  onGenerate: () => void;
  onPrint: () => void;
  copies?: string;
  onCopiesChange?: (value: string) => void;
  copiesPlaceholder?: string;
  copiesError?: string;
}) {
  const hasBarcode = Boolean(barcodeDataUri);
  const showCopies = Boolean(onCopiesChange);

  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
      <div className="flex h-24 w-44 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-white p-2">
        {hasBarcode ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={barcodeDataUri ?? ""} alt={`Barcode ${code}`} className="h-full w-full object-contain" />
        ) : (
          <Barcode className="h-7 w-7 text-[var(--faint)]" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-[var(--muted)]">
          {hasBarcode ? (
            <>Code128 barcode encoding <span className="font-mono font-bold text-[var(--ink)]">{code}</span>.</>
          ) : (
            "No barcode generated yet. Generate one to print a label for the physical stock."
          )}
        </p>
        {hasBarcode ? (
          // Barcode exists → only ever reprint the SAME sticker (reuses barcodeDataUri).
          // Available to anyone who can view the item; never creates a new value/number/row.
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {showCopies && (
                <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                  Copies
                  <NumberInput
                    className={cn(inputCls, "w-20 px-2.5 py-1.5 text-xs font-semibold")}
                    min={1}
                    max={MAX_LABEL_COPIES}
                    value={copies ?? ""}
                    onChange={(e) => onCopiesChange?.(e.target.value)}
                    placeholder={copiesPlaceholder}
                    aria-invalid={Boolean(copiesError)}
                    aria-label={`Label copies for ${code}`}
                  />
                </label>
              )}
              <button
                type="button"
                onClick={onPrint}
                disabled={Boolean(copiesError)}
                className="flex w-fit items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Printer className="h-3.5 w-3.5" /> Reprint Label
              </button>
            </div>
            {copiesError && <p className="text-[11px] font-semibold text-[var(--neg)]">{copiesError}</p>}
          </div>
        ) : canManage ? (
          // No barcode yet → one-time generation (encodes the item's permanent code).
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy}
            className="flex w-fit items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Barcode className="h-3.5 w-3.5" />}
            Generate Barcode
          </button>
        ) : null}
      </div>
    </div>
  );
}
