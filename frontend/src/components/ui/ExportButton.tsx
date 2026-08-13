"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";

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
 */
export function ExportButton({
  onExport,
  onResult,
  disabled,
  label = "Export CSV",
  title = "Export the filtered list to CSV",
}: {
  /** Runs the download. Resolve with `capped: true` when the server stopped short of the full set. */
  onExport: () => Promise<{ capped: boolean }>;
  /** Takes over reporting. Omit to get a toast for both the truncation and the failure. */
  onResult?: (result: { capped: boolean } | { error: string }) => void;
  /** Pass `rows.length === 0` — see above. */
  disabled?: boolean;
  label?: string;
  title?: string;
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
      className={toolbarBtn}
    >
      {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {exporting ? "Exporting…" : label}
    </button>
  );
}
