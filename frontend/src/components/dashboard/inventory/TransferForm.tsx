"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftRight, Loader2 } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { listIrmItems } from "@/services/irm.service";
import type { IrmItem } from "@/types/irm";
import { IrmItemPicker } from "@/components/dashboard/irm/IrmItemPicker";
import { mergeIrmItems, missingIrmIds } from "@/components/dashboard/irm/irmItemPickerModel";
import { useIrmItemsByIds } from "@/hooks/useIrmItemsByIds";
import { listWarehouses } from "@/services/warehouse.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark, SummaryRow } from "@/components/ui/FormScaffold";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import type { Availability } from "@/types/inventory";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

const INVENTORY_LIST = "/dashboard/inventory";
const today = () => new Date().toISOString().slice(0, 10);

type WarehouseOption = { id: string; name: string; code: string };

export function TransferForm() {
  const router = useRouter();
  const guard = useNavigationGuard();
  const params = useSearchParams();
  const { pushToast } = useDashboard();

  const [items, setItems] = React.useState<IrmItem[]>([]);
  const [warehouses, setWarehouses] = React.useState<WarehouseOption[]>([]);

  const [irmItemId, setIrmItemId] = React.useState(params.get("item") ?? "");
  const [fromWarehouseId, setFromWarehouseId] = React.useState(params.get("from") ?? "");
  // ?to= / ?qty= complete the Reorder workbench's "Create Transfer" prefill — the user still reviews
  // everything (live availability re-checks below) and submits; nothing moves automatically.
  const [toWarehouseId, setToWarehouseId] = React.useState(params.get("to") ?? "");
  const [quantity, setQuantity] = React.useState(() => {
    const q = params.get("qty") ?? "";
    return /^\d+$/.test(q) && Number(q) > 0 ? q : "";
  });
  const [movementDate, setMovementDate] = React.useState(today());
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [internalNotes, setInternalNotes] = React.useState("");

  const [availability, setAvailability] = React.useState<Availability | null>(null);
  const [availLoading, setAvailLoading] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const touch = () => setDirty(true);
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  useReportDirty("transfer-form", dirty && !saved);

  // Transferable items = active, non-serial- and non-batch-tracked (serial-level transfer is a future
  // feature the backend rejects); plus active warehouses for the source/destination pickers.
  React.useEffect(() => {
    let active = true;
    listIrmItems({ status: "active", pageSize: 200 }).then(
      // Bounded first page only; the picker searches the rest of the catalogue server-side.
      (r) => active && setItems(r.items),
      () => {},
    );
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))),
      () => {},
    );
    return () => { active = false; };
  }, []);

  // Live availability at the chosen item × source. Re-fetched whenever either changes; a request
  // token guards against an out-of-order response overwriting a newer one.
  React.useEffect(() => {
    let active = true;
    (async () => {
      if (!irmItemId || !fromWarehouseId) { setAvailability(null); return; }
      setAvailLoading(true);
      try {
        const a = await inventoryService.getAvailability(irmItemId, fromWarehouseId);
        if (active) { setAvailability(a); setError(null); }
      } catch {
        if (active) setAvailability(null);
      } finally {
        if (active) setAvailLoading(false);
      }
    })();
    return () => { active = false; };
  }, [irmItemId, fromWarehouseId]);

  const selectedItem = items.find((i) => i.id === irmItemId) ?? null;
  // ?item=<id> can name an item outside the page loaded at mount — resolve it by id so the picker
  // shows what is actually selected.
  // "Still looking" comes from the hook, not from "the id isn't in my list yet" — see AddStockForm.
  const resolvingItem = useIrmItemsByIds(missingIrmIds([irmItemId], items), (found) =>
    setItems((prev) => mergeIrmItems(prev, found)),
  );
  const sourceWh = warehouses.find((w) => w.id === fromWarehouseId) ?? null;
  const destWh = warehouses.find((w) => w.id === toWarehouseId) ?? null;
  const available = availability?.available ?? null;
  const qtyNum = Number(quantity);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(INVENTORY_LIST);
    });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!irmItemId) errs.irmItemId = "Select an item.";
    if (!fromWarehouseId) errs.fromWarehouseId = "Select a source warehouse.";
    if (!toWarehouseId) errs.toWarehouseId = "Select a destination warehouse.";
    else if (toWarehouseId === fromWarehouseId) errs.toWarehouseId = "Source and destination must be different.";
    if (!quantity.trim() || !Number.isInteger(qtyNum) || qtyNum < 1) errs.quantity = "Enter a whole quantity of at least 1.";
    else if (available !== null && qtyNum > available) errs.quantity = `Only ${available} available at the source.`;
    if (!movementDate) errs.movementDate = "Movement date is required.";
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
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const transfer = await inventoryService.createTransfer({
        irmItemId,
        fromWarehouseId,
        toWarehouseId,
        quantity: qtyNum,
        movementDate,
        referenceNumber: referenceNumber.trim() || undefined,
        description: description.trim() || undefined,
        internalNotes: internalNotes.trim() || undefined,
      });
      setSaved(true); // unmount the dirty guard before navigating away
      pushToast(`Transfer ${transfer.code} completed.`, "success");
      router.replace("/dashboard/inventory/history");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not complete the transfer.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false); // re-enable so the user can correct and retry
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title="Move stock"
        subtitle="Transfer stock from one warehouse to another"
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
              {saving ? "Moving…" : "Move stock"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Transfer details" description="Choose the item and the warehouses. Serial- and batch-tracked items can't be transferred yet and are not listed.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Item<RequiredMark /></label>
                <IrmItemPicker
                  value={irmItemId}
                  selectedItem={selectedItem}
                  seed={items}
                  onSelect={(i) => { setItems((prev) => mergeIrmItems(prev, [i])); setIrmItemId(i.id); touch(); clearError("irmItemId"); clearError("quantity"); }}
                  canCreate={false}
                  loading={resolvingItem}
                  ariaLabel="Item"
                  invalid={Boolean(errors.irmItemId)}
                />
                <FieldError message={errors.irmItemId} />
              </div>
              <div>
                <label className={labelCls}>Source warehouse<RequiredMark /></label>
                <Select value={fromWarehouseId} onChange={(v) => { setFromWarehouseId(v); touch(); clearError("fromWarehouseId"); clearError("quantity"); }} options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))} placeholder="— Select source —" ariaLabel="Source warehouse" invalid={Boolean(errors.fromWarehouseId)} />
                <FieldError message={errors.fromWarehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  {!irmItemId || !fromWarehouseId ? "Pick an item and source to see available stock." : availLoading ? "Checking available stock…" : available !== null ? `${available} available to move${selectedItem?.baseUnit ? ` ${selectedItem.baseUnit}` : ""}.` : "No stock of this item at the source."}
                </p>
              </div>
              <div>
                <label className={labelCls}>Destination warehouse<RequiredMark /></label>
                <Select value={toWarehouseId} onChange={(v) => { setToWarehouseId(v); touch(); clearError("toWarehouseId"); }} options={warehouses.filter((w) => w.id !== fromWarehouseId).map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))} placeholder="— Select destination —" ariaLabel="Destination warehouse" invalid={Boolean(errors.toWarehouseId)} />
                <FieldError message={errors.toWarehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Must be different from the source warehouse.</p>
              </div>
              <div>
                <label className={labelCls}>Quantity<RequiredMark /></label>
                <NumberInput className={inputCls} min={1} step={1} max={available ?? undefined} value={quantity} onChange={(e) => { setQuantity(e.target.value); touch(); clearError("quantity"); }} aria-invalid={Boolean(errors.quantity)} placeholder="e.g. 50" />
                <FieldError message={errors.quantity} />
              </div>
              <div>
                <label className={labelCls}>Movement date<RequiredMark /></label>
                <input className={inputCls} type="date" value={movementDate} onChange={(e) => { setMovementDate(e.target.value); touch(); clearError("movementDate"); }} aria-invalid={Boolean(errors.movementDate)} />
                <FieldError message={errors.movementDate} />
              </div>
            </div>
          </FormSection>

          <FormSection title="References" description="Optional notes recorded against this movement.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. TRN-2026-01" />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input className={inputCls} value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Rebalancing stock for the Leeds job" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Internal notes</label>
                <textarea className={inputCls} rows={2} value={internalNotes} onChange={(e) => { setInternalNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Internal notes visible only to staff." />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Movement summary">
            <div className="space-y-2.5 text-sm">
              <SummaryRow label="Item" valueClassName="font-semibold">{selectedItem ? selectedItem.name : "—"}</SummaryRow>
              <SummaryRow label="From" valueClassName="font-semibold">{sourceWh ? `${sourceWh.name} (${sourceWh.code})` : "—"}</SummaryRow>
              <SummaryRow label="To" valueClassName="font-semibold">{destWh ? `${destWh.name} (${destWh.code})` : "—"}</SummaryRow>
              <SummaryRow label="Available at source" valueClassName="font-semibold">{available ?? "—"}</SummaryRow>
              <SummaryRow label="Quantity to move" valueClassName="font-extrabold">{Number.isInteger(qtyNum) && qtyNum > 0 ? qtyNum : "—"}</SummaryRow>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">The transfer is applied immediately and atomically: stock leaves the source and arrives at the destination in a single step. The TRF number is assigned on completion.</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
