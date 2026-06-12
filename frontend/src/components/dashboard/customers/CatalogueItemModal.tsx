"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { CatalogueItem } from "@/types/customer";

// Units of measure for catalogue items (UK telecom field-services stock). Kept in
// lockstep with the backend UOM_OPTIONS (customer.validation.ts).
const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;

type CustomField = { id: number; key: string; value: string };

// Add / edit a per-customer catalogue item — the product master: name, SKU,
// category, unit of measure, the serial/barcode/high-value flags, a low-stock
// threshold, status, plus any number of per-category custom attributes.
export function CatalogueItemModal({
  customerId,
  item,
  onClose,
  onSaved,
  categories,
}: {
  customerId: string;
  item: CatalogueItem | null; // null = create
  onClose: () => void;
  onSaved: (item: CatalogueItem) => void;
  categories: { id: string; name: string }[]; // active global categories for the picker
}) {
  const isEdit = Boolean(item);
  const [name, setName] = React.useState(item?.name ?? "");
  const [sku, setSku] = React.useState(item?.sku ?? "");
  const [categoryId, setCategoryId] = React.useState(item?.categoryId ?? "");
  const [description, setDescription] = React.useState(item?.description ?? "");
  const [uom, setUom] = React.useState(item?.uom ?? "");
  const [serialized, setSerialized] = React.useState(item?.serialized ?? false);
  const [barcodeRequired, setBarcodeRequired] = React.useState(item?.barcodeRequired ?? false);
  const [highValue, setHighValue] = React.useState(item?.highValue ?? false);
  const [thresholdQty, setThresholdQty] = React.useState(
    item?.thresholdQty != null ? String(item.thresholdQty) : "",
  );
  const [status, setStatus] = React.useState<"active" | "inactive">(item?.status ?? "active");
  // Each row carries a stable id so React keys survive insert/remove — an
  // array-index key would reattach focus/IME/selection state to the wrong row when
  // a middle field is deleted.
  const [fields, setFields] = React.useState<CustomField[]>(() =>
    Object.entries(item?.attributes ?? {}).map(([key, value], i) => ({
      id: i,
      key,
      value: String(value),
    })),
  );
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; sku?: string; category?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  // The picker is fed the ACTIVE categories. When editing an item whose category was
  // since deactivated, its id is absent from that list — so surface the item's own
  // current category as an extra option. Without this the native <select> would render
  // blank (no matching option) and block the save with "Select a category", making an
  // unrelated edit (e.g. fixing the threshold) impossible without re-categorising.
  const categoryOptions = React.useMemo(() => {
    const current = item?.category;
    if (current && !categories.some((c) => c.id === current.id)) {
      return [...categories, { id: current.id, name: `${current.name} (inactive)` }];
    }
    return categories;
  }, [categories, item]);

  const setFieldAt = (i: number, patch: Partial<CustomField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () =>
    setFields((prev) => [
      ...prev,
      { id: prev.reduce((m, f) => Math.max(m, f.id), -1) + 1, key: "", value: "" },
    ]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Item name is required.";
    if (!sku.trim()) errs.sku = "SKU is required.";
    if (!categoryId) errs.category = "Select a category.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    // Any row with a (trimmed) key is kept, so attributes round-trip faithfully;
    // duplicate keys collapse (last wins) and fully-blank rows are discarded.
    const attributes: Record<string, string> = {};
    for (const f of fields) {
      const key = f.key.trim();
      if (key) attributes[key] = f.value.trim();
    }

    const qty = thresholdQty.trim();
    const thresholdNum = qty === "" ? undefined : Number(qty);
    if (thresholdNum !== undefined && (!Number.isInteger(thresholdNum) || thresholdNum < 0)) {
      setError("Threshold quantity must be a whole number (0 or more).");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        categoryId,
        description: description.trim() || undefined,
        uom: uom || undefined,
        serialized,
        barcodeRequired,
        highValue,
        thresholdQty: thresholdNum,
        status,
        attributes,
      };
      const saved =
        isEdit && item
          ? await customerService.updateCatalogueItem(customerId, item.id, payload)
          : await customerService.addCatalogueItem(customerId, payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the item.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? "Edit catalogue item" : "Add catalogue item"}
      subtitle="A per-customer stock item (the product master). The catalogue is never priced."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button
            type="submit"
            form="catalogue-item-form"
            disabled={busy || (!isEdit && categories.length === 0)}
            className={primaryBtn}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save changes" : "Add item"}
          </button>
        </>
      }
    >
      <form id="catalogue-item-form" onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Item name<RequiredMark /></label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((p) => ({ ...p, name: undefined }));
              }}
              placeholder="e.g. SFP-LX optical module"
              maxLength={160}
              autoFocus
              aria-invalid={Boolean(errors.name)}
            />
            <FieldErr msg={errors.name} />
          </div>
          <div>
            <label className={labelCls}>SKU / part code<RequiredMark /></label>
            <input
              className={inputCls}
              value={sku}
              onChange={(e) => {
                setSku(e.target.value);
                setErrors((p) => ({ ...p, sku: undefined }));
              }}
              placeholder="e.g. NTTP06CFE6"
              maxLength={80}
              aria-invalid={Boolean(errors.sku)}
            />
            <FieldErr msg={errors.sku} />
          </div>
          <div>
            <label className={labelCls}>Category<RequiredMark /></label>
            <select
              className={inputCls}
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setErrors((p) => ({ ...p, category: undefined }));
              }}
              aria-invalid={Boolean(errors.category)}
            >
              <option value="">— Select a category</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {!isEdit && categories.length === 0 && (
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                No categories yet. Create one in Settings → Categories first.
              </p>
            )}
            <FieldErr msg={errors.category} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Description</label>
            <textarea
              className={inputCls}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — what this item is."
              maxLength={2000}
            />
          </div>
          <div>
            <label className={labelCls}>Unit of measure</label>
            <select className={inputCls} value={uom} onChange={(e) => setUom(e.target.value)}>
              <option value="">— Not set</option>
              {UOM_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Low-stock threshold</label>
            <input
              type="number"
              min={0}
              step={1}
              className={inputCls}
              value={thresholdQty}
              onChange={(e) => setThresholdQty(e.target.value)}
              placeholder="e.g. 10"
            />
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-[var(--border-2)] px-3.5 py-3">
          <Toggle label="Serialized item" checked={serialized} onChange={setSerialized} />
          <Toggle label="Barcode required" checked={barcodeRequired} onChange={setBarcodeRequired} />
          <Toggle label="High-value item" checked={highValue} onChange={setHighValue} />
        </div>

        <div className="border-t border-[var(--border-2)] pt-4">
          <div className="flex items-center justify-between">
            <label className={labelCls}>Custom fields</label>
            <button
              type="button"
              onClick={addField}
              className="flex items-center gap-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
            >
              <Plus className="h-3.5 w-3.5" /> Add field
            </button>
          </div>
          <p className="mb-2.5 text-[11px] text-[var(--faint)]">
            Per-category attributes, e.g. Length: 50m · Connector: LC · Armoured: Yes.
          </p>
          {fields.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No custom fields.</p>
          ) : (
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={f.id} className="flex gap-2">
                  <input
                    className={inputCls}
                    value={f.key}
                    onChange={(e) => setFieldAt(i, { key: e.target.value })}
                    placeholder="Field (e.g. Length)"
                    maxLength={60}
                  />
                  <input
                    className={inputCls}
                    value={f.value}
                    onChange={(e) => setFieldAt(i, { value: e.target.value })}
                    placeholder="Value (e.g. 50m)"
                    maxLength={200}
                  />
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    aria-label="Remove field"
                    className="flex h-[42px] w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--faint)] transition-colors hover:bg-[var(--neg)]/10 hover:text-[var(--neg)]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--ink)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

function FieldErr({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{msg}</p>;
}
