"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Barcode, Loader2, Printer, Save } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listCategories, getCachedCategories } from "@/services/category.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { FormSection, FormAsideCard, RequiredMark } from "@/components/ui/FormScaffold";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn, secondaryBtn, hintCls } from "@/components/ui/styles";
import type { CustomerStockEntry, StockEntryStatus } from "@/types/customer";
import type { Category } from "@/types/category";

// Standard units of measure — mirrors the IRM item form + backend UOM_OPTIONS.
const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

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
        // Tracking flags are set during receive — preserved here as-is (not editable on this screen).
        serialized: entry.serialized,
        serialNumber: entry.serialNumber ?? undefined,
        highValue: entry.highValue,
      });
      setEntry(updated);
      pushToast(isDraft ? "Stock entry activated." : "Stock entry updated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not save.", "alert");
    } finally {
      setSaving(false);
    }
  };

  // Print ONLY the barcode label (image + code) via a hidden iframe — not the whole page.
  // Waits for the image to load before printing, then cleans up. No popup-blocker issues.
  const printBarcodeLabel = () => {
    if (!entry.barcodeDataUri) return;
    const code = entry.barcode ?? "";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) { iframe.remove(); return; }
    doc.open();
    // Print page sized to the physical label (50×30mm thermal sticker) so the page IS the
    // label — no A4 white space. The barcode PNG already renders the human-readable code
    // beneath the bars, so we print just the image scaled to fill the label (no duplicate
    // code line). Adjust LABEL_W/LABEL_H if your label stock differs.
    const LABEL_W = "50mm", LABEL_H = "30mm";
    // @page margin:0 removes the browser's auto date/title/URL/page-number header & footer
    // (they're only drawn in the page margin), so the label prints clean. The quiet-zone
    // padding lives on the body instead.
    doc.write(
      `<!doctype html><html><head><title>${code}</title>` +
        `<style>@page{size:${LABEL_W} ${LABEL_H};margin:0}html,body{margin:0;padding:0}` +
        `body{display:flex;align-items:center;justify-content:center;min-height:${LABEL_H};padding:2mm;box-sizing:border-box}` +
        `img{width:100%;height:auto;max-height:calc(${LABEL_H} - 4mm);object-fit:contain}</style></head>` +
        `<body><img src="${entry.barcodeDataUri}" alt="${code}"/></body></html>`,
    );
    doc.close();
    const win = iframe.contentWindow;
    if (!win) { iframe.remove(); return; }
    const run = () => {
      win.focus();
      win.print();
      setTimeout(() => iframe.remove(), 500);
    };
    const img = doc.querySelector("img");
    if (img && !img.complete) {
      img.onload = run;
      img.onerror = run;
    } else {
      run();
    }
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

      {/* Main grid */}
      <form id="entry-form" onSubmit={handleSave}>
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: form fields */}
          <div className="space-y-6 lg:col-span-2">
            <FormSection title="Product details" description="Fill in the mandatory fields to activate this stock entry.">
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
                    options={UOM_OPTIONS.map((u) => ({ value: u, label: u }))}
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
                <div className="flex flex-col items-center gap-3 py-4">
                  <img
                    src={entry.barcodeDataUri}
                    alt={`Barcode ${entry.barcode}`}
                    className="max-w-xs"
                  />
                  <span className="font-mono text-sm font-bold text-[var(--ink)]">{entry.barcode}</span>
                  {fromWarehouse && (
                    <>
                      <button type="button" onClick={printBarcodeLabel} className={secondaryBtn}>
                        <Printer className="h-3.5 w-3.5" />
                        Print label
                      </button>
                      <p className={hintCls}>Print this barcode and attach it to the physical stock.</p>
                    </>
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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
