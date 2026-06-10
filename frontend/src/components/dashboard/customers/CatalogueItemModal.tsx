"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { CatalogueItem } from "@/types/customer";

// Units of measure for catalogue items (UK telecom field-services stock). Stored
// under the reserved `uom` key inside the item's flexible `attributes` JSON, so no
// schema change is needed and every other attribute is a free-form custom field.
export const UOM_KEY = "uom";
const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;

type CustomField = { id: number; key: string; value: string };

// Add / edit a per-customer catalogue item: name, SKU, category, unit of measure,
// plus any number of per-category custom fields (e.g. Length: 50m, Connector: LC).
export function CatalogueItemModal({
  customerId,
  item,
  onClose,
  onSaved,
}: {
  customerId: string;
  item: CatalogueItem | null; // null = create
  onClose: () => void;
  onSaved: (item: CatalogueItem) => void;
}) {
  const isEdit = Boolean(item);
  const [name, setName] = React.useState(item?.name ?? "");
  const [sku, setSku] = React.useState(item?.sku ?? "");
  const [category, setCategory] = React.useState(item?.category ?? "");
  const [uom, setUom] = React.useState(() => item?.attributes?.[UOM_KEY] ?? "");
  // Each row carries a stable id so React keys survive insert/remove — an
  // array-index key would reattach focus/IME/selection state to the wrong row when
  // a middle field is deleted. Initial rows seed from their position; new rows take
  // (max existing id + 1), which stays unique among current siblings without a ref.
  const [fields, setFields] = React.useState<CustomField[]>(() =>
    Object.entries(item?.attributes ?? {})
      .filter(([k]) => k !== UOM_KEY)
      .map(([key, value], i) => ({ id: i, key, value: String(value) })),
  );
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; sku?: string; category?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

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
    if (!category.trim()) errs.category = "Category is required.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    // Build the attributes map: any row with a (trimmed) key is kept, so attributes
    // loaded from the server round-trip faithfully — editing an unrelated field
    // never silently drops a stored attribute. Only fully-blank rows are discarded,
    // the reserved `uom` key can't be overridden by a custom row, and the unit of
    // measure is appended. Duplicate keys collapse (last wins).
    const attributes: Record<string, string> = {};
    for (const f of fields) {
      const key = f.key.trim();
      const value = f.value.trim();
      if (key && key.toLowerCase() !== UOM_KEY) attributes[key] = value;
    }
    if (uom) attributes[UOM_KEY] = uom;

    setBusy(true);
    setError(null);
    try {
      const payload = { name: name.trim(), sku: sku.trim(), category: category.trim(), attributes };
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
      subtitle="A per-customer stock item. No pricing is ever stored or shown to customers."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="catalogue-item-form" disabled={busy} className={primaryBtn}>
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
              onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: undefined })); }}
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
              onChange={(e) => { setSku(e.target.value); setErrors((p) => ({ ...p, sku: undefined })); }}
              placeholder="e.g. NTTP06CFE6"
              maxLength={80}
              aria-invalid={Boolean(errors.sku)}
            />
            <FieldErr msg={errors.sku} />
          </div>
          <div>
            <label className={labelCls}>Category<RequiredMark /></label>
            <input
              className={inputCls}
              value={category}
              onChange={(e) => { setCategory(e.target.value); setErrors((p) => ({ ...p, category: undefined })); }}
              placeholder="e.g. Optical"
              maxLength={80}
              aria-invalid={Boolean(errors.category)}
            />
            <FieldErr msg={errors.category} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Unit of measure</label>
            <select className={inputCls} value={uom} onChange={(e) => setUom(e.target.value)}>
              <option value="">— Not set</option>
              {UOM_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
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

function FieldErr({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{msg}</p>;
}
