"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useDashboard } from "@/hooks/useDashboard";
import { toolbarBtn } from "@/components/ui/styles";

/**
 * The "Export CSV" control, in one place.
 *
 * Every list that offers an export needs the same five things, and each was previously hand-rolled
 * per page: a busy flag, a spinner swap, a disabled state while it runs, an error path, and the
 * truncation warning. Five copies is four chances to leave one out — and the one most often left
 * out is the last, which is the one that matters: a capped export that reports nothing hands the
 * user a partial file they believe is complete.
 *
 * Disabling on an EMPTY list is deliberate rather than cosmetic. A CSV of nothing is a header row
 * and no data, which downloads and opens looking like a broken export rather than an empty one.
 *
 * The failure and truncation paths default to a toast, so a new export gets both for free. A page
 * that wants the warning to persist (My Stock and Stock Submissions render it inline, tied to the
 * filters it was produced under) passes `onResult` and handles it instead.
 *
 * The LABEL collapses to the icon below `xl`, and `icon` exists because of what that costs when a page
 * offers TWO exports side by side ("Export" + "Export lines", on four screens): collapsed, they became
 * two identical ⤓ glyphs, and you could not tell one-row-per-order from one-row-per-line without
 * hovering. The title and aria-label always differed — but a control you have to hover to identify is
 * not an improvement on one that wrapped. So the per-LINE export takes a distinct glyph.
 *
 * The label collapse itself: A list toolbar is search + filters + two or three of
 * these, and on a laptop the labelled buttons are what tip the row onto a second line — ~50px taken
 * from a full-height panel, where nothing scrolls it back. Every consumer gets the same behaviour
 * from here rather than each page inventing its own (Inventory had already hand-rolled exactly this).
 * The button keeps its `title` and gains a matching `aria-label`, so the icon-only state is still
 * announced to a screen reader and still hoverable — the word is hidden, never lost.
 */
export function ExportButton({
  onExport,
  onResult,
  disabled,
  label = "Export CSV",
  title = "Export the filtered list to CSV",
  collapseLabel = true,
  icon: Icon = Download,
}: {
  /** Runs the download. Resolve with `capped: true` when the server stopped short of the full set. */
  onExport: () => Promise<{ capped: boolean }>;
  /** Takes over reporting. Omit to get a toast for both the truncation and the failure. */
  onResult?: (result: { capped: boolean } | { error: string }) => void;
  /** Pass `rows.length === 0` — see above. */
  disabled?: boolean;
  label?: string;
  title?: string;
  /** Set false to keep the word visible at every width — for a page whose toolbar has room. */
  collapseLabel?: boolean;
  /** Override the glyph. Pass a distinct one when this button sits beside another export. */
  icon?: LucideIcon;
}) {
  const [exporting, setExporting] = React.useState(false);
  const { pushToast } = useDashboard();

  const run = async () => {
    setExporting(true);
    try {
      const result = await onExport();
      if (onResult) onResult(result);
      else if (result.capped) {
        pushToast("Export truncated — too many rows. Narrow the filters and try again.", "alert");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Could not export.";
      if (onResult) onResult({ error });
      else pushToast(error, "alert");
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={exporting || disabled}
      title={title}
      aria-label={label}
      className={toolbarBtn}
    >
      {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      <span className={collapseLabel ? "hidden xl:inline" : undefined}>{exporting ? "Exporting…" : label}</span>
    </button>
  );
}
