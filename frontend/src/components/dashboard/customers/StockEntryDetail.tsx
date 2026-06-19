"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Barcode, Loader2, Save } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { listCategories, getCachedCategories } from "@/services/category.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { FormSection, FormAsideCard, RequiredMark } from "@/components/ui/FormScaffold";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn, hintCls } from "@/components/ui/styles";
import type { CustomerStockEntry, StockEntryStatus } from "@/types/customer";

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
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const canEdit = can("stock_requests.complete");

  const [entry, setEntry] = React.useState(initial);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>(() =>
    (getCachedCategories() ?? [])
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name })),
  );

  React.useEffect(() => {
    listCategories()
      .then((cats) =>
        setCategories(
          cats.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })),
        ),
      )
      .catch(() => {});
  }, []);

  // Form state — seeded from the entry.
  const [itemName, setItemName] = React.useState(entry.itemName);
  const [sku, setSku] = React.useState(entry.sku ?? "");
  const [categoryId, setCategoryId] = React.useState(entry.categoryId ?? "");
  const [description, setDescription] = React.useState(entry.description ?? "");
  const [uom, setUom] = React.useState(entry.uom ?? "");
  const [serialized, setSerialized] = React.useState(entry.serialized);
  const [serialNumber, setSerialNumber] = React.useState(entry.serialNumber ?? "");
  const [highValue, setHighValue] = React.useState(entry.highValue);

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [generatingBarcode, setGeneratingBarcode] = React.useState(false);

  const clearError = (key: string) => setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!itemName.trim()) errs.itemName = "Item name is required.";
    if (serialized && !serialNumber.trim()) errs.serialNumber = "Serial number is required for serialized items.";
    return errs;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
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
        serialized,
        serialNumber: serialNumber.trim() || undefined,
        highValue,
      });
      setEntry(updated);
      pushToast("Stock entry updated and activated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not save.", "alert");
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateBarcode = async () => {
    setGeneratingBarcode(true);
    try {
      const updated = await customerService.generateStockEntryBarcode(entry.id);
      setEntry(updated);
      pushToast("Barcode generated.", "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not generate barcode.", "alert");
    } finally {
      setGeneratingBarcode(false);
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
                  <label className={labelCls}>Category</label>
                  <Select
                    value={categoryId}
                    onChange={(v) => setCategoryId(v)}
                    options={categories.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder="— Select category —"
                    ariaLabel="Category"
                    disabled={!canEdit}
                  />
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
                  <input
                    className={inputCls}
                    value={uom}
                    onChange={(e) => setUom(e.target.value)}
                    placeholder="e.g. Each, Metre, Box"
                    disabled={!canEdit}
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

            <FormSection title="Tracking" description="Serial number and high-value designation.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="serialized"
                    checked={serialized}
                    onChange={(e) => { setSerialized(e.target.checked); if (!e.target.checked) clearError("serialNumber"); }}
                    className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
                    disabled={!canEdit}
                  />
                  <label htmlFor="serialized" className="text-sm font-semibold text-[var(--ink)]">
                    Serialized item
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="highValue"
                    checked={highValue}
                    onChange={(e) => setHighValue(e.target.checked)}
                    className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
                    disabled={!canEdit}
                  />
                  <label htmlFor="highValue" className="text-sm font-semibold text-[var(--ink)]">
                    High-value item
                  </label>
                </div>
                {serialized && (
                  <div className="sm:col-span-2">
                    <label className={labelCls}>Serial number<RequiredMark /></label>
                    <input
                      className={inputCls}
                      value={serialNumber}
                      onChange={(e) => { setSerialNumber(e.target.value); clearError("serialNumber"); }}
                      aria-invalid={Boolean(errors.serialNumber)}
                      disabled={!canEdit}
                    />
                    <FieldError message={errors.serialNumber} />
                  </div>
                )}
              </div>
            </FormSection>

            {/* Barcode section */}
            <FormSection title="Barcode" description="Generate a unique Code128 barcode for this stock entry.">
              {entry.barcodeDataUri ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <img
                    src={entry.barcodeDataUri}
                    alt={`Barcode ${entry.barcode}`}
                    className="max-w-xs"
                  />
                  <span className="font-mono text-sm font-bold text-[var(--ink)]">{entry.barcode}</span>
                  <p className={hintCls}>Print this barcode and attach it to the physical stock.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-6">
                  <Barcode className="h-10 w-10 text-[var(--faint)]" />
                  <p className="text-sm text-[var(--muted)]">No barcode generated yet.</p>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={handleGenerateBarcode}
                      disabled={generatingBarcode}
                      className={primaryBtn}
                    >
                      {generatingBarcode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Barcode className="h-3.5 w-3.5" />}
                      Generate barcode
                    </button>
                  )}
                </div>
              )}
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
