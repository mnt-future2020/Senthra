"use client";

import * as React from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { restoreDamaged } from "@/services/stockPosition.service";
import { useDashboard } from "@/hooks/useDashboard";
import { FieldError } from "@/components/ui/FormScaffold";
import { inputCls, labelCls, ghostBtn, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import type { StockPosition } from "@/types/stock-position";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

interface RestoreDamagedDialogProps {
  row: StockPosition;
  onDone: () => void;
}

export function RestoreDamagedDialog({ row, onDone }: RestoreDamagedDialogProps) {
  const { pushToast } = useDashboard();

  const [quantity, setQuantity] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  const clearError = (f: string) =>
    setErrors((p) => {
      if (!p[f]) return p;
      const n = { ...p };
      delete n[f];
      return n;
    });

  const qtyNum = Number(quantity);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1)
      errs.quantity = "Enter a whole quantity of at least 1.";
    else if (qtyNum > row.quantity)
      errs.quantity = `Cannot restore more than the damaged quantity (${row.quantity}).`;
    if (!notes.trim()) errs.notes = "Notes are required for a damage restore.";
    return errs;
  };

  const isFormValid =
    quantity.trim() !== "" &&
    Number.isInteger(qtyNum) &&
    qtyNum >= 1 &&
    qtyNum <= row.quantity &&
    notes.trim() !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setSaving(true);

    // Derive ownerType and itemId fields from the row
    const ownerType = row.ownership; // "company" | "customer"
    const payload =
      ownerType === "customer"
        ? {
            warehouseId: row.locationId,
            ownerType: "customer" as const,
            customerStockEntryId: row.itemId,
            quantity: qtyNum,
            notes: notes.trim(),
          }
        : {
            warehouseId: row.locationId,
            ownerType: "company" as const,
            irmItemId: row.itemId,
            quantity: qtyNum,
            notes: notes.trim(),
          };

    try {
      await restoreDamaged(payload);
      pushToast(
        `Restored ${qtyNum} unit${qtyNum !== 1 ? "s" : ""} of ${row.itemName} from damaged stock.`,
        "success",
      );
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not restore the damaged stock.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Prefilled row context */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm">
            <p className="font-semibold text-[var(--ink)]">{row.itemName}</p>
            <p className="mt-0.5 text-[var(--muted)]">
              Owner:{" "}
              {row.ownership === "customer"
                ? row.customerName ?? "Customer"
                : "Company"}{" "}
              &nbsp;·&nbsp; Location: {row.locationLabel} &nbsp;·&nbsp; Damaged qty: {row.quantity}
            </p>
          </div>

          <div>
            <label className={labelCls}>Quantity to restore</label>
            <NumberInput
              className={inputCls}
              min={1}
              max={row.quantity}
              step={1}
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                clearError("quantity");
              }}
              aria-invalid={Boolean(errors.quantity)}
              placeholder={`1 – ${row.quantity}`}
              disabled={saving}
            />
            <FieldError message={errors.quantity} />
          </div>

          <div>
            <label className={labelCls}>Notes (required)</label>
            <textarea
              className={inputCls}
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                clearError("notes");
              }}
              aria-invalid={Boolean(errors.notes)}
              maxLength={2000}
              placeholder="Explain why these units are being restored (e.g. repaired, misclassified)."
              disabled={saving}
            />
            <FieldError message={errors.notes} />
          </div>
        </div>

        {/* Summary aside */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4"
            style={{ borderRadius: "var(--radius)" }}
          >
            <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
              Restore summary
            </p>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Item</span>
                <span className="text-right font-semibold text-[var(--ink)]">{row.itemName}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Owner</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {row.ownership === "customer"
                    ? (row.customerName ?? "Customer")
                    : "Company"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">From location</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {row.locationLabel}
                </span>
              </div>
              <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2.5">
                <span className="text-[var(--muted)]">Qty restoring</span>
                <span className="font-extrabold text-emerald-600">
                  {Number.isInteger(qtyNum) && qtyNum > 0 ? `+${qtyNum}` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Remaining damaged</span>
                <span className="font-extrabold text-[var(--ink)]">
                  {Number.isInteger(qtyNum) && qtyNum > 0
                    ? Math.max(0, row.quantity - qtyNum)
                    : row.quantity}
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] pt-4">
        <button type="button" onClick={onDone} disabled={saving} className={ghostBtn}>
          Cancel
        </button>
        <button type="submit" disabled={!isFormValid || saving} className={primaryBtn}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {saving ? "Restoring…" : "Restore Stock"}
        </button>
      </div>
    </form>
  );
}
