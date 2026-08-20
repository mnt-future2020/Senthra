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
import type { IrmItem } from "@/types/irm";
import type { IrmType } from "@/types/irm-type";
import type { IrmCategory } from "@/types/irm-category";
import type { Supplier } from "@/types/supplier";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { firstActiveId } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { NumberInput } from "@/components/ui/NumberInput";
import { CreatableSelect } from "@/components/ui/CreatableSelect";
import { UOM_SELECT_OPTIONS } from "@/lib/uom";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FieldError, FormAsideCard, FormField, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import type { UserStatus } from "@/types/user";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { buildSkuCandidate, categoryPrefix, findSkuPrefixMismatch, normalizeSku } from "@/lib/irmSku";

// The IRM catalogue now lives in the Inventory Hub (Inventory → IRM → Catalogue), so that's the
// fallback "list" destination when there's no in-app history to go back to.
const IRM_LIST = "/dashboard/inventory?tab=company&irm=catalogue";
const CURRENCY_OPTIONS = ["GBP", "EUR"];
const CURRENCY_LABELS: Record<string, string> = { GBP: "GBP (£)", EUR: "EUR (€)" };

type SupplierRow = { supplierId: string; isPrimary: boolean; priority: string; supplierSku: string; leadTimeDays: string };

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
  // On CREATE the SKU follows the name + category until the user types their own. On EDIT it never
  // auto-follows: the item already has a SKU, and changing it burns the old one forever.
  const [skuTouched, setSkuTouched] = React.useState(mode === "edit");
  const [baseUnit, setBaseUnit] = React.useState(o?.baseUnit ?? "Each");
  const [packSize, setPackSize] = React.useState(numStr(o?.packSize));
  const [reorderLevel, setReorderLevel] = React.useState(numStr(o?.reorderLevel));
  const [maximumStock, setMaximumStock] = React.useState(numStr(o?.maximumStock));
  const [criticalLevel, setCriticalLevel] = React.useState(numStr(o?.criticalLevel));
  const [standardCost, setStandardCost] = React.useState(numStr(o?.standardCost));
  const [currency, setCurrency] = React.useState(o?.currency ?? "GBP");
  const [vatRatePercent, setVatRatePercent] = React.useState(o ? numStr(o.vatRatePercent) : "20");
  // Tracking flags are code defaults (no UI): IRM items are inventory-tracked; serial/batch tracking
  // isn't used here. Existing values are preserved on edit; new items default to inventory-tracked.
  const trackInventory = o?.trackInventory ?? true;
  const trackSerialNumbers = o?.trackSerialNumbers ?? false;
  const trackBatchNumbers = o?.trackBatchNumbers ?? false;
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

  // The category's NAME drives the SKU prefix (Cable -> CAB), so it has to be resolved from the
  // loaded master rather than the selected id alone.
  const selectedCategoryName = React.useMemo(
    () => categories.find((c) => c.id === irmCategoryId)?.name ?? o?.category?.name ?? null,
    [categories, irmCategoryId, o],
  );
  // Suggest nothing until there is a name to build from — otherwise a freshly-opened create form
  // would start with a bare category code in the box and count as unsaved work straight away.
  const suggestedSku = name.trim() ? buildSkuCandidate(name, selectedCategoryName) : "";
  // What the field shows, what gets validated, and what gets sent. Deriving it (rather than writing
  // state from an effect) keeps the auto-fill out of React's render cycle entirely.
  const effectiveSku = skuTouched ? sku : suggestedSku;

  // On EDIT the SKU never re-follows the category — it is a permanent identifier, and rewriting it
  // would strand printed labels (the goods/van-stock scan resolves on skuLower) and disagree with
  // the SKU already snapshotted onto every past PO, GRN and kit line. But an item re-categorised
  // after its SKU was set does end up carrying the wrong category's code, so say so and let the
  // person decide. Only fires when the leading segment is ANOTHER CATEGORY's code: a hand-written
  // SKU like CAT6-305-BOX or LC-UPC-SM matches no category and is left alone.
  // The field auto-follows the name + category on create until the user types their own, so a
  // "use the suggestion" control only has work to do once they HAVE typed something different.
  // Shown then and only then — a button that restores the state you are already in is furniture.
  // Edit deliberately has no such control: the SKU there is a live identifier, and one click that
  // rewrites it would strand printed labels and burn the old value forever. The one case worth
  // acting on (the item was re-categorised) is offered by skuPrefixMismatch below instead.
  const canUseSuggestedSku =
    mode === "create" && skuTouched && Boolean(suggestedSku) && normalizeSku(effectiveSku) !== suggestedSku;

  const skuPrefixMismatch = React.useMemo(
    () =>
      mode === "edit" && suggestedSku
        ? findSkuPrefixMismatch(effectiveSku, selectedCategoryName, categories, irmCategoryId)
        : null,
    [mode, suggestedSku, effectiveSku, selectedCategoryName, categories, irmCategoryId],
  );

  // Dirty detection — snapshot of every field captured on the first render.
  const liveKey = JSON.stringify({
    name, typeId, irmCategoryId, description, brand, manufacturer, mpn, status, sku: effectiveSku,
    baseUnit, packSize, reorderLevel, maximumStock, criticalLevel, standardCost, currency, vatRatePercent, trackInventory, trackSerialNumbers, trackBatchNumbers,
    notes, supplierRows,
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
        reorderLevel: numStr(o?.reorderLevel),
        maximumStock: numStr(o?.maximumStock),
        criticalLevel: numStr(o?.criticalLevel),
        standardCost: numStr(o?.standardCost),
        currency: o?.currency ?? "GBP",
        vatRatePercent: o ? numStr(o.vatRatePercent) : "20",
        trackInventory: o?.trackInventory ?? true,
        trackSerialNumbers: o?.trackSerialNumbers ?? false,
        trackBatchNumbers: o?.trackBatchNumbers ?? false,
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
    // Mandatory on create AND edit. The auto-suggestion normally fills this, so an empty box means
    // the user deliberately cleared it — which the server refuses too.
    if (!normalizeSku(effectiveSku)) errs.sku = "SKU is required.";

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
    // Mirrors packSizeField in irm.validation.ts. NumberInput blocks e/E/+/- but NOT the decimal
    // point, so "2.5" reaches here looking fine and is only refused by the server — a round trip for
    // something the form already knows. Whole packs is the whole point: half a box can't be ordered.
    if (packSize.trim()) {
      const n = Number(packSize);
      if (!Number.isInteger(n)) errs.packSize = "Pack size must be a whole number.";
      else if (n < 1) errs.packSize = "Pack size must be at least 1.";
      else if (n > 1_000_000) errs.packSize = "Pack size can't be more than 1,000,000.";
    }
    // Mirrors the server: critical ≤ reorder ≤ maximum. This used to compare the maximum against
    // `minimumStock`, a field the reorder engine never read — the only cross-field rule on the form
    // was guarding a number that changed nothing.
    const reorder = reorderLevel.trim() ? Number(reorderLevel) : null;
    const max = maximumStock.trim() ? Number(maximumStock) : null;
    const critical = criticalLevel.trim() ? Number(criticalLevel) : null;
    if (reorder != null && max != null && max < reorder) {
      errs.maximumStock = "Maximum must be ≥ the reorder level — an order has to lift stock clear of it.";
    }
    if (reorder != null && critical != null && critical > reorder) {
      errs.criticalLevel = "Critical must be at or below the reorder level.";
    } else if (critical != null && max != null && critical > max) {
      // Closes the chain — both rules above need a reorder level, so with it blank nothing compared
      // these two. `else if` so a row failing both only reports the more specific one.
      errs.criticalLevel = "Critical must be at or below the maximum stock.";
    }
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
    sku: normalizeSku(effectiveSku),
    suppliers: buildSuppliersPayload(),
    baseUnit,
    packSize: packSize.trim(),
    reorderLevel: reorderLevel.trim(),
    maximumStock: maximumStock.trim(),
    criticalLevel: criticalLevel.trim(),
    standardCost: standardCost.trim(),
    currency,
    vatRatePercent: vatRatePercent.trim(),
    trackInventory,
    trackSerialNumbers,
    trackBatchNumbers,
    notes: notes.trim(),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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

          {/* Don't explain the barcode here: the Code128 label is rendered FROM the item's `code`,
              and BarcodePanel says so where the barcode actually lives. */}
          <FormSection title="Identification" description="The item's internal SKU — suggested from the name and category, and unique forever once used.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex items-end justify-between gap-2">
                  <label className={labelCls} htmlFor="irm-sku">
                    SKU<RequiredMark />
                  </label>
                  {canUseSuggestedSku && (
                    <button
                      type="button"
                      className="mb-1.5 text-[11px] font-bold text-[var(--accent)] hover:underline"
                      // Hands the field back to the name + category rather than pasting a frozen
                      // value, so changing either afterwards keeps updating it.
                      onClick={() => { setSkuTouched(false); clearError("sku"); }}
                      title={`Use ${suggestedSku}`}
                    >
                      Use suggested
                    </button>
                  )}
                </div>
                <input
                  id="irm-sku"
                  className={inputCls}
                  value={effectiveSku}
                  onChange={(e) => { setSkuTouched(true); setSku(e.target.value); clearError("sku"); }}
                  // Fold to the stored shape once they look away, so the box matches what the server
                  // will save rather than surprising them with a rewrite after submit.
                  onBlur={() => skuTouched && setSku((cur) => normalizeSku(cur))}
                  maxLength={80}
                  placeholder="e.g. CAB-CAT6-305M"
                  aria-invalid={Boolean(errors.sku)}
                  aria-describedby={errors.sku ? "err-sku" : undefined}
                />
                <FieldError id="err-sku" message={errors.sku} />
                {skuPrefixMismatch && (
                  <p className="mt-1.5 text-[11px] text-amber-600">
                    Starts {skuPrefixMismatch.head}- ({skuPrefixMismatch.owner}), not {categoryPrefix(selectedCategoryName)}-.{" "}
                    <button
                      type="button"
                      className="font-bold underline"
                      onClick={() => { setSku(suggestedSku); setSkuTouched(true); clearError("sku"); }}
                    >
                      Use {suggestedSku}
                    </button>{" "}
                    — only if no labels are printed yet.
                  </p>
                )}
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {mode === "create" && !skuTouched
                    ? "Following the item name and category. Type here to set your own."
                    : "Unique forever — it can’t be reused once set, even by a removed item."}
                </p>
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

          <FormSection title="Unit" description="How you count this item, and how many come in a pack.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>
                  Base unit<RequiredMark />
                </label>
                <Select
                  value={baseUnit}
                  onChange={(v) => { setBaseUnit(v); clearError("baseUnit"); }}
                  options={UOM_SELECT_OPTIONS}
                  ariaLabel="Base unit"
                  invalid={Boolean(errors.baseUnit)}
                />
                <FieldError id="err-baseUnit" message={errors.baseUnit} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The unit you store and count this item in.</p>
              </div>
              {/* "Conversion" used to sit beside this. It was captured and then read by nothing — no
                  calculation, no report, no document — so it asked for a number and quietly did
                  nothing with it. Pack size is the one that acts: the reorder engine rounds a
                  suggested quantity UP to whole packs. */}
              <div>
                <label className={labelCls}>Pack size</label>
                <NumberInput
                  className={inputCls}
                  min={1}
                  max={1_000_000}
                  step={1}
                  value={packSize}
                  onChange={(e) => { setPackSize(e.target.value); clearError("packSize"); }}
                  aria-invalid={Boolean(errors.packSize)}
                  aria-describedby={errors.packSize ? "err-packSize" : undefined}
                  placeholder="e.g. 305"
                />
                <FieldError id="err-packSize" message={errors.packSize} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Base units in one pack — e.g. a 305 m box = 305. Reorder suggestions round up to whole packs.</p>
              </div>
            </div>
          </FormSection>

          {/* THREE thresholds, and they stack: critical ≤ reorder ≤ maximum. There were six — the
              other three (Minimum stock, Reorder qty, Safety stock) were read by nothing. "Minimum
              stock" was the harmful one: it is the phrase everyone knows, so people filled it in
              believing it set the trigger while Reorder level silently did. Every field here now
              says what it drives, because the reason the wrong box got used was that none of them
              said anything at all. */}
          <FormSection title="Stock policies" description="When to reorder, how far to top up, and when it becomes urgent. All optional — leave blank for items you don't replenish.">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>Reorder level</label>
                <NumberInput className={inputCls} min={0} value={reorderLevel} onChange={(e) => { setReorderLevel(e.target.value); clearError("maximumStock"); clearError("criticalLevel"); }} placeholder="e.g. 100" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Order when stock drops to this — your minimum.</p>
              </div>
              <div>
                <label className={labelCls}>Maximum stock</label>
                <NumberInput className={inputCls} min={0} value={maximumStock} onChange={(e) => { setMaximumStock(e.target.value); clearError("maximumStock"); }} placeholder="e.g. 500" aria-invalid={Boolean(errors.maximumStock)} aria-describedby={errors.maximumStock ? "err-maximumStock" : undefined} />
                <FieldError id="err-maximumStock" message={errors.maximumStock} />
                {/* Short like its siblings. The blank-maximum warning is REAL but only matters once a
                    reorder level exists — printed always it was three lines of noise against their
                    one, and noise beside two useful hints is what gets all three stopped being read.
                    Shown exactly when it applies instead. */}
                {reorderLevel.trim() && !maximumStock.trim() ? (
                  <p className="mt-1.5 text-[11px] text-amber-600">Blank — orders will only restore the reorder level, so it triggers again straight away.</p>
                ) : (
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">Top up to this when reordering.</p>
                )}
              </div>
              <div>
                <label className={labelCls}>Critical level</label>
                <NumberInput className={inputCls} min={0} value={criticalLevel} onChange={(e) => { setCriticalLevel(e.target.value); clearError("criticalLevel"); }} placeholder="e.g. 10" aria-invalid={Boolean(errors.criticalLevel)} aria-describedby={errors.criticalLevel ? "err-criticalLevel" : undefined} />
                <FieldError id="err-criticalLevel" message={errors.criticalLevel} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Flags the row as urgent. Doesn&apos;t change how much is ordered.</p>
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

          {/* Was "Operations" — named for the tracking toggles that used to sit here. Those were removed
              deliberately, and the heading stayed on describing a section that holds only notes. */}
          <FormSection title="Notes" description="Internal context for whoever handles or buys this item.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
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
                {/* No prefix quoted here. It is configurable in Settings → Branding, and this form cannot
                    read it — the full settings payload needs `settings.view`, which a person adding a
                    catalogue item may well not have, and the PUBLIC branding endpoint (served to the
                    login page with no auth) is no place for internal numbering conventions. A
                    hardcoded guess is worse than silence: it read "IRM-####" while the configured
                    prefix was something else entirely. */}
                <p className="font-mono text-[var(--ink)]">{mode === "edit" && o ? o.code : "Auto-assigned on save"}</p>
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
