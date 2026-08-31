"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listWarehouses, type PagedWarehouses } from "@/services/warehouse.service";
import { useReferenceData } from "@/hooks/useReferenceData";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { shouldPrefillAssignment } from "@/lib/preferredWarehouse";
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

  const { isLoading: refLoading } = useReferenceData([
    {
      label: "warehouses",
      load: () => listWarehouses({ status: "active", pageSize: 200 }),
      onData: (r: PagedWarehouses) => {
        const list = r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }));
        setWarehouses(list);
        // Pre-fill the first row with the customer's PREFERENCE — a starting point, nothing more.
        // Gated on the warehouse still being in the ACTIVE list we just loaded, so a warehouse
        // deactivated since submission is never pre-selected into an assignment.
        //
        // Only ever touches the untouched initial row: this fires once the reference data lands,
        // and overwriting a warehouse the reviewer had already chosen would be the modal fighting
        // them. Everything after this point is entirely theirs to change or split.
        const preferred = request.preferredWarehouseId;
        setRows((p) => (shouldPrefillAssignment(preferred, list, p) ? [{ ...p[0], warehouseId: preferred! }] : p));
      },
    },
  ]);

  const preferredName = request.preferredWarehouseName;

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
        {/* States whose choice this was, and that it isn't binding. Shown even when the preferred
            warehouse is inactive (and so wasn't pre-filled) — the reviewer still needs to know what
            the customer asked for before they pick something else. */}
        {preferredName && (
          <p className="text-[11px] text-[var(--muted)]">
            <span className="font-semibold text-[var(--faint)]">Customer preferred:</span> {preferredName}
            {" — a preference only. Assign any warehouse, or split across several."}
          </p>
        )}
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
                placeholder={refLoading && !row.warehouseId ? "Loading warehouses…" : "Select warehouse…"}
                disabled={refLoading && !row.warehouseId}
                ariaLabel="Warehouse"
              />
            </div>
            <div className="w-28">
              <label className={labelCls}>Qty</label>
              <NumberInput
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
