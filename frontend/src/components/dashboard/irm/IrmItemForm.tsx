"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as irmService from "@/services/irm.service";
import { listIrmTypes, createIrmType } from "@/services/irm-type.service";
import { listIrmCategories, createIrmCategory } from "@/services/irm-category.service";
import { listSuppliers } from "@/services/supplier.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { IrmItem, IrmOwner } from "@/types/irm";
import type { IrmType } from "@/types/irm-type";
import type { IrmCategory } from "@/types/irm-category";
import type { Supplier } from "@/types/supplier";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { firstActiveId } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { NumberInput } from "@/components/ui/NumberInput";
import { CreatableSelect } from "@/components/ui/CreatableSelect";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormAsideCard, FormField, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import type { UserStatus } from "@/types/user";

// The IRM catalogue now lives in the Inventory Hub (Inventory → IRM → Catalogue), so that's the
// fallback "list" destination when there's no in-app history to go back to.
const IRM_LIST = "/dashboard/inventory?tab=company&irm=catalogue";
const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"];
const CURRENCY_OPTIONS = ["GBP", "EUR"];
const CURRENCY_LABELS: Record<string, string> = { GBP: "GBP (£)", EUR: "EUR (€)" };

type SupplierRow = { supplierId: string; isPrimary: boolean; priority: string; supplierSku: string; leadTimeDays: string };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
      {message}
    </p>
  );
}

const numStr = (n: number | null | undefined): string => (n == null ? "" : String(n));

