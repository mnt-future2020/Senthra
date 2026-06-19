"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listWarehouses } from "@/services/warehouse.service";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { StockRequest } from "@/types/customer";

interface Row {
  warehouseId: string;
  quantity: string;
}

export function AssignWarehouseModal({
  customerId,
  request,
  onClose,
  onSaved,
}: {
  customerId: string;
  request: StockRequest;
  onClose: () => void;
  onSaved: (updated: StockRequest) => void;
}) {
  const totalQty = request.quantity ?? 0;
  const [rows, setRows] = React.useState<Row[]>([{ warehouseId: "", quantity: String(totalQty) }]);
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    listWarehouses({ status: "active", pageSize: 200 })
      .then((r) => setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))))
      .catch(() => {});
  }, []);

  const addRow = () => setRows((p) => [...p, { warehouseId: "", quantity: "" }]);
  const removeRow = (i: number) => setRows((p) => p.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: keyof Row, value: string) =>
    setRows((p) => p.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));

  const assigned = rows.reduce((s, r) => s + (parseInt(r.quantity, 10) || 0), 0);
  const remaining = totalQty - assigned;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const assignments = rows
      .filter((r) => r.warehouseId && r.quantity)
      .map((r) => ({ warehouseId: r.warehouseId, quantity: parseInt(r.quantity, 10) }));

    if (!assignments.length) {
      setError("Add at least one warehouse assignment.");
      return;
    }

    const total = assignments.reduce((s, a) => s + a.quantity, 0);
    if (total !== totalQty) {
      setError(`Total assigned (${total}) must equal request quantity (${totalQty}).`);
      return;
    }

    const ids = new Set(assignments.map((a) => a.warehouseId));
    if (ids.size !== assignments.length) {
      setError("Each warehouse can only appear once.");
      return;
    }

    setBusy(true);
    try {
      const updated = await customerService.assignStockRequestWarehouses(customerId, request.id, {
        assignments,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign warehouses.");
      setBusy(false);
    }
  };

  const usedIds = new Set(rows.map((r) => r.warehouseId).filter(Boolean));

  return (
    <Modal
      open
      title="Assign to warehouses"
      subtitle={`"${request.editedName ?? request.name}" — ${totalQty} to assign`}
      onClose={busy ? () => {} : onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="assign-form" disabled={busy || remaining !== 0} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Assign
          </button>
        </>
      }
    >
      <form id="assign-form" onSubmit={submit} className="space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <label className={labelCls}>Warehouse</label>
              <Select
                value={row.warehouseId}
                onChange={(v) => updateRow(i, "warehouseId", v)}
                options={warehouses.map((w) => ({
                  value: w.id,
                  label: `${w.name} (${w.code})`,
                  disabled: usedIds.has(w.id) && w.id !== row.warehouseId,
                }))}
                placeholder="Select warehouse…"
                ariaLabel="Warehouse"
              />
            </div>
            <div className="w-28">
              <label className={labelCls}>Qty</label>
              <input
                type="number"
                min={1}
                step={1}
                className={inputCls}
                value={row.quantity}
                onChange={(e) => updateRow(i, "quantity", e.target.value)}
              />
            </div>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--faint)] hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}

        <div className="flex items-center justify-between">
          <button type="button" onClick={addRow} className="flex items-center gap-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">
            <Plus className="h-3.5 w-3.5" /> Add warehouse
          </button>
          <span className={`text-xs font-bold ${remaining === 0 ? "text-[var(--pos)]" : remaining < 0 ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
            {remaining === 0 ? "All assigned" : remaining > 0 ? `${remaining} remaining` : `${Math.abs(remaining)} over`}
          </span>
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
