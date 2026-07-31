"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, PackagePlus } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import type { StockAdjustment, StockAdjustmentReason } from "@/services/inventory.service";
import { listIrmItems, generateBarcode, getIrmItem } from "@/services/irm.service";
import { listWarehouses } from "@/services/warehouse.service";
import { printLabels } from "@/lib/printBarcode";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { Notice } from "@/components/ui/Notice";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";
import type { Availability } from "@/types/inventory";

const INVENTORY_LIST = "/dashboard/inventory";
const today = () => new Date().toISOString().slice(0, 10);

// Reasons mirror the backend STOCK_ADJUSTMENT_REASONS enum.
const REASONS: { value: StockAdjustmentReason; label: string }[] = [
  { value: "opening_balance", label: "Opening balance" },
  { value: "legacy_stock", label: "Legacy stock" },
  { value: "found", label: "Found / recount" },
  { value: "other", label: "Other" },
];

type ItemOption = { id: string; code: string; name: string; sku: string | null; baseUnit: string | null; barcodeDataUri: string | null };
type WarehouseOption = { id: string; name: string; code: string };

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

export function AddStockForm() {
  const router = useRouter();
  const guard = useNavigationGuard();
  const params = useSearchParams();
  const { pushToast } = useDashboard();
  const { can, principal, admin, user } = useAuth();
  const canCreateItem = can("irm.create");
  const canManageBarcode = can("irm.barcode.manage");

  // Display-only "Created by" — the currently authenticated operator (audit visibility).
  const currentUserName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : admin
      ? admin.name || admin.email
      : principal?.email ?? "—";

  // When launched from a specific warehouse (?warehouse=), lock that field.
  const lockedWarehouseId = params.get("warehouse") ?? "";

  const [items, setItems] = React.useState<ItemOption[]>([]);
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);

  const [irmItemId, setIrmItemId] = React.useState(params.get("item") ?? "");
  const [warehouseId, setWarehouseId] = React.useState(lockedWarehouseId);
  const [quantity, setQuantity] = React.useState("");
  const [movementDate, setMovementDate] = React.useState(today());
  const [reason, setReason] = React.useState<StockAdjustmentReason>("opening_balance");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [availability, setAvailability] = React.useState<Availability | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // The persisted adjustment (set after a successful save) — drives the post-save confirmation:
  // shows the real ADJ number and freezes the form so the immutable entry can't be re-submitted.
  const [savedAdjustment, setSavedAdjustment] = React.useState<StockAdjustment | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [barcodeBusy, setBarcodeBusy] = React.useState(false);
  // The barcode image is omitted from the item list payload — track which item is having its
  // barcode lazily fetched, and remember the ids already loaded so we don't refetch on reselect.
  const [barcodeLoadingId, setBarcodeLoadingId] = React.useState<string | null>(null);
  const loadedBarcodeIds = React.useRef<Set<string>>(new Set());

  const touch = () => setDirty(true);
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  useReportDirty("add-stock-form", dirty && !saved);

  // Addable items = active, non-serial- and non-batch-tracked, inventory-tracked (serial/batch
  // stock must come through Goods In — the backend rejects them here); plus active warehouses.
  React.useEffect(() => {
    let active = true;
    listIrmItems({ status: "active", pageSize: 200 }).then(
      // barcodeDataUri is intentionally NOT returned by the list endpoint (kept light even with
      // 100+ barcoded items); it's lazy-loaded for the selected item below.
      (r) => active && setItems(r.items.filter((i) => i.trackInventory && !i.trackSerialNumbers && !i.trackBatchNumbers).map((i) => ({ id: i.id, code: i.code, name: i.name, sku: i.sku, baseUnit: i.baseUnit, barcodeDataUri: i.barcodeDataUri ?? null }))),
      () => {},
    );
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))),
      () => {},
    );
    return () => { active = false; };
  }, []);

  // Live current on-hand at the chosen item × warehouse (informational — shows the resulting total).
  React.useEffect(() => {
    let active = true;
    (async () => {
      if (!irmItemId || !warehouseId) { setAvailability(null); return; }
      try {
        const a = await inventoryService.getAvailability(irmItemId, warehouseId);
        if (active) setAvailability(a);
      } catch {
        if (active) setAvailability(null);
      }
    })();
    return () => { active = false; };
  }, [irmItemId, warehouseId]);

  // Lazy-load the SELECTED item's barcode image on demand (the list omits it to stay light).
  // Fetches once per item id; failures don't cache so a reselect retries.
  React.useEffect(() => {
    if (!irmItemId || loadedBarcodeIds.current.has(irmItemId)) return;
    let active = true;
    const id = irmItemId;
    setBarcodeLoadingId(id);
    getIrmItem(id).then(
      (full) => {
        loadedBarcodeIds.current.add(id);
        if (!active) return;
        setItems((prev) => prev.map((it) => (it.id === full.id ? { ...it, barcodeDataUri: full.barcodeDataUri } : it)));
        setBarcodeLoadingId((cur) => (cur === id ? null : cur));
      },
      () => { if (active) setBarcodeLoadingId((cur) => (cur === id ? null : cur)); },
    );
    return () => { active = false; };
  }, [irmItemId]);

  const selectedItem = items.find((i) => i.id === irmItemId) ?? null;
  const targetWh = warehouses.find((w) => w.id === warehouseId) ?? null;
  const qtyNum = Number(quantity);
  const onHand = availability?.onHand ?? null;

  // Saved → the form is a read-only confirmation. While saving → frozen to prevent edits mid-request.
  const locked = saving || Boolean(savedAdjustment);
  // The submit button stays disabled until EVERY required field is valid (Item, Warehouse,
  // Quantity ≥ 1, Reason, Movement date). Reason + date are always populated (sensible defaults).
  const quantityValid = quantity.trim() !== "" && Number.isInteger(qtyNum) && qtyNum >= 1;
  const dateValid = Boolean(movementDate) && movementDate <= today();
  const isFormValid = Boolean(irmItemId) && Boolean(warehouseId) && quantityValid && Boolean(reason) && dateValid;

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(INVENTORY_LIST);
    });

  // Reset to a blank form for a second add (keeps the warehouse prefill when launched from one).
  const resetForm = () => {
    setSavedAdjustment(null);
    setSaved(false);
    setDirty(false);
    setError(null);
    setErrors({});
    setIrmItemId("");
    setWarehouseId(lockedWarehouseId);
    setQuantity("");
    setMovementDate(today());
    setReason("opening_balance");
    setReferenceNumber("");
    setNotes("");
    setAvailability(null);
  };

  // Generate the selected item's Code128 barcode (one-time), then keep the local item list in sync
  // so the panel flips to "Reprint Label" without a full reload. Mirrors the IRM Catalogue flow —
  // staff print the label here and stick it on the physical stock as they put it away.
  const generateItemBarcode = async () => {
    if (!selectedItem || barcodeBusy) return;
    setBarcodeBusy(true);
    try {
      const updated = await generateBarcode(selectedItem.id);
      loadedBarcodeIds.current.add(updated.id); // generate returns the image — no need to lazy-fetch
      setItems((prev) => prev.map((it) => (it.id === updated.id ? { ...it, barcodeDataUri: updated.barcodeDataUri } : it)));
      pushToast("Barcode generated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate the barcode.", "alert");
    } finally {
      setBarcodeBusy(false);
    }
  };

  // One sticker per unit being put away, mirroring GRN receive — this used to print a SINGLE label
  // no matter how many units you were adding, so a 50-unit addition gave you one sticker for 50
  // boxes. Blank tracks the quantity field live; typing a number pins it.
  const [labelCopies, setLabelCopies] = React.useState("");
  const printItemBarcode = (count: number) => {
    if (!selectedItem?.barcodeDataUri) return;
    printLabels({ dataUri: selectedItem.barcodeDataUri, code: selectedItem.code, copies: count });
  };

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!irmItemId) errs.irmItemId = "Select an item.";
    if (!warehouseId) errs.warehouseId = "Select a warehouse.";
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1) errs.quantity = "Enter a whole quantity of at least 1.";
    if (!movementDate) errs.movementDate = "Movement date is required.";
    else if (movementDate > today()) errs.movementDate = "Movement date can't be in the future.";
    return errs;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return; // double-submit guard
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
      const adjustment = await inventoryService.addStock({
        irmItemId,
        warehouseId,
        quantity: qtyNum,
        movementDate,
        reason,
        referenceNumber: referenceNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setSaved(true); // unmount the dirty guard
      setSavedAdjustment(adjustment); // stay on the page and confirm with the real ADJ number
      setSaving(false);
      pushToast(`Added ${adjustment.quantity} to ${adjustment.warehouseName} (${adjustment.code}).`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not add the stock.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false); // re-enable so the user can correct and retry
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title="Add Stock"
        subtitle="Add existing / opening stock straight into a warehouse"
        onBack={goBack}
        actions={
          savedAdjustment ? (
            <>
              <button type="button" onClick={resetForm} className={ghostBtn}>Add Another</button>
              <button type="button" onClick={() => router.push(INVENTORY_LIST)} className={primaryBtn}>Back to Inventory</button>
            </>
          ) : (
            <>
              <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>Cancel</button>
              {/* Disabled until every required field is valid, and while a submit is in flight
                  (prevents duplicate submissions of an immutable ledger entry). */}
              <button type="submit" disabled={!isFormValid || saving} className={primaryBtn}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="h-3.5 w-3.5" />}
                {saving ? "Adding…" : "Add Stock"}
              </button>
            </>
          )
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      {savedAdjustment && (
        <Notice msg={{ type: "success", text: `Stock added — adjustment ${savedAdjustment.code} created. New on hand at ${savedAdjustment.warehouseName}: ${savedAdjustment.balanceAfter}.` }} />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Stock details" description="Choose the item, warehouse and quantity. Serial- and batch-tracked items must be received via Goods In and are not listed.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Item<RequiredMark /></label>
                <Select value={irmItemId} onChange={(v) => { setIrmItemId(v); touch(); clearError("irmItemId"); }} options={items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}${i.sku ? ` (${i.sku})` : ""}` }))} placeholder="— Select an item —" ariaLabel="Item" invalid={Boolean(errors.irmItemId)} disabled={locked} />
                <FieldError message={errors.irmItemId} />
                {/* Items must exist in the catalogue first. Offer a shortcut to create one (gated by
                    irm.create) — uses the nav guard so an in-progress form prompts before leaving. */}
                {canCreateItem && !locked && (
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                    Can&apos;t find it?{" "}
                    <button
                      type="button"
                      onClick={() => guard.attemptLeave(() => router.push("/dashboard/irm/new"))}
                      className="font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      Add a new item in IRM Catalogue
                    </button>
                  </p>
                )}
              </div>
              <div>
                <label className={labelCls}>Warehouse<RequiredMark /></label>
                <Select value={warehouseId} onChange={(v) => { setWarehouseId(v); touch(); clearError("warehouseId"); }} options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))} placeholder="— Select warehouse —" ariaLabel="Warehouse" invalid={Boolean(errors.warehouseId)} disabled={Boolean(lockedWarehouseId) || locked} />
                <FieldError message={errors.warehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {!irmItemId || !warehouseId ? "Pick an item and warehouse to see the current on-hand." : onHand !== null ? `${onHand} currently on hand${selectedItem?.baseUnit ? ` ${selectedItem.baseUnit}` : ""}.` : "No stock of this item here yet."}
                </p>
              </div>
              <div>
                <label className={labelCls}>Quantity to add<RequiredMark /></label>
                <NumberInput className={inputCls} min={1} step={1} value={quantity} onChange={(e) => { setQuantity(e.target.value); touch(); clearError("quantity"); }} aria-invalid={Boolean(errors.quantity)} placeholder="e.g. 50" disabled={locked} />
                <FieldError message={errors.quantity} />
              </div>
              <div>
                <label className={labelCls}>Reason<RequiredMark /></label>
                <Select value={reason} onChange={(v) => { setReason(v as StockAdjustmentReason); touch(); }} options={REASONS} ariaLabel="Reason" disabled={locked} />
              </div>
              <div>
                <label className={labelCls}>Movement date<RequiredMark /></label>
                <input className={inputCls} type="date" max={today()} value={movementDate} onChange={(e) => { setMovementDate(e.target.value); touch(); clearError("movementDate"); }} aria-invalid={Boolean(errors.movementDate)} disabled={locked} />
                <FieldError message={errors.movementDate} />
              </div>
            </div>
          </FormSection>

          {/* Item barcode — appears once an item is chosen. Staff generate (one-time) and print the
              Code128 label to stick on the physical stock as it's put away. Same flow/look as the IRM
              Catalogue (shared BarcodePanel). Independent of the save: still printable after submit. */}
          {selectedItem && (
            <FormSection title="Item barcode" description="Generate and print a Code128 label to stick on the physical stock as you put it away.">
              {barcodeLoadingId === selectedItem.id ? (
                <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading barcode…
                </div>
              ) : (
                <BarcodePanel
                  code={selectedItem.code}
                  barcodeDataUri={selectedItem.barcodeDataUri}
                  canManage={canManageBarcode}
                  busy={barcodeBusy}
                  onGenerate={generateItemBarcode}
                  onPrint={printItemBarcode}
                  copies={labelCopies}
                  onCopiesChange={setLabelCopies}
                  defaultCopies={Number(quantity) || 1}
                />
              )}
              {/* Same blank-box-only hint the GRN receive and stock-entry surfaces carry: this one
                  also defaults its count to a quantity, so it needs to say which quantity. */}
              {selectedItem.barcodeDataUri && labelCopies.trim() === "" && (
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">One label per unit being added.</p>
              )}
            </FormSection>
          )}

          <FormSection title="References" description="Optional notes recorded against this addition.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. STOCKTAKE-2026-01" disabled={locked} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={2} value={notes} onChange={(e) => { setNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Internal notes visible only to staff." disabled={locked} />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Item</span><span className="text-right font-semibold text-[var(--ink)]">{selectedItem ? selectedItem.name : "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Warehouse</span><span className="text-right font-semibold text-[var(--ink)]">{targetWh ? `${targetWh.name} (${targetWh.code})` : "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Current on hand</span><span className="font-semibold text-[var(--ink)]">{onHand ?? "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Quantity to add</span><span className="font-extrabold text-[var(--ink)]">{Number.isInteger(qtyNum) && qtyNum > 0 ? qtyNum : "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">New on hand</span><span className="font-extrabold text-[var(--ink)]">{onHand !== null && Number.isInteger(qtyNum) && qtyNum > 0 ? onHand + qtyNum : "—"}</span></div>

              {/* Audit info: the ADJ number (backend is the source of truth — preview only until saved)
                  and the operator performing the add. Both display-only. */}
              <div className="mt-1 space-y-2.5 border-t border-[var(--border)] pt-3">
                <div className="flex justify-between gap-3">
                  <span className="text-[var(--muted)]">Adjustment No</span>
                  <span className={`text-right font-mono font-bold ${savedAdjustment ? "text-[var(--ink)]" : "text-[var(--faint)]"}`}>
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

          {/* Enterprise guardrail — subtle, non-destructive. Reinforces which flow to use and that
              the resulting ledger entry is immutable. */}
          <div className="mt-4 flex gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--faint)]" />
            <div className="space-y-1.5">
              <p className="font-bold text-[var(--ink)]">This action cannot be edited later.</p>
              <p>Use <span className="font-semibold text-[var(--muted)]">Goods In</span> for supplier deliveries. Use <span className="font-semibold text-[var(--muted)]">Add Stock</span> only for opening balance, legacy stock, or found / recount stock.</p>
              <p>It creates an immutable inventory ledger entry.</p>
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}