export function IrmItemForm({ mode, item }: { mode: "create" | "edit"; item?: IrmItem | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();
  const { can } = useAuth();

  const o = item;
  const [name, setName] = React.useState(o?.name ?? "");
  const [typeId, setTypeId] = React.useState(o?.typeId ?? "");
  const [irmCategoryId, setIrmCategoryId] = React.useState(o?.irmCategoryId ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [brand, setBrand] = React.useState(o?.brand ?? "");
  const [manufacturer, setManufacturer] = React.useState(o?.manufacturer ?? "");
  const [mpn, setMpn] = React.useState(o?.mpn ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(o?.status ?? "active");
  const [sku, setSku] = React.useState(o?.sku ?? "");
  const [baseUnit, setBaseUnit] = React.useState(o?.baseUnit ?? "Each");
  const [packSize, setPackSize] = React.useState(numStr(o?.packSize));
  const [conversionRatio, setConversionRatio] = React.useState(numStr(o?.conversionRatio));
  const [minimumStock, setMinimumStock] = React.useState(numStr(o?.minimumStock));
  const [reorderLevel, setReorderLevel] = React.useState(numStr(o?.reorderLevel));
  const [reorderQuantity, setReorderQuantity] = React.useState(numStr(o?.reorderQuantity));
  const [maximumStock, setMaximumStock] = React.useState(numStr(o?.maximumStock));
  const [safetyStock, setSafetyStock] = React.useState(numStr(o?.safetyStock));
  const [criticalLevel, setCriticalLevel] = React.useState(numStr(o?.criticalLevel));
  const [standardCost, setStandardCost] = React.useState(numStr(o?.standardCost));
  const [currency, setCurrency] = React.useState(o?.currency ?? "GBP");
  const [vatRatePercent, setVatRatePercent] = React.useState(o ? numStr(o.vatRatePercent) : "20");
  // Tracking flags are code defaults (no UI): IRM items are inventory-tracked; serial/batch tracking
  // isn't used here. Existing values are preserved on edit; new items default to inventory-tracked.
  const trackInventory = o?.trackInventory ?? true;
  const trackSerialNumbers = o?.trackSerialNumbers ?? false;
  const trackBatchNumbers = o?.trackBatchNumbers ?? false;
  const [ownerUserId, setOwnerUserId] = React.useState(o?.ownerUserId ?? "");
  const [notes, setNotes] = React.useState(o?.notes ?? "");

  // Suppliers are optional, so an item with none starts with NO rows — the user adds one only if
  // the item is actually bought in.
  const [supplierRows, setSupplierRows] = React.useState<SupplierRow[]>(() =>
    (o?.suppliers ?? []).map((s) => ({
      supplierId: s.supplierId,
      isPrimary: s.isPrimary,
      priority: numStr(s.priority),
      supplierSku: s.supplierSku ?? "",
      leadTimeDays: numStr(s.leadTimeDays),
    })),
  );

  const [types, setTypes] = React.useState<IrmType[]>([]);
  const [categories, setCategories] = React.useState<IrmCategory[]>([]);
  const [owners, setOwners] = React.useState<IrmOwner[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const { isLoading: refLoading } = useReferenceData(
    [
      {
        label: "types",
        load: () => listIrmTypes(),
        onData: (t) => {
          setTypes(t);
          if (mode === "create") setTypeId((cur) => cur || firstActiveId(t));
        },
      },
      {
        label: "categories",
        load: () => listIrmCategories(),
        onData: (c) => {
          setCategories(c);
          if (mode === "create") setIrmCategoryId((cur) => cur || firstActiveId(c));
        },
      },
      { label: "owners", load: () => irmService.listOwnerOptions(), onData: (m) => setOwners(m) },
      { label: "suppliers", load: () => listSuppliers({ status: "active", pageSize: 100 }), onData: (r) => setSuppliers(r.suppliers) },
    ],
    [mode],
  );

  const typeOptions = React.useMemo(() => {
    const act = types.filter((t) => t.status === "active");
    if (o?.type && !act.some((t) => t.id === o.type!.id)) {
      return [{ id: o.type.id, name: `${o.type.name} (inactive)`, status: "inactive" } as IrmType, ...act];
    }
    return act;
  }, [types, o]);
  const categoryOptions = React.useMemo(() => {
    const act = categories.filter((c) => c.status === "active");
    if (o?.category && !act.some((c) => c.id === o.category!.id)) {
      return [{ id: o.category.id, name: `${o.category.name} (inactive)`, status: "inactive" } as IrmCategory, ...act];
    }
    return act;
  }, [categories, o]);
  const ownerOptions = React.useMemo(() => {
    if (o?.owner && !owners.some((m) => m.id === o.owner!.id)) {
      return [{ id: o.owner.id, name: `${o.owner.name} (inactive)`, email: o.owner.email, jobTitle: o.owner.jobTitle }, ...owners];
    }
    return owners;
  }, [owners, o]);
  // Supplier dropdown options: every ACTIVE supplier, plus any supplier already linked to
  // this item that is no longer active (shown as "Name (inactive)"), so editing other fields
  // never hides or silently drops a stale link. Mirrors the owner/type/category pattern; the
  // backend preserves already-linked suppliers and only requires NEW selections to be active.
  const supplierOptions = React.useMemo(() => {
    const opts = suppliers.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }));
    const known = new Set(suppliers.map((s) => s.id));
    const seen = new Set<string>();
    for (const link of o?.suppliers ?? []) {
      const s = link.supplier;
      if (s && !known.has(s.id) && !seen.has(s.id)) {
        seen.add(s.id);
        opts.push({ id: s.id, label: `${s.name} (inactive)` });
      }
    }
    return opts;
  }, [suppliers, o]);

  // Dirty detection — snapshot of every field captured on the first render.
  const liveKey = JSON.stringify({
    name, typeId, irmCategoryId, description, brand, manufacturer, mpn, status, sku,
    baseUnit, packSize, conversionRatio, minimumStock, reorderLevel, reorderQuantity, maximumStock, safetyStock,
    criticalLevel, standardCost, currency, vatRatePercent, trackInventory, trackSerialNumbers, trackBatchNumbers,
    ownerUserId, notes, supplierRows,
  });
  // Initial snapshot derived from the item prop (same shape/order as liveKey), so a
  // change to any field flips dirty. Computed from `o`, not a render-time ref read.
  const initialKey = React.useMemo(
    () =>
      JSON.stringify({
        name: o?.name ?? "",
        // On create, Type/Category are auto-preselected to the first active option — the
        // baseline must mirror that default so the preselect alone isn't read as an edit.
        typeId: mode === "create" ? firstActiveId(types) : (o?.typeId ?? ""),
        irmCategoryId: mode === "create" ? firstActiveId(categories) : (o?.irmCategoryId ?? ""),
        description: o?.description ?? "",
        brand: o?.brand ?? "",
        manufacturer: o?.manufacturer ?? "",
        mpn: o?.mpn ?? "",
        status: o?.status ?? "active",
        sku: o?.sku ?? "",
        baseUnit: o?.baseUnit ?? "Each",
        packSize: numStr(o?.packSize),
        conversionRatio: numStr(o?.conversionRatio),
        minimumStock: numStr(o?.minimumStock),
        reorderLevel: numStr(o?.reorderLevel),
        reorderQuantity: numStr(o?.reorderQuantity),
        maximumStock: numStr(o?.maximumStock),
        safetyStock: numStr(o?.safetyStock),
        criticalLevel: numStr(o?.criticalLevel),
        standardCost: numStr(o?.standardCost),
        currency: o?.currency ?? "GBP",
        vatRatePercent: o ? numStr(o.vatRatePercent) : "20",
        trackInventory: o?.trackInventory ?? true,
        trackSerialNumbers: o?.trackSerialNumbers ?? false,
        trackBatchNumbers: o?.trackBatchNumbers ?? false,
        ownerUserId: o?.ownerUserId ?? "",
        notes: o?.notes ?? "",
        supplierRows: (o?.suppliers ?? []).map((s) => ({
          supplierId: s.supplierId,
          isPrimary: s.isPrimary,
          priority: numStr(s.priority),
          supplierSku: s.supplierSku ?? "",
          leadTimeDays: numStr(s.leadTimeDays),
        })),
      }),
    [o, mode, types, categories],
  );
  const isDirty = !saved && liveKey !== initialKey;
  useReportDirty("irm-form", isDirty);

  const goBack = () =>
    guard.attemptLeave(() => {
      // Return to wherever the user came from (the Inventory Hub IRM tab with its filters intact, or
      // the item detail when editing). Fall back to the IRM catalogue if opened by a direct link.
      if (window.history.length > 1) router.back();
      else router.push(IRM_LIST);
    });
  const clearError = (field: string) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  // --- supplier-row helpers ---
  const setPrimary = (idx: number) => {
    setSupplierRows((rows) => rows.map((r, i) => ({ ...r, isPrimary: i === idx })));
    clearError("suppliers");
  };
  const updateRow = (idx: number, patch: Partial<SupplierRow>) => {
    setSupplierRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    clearError("suppliers");
  };
  const addRow = () =>
    setSupplierRows((rows) => [...rows, { supplierId: "", isPrimary: rows.length === 0, priority: "1", supplierSku: "", leadTimeDays: "" }]);
  // Removing the last row is allowed (suppliers are optional). When rows remain but the primary
  // was the one removed, promote the first survivor so a supplied item always has a primary.
  const removeRow = (idx: number) => {
    setSupplierRows((rows) => {
      const next = rows.filter((_, i) => i !== idx);
      if (next.length && !next.some((r) => r.isPrimary)) return next.map((r, i) => (i === 0 ? { ...r, isPrimary: true } : r));
      return next;
    });
    clearError("suppliers");
  };

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Item name is required.";
    else if (name.trim().length > 150) errs.name = "Keep this under 150 characters.";
    if (!typeId) errs.typeId = "Select an IRM type.";
    if (!irmCategoryId) errs.irmCategoryId = "Select an IRM category.";
    if (!baseUnit) errs.baseUnit = "Select a base unit.";

    // Suppliers are optional — an item may have none. Only the shape of the rows that DO name a
    // supplier is checked: unique, and at most one primary.
    const effective = supplierRows.filter((r) => r.supplierId);
    const ids = effective.map((r) => r.supplierId);
    const primaries = effective.filter((r) => r.isPrimary).length;
    if (new Set(ids).size !== ids.length) errs.suppliers = "Each supplier can only be added once.";
    else if (primaries > 1) errs.suppliers = "Only one supplier can be primary.";

    if (standardCost.trim() && (Number.isNaN(Number(standardCost)) || Number(standardCost) < 0)) {
      errs.standardCost = "Enter a valid cost (0 or more).";
    }
    if (vatRatePercent.trim()) {
      const v = Number(vatRatePercent);
      if (Number.isNaN(v) || v < 0 || v > 100) errs.vatRatePercent = "VAT must be 0–100%.";
    }
    const min = minimumStock.trim() ? Number(minimumStock) : null;
    const max = maximumStock.trim() ? Number(maximumStock) : null;
    if (min != null && max != null && max < min) errs.maximumStock = "Maximum must be ≥ minimum.";
    return errs;
  };

  const buildSuppliersPayload = (): irmService.IrmSupplierRowPayload[] =>
    supplierRows
      .filter((r) => r.supplierId)
      .map((r) => ({
        supplierId: r.supplierId,
        isPrimary: r.isPrimary,
        priority: r.priority.trim() || undefined,
        supplierSku: r.supplierSku.trim() || undefined,
        leadTimeDays: r.leadTimeDays.trim() || undefined,
      }));

  const basePayload = (): irmService.IrmItemPayload => ({
    name: name.trim(),
    typeId,
    irmCategoryId,
    description: description.trim(),
    brand: brand.trim(),
    manufacturer: manufacturer.trim(),
    mpn: mpn.trim(),
    status,
    sku: sku.trim(),
    suppliers: buildSuppliersPayload(),
    baseUnit,
    packSize: packSize.trim(),
    conversionRatio: conversionRatio.trim(),
    minimumStock: minimumStock.trim(),
    reorderLevel: reorderLevel.trim(),
    reorderQuantity: reorderQuantity.trim(),
    maximumStock: maximumStock.trim(),
    safetyStock: safetyStock.trim(),
    criticalLevel: criticalLevel.trim(),
    standardCost: standardCost.trim(),
    currency,
    vatRatePercent: vatRatePercent.trim(),
    trackInventory,
    trackSerialNumbers,
    trackBatchNumbers,
    ownerUserId,
    notes: notes.trim(),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      if (mode === "create") {
        const created = await irmService.createIrmItem(basePayload());
        setSaved(true);
        pushToast(`Item ${created.code} created.`, "success");
        router.replace(`/dashboard/irm/${created.code}`);
      } else if (o) {
        await irmService.updateIrmItem(o.id, basePayload());
        setSaved(true);
        pushToast("Item updated.", "success");
        router.replace(`/dashboard/irm/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the item.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "Add IRM item" : `Edit ${o?.name ?? "item"}`}
        subtitle={mode === "edit" && o ? o.code : "A new internal stock item"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create item" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Basic information" description="Name and how this item is classified.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>
                  Item name<RequiredMark />
                </label>
                <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); clearError("name"); }} placeholder="e.g. CAT6 U/UTP Cable, 305m box" maxLength={150} autoFocus aria-invalid={Boolean(errors.name)} />
                <FieldError id="err-name" message={errors.name} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">A clear name staff will recognise across similar items.</p>
              </div>
              <div>
                <label className={labelCls}>
                  Type<RequiredMark />
                </label>
                <CreatableSelect
                  value={typeId}
                  onChange={(id) => { setTypeId(id); clearError("typeId"); }}
                  options={typeOptions}
                  disabled={refLoading && !typeId}
                  placeholder={refLoading && !typeId ? "Loading types…" : undefined}
                  onCreate={async (name) => {
                    const t = await createIrmType({ name });
                    setTypes((prev) => [...prev, t]);
                    return { id: t.id, name: t.name };
                  }}
                  canCreate={can("irm_types.create") || can("irm.create") || can("irm.edit")}
                  canManage={can("irm_types.edit") || can("irm_types.delete")}
                  manageHref="/dashboard/inventory?tab=company&irm=catalogue&cat=types"
                  noun="type"
                  required
                  invalid={Boolean(errors.typeId)}
                  describedBy={errors.typeId ? "err-typeId" : undefined}
                />
                <FieldError id="err-typeId" message={errors.typeId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">What kind of item this is.</p>
              </div>
              <div>
                <label className={labelCls}>
                  Category<RequiredMark />
                </label>
                <CreatableSelect
                  value={irmCategoryId}
                  onChange={(id) => { setIrmCategoryId(id); clearError("irmCategoryId"); }}
                  options={categoryOptions}
                  disabled={refLoading && !irmCategoryId}
                  placeholder={refLoading && !irmCategoryId ? "Loading categories…" : undefined}
                  onCreate={async (name) => {
                    const c = await createIrmCategory({ name });
                    setCategories((prev) => [...prev, c]);
                    return { id: c.id, name: c.name };
                  }}
                  canCreate={can("irm_categories.create") || can("irm.create") || can("irm.edit")}
                  canManage={can("irm_categories.edit") || can("irm_categories.delete")}
                  manageHref="/dashboard/inventory?tab=company&irm=catalogue&cat=categories"
                  noun="category"
                  required
                  invalid={Boolean(errors.irmCategoryId)}
                  describedBy={errors.irmCategoryId ? "err-irmCategoryId" : undefined}
                />
                <FieldError id="err-irmCategoryId" message={errors.irmCategoryId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The material / domain category.</p>
              </div>
              <div>
                <label className={labelCls}>Brand</label>
                <input className={inputCls} value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={120} placeholder="e.g. Excel, CommScope" />
              </div>
              <div>
                <label className={labelCls}>Manufacturer</label>
                <input className={inputCls} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} maxLength={120} placeholder="e.g. CommScope Inc." />
              </div>
              <FormField>
                <label className={labelCls}>Manufacturer part number (MPN)</label>
                <input className={inputCls} value={mpn} onChange={(e) => setMpn(e.target.value)} maxLength={120} placeholder="e.g. 100-024-RL" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The maker&apos;s own part number, if known.</p>
              </FormField>
              <FormField>
                <label className={labelCls}>Status</label>
                <Select
                  value={status}
                  onChange={(v) => setStatus(v as "active" | "inactive")}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                  ariaLabel="Status"
                />
              </FormField>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea className={inputCls} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Specification, variant or usage notes (optional)." />
              </div>
            </div>
          </FormSection>

          <FormSection title="Identification" description="The item's internal SKU (optional). Unique forever once used. The printable Code128 label is generated separately from the item code.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>SKU</label>
                <input className={inputCls} value={sku} onChange={(e) => setSku(e.target.value)} maxLength={80} placeholder="e.g. IRM-CAT6-305" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Your internal code. Unique forever — it can&apos;t be reused once set.</p>
              </div>
            </div>
          </FormSection>

          <FormSection title="Suppliers" description="Every supplier that can provide this item. Optional — leave empty if this item isn't bought in. Mark one as primary. Lower priority numbers rank higher (1 = first choice).">
            <div className="space-y-3">
              {supplierRows.length === 0 && (
                <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
                  No suppliers linked to this item.
                </p>
              )}
              {supplierRows.map((row, idx) => (
                <div key={idx} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-12">
                    <FormField className="col-span-2 xl:col-span-4">
                      <label className={labelCls}>Supplier</label>
                      <Select
                        value={row.supplierId}
                        onChange={(v) => updateRow(idx, { supplierId: v })}
                        options={supplierOptions.map((s) => ({ value: s.id, label: s.label }))}
                        placeholder={refLoading && !row.supplierId ? "Loading suppliers…" : "— Select a supplier —"}
                        disabled={refLoading && !row.supplierId}
                        ariaLabel="Supplier"
                      />
                    </FormField>
                    <FormField className="xl:col-span-2">
                      <label className={labelCls}>Priority</label>
                      <NumberInput className={inputCls} min={0} value={row.priority} onChange={(e) => updateRow(idx, { priority: e.target.value })} placeholder="1" />
                    </FormField>
                    <FormField className="xl:col-span-3">
                      <label className={labelCls}>Supplier code</label>
                      <input className={inputCls} value={row.supplierSku} onChange={(e) => updateRow(idx, { supplierSku: e.target.value })} maxLength={80} placeholder="Supplier's code" aria-label="Supplier item code" />
                    </FormField>
                    <FormField className="xl:col-span-2">
                      <label className={labelCls}>Lead time</label>
                      <NumberInput className={inputCls} min={0} max={365} value={row.leadTimeDays} onChange={(e) => updateRow(idx, { leadTimeDays: e.target.value })} placeholder="days" />
                    </FormField>
                    <div className="col-span-2 flex items-end justify-between xl:col-span-1">
                      <button
                        type="button"
                        onClick={() => removeRow(idx)}
                        className="rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)]"
                        title="Remove supplier"
                        aria-label="Remove supplier"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs font-bold text-[var(--ink)]">
                    <input type="radio" name="primary-supplier" checked={row.isPrimary} onChange={() => setPrimary(idx)} className="accent-[var(--accent)]" />
                    Primary supplier
                  </label>
                </div>
              ))}
              <button type="button" onClick={addRow} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]">
                <Plus className="h-3.5 w-3.5" /> Add supplier
              </button>
              <FieldError id="err-suppliers" message={errors.suppliers} />
            </div>
          </FormSection>

          <FormSection title="Unit" description="How you count and (optionally) convert packs of this item.">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>
                  Base unit<RequiredMark />
                </label>
                <Select
                  value={baseUnit}
                  onChange={(v) => { setBaseUnit(v); clearError("baseUnit"); }}
                  options={UOM_OPTIONS.map((u) => ({ value: u, label: u }))}
                  ariaLabel="Base unit"
                  invalid={Boolean(errors.baseUnit)}
                />
                <FieldError id="err-baseUnit" message={errors.baseUnit} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The unit you store and count this item in.</p>
              </div>
              <div>
                <label className={labelCls}>Pack size</label>
                <NumberInput className={inputCls} min={1} value={packSize} onChange={(e) => setPackSize(e.target.value)} placeholder="e.g. 1" />
              </div>
              <div>
                <label className={labelCls}>Conversion</label>
                <NumberInput className={inputCls} min={0} step="any" value={conversionRatio} onChange={(e) => setConversionRatio(e.target.value)} placeholder="e.g. 305" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Base units in one pack — e.g. a 305 m box = 305.</p>
              </div>
            </div>
          </FormSection>

          <FormSection title="Stock policies" description="Advisory reorder thresholds, used by alerts once the inventory module is live. All optional.">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>Minimum stock</label>
                <NumberInput className={inputCls} min={0} value={minimumStock} onChange={(e) => { setMinimumStock(e.target.value); clearError("maximumStock"); }} placeholder="e.g. 50" />
              </div>
              <div>
                <label className={labelCls}>Reorder level</label>
                <NumberInput className={inputCls} min={0} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} placeholder="e.g. 100" />
              </div>
              <div>
                <label className={labelCls}>Reorder qty</label>
                <NumberInput className={inputCls} min={0} value={reorderQuantity} onChange={(e) => setReorderQuantity(e.target.value)} placeholder="e.g. 200" />
              </div>
              <div>
                <label className={labelCls}>Maximum stock</label>
                <NumberInput className={inputCls} min={0} value={maximumStock} onChange={(e) => { setMaximumStock(e.target.value); clearError("maximumStock"); }} placeholder="e.g. 500" aria-invalid={Boolean(errors.maximumStock)} />
                <FieldError id="err-maximumStock" message={errors.maximumStock} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Must be greater than or equal to minimum stock.</p>
              </div>
              <div>
                <label className={labelCls}>Safety stock</label>
                <NumberInput className={inputCls} min={0} value={safetyStock} onChange={(e) => setSafetyStock(e.target.value)} placeholder="e.g. 25" />
              </div>
              <div>
                <label className={labelCls}>Critical level</label>
                <NumberInput className={inputCls} min={0} value={criticalLevel} onChange={(e) => setCriticalLevel(e.target.value)} placeholder="e.g. 10" />
              </div>
            </div>
          </FormSection>

          <FormSection title="Cost" description="Internal cost — never shown to customers.">
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField>
                <label className={labelCls}>Standard cost ({currency === "EUR" ? "€" : "£"})</label>
                <NumberInput className={inputCls} min={0} step="0.01" value={standardCost} onChange={(e) => { setStandardCost(e.target.value); clearError("standardCost"); }} placeholder="e.g. 42.50" aria-invalid={Boolean(errors.standardCost)} />
                <FieldError id="err-standardCost" message={errors.standardCost} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Unit cost excluding VAT. Never shown to customers.</p>
              </FormField>
              <FormField>
                <label className={labelCls}>Currency</label>
                <Select
                  value={currency}
                  onChange={(v) => setCurrency(v)}
                  options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: CURRENCY_LABELS[c] ?? c }))}
                  ariaLabel="Currency"
                />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Defaults to GBP — change only if this item is priced in another currency.</p>
              </FormField>
              <FormField>
                <label className={labelCls}>VAT rate (%)</label>
                <NumberInput className={inputCls} min={0} max={100} step="0.01" value={vatRatePercent} onChange={(e) => { setVatRatePercent(e.target.value); clearError("vatRatePercent"); }} placeholder="e.g. 20" aria-invalid={Boolean(errors.vatRatePercent)} />
                <FieldError id="err-vatRatePercent" message={errors.vatRatePercent} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">UK standard rate is 20%. Use 5% or 0% where applicable.</p>
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Operations" description="Internal owner and notes.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Internal owner</label>
                <Select
                  value={ownerUserId}
                  onChange={(v) => setOwnerUserId(v)}
                  options={ownerOptions.map((m) => ({ value: m.id, label: m.jobTitle ? `${m.name} — ${m.jobTitle}` : m.name }))}
                  placeholder={refLoading && !ownerUserId ? "Loading owners…" : "— No owner assigned —"}
                  disabled={refLoading && !ownerUserId}
                  ariaLabel="Internal owner"
                />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The staff member responsible for this item (optional).</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Internal notes — handling, storage or procurement context." />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Code</p>
                <p className="font-mono text-[var(--ink)]">{mode === "edit" && o ? o.code : "Auto-assigned (IRM-####)"}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Status</p>
                <div className="mt-1">
                  <StatusBadge status={status as UserStatus} />
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">
                Cost is internal-only and never shown to customers. Stock balances are tracked later by the
                inventory module.
              </div>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
