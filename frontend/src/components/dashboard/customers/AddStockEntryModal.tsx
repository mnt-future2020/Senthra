"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import * as warehouseService from "@/services/warehouse.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { listCategories, getCachedCategories } from "@/services/category.service";
import type { CustomerStockEntry } from "@/types/customer";

const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;

type CustomField = { key: string; value: string };

export function AddStockEntryModal({
  customerId,
  onClose,
  onSaved,
}: {
  customerId: string;
  onClose: () => void;
  onSaved: (entry: CustomerStockEntry) => void;
}) {
  const [itemName, setItemName] = React.useState("");
  const [warehouseId, setWarehouseId] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [uom, setUom] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [serialized, setSerialized] = React.useState(false);
  const [serialNumber, setSerialNumber] = React.useState("");
  const [highValue, setHighValue] = React.useState(false);
  const [thresholdQty, setThresholdQty] = React.useState("");
  const [customFields, setCustomFields] = React.useState<CustomField[]>([]);

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(() =>
    (getCachedCategories() ?? [])
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name })),
  );

  React.useEffect(() => {
    warehouseService
      .listWarehouses({ pageSize: 200 })
      .then((r) =>
        setWarehouses(
          r.warehouses
            .filter((w) => w.status === "active")
            .map((w) => ({ id: w.id, name: w.name, code: w.code })),
        ),
      )
      .catch(() => {});
    listCategories()
      .then((cats) =>
        setCategories(
          cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })),
        ),
      )
      .catch(() => {});
  }, []);

  const clearError = (key: string) => setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });

  const updateField = (idx: number, field: "key" | "value", val: string) =>
    setCustomFields((prev) => prev.map((f, i) => (i === idx ? { ...f, [field]: val } : f)));
  const removeField = (idx: number) => setCustomFields((prev) => prev.filter((_, i) => i !== idx));
  const addField = () => setCustomFields((prev) => [...prev, { key: "", value: "" }]);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!itemName.trim()) errs.itemName = "Item name is required.";
    if (!warehouseId) errs.warehouseId = "Select a warehouse.";
    const qty = parseInt(quantity, 10);
    if (!quantity || isNaN(qty) || qty < 1) errs.quantity = "Quantity must be at least 1.";
    if (serialized && !serialNumber.trim()) errs.serialNumber = "Serial number is required.";
    if (thresholdQty !== "") {
      const t = parseInt(thresholdQty, 10);
      if (isNaN(t) || t < 0) errs.thresholdQty = "Must be 0 or more.";
    }
    const badFields = customFields.filter((f) => f.key.trim() && !f.value.trim());
    if (badFields.length) errs.customFields = "Fill in all custom field values or remove empty rows.";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    setErrors({});

    const attrs: Record<string, string> = {};
    for (const f of customFields) {
      const k = f.key.trim();
      const v = f.value.trim();
      if (k && v) attrs[k] = v;
    }

    try {
      const entry = await customerService.createDirectStockEntry(customerId, {
        warehouseId,
        itemName: itemName.trim(),
        sku: sku.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        uom: uom || undefined,
        quantity: parseInt(quantity, 10),
        serialized,
        serialNumber: serialNumber.trim() || undefined,
        highValue,
        thresholdQty: thresholdQty !== "" ? parseInt(thresholdQty, 10) : undefined,
        attributes: Object.keys(attrs).length ? attrs : undefined,
      });
      onSaved(entry);
    } catch (err) {
      setErrors({ _form: err instanceof Error ? err.message : "Could not add stock entry." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add stock entry">
      <form onSubmit={handleSubmit} className="space-y-4">
        {errors._form && (
          <p className="rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-3 py-2 text-sm font-semibold text-[var(--neg)]">
            {errors._form}
          </p>
        )}

        <div>
          <label className={labelCls}>Item name<RequiredMark /></label>
          <input
            className={inputCls}
            value={itemName}
            onChange={(e) => { setItemName(e.target.value); clearError("itemName"); }}
            placeholder="e.g. Fibre Optic Cable SM 100M"
            aria-invalid={Boolean(errors.itemName)}
          />
          {errors.itemName && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.itemName}</p>}
        </div>

        <div>
          <label className={labelCls}>Warehouse<RequiredMark /></label>
          <select
            className={inputCls}
            value={warehouseId}
            onChange={(e) => { setWarehouseId(e.target.value); clearError("warehouseId"); }}
            aria-invalid={Boolean(errors.warehouseId)}
          >
            <option value="">-- Select warehouse --</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
            ))}
          </select>
          {errors.warehouseId && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.warehouseId}</p>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Quantity<RequiredMark /></label>
            <input
              type="number"
              min={1}
              className={inputCls}
              value={quantity}
              onChange={(e) => { setQuantity(e.target.value); clearError("quantity"); }}
              placeholder="e.g. 10"
              aria-invalid={Boolean(errors.quantity)}
            />
            {errors.quantity && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.quantity}</p>}
          </div>
          <div>
            <label className={labelCls}>SKU</label>
            <input
              className={inputCls}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="e.g. FIBRE-SM-100M"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Category</label>
            <select
              className={inputCls}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">-- Select category --</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Unit of measure</label>
            <select
              className={inputCls}
              value={uom}
              onChange={(e) => setUom(e.target.value)}
            >
              <option value="">-- Select --</option>
              {UOM_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls}>Threshold qty</label>
          <input
            type="number"
            min={0}
            className={inputCls}
            value={thresholdQty}
            onChange={(e) => { setThresholdQty(e.target.value); clearError("thresholdQty"); }}
            placeholder="Low-stock reorder threshold (optional)"
            aria-invalid={Boolean(errors.thresholdQty)}
          />
          {errors.thresholdQty && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.thresholdQty}</p>}
        </div>

        <div>
          <label className={labelCls}>Description</label>
          <textarea
            className={inputCls}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            maxLength={2000}
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <input
              type="checkbox"
              checked={serialized}
              onChange={(e) => { setSerialized(e.target.checked); if (!e.target.checked) clearError("serialNumber"); }}
              className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
            />
            Serialized
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <input
              type="checkbox"
              checked={highValue}
              onChange={(e) => setHighValue(e.target.checked)}
              className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
            />
            High value
          </label>
        </div>

        {serialized && (
          <div>
            <label className={labelCls}>Serial number<RequiredMark /></label>
            <input
              className={inputCls}
              value={serialNumber}
              onChange={(e) => { setSerialNumber(e.target.value); clearError("serialNumber"); }}
              aria-invalid={Boolean(errors.serialNumber)}
            />
            {errors.serialNumber && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.serialNumber}</p>}
          </div>
        )}

        {/* Dynamic custom fields */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className={labelCls}>Custom fields</label>
            {customFields.length < 30 && (
              <button
                type="button"
                onClick={addField}
                className="flex items-center gap-1 text-[11px] font-bold text-[var(--accent)] hover:opacity-80"
              >
                <Plus className="h-3.5 w-3.5" /> Add field
              </button>
            )}
          </div>
          {customFields.length === 0 ? (
            <p className="text-[11px] text-[var(--faint)]">No custom fields. Click &quot;Add field&quot; to add key-value pairs.</p>
          ) : (
            <div className="space-y-2">
              {customFields.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    value={f.key}
                    onChange={(e) => updateField(i, "key", e.target.value)}
                    placeholder="Field name"
                    maxLength={60}
                  />
                  <input
                    className={inputCls}
                    value={f.value}
                    onChange={(e) => updateField(i, "value", e.target.value)}
                    placeholder="Value"
                    maxLength={200}
                  />
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {errors.customFields && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errors.customFields}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">
            Cancel
          </button>
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? "Adding..." : "Add entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
