"use client";

import * as React from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { transferCustomerStock } from "@/services/stockPosition.service";
import { listWarehouses } from "@/services/warehouse.service";
import { useDashboard } from "@/hooks/useDashboard";
import { FieldError } from "@/components/ui/FormScaffold";
import { inputCls, labelCls, ghostBtn, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import type { StockPosition } from "@/types/stock-position";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

type WarehouseOption = { id: string; name: string; code: string };

interface CustomerTransferFormProps {
  row: StockPosition;
  onDone: () => void;
}

export function CustomerTransferForm({ row, onDone }: CustomerTransferFormProps) {
  const { pushToast } = useDashboard();

  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);
  const [toWarehouseId, setToWarehouseId] = React.useState("");
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

  React.useEffect(() => {
    let active = true;
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) =>
        active &&
        setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  const qtyNum = Number(quantity);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!toWarehouseId) errs.toWarehouseId = "Select a destination warehouse.";
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1)
      errs.quantity = "Enter a whole quantity of at least 1.";
    else if (qtyNum > row.quantity)
      errs.quantity = `Cannot transfer more than the available quantity (${row.quantity}).`;
    return errs;
  };

  const isFormValid =
    Boolean(toWarehouseId) &&
    quantity.trim() !== "" &&
    Number.isInteger(qtyNum) &&
    qtyNum >= 1 &&
    qtyNum <= row.quantity;

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
    try {
      await transferCustomerStock(row.itemId, {
        toWarehouseId,
        quantity: qtyNum,
        notes: notes.trim() || undefined,
      });
      pushToast(
        `Transferred ${qtyNum} unit${qtyNum !== 1 ? "s" : ""} of ${row.itemName} to ${warehouses.find((w) => w.id === toWarehouseId)?.name ?? toWarehouseId}.`,
        "success",
      );
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not complete the transfer.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  const targetWh = warehouses.find((w) => w.id === toWarehouseId) ?? null;

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Prefilled row context */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm">
            <p className="font-semibold text-[var(--ink)]">{row.itemName}</p>
            <p className="mt-0.5 text-[var(--muted)]">
              Customer: {row.customerName ?? "—"} &nbsp;·&nbsp; Current location:{" "}
              {row.locationLabel} &nbsp;·&nbsp; Available: {row.quantity}
            </p>
          </div>

          <div>
            <label className={labelCls}>Destination warehouse</label>
            <Select
              value={toWarehouseId}
              onChange={(v) => {
                setToWarehouseId(v);
                clearError("toWarehouseId");
              }}
              options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))}
              placeholder="— Select destination —"
              ariaLabel="Destination warehouse"
              invalid={Boolean(errors.toWarehouseId)}
              disabled={saving}
            />
            <FieldError message={errors.toWarehouseId} />
          </div>

          <div>
            <label className={labelCls}>Quantity to transfer</label>
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
            <label className={labelCls}>Notes (optional)</label>
            <textarea
              className={inputCls}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              placeholder="Internal notes for this transfer."
              disabled={saving}
            />
          </div>
        </div>

        {/* Summary aside */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4"
            style={{ borderRadius: "var(--radius)" }}
          >
            <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
              Transfer summary
            </p>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Item</span>
                <span className="text-right font-semibold text-[var(--ink)]">{row.itemName}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Customer</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {row.customerName ?? "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">From</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {row.locationLabel}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">To</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {targetWh ? `${targetWh.name} (${targetWh.code})` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2.5">
                <span className="text-[var(--muted)]">Qty</span>
                <span className="font-extrabold text-[var(--accent)]">
                  {Number.isInteger(qtyNum) && qtyNum > 0 ? qtyNum : "—"}
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
            <ArrowRight className="h-3.5 w-3.5" />
          )}
          {saving ? "Transferring…" : "Transfer Stock"}
        </button>
      </div>
    </form>
  );
}
