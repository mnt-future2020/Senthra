"use client";

import * as React from "react";
import { Barcode, Loader2, Printer } from "lucide-react";

// Shared barcode UI for an IRM item: renders the item's Code128 image (which permanently encodes
// the item code, e.g. IRM-0004) and the generate/print action. Used by both the IRM item detail
// page and the Add Stock form so the two stay visually and behaviourally identical.
//
// Generate is a ONE-TIME action; once a barcode exists only "Reprint Label" is offered (reuses the
// stored image — never a new value/number). Callers own the busy/handler state so they can wire it
// to their own service calls and keep the source-of-truth item in sync.
export function BarcodePanel({
  code,
  barcodeDataUri,
  canManage,
  busy,
  onGenerate,
  onPrint,
}: {
  code: string;
  barcodeDataUri: string | null;
  canManage: boolean;
  busy: boolean;
  onGenerate: () => void;
  onPrint: () => void;
}) {
  const hasBarcode = Boolean(barcodeDataUri);

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
          <button
            type="button"
            onClick={onPrint}
            className="flex w-fit items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)]"
          >
            <Printer className="h-3.5 w-3.5" /> Reprint Label
          </button>
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
