"use client";

import * as React from "react";
import { Barcode, Loader2, Printer } from "lucide-react";

import { MAX_LABEL_COPIES, copiesError as copiesErrorFor, resolveCopies } from "@/lib/printBarcode";
import { cn } from "@/lib/utils";
import { inputCls } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";

// The ONE barcode UI: renders a Code128 image (which permanently encodes the owning record's code,
// e.g. IRM-0004 or a customer stock entry's barcode) plus the generate + print actions. Used by the
// IRM item detail page, the Add Stock form, the GRN receive form, the customer stock-entry detail
// page and the stock-entry create page, so all five behave identically.
//
// Generate is a ONE-TIME action. Once a barcode exists the panel only ever prints the SAME stored
// image — it never mints a new value or number. Callers own the busy/handler state so they can wire
// it to their own service calls and keep the source-of-truth record in sync.
//
// COPIES is mandatory, not optional. Every one of these surfaces labels physical stock, and a
// put-away of 50 units needs 50 stickers — the panel used to default to a single label, so adding
// 50 units printed one. A blank box means `defaultCopies` (each surface passes its own quantity in
// context); typing a number pins it, which is how you reprint the three that smudged.
//
// Validation lives in lib/printBarcode, NOT here and not in the callers: two of them used to carry
// their own copy of the rules and one accepted "2.5", so the button offered "Print 2.5 labels"
// while the printer floored it to 2. The count on the button is now always what comes out.
export function BarcodePanel({
  code,
  barcodeDataUri,
  canManage,
  busy,
  onGenerate,
  onPrint,
  copies,
  onCopiesChange,
  defaultCopies,
}: {
  code: string;
  barcodeDataUri: string | null;
  canManage: boolean;
  busy: boolean;
  /**
   * One-time generation, for the surfaces that STORE their barcode image. Omitted by a surface whose
   * label is rendered from an immutable code and therefore always exists (rental items) — there is
   * nothing to generate there, so the button and its copy would be offering a step that does not
   * exist.
   */
  onGenerate?: () => void;
  /** Receives the RESOLVED count (typed value, or defaultCopies when the box is blank). */
  onPrint: (copies: number) => void;
  copies: string;
  onCopiesChange: (value: string) => void;
  /** What a blank box prints — the quantity this surface is labelling. Clamped to the print cap. */
  defaultCopies: number;
}) {
  const hasBarcode = Boolean(barcodeDataUri);
  const error = copiesErrorFor(copies);
  const resolved = resolveCopies(copies, defaultCopies);
  // A blank box always resolves, so this only shows the cap-clamped default as a hint.
  const placeholder = String(resolveCopies("", defaultCopies) ?? 1);

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
            onGenerate
              ? "No barcode generated yet. Generate one to print a label for the physical stock."
              : "No barcode to show."
          )}
        </p>
        {hasBarcode ? (
          // Barcode exists → print the SAME sticker (reuses barcodeDataUri). Available to anyone who
          // can view the record; it never creates a new value/number/row.
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                Copies
                <NumberInput
                  className={cn(inputCls, "w-20 px-2.5 py-1.5 text-xs font-semibold")}
                  min={1}
                  max={MAX_LABEL_COPIES}
                  value={copies}
                  onChange={(e) => onCopiesChange(e.target.value)}
                  placeholder={placeholder}
                  aria-invalid={Boolean(error) || undefined}
                  aria-label={`Label copies for ${code}`}
                />
              </label>
              <button
                type="button"
                onClick={() => resolved !== null && onPrint(resolved)}
                disabled={resolved === null}
                className="flex w-fit items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {/* Says "Print", never "Reprint": the panel can't know whether anything was ever
                    printed, and it used to read "Reprint Label" the instant you clicked Generate. */}
                <Printer className="h-3.5 w-3.5" />
                {resolved === null ? "Print labels" : `Print ${resolved} label${resolved === 1 ? "" : "s"}`}
              </button>
            </div>
            {error && <p className="text-[11px] font-semibold text-[var(--neg)]">{error}</p>}
          </div>
        ) : canManage && onGenerate ? (
          // No barcode yet → one-time generation (encodes the record's permanent code).
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
