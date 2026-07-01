"use client";

import * as React from "react";
import { AlertTriangle, Loader2, MinusCircle } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import type { AdjustStockReason, StockAdjustment } from "@/services/inventory.service";
import { listIrmItems } from "@/services/irm.service";
import { listWarehouses } from "@/services/warehouse.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormSection } from "@/components/ui/FormScaffold";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { Notice } from "@/components/ui/Notice";
import type { Availability } from "@/types/inventory";

const today = () => new Date().toISOString().slice(0, 10);

const REASONS: { value: AdjustStockReason; label: string }[] = [
  { value: "damage_correction", label: "Damage correction" },
  { value: "shrinkage", label: "Shrinkage" },
  { value: "miscount", label: "Miscount" },
  { value: "other", label: "Other" },
];

type ItemOption = { id: string; code: string; name: string; sku: string | null; baseUnit: string | null };
type WarehouseOption = { id: string; name: string; code: string };

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

interface AdjustStockFormProps {
  /** Called after a successful adjustment or when the user cancels */
  onDone: () => void;
}

export function AdjustStockForm({ onDone }: AdjustStockFormProps) {
  const { pushToast } = useDashboard();
  const { user, admin, principal } = useAuth();

  const currentUserName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : admin
      ? admin.name || admin.email
      : principal?.email ?? "—";

  const [items, setItems] = React.useState<ItemOption[]>([]);
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);

  const [irmItemId, setIrmItemId] = React.useState("");
  const [warehouseId, setWarehouseId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [movementDate, setMovementDate] = React.useState(today());
  const [reason, setReason] = React.useState<AdjustStockReason>("damage_correction");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [availability, setAvailability] = React.useState<Availability | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savedAdjustment, setSavedAdjustment] = React.useState<StockAdjustment | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const clearError = (f: string) =>
    setErrors((p) => {
      if (!p[f]) return p;
      const n = { ...p };
      delete n[f];
      return n;
    });

  // Load adjustable items (non-serial, non-batch, inventory-tracked) and active warehouses.
  React.useEffect(() => {
    let active = true;
    listIrmItems({ status: "active", pageSize: 200 }).then(
      (r) =>
        active &&
        setItems(
          r.items
            .filter((i) => i.trackInventory && !i.trackSerialNumbers && !i.trackBatchNumbers)
            .map((i) => ({ id: i.id, code: i.code, name: i.name, sku: i.sku, baseUnit: i.baseUnit })),
        ),
      () => {},
    );
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  // Live on-hand at the chosen item × warehouse — used to show new balance and guard qty ≤ available.
  React.useEffect(() => {
    let active = true;
    (async () => {
      if (!irmItemId || !warehouseId) {
        setAvailability(null);
        return;
      }
      try {
        const a = await inventoryService.getAvailability(irmItemId, warehouseId);
        if (active) setAvailability(a);
      } catch {
        if (active) setAvailability(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [irmItemId, warehouseId]);

  const selectedItem = items.find((i) => i.id === irmItemId) ?? null;
  const targetWh = warehouses.find((w) => w.id === warehouseId) ?? null;
  const qtyNum = Number(quantity);
  const available = availability?.available ?? null;
  const newBalance =
    available !== null && Number.isInteger(qtyNum) && qtyNum > 0 ? available - qtyNum : null;

  const locked = saving || Boolean(savedAdjustment);
  const quantityValid =
    quantity.trim() !== "" &&
    Number.isInteger(qtyNum) &&
    qtyNum >= 1 &&
    (available === null || qtyNum <= available);
  const dateValid = Boolean(movementDate) && movementDate <= today();
  const isFormValid =
    Boolean(irmItemId) && Boolean(warehouseId) && quantityValid && Boolean(reason) && dateValid;

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!irmItemId) errs.irmItemId = "Select an item.";
    if (!warehouseId) errs.warehouseId = "Select a warehouse.";
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1)
      errs.quantity = "Enter a whole quantity of at least 1.";
    else if (available !== null && qtyNum > available)
      errs.quantity = `Cannot remove more than the available quantity (${available}).`;
    if (!movementDate) errs.movementDate = "Movement date is required.";
    else if (movementDate > today()) errs.movementDate = "Movement date cannot be in the future.";
    return errs;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const adjustment = await inventoryService.adjustStock({
        irmItemId,
        warehouseId,
        quantity: qtyNum,
        movementDate,
        reason,
        referenceNumber: referenceNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setSavedAdjustment(adjustment);
      setSaving(false);
      pushToast(
        `Adjusted — removed ${adjustment.quantity} from ${adjustment.warehouseName} (${adjustment.code}).`,
        "success",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not adjust the stock.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      {savedAdjustment && (
        <Notice
          msg={{
            type: "success",
            text: `Adjustment ${savedAdjustment.code} recorded. New on hand at ${savedAdjustment.warehouseName}: ${savedAdjustment.balanceAfter}.`,
          }}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <FormSection
            title="Adjustment details"
            description="Remove units from the warehouse balance. Serial- and batch-tracked items are not listed."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Item</label>
                <Select
                  value={irmItemId}
                  onChange={(v) => {
                    setIrmItemId(v);
                    clearError("irmItemId");
                  }}
                  options={items.map((i) => ({
                    value: i.id,
                    label: `${i.code} — ${i.name}${i.sku ? ` (${i.sku})` : ""}`,
                  }))}
                  placeholder="— Select an item —"
                  ariaLabel="Item"
                  invalid={Boolean(errors.irmItemId)}
                  disabled={locked}
                />
                <FieldError message={errors.irmItemId} />
              </div>
              <div>
                <label className={labelCls}>Warehouse</label>
                <Select
                  value={warehouseId}
                  onChange={(v) => {
                    setWarehouseId(v);
                    clearError("warehouseId");
                  }}
                  options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))}
                  placeholder="— Select warehouse —"
                  ariaLabel="Warehouse"
                  invalid={Boolean(errors.warehouseId)}
                  disabled={locked}
                />
                <FieldError message={errors.warehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {!irmItemId || !warehouseId
                    ? "Pick item + warehouse to see current available."
                    : available !== null
                      ? `${available} available${selectedItem?.baseUnit ? ` ${selectedItem.baseUnit}` : ""}.`
                      : "No stock of this item here."}
                </p>
              </div>
              <div>
                <label className={labelCls}>Quantity to remove</label>
                <NumberInput
                  className={inputCls}
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(e) => {
                    setQuantity(e.target.value);
                    clearError("quantity");
                  }}
                  aria-invalid={Boolean(errors.quantity)}
                  placeholder="e.g. 3"
                  disabled={locked}
                />
                <FieldError message={errors.quantity} />
              </div>
              <div>
                <label className={labelCls}>Reason</label>
                <Select
                  value={reason}
                  onChange={(v) => setReason(v as AdjustStockReason)}
                  options={REASONS}
                  ariaLabel="Reason"
                  disabled={locked}
                />
              </div>
              <div>
                <label className={labelCls}>Movement date</label>
                <input
                  className={inputCls}
                  type="date"
                  max={today()}
                  value={movementDate}
                  onChange={(e) => {
                    setMovementDate(e.target.value);
                    clearError("movementDate");
                  }}
                  aria-invalid={Boolean(errors.movementDate)}
                  disabled={locked}
                />
                <FieldError message={errors.movementDate} />
              </div>
            </div>
          </FormSection>

          <FormSection title="References" description="Optional references recorded against this adjustment.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Reference number</label>
                <input
                  className={inputCls}
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  maxLength={60}
                  placeholder="e.g. DAMAGE-2026-01"
                  disabled={locked}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={2000}
                  placeholder="Internal notes visible only to staff."
                  disabled={locked}
                />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Item</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {selectedItem ? selectedItem.name : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Warehouse</span>
                <span className="text-right font-semibold text-[var(--ink)]">
                  {targetWh ? `${targetWh.name} (${targetWh.code})` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Available now</span>
                <span className="font-semibold text-[var(--ink)]">{available ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">Qty to remove</span>
                <span className="font-extrabold text-rose-600">
                  {Number.isInteger(qtyNum) && qtyNum > 0 ? `−${qtyNum}` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--muted)]">New balance</span>
                <span
                  className={`font-extrabold ${newBalance !== null && newBalance < 0 ? "text-rose-600" : "text-[var(--ink)]"}`}
                >
                  {newBalance !== null ? newBalance : "—"}
                </span>
              </div>
              <div className="mt-1 space-y-2.5 border-t border-[var(--border)] pt-3">
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted)]">Adjustment No</span>
                  <span
                    className={`text-right font-mono font-bold ${savedAdjustment ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}
                  >
                    {savedAdjustment ? savedAdjustment.code : "Auto-generated after save"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted)]">Created by</span>
                  <span className="text-right font-semibold text-[var(--ink)]">{currentUserName}</span>
                </div>
              </div>
            </div>
          </FormAsideCard>

          <div className="mt-4 flex gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--faint)]" />
            <div className="space-y-1.5">
              <p className="font-bold text-[var(--ink)]">This action cannot be edited later.</p>
              <p>
                Use <span className="font-semibold text-[var(--muted)]">Adjust</span> for damage,
                shrinkage, or miscount corrections only. It creates an immutable downward ledger entry.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] pt-4">
        {savedAdjustment ? (
          <button type="button" onClick={onDone} className={primaryBtn}>
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onDone} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={!isFormValid || saving} className={primaryBtn}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MinusCircle className="h-3.5 w-3.5" />
              )}
              {saving ? "Adjusting…" : "Adjust Stock"}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
