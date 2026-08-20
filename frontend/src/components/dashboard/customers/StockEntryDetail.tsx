"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Barcode, CheckCircle2, Loader2, Save } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listCategories, getCachedCategories } from "@/services/category.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { FieldError, FormAsideCard, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { UOM_SELECT_OPTIONS } from "@/lib/uom";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn, secondaryBtn, hintCls } from "@/components/ui/styles";
import { printLabels, parseCopiesParam } from "@/lib/printBarcode";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";
import type { CustomerStockEntry, StockEntryStatus } from "@/types/customer";
import type { Category } from "@/types/category";
import { formatDate as fmtDate } from "@/lib/formatDate";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";


const STATUS_STYLE: Record<StockEntryStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "border-amber-400/30 bg-amber-400/10 text-amber-600" },
  active: { label: "Active", cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]" },
};

function EntryStatusBadge({ status }: { status: StockEntryStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function StockEntryDetail({ initial }: { initial: CustomerStockEntry }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  // Editing, activating, generating + printing a barcode are all WAREHOUSE-MANAGER actions, done from
  // the warehouse's Customer-pool inventory (?from=warehouse). Opened from the CUSTOMER module
  // (?from=customer, or no param) the page is strictly READ-ONLY — a PM only views; they never edit
  // or activate a customer's stock. So edit-ability is gated on BOTH the permission AND the context.
  const fromWarehouse = searchParams.get("from") === "warehouse";
  const canEdit = can("stock_requests.complete") && fromWarehouse;

  const [entry, setEntry] = React.useState(initial);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(() =>
    (getCachedCategories() ?? [])
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name })),
  );

  const { isLoading: refLoading } = useReferenceData([
    {
      label: "categories",
      load: () => listCategories(),
      onData: (cats: Category[]) => setCategories(cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))),
    },
  ]);

  // Form state — seeded from the entry.
  const [itemName, setItemName] = React.useState(entry.itemName);
  const [sku, setSku] = React.useState(entry.sku ?? "");
  const [categoryId, setCategoryId] = React.useState(entry.categoryId ?? "");
  const [description, setDescription] = React.useState(entry.description ?? "");
  const [uom, setUom] = React.useState(entry.uom ?? "");

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  // Set only by the draft → active transition in this session, so the "what now?" panel appears on
  // the save that earned it and not every time someone opens an entry that happens to be active.
  const [justActivated, setJustActivated] = React.useState(false);
  // Print-only control — never part of the saved entry, so it must not mark the form dirty.
  // Seeded from ?copies= when the Incoming list sends the warehouse manager here to label a top-up:
  // they need stickers for the units that just arrived, not for the entry's whole running total.
  // Anything out of range is ignored in favour of the blank default (= the entry quantity).
  const [copies, setCopies] = React.useState(() => {
    const seeded = parseCopiesParam(searchParams.get("copies"));
    return seeded == null ? "" : String(seeded);
  });
  const [generatingBarcode, setGeneratingBarcode] = React.useState(false);

  const clearError = (key: string) => setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });

  // Warehouse-manager action only — generate the Code128 barcode for this entry (then Print label).
  const handleGenerateBarcode = async () => {
    setGeneratingBarcode(true);
    try {
      const updated = await customerService.generateStockEntryBarcode(entry.id);
      setEntry(updated);
      clearError("barcode");
      pushToast("Barcode generated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not generate barcode.", "alert");
    } finally {
      setGeneratingBarcode(false);
    }
  };

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!itemName.trim()) errs.itemName = "Item name is required.";
    // Category is a required field for a trackable customer-stock entry.
    if (!categoryId) errs.categoryId = "Select a category.";
    // A draft can't go ACTIVE without a barcode — the WM must generate it (+ print + attach the
    // label) first. Surfaced as a section-level error below (mirrored server-side). An already-active
    // entry doesn't re-require it.
    if (entry.status === "draft" && !entry.barcode) errs.barcode = "Generate the barcode to activate this entry.";
    return errs;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      // The barcode requirement lives at the bottom of the form, so flag it with a toast too.
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const updated = await customerService.updateStockEntry(entry.id, {
        itemName: itemName.trim(),
        sku: sku.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        uom: uom.trim() || undefined,
        // No UI collects serialized / highValue anywhere (see CustomerStockEntry in the Prisma schema),
        // but the backend update overwrites them with `?? false` — so we MUST echo the entry's existing
        // values back or a plain name/SKU edit would silently reset them. Not a live feature; just don't
        // clobber the stored value.
        serialized: entry.serialized,
        serialNumber: entry.serialNumber ?? undefined,
        highValue: entry.highValue,
      });
      setEntry(updated);
      // Activation is the end of this entry's job, but NOT the end of the warehouse manager's: the
      // label still has to be printed and stuck on the physical stock. So don't navigate away on
      // save — that would yank them off the Print button. Surface the next step instead, plus a
      // one-click way back to the queue they were working through.
      if (isDraft && updated.status === "active") setJustActivated(true);
      pushToast(isDraft ? "Stock entry activated." : "Stock entry updated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not save.", "alert");
    } finally {
      setSaving(false);
    }
  };

  // One sticker per physical unit, so the copy count defaults to the quantity actually received.
  // Blank means "track the quantity"; typing a number pins it (reprinting the three that smudged).
  // Resolving + clamping + validating the count is BarcodePanel's job now (via lib/printBarcode),
  // so the rules can't drift between this page, the GRN form and the ?copies= URL param again.
  const printBarcodeLabel = (count: number) => {
    if (!entry.barcodeDataUri) return;
    printLabels({ dataUri: entry.barcodeDataUri, code: entry.barcode ?? "", copies: count });
  };

  const isDraft = entry.status === "draft";

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
              {entry.itemName}
            </h1>
            <p className="truncate text-xs text-[var(--muted)]">
              {entry.customerName} · {entry.warehouseName}
              {entry.barcode && <span className="ml-2 font-mono">{entry.barcode}</span>}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <EntryStatusBadge status={entry.status} />
          {canEdit && (
            <button
              type="submit"
              form="entry-form"
              disabled={saving}
              className={primaryBtn}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {isDraft ? "Save & Activate" : "Save"}
            </button>
          )}
        </div>
      </div>

      {/* Post-activation next step. Deliberately NOT an auto-redirect: the label still has to be
          printed and attached, and navigating away on save would skip that. `warehouseCode` gives a
          deterministic link back to the queue rather than relying on history depth. */}
      {justActivated && fromWarehouse && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--pos)]/30 bg-[var(--pos)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--pos)]" />
            <p className="text-xs leading-relaxed text-[var(--ink)]">
              <span className="font-bold">Stock entry activated.</span>{" "}
              Print the barcode label below and attach it to the physical stock.
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push(`/dashboard/warehouses/${entry.warehouseCode}?tab=incoming&pool=customer`)}
            className={`${secondaryBtn} shrink-0`}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Incoming stock
          </button>
        </div>
      )}

      {/* Main grid */}
      <form id="entry-form" onSubmit={handleSave}>
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: form fields */}
          <div className="space-y-6 lg:col-span-2">
            {/* The activation prompt is only true while the entry is a draft. Leaving it up on an
                ACTIVE entry made a successful save look like a no-op — the status badge had flipped
                and the button had changed to "Save", but the form still asked to activate. */}
            <FormSection
              title="Product details"
              description={
                isDraft
                  ? "Fill in the mandatory fields to activate this stock entry."
                  : "Product details for this stock entry. Quantity is set by receiving."
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={labelCls}>Item name<RequiredMark /></label>
                  <input
                    className={inputCls}
                    value={itemName}
                    onChange={(e) => { setItemName(e.target.value); clearError("itemName"); }}
                    aria-invalid={Boolean(errors.itemName)}
                    disabled={!canEdit}
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
                    disabled={!canEdit}
                  />
                </div>
                <div>
                  <label className={labelCls}>Category<RequiredMark /></label>
                  <Select
                    value={categoryId}
                    onChange={(v) => { setCategoryId(v); clearError("categoryId"); }}
                    options={categories.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder={refLoading && !categoryId ? "Loading categories…" : "— Select category —"}
                    ariaLabel="Category"
                    invalid={Boolean(errors.categoryId)}
                    disabled={!canEdit || (refLoading && !categoryId)}
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
                    disabled={!canEdit}
                  />
                </div>
                <div>
                  <label className={labelCls}>Unit of measure</label>
                  <Select
                    value={uom}
                    onChange={(v) => setUom(v)}
                    options={UOM_SELECT_OPTIONS}
                    placeholder="— Select unit —"
                    disabled={!canEdit}
                    ariaLabel="Unit of measure"
                  />
                </div>
                <div>
                  <label className={labelCls}>Quantity</label>
                  <input
                    className={inputCls}
                    value={entry.quantity}
                    disabled
                  />
                  <p className={hintCls}>Set during receive — cannot be changed here.</p>
                </div>
              </div>
            </FormSection>

            {/* Barcode section */}
            <FormSection
              title={<>Barcode{isDraft && <RequiredMark />}</>}
              description="Code128 barcode for this stock entry. Generated by the warehouse manager, who prints the label and attaches it to the physical stock."
              invalid={Boolean(errors.barcode)}
            >
              {entry.barcodeDataUri ? (
                // The SHARED panel, same as IRM item detail / Add stock / GRN receive. This page
                // used to hand-roll its own copy of it, and printing was hidden behind
                // `fromWarehouse` — a ?from= query param, not a permission — so the very same entry
                // could be printed when reached from the warehouse Incoming list and not when
                // reached from the customer's stock tab or an inventory search. Printing reuses the
                // stored image and creates nothing, so it belongs to anyone who can see the entry.
                <div className="py-2">
                  <BarcodePanel
                    code={entry.barcode ?? ""}
                    barcodeDataUri={entry.barcodeDataUri}
                    canManage={canEdit}
                    busy={generatingBarcode}
                    onGenerate={handleGenerateBarcode}
                    onPrint={printBarcodeLabel}
                    copies={copies}
                    onCopiesChange={setCopies}
                    defaultCopies={entry.quantity}
                  />
                  {/* Only while the box is blank: once a count is pinned the button states it
                      exactly, and "one sticker per unit" would be describing a different number. */}
                  {copies.trim() === "" && (
                    <p className={`${hintCls} mt-2`}>One sticker per unit — attach them to the physical stock.</p>
                  )}
                </div>
              ) : canEdit ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Barcode className="h-10 w-10 text-[var(--faint)]" />
                  <p className="text-sm text-[var(--muted)]">No barcode generated yet.</p>
                  <button
                    type="button"
                    onClick={handleGenerateBarcode}
                    disabled={generatingBarcode}
                    className={primaryBtn}
                  >
                    {generatingBarcode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Barcode className="h-3.5 w-3.5" />}
                    Generate barcode
                  </button>
                  <p className={hintCls}>Generate, print the label and attach it to the stock before activating.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <Barcode className="h-10 w-10 text-[var(--faint)]" />
                  <p className="text-sm text-[var(--muted)]">No barcode yet.</p>
                  <p className={hintCls}>The warehouse manager generates the barcode when handling this stock.</p>
                </div>
              )}
              <FieldError message={errors.barcode} />
            </FormSection>
          </div>

          {/* Right sidebar */}
          <div className="space-y-6">
            <FormAsideCard title="Entry summary">
              <div className="space-y-3 text-sm">
                <SummaryRow label="Status">
                  <EntryStatusBadge status={entry.status} />
                </SummaryRow>
                <SummaryRow label="Customer">
                  <span className="font-semibold text-[var(--ink)]">{entry.customerName}</span>
                  <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{entry.customerCode}</span>
                </SummaryRow>
                <SummaryRow label="Warehouse">
                  <span className="font-semibold text-[var(--ink)]">{entry.warehouseName}</span>
                  {entry.warehouseCode && (
                    <span className="ml-1 font-mono text-[11px] text-[var(--faint)]">{entry.warehouseCode}</span>
                  )}
                </SummaryRow>
                <SummaryRow label="Quantity">
                  <span className="font-bold text-[var(--ink)]">{entry.quantity}</span>
                </SummaryRow>
                {entry.categoryName && (
                  <SummaryRow label="Category">
                    <span className="text-[var(--ink)]">{entry.categoryName}</span>
                  </SummaryRow>
                )}
                {entry.receivedBy && (
                  <SummaryRow label="Received by">
                    <span className="text-[var(--ink)]">{entry.receivedBy}</span>
                  </SummaryRow>
                )}
                {entry.receivedAt && (
                  <SummaryRow label="Received">
                    <span className="text-[var(--ink)]">{fmtDate(entry.receivedAt)}</span>
                  </SummaryRow>
                )}
                <SummaryRow label="Created">
                  <span className="text-[var(--ink)]">{fmtDate(entry.createdAt)}</span>
                </SummaryRow>
              </div>
            </FormAsideCard>

            {entry.barcodeDataUri && (
              <FormAsideCard title="Barcode">
                <div className="flex flex-col items-center gap-2">
                  <img
                    src={entry.barcodeDataUri}
                    alt={`Barcode ${entry.barcode}`}
                    className="w-full max-w-[180px]"
                  />
                  <span className="font-mono text-xs font-bold text-[var(--ink)]">{entry.barcode}</span>
                </div>
              </FormAsideCard>
            )}
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

