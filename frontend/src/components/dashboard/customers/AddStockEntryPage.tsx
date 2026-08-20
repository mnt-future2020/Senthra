"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Barcode, Loader2, Save } from "lucide-react";

import { printLabels } from "@/lib/printBarcode";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";

import * as customerService from "@/services/customer.service";
import * as warehouseService from "@/services/warehouse.service";
import { listCategories, getCachedCategories } from "@/services/category.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { FieldError, FormAsideCard, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { inputCls, labelCls, primaryBtn, hintCls } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { UOM_SELECT_OPTIONS } from "@/lib/uom";
import { Select } from "@/components/ui/Select";
import type { CustomerStockEntry } from "@/types/customer";
import type { Category } from "@/types/category";
import type { PagedWarehouses } from "@/services/warehouse.service";


interface CustomerInfo {
  id: string;
  name: string;
  customerCode: string;
}

export function AddStockEntryPage({ customer }: { customer: CustomerInfo }) {
  const router = useRouter();
  const { pushToast } = useDashboard();

  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(() =>
    (getCachedCategories() ?? [])
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name })),
  );
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);

  const { isLoading: refLoading } = useReferenceData([
    {
      label: "categories",
      load: () => listCategories(),
      onData: (cats: Category[]) => setCategories(cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))),
    },
    {
      label: "warehouses",
      load: () => warehouseService.listWarehouses({ pageSize: 200 }),
      onData: (r: PagedWarehouses) => setWarehouses(r.warehouses.filter((w) => w.status === "active").map((w) => ({ id: w.id, name: w.name, code: w.code }))),
    },
  ]);

  const [itemName, setItemName] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [uom, setUom] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [warehouseId, setWarehouseId] = React.useState("");

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [generatingBarcode, setGeneratingBarcode] = React.useState(false);
  // Once created (e.g. by generating a barcode before saving), we update this
  // entry instead of creating a duplicate.
  const [created, setCreated] = React.useState<CustomerStockEntry | null>(null);
  // Lock BOTH buttons while either op runs; the ref additionally blocks a fast
  // double-trigger (Save + Generate) from creating two entries before `created` settles.
  const busy = saving || generatingBarcode;
  const creatingRef = React.useRef(false);

  const clearError = (key: string) => setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!itemName.trim()) errs.itemName = "Item name is required.";
    if (!categoryId) errs.categoryId = "Select a category.";
    if (!warehouseId) errs.warehouseId = "Select a warehouse.";
    const qty = parseInt(quantity, 10);
    if (!quantity || isNaN(qty) || qty < 1) errs.quantity = "Quantity must be at least 1.";
    return errs;
  };

  // Create the entry if not yet created, or update the already-created one. Returns
  // the persisted entry (or null on validation/error).
  const persist = async (): Promise<CustomerStockEntry | null> => {
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      return null;
    }
    setErrors({});
    if (created) {
      const updated = await customerService.updateStockEntry(created.id, {
        itemName: itemName.trim(),
        sku: sku.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        uom: uom.trim() || undefined,
      });
      setCreated(updated);
      return updated;
    }
    // A create is already in flight (e.g. Save and Generate clicked together) — don't
    // create a second entry; let the in-flight one win.
    if (creatingRef.current) return null;
    creatingRef.current = true;
    try {
      const entry = await customerService.createDirectStockEntry(customer.id, {
        warehouseId,
        itemName: itemName.trim(),
        sku: sku.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        uom: uom.trim() || undefined,
        quantity: parseInt(quantity, 10),
      });
      setCreated(entry);
      return entry;
    } finally {
      creatingRef.current = false;
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const entry = await persist();
      if (!entry) return;
      pushToast("Stock entry saved.", "success");
      // Back to the customer's Inventory list — no second save screen.
      router.replace(`/dashboard/customers/${customer.customerCode}?tab=catalogue`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not save stock entry.", "alert");
    } finally {
      setSaving(false);
    }
  };

  // One sticker per unit being received, matching the GRN receive + Add stock surfaces. Blank
  // tracks the Quantity field live; typing a number pins it.
  const [labelCopies, setLabelCopies] = React.useState("");
  const printBarcodeLabel = (count: number) => {
    if (!created?.barcodeDataUri) return;
    printLabels({ dataUri: created.barcodeDataUri, code: created.barcode ?? "", copies: count });
  };

  const handleGenerateBarcode = async () => {
    setGeneratingBarcode(true);
    try {
      const entry = created ?? (await persist());
      if (!entry) return; // validation failed
      const withBarcode = await customerService.generateStockEntryBarcode(entry.id);
      setCreated(withBarcode);
      pushToast("Barcode generated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not generate barcode.", "alert");
    } finally {
      setGeneratingBarcode(false);
    }
  };

  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="sticky -top-4 z-20 -mx-4 -mt-4 flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-4 shadow-sm md:-top-8 md:-mx-8 md:-mt-8 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            aria-label="Back"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--ink)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-extrabold tracking-tight text-[var(--ink)]">
              New stock entry
            </h1>
            <p className="truncate text-xs text-[var(--muted)]">
              {customer.name}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="submit"
            form="entry-form"
            disabled={busy}
            className={primaryBtn}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {created ? "Save changes" : "Create entry"}
          </button>
        </div>
      </div>

      {/* Main grid */}
      <form id="entry-form" onSubmit={handleSave}>
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: form fields */}
          <div className="space-y-6 lg:col-span-2">
            <FormSection title="Product details" description="Fill in the item details for this stock entry.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={labelCls}>Item name<RequiredMark /></label>
                  <input
                    className={inputCls}
                    value={itemName}
                    onChange={(e) => { setItemName(e.target.value); clearError("itemName"); }}
                    placeholder="e.g. Fibre Optic Cable SM 100M"
                    aria-invalid={Boolean(errors.itemName)}
                  />
                  <FieldError message={errors.itemName} />
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
                <div>
                  <label className={labelCls}>Category<RequiredMark /></label>
                  <Select
                    value={categoryId}
                    onChange={(v) => { setCategoryId(v); clearError("categoryId"); }}
                    options={categories.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder={refLoading && !categoryId ? "Loading categories…" : "— Select category —"}
                    disabled={refLoading && !categoryId}
                    ariaLabel="Category"
                    invalid={Boolean(errors.categoryId)}
                  />
                  <FieldError message={errors.categoryId} />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>Description</label>
                  <textarea
                    className={inputCls}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional product description"
                    maxLength={2000}
                  />
                </div>
                <div>
                  <label className={labelCls}>Unit of measure</label>
                  <Select
                    value={uom}
                    onChange={(v) => setUom(v)}
                    options={UOM_SELECT_OPTIONS}
                    placeholder="— Select unit —"
                    ariaLabel="Unit of measure"
                  />
                </div>
                <div>
                  <label className={labelCls}>Quantity<RequiredMark /></label>
                  <NumberInput
                    min={1}
                    className={inputCls}
                    value={quantity}
                    onChange={(e) => { setQuantity(e.target.value); clearError("quantity"); }}
                    placeholder="e.g. 10"
                    aria-invalid={Boolean(errors.quantity)}
                    disabled={Boolean(created)}
                  />
                  {created && <p className={hintCls}>Set on creation — cannot be changed here.</p>}
                  <FieldError message={errors.quantity} />
                </div>
              </div>
            </FormSection>

            <FormSection title="Warehouse" description="Select the warehouse where this item will be stored.">
              <div>
                <label className={labelCls}>Warehouse<RequiredMark /></label>
                <Select
                  value={warehouseId}
                  onChange={(v) => { setWarehouseId(v); clearError("warehouseId"); }}
                  options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))}
                  placeholder={refLoading && !warehouseId ? "Loading warehouses…" : "— Select warehouse —"}
                  ariaLabel="Warehouse"
                  required
                  invalid={Boolean(errors.warehouseId)}
                  disabled={Boolean(created) || (refLoading && !warehouseId)}
                />
                {created && <p className={hintCls}>Set on creation — cannot be changed here.</p>}
                <FieldError message={errors.warehouseId} />
              </div>
            </FormSection>

            {/* Tracking (serialized / high-value) intentionally omitted — the app doesn't use these flags
                (nothing downstream reads a user-set value; they stay false). See CustomerStockEntry in
                the Prisma schema for the full note. */}

            <FormSection title="Barcode" description="Generate a unique Code128 barcode for this stock entry.">
              {created?.barcodeDataUri ? (
                // The shared panel, same as every other barcode surface. This page used to render
                // the image with the hint "Print this barcode and attach it to the physical stock."
                // and NO print button anywhere — the instruction was a dead end, and you had to
                // navigate to the entry's detail page to actually print it.
                <div className="py-2">
                  <BarcodePanel
                    code={created.barcode ?? ""}
                    barcodeDataUri={created.barcodeDataUri}
                    canManage
                    busy={busy}
                    onGenerate={handleGenerateBarcode}
                    onPrint={printBarcodeLabel}
                    copies={labelCopies}
                    onCopiesChange={setLabelCopies}
                    defaultCopies={Number(quantity) || 1}
                  />
                  {/* Blank-box only — see StockEntryDetail: a pinned count is already on the button. */}
                  {labelCopies.trim() === "" && (
                    <p className={`${hintCls} mt-2`}>One sticker per unit — attach them to the physical stock.</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Barcode className="h-10 w-10 text-[var(--faint)]" />
                  <p className="text-sm text-[var(--muted)]">No barcode generated yet.</p>
                  <button
                    type="button"
                    onClick={handleGenerateBarcode}
                    disabled={busy}
                    className={primaryBtn}
                  >
                    {generatingBarcode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Barcode className="h-3.5 w-3.5" />}
                    Generate barcode
                  </button>
                  <p className={hintCls}>Generating will save this entry first.</p>
                </div>
              )}
            </FormSection>
          </div>

          {/* Right sidebar */}
          <div className="space-y-6">
            <FormAsideCard title="Entry summary">
              <div className="space-y-3 text-sm">
                <SummaryRow label="Status">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">
                    New
                  </span>
                </SummaryRow>
                <SummaryRow label="Customer">
                  <span className="font-semibold text-[var(--ink)]">{customer.name}</span>
                  <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{customer.customerCode}</span>
                </SummaryRow>
                {selectedWarehouse && (
                  <SummaryRow label="Warehouse">
                    <span className="font-semibold text-[var(--ink)]">{selectedWarehouse.name}</span>
                    <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{selectedWarehouse.code}</span>
                  </SummaryRow>
                )}
                {quantity && !isNaN(parseInt(quantity, 10)) && (
                  <SummaryRow label="Quantity">
                    <span className="font-bold text-[var(--ink)]">{parseInt(quantity, 10)}</span>
                  </SummaryRow>
                )}
              </div>
            </FormAsideCard>
          </div>
        </div>
      </form>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}
