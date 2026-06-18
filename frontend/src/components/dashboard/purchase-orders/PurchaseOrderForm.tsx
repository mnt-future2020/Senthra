"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import { listSuppliers } from "@/services/supplier.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { formatMoney } from "./poStatus";
import type { PoPriority, PurchaseOrder } from "@/types/purchase-order";
import type { Supplier } from "@/types/supplier";
import type { Warehouse } from "@/types/warehouse";
import type { IrmItem } from "@/types/irm";

const PO_LIST = "/dashboard/purchase-orders";
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const PRIORITY_LABELS: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

// `_key` is a stable, frontend-only React key (never sent to the backend) so rows
// keep their identity across add/remove and controlled inputs don't desync.
type LineRow = { _key: string; irmItemId: string; quantity: string; unitPrice: string; vatRate: string; notes: string };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

const today = () => new Date().toISOString().slice(0, 10);
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const blankLine = (): LineRow => ({ _key: crypto.randomUUID(), irmItemId: "", quantity: "1", unitPrice: "", vatRate: "20", notes: "" });

export function PurchaseOrderForm({ mode, order }: { mode: "create" | "edit"; order?: PurchaseOrder | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const o = order;
  const [supplierId, setSupplierId] = React.useState(o?.supplierId ?? "");
  const [warehouseId, setWarehouseId] = React.useState(o?.warehouseId ?? "");
  const [orderDate, setOrderDate] = React.useState(o ? dateInput(o.orderDate) : today());
  const [expectedDeliveryDate, setExpectedDeliveryDate] = React.useState(dateInput(o?.expectedDeliveryDate));
  const [referenceNumber, setReferenceNumber] = React.useState(o?.referenceNumber ?? "");
  const [priority, setPriority] = React.useState<PoPriority>(o?.priority ?? "normal");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [deliveryAddress, setDeliveryAddress] = React.useState(o?.deliveryAddress ?? "");
  const [deliveryInstructions, setDeliveryInstructions] = React.useState(o?.deliveryInstructions ?? "");
  // Off-site delivery is the exception: hide the address override by default and only
  // reveal it when the user opts in. Pre-open on edit if the order already carries one.
  const [overrideAddress, setOverrideAddress] = React.useState(Boolean(o?.deliveryAddress));
  const [internalNotes, setInternalNotes] = React.useState(o?.internalNotes ?? "");
  const [supplierNotes, setSupplierNotes] = React.useState(o?.supplierNotes ?? "");
  const [lineRows, setLineRows] = React.useState<LineRow[]>(() =>
    o && o.items.length
      ? o.items.map((i) => ({ _key: crypto.randomUUID(), irmItemId: i.irmItemId, quantity: String(i.quantity), unitPrice: i.unitPrice.toFixed(2), vatRate: String(i.vatRate), notes: i.notes ?? "" }))
      : [blankLine()],
  );

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  const [items, setItems] = React.useState<IrmItem[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);

  React.useEffect(() => {
    let active = true;
    listSuppliers({ status: "active", pageSize: 100 }).then((r) => active && setSuppliers(r.suppliers), () => {});
    listWarehouses({ status: "active", pageSize: 100 }).then(
      (r) => {
        if (!active) return;
        setWarehouses(r.warehouses);
        // Default to the company's default warehouse on create (preselect; user can override).
        if (mode === "create") {
          setWarehouseId((cur) => cur || r.warehouses.find((w) => w.isDefault)?.id || "");
        }
      },
      () => {},
    );
    listIrmItems({ status: "active", pageSize: 100 }).then((r) => active && setItems(r.items), () => {});
    return () => {
      active = false;
    };
  }, [mode]);

  useReportDirty("po-form", dirty && !saved);

  const supplierPanel = suppliers.find((s) => s.id === supplierId) ?? o?.supplier ?? null;

  // Selected warehouse + its composed address, shown read-only so the user can see
  // where goods will be delivered. Blank delivery address = this address is used
  // (resolved server-side); the override below is only for off-site deliveries.
  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId) ?? null;
  const warehouseAddressLines = selectedWarehouse
    ? [
        selectedWarehouse.addressLine1,
        selectedWarehouse.addressLine2,
        selectedWarehouse.city,
        selectedWarehouse.county,
        selectedWarehouse.postcode,
        selectedWarehouse.country,
      ]
        .map((l) => l?.trim())
        .filter((l): l is string => Boolean(l))
    : [];

  const itemOptions = React.useMemo(() => {
    // keep any already-selected (possibly now-inactive) line items visible on edit
    const map = new Map(items.map((i) => [i.id, i]));
    return { map, list: items };
  }, [items]);

  const goBack = () => guard.attemptLeave(() => router.push(PO_LIST));
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });

  const updateLine = (idx: number, patch: Partial<LineRow>) => {
    setLineRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    touch();
    clearError("items");
  };
  const onPickItem = (idx: number, irmItemId: string) => {
    const item = itemOptions.map.get(irmItemId);
    updateLine(idx, {
      irmItemId,
      unitPrice: item?.standardCost != null ? item.standardCost.toFixed(2) : "",
      vatRate: item?.vatRatePercent != null ? String(item.vatRatePercent) : "20",
    });
  };
  const addLine = () => { setLineRows((rows) => [...rows, blankLine()]); touch(); };
  const removeLine = (idx: number) => { setLineRows((rows) => (rows.length === 1 ? rows : rows.filter((_, i) => i !== idx))); touch(); };

  // Live financial preview (pounds).
  const totals = React.useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const r of lineRows) {
      const qty = Number(r.quantity) || 0;
      const price = Number(r.unitPrice) || 0;
      const lineEx = qty * price;
      subtotal += lineEx;
      vat += (lineEx * (Number(r.vatRate) || 0)) / 100;
    }
    return { subtotal, vat, grand: subtotal + vat };
  }, [lineRows]);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!supplierId) errs.supplierId = "Select a supplier.";
    if (!warehouseId) errs.warehouseId = "Select a delivery warehouse.";
    if (!orderDate) errs.orderDate = "Order date is required.";
    if (!expectedDeliveryDate) errs.expectedDeliveryDate = "Expected delivery date is required.";
    else if (orderDate && expectedDeliveryDate < orderDate) errs.expectedDeliveryDate = "Can't be before the order date.";

    const effective = lineRows.filter((r) => r.irmItemId);
    const ids = effective.map((r) => r.irmItemId);
    if (effective.length === 0) errs.items = "Add at least one item.";
    else if (new Set(ids).size !== ids.length) errs.items = "Each item can only be added once.";
    else if (effective.some((r) => !(Number(r.quantity) >= 1))) errs.items = "Every line needs a quantity of at least 1.";
    else if (effective.some((r) => Number(r.unitPrice) < 0 || Number.isNaN(Number(r.unitPrice)))) errs.items = "Enter a valid unit price for every line.";
    return errs;
  };

  const buildPayload = (): poService.PurchaseOrderPayload => ({
    supplierId,
    warehouseId,
    orderDate,
    expectedDeliveryDate,
    referenceNumber: referenceNumber.trim(),
    description: description.trim(),
    priority,
    deliveryAddress: deliveryAddress.trim(),
    deliveryInstructions: deliveryInstructions.trim(),
    internalNotes: internalNotes.trim(),
    supplierNotes: supplierNotes.trim(),
    items: lineRows
      .filter((r) => r.irmItemId)
      .map((r) => ({
        irmItemId: r.irmItemId,
        quantity: Number(r.quantity),
        unitPricePence: Math.round((Number(r.unitPrice) || 0) * 100),
        vatRate: Number(r.vatRate) || 0,
        notes: r.notes.trim() || undefined,
      })),
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
        const created = await poService.createPurchaseOrder(buildPayload());
        setSaved(true);
        pushToast(`Purchase order ${created.code} created.`, "success");
        router.replace(`/dashboard/purchase-orders/${created.code}`);
      } else if (o) {
        await poService.updatePurchaseOrder(o.id, buildPayload());
        setSaved(true);
        pushToast("Purchase order updated.", "success");
        router.replace(`/dashboard/purchase-orders/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the purchase order.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New purchase order" : `Edit ${o?.code ?? "order"}`}
        subtitle={mode === "edit" && o ? o.code : "Raise a draft order to a supplier"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create draft" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Purchase order information" description="Who you're ordering from and when you expect it.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Supplier<RequiredMark /></label>
                <select className={inputCls} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); touch(); clearError("supplierId"); }} aria-invalid={Boolean(errors.supplierId)}>
                  <option value="">— Select a supplier —</option>
                  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name} ({s.code})</option>))}
                </select>
                <FieldError id="err-supplierId" message={errors.supplierId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Choose who this order is being placed with.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery warehouse<RequiredMark /></label>
                <select className={inputCls} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); touch(); clearError("warehouseId"); }} aria-invalid={Boolean(errors.warehouseId)}>
                  <option value="">— Select a warehouse —</option>
                  {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name} ({w.code}){w.isDefault ? " — default" : ""}</option>))}
                </select>
                <FieldError id="err-warehouseId" message={errors.warehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Defaults to your company default warehouse. You can change it if needed.</p>
              </div>
              <div>
                <label className={labelCls}>Order date<RequiredMark /></label>
                <input type="date" className={inputCls} value={orderDate} onChange={(e) => { setOrderDate(e.target.value); touch(); clearError("orderDate"); }} aria-invalid={Boolean(errors.orderDate)} placeholder="dd-mm-yyyy" />
                <FieldError id="err-orderDate" message={errors.orderDate} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The date this purchase order was created.</p>
              </div>
              <div>
                <label className={labelCls}>Expected delivery date<RequiredMark /></label>
                <input type="date" className={inputCls} value={expectedDeliveryDate} onChange={(e) => { setExpectedDeliveryDate(e.target.value); touch(); clearError("expectedDeliveryDate"); }} aria-invalid={Boolean(errors.expectedDeliveryDate)} placeholder="dd-mm-yyyy" />
                <FieldError id="err-expectedDeliveryDate" message={errors.expectedDeliveryDate} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">When you expect the supplier to deliver the goods.</p>
              </div>
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. PROJ-001 or REF-2026-01" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional internal reference.</p>
              </div>
              <div>
                <label className={labelCls}>Priority</label>
                <select className={inputCls} value={priority} onChange={(e) => { setPriority(e.target.value as typeof priority); touch(); }}>
                  {PRIORITIES.map((p) => (<option key={p} value={p}>{PRIORITY_LABELS[p]}</option>))}
                </select>
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Use Urgent only for exceptional cases.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea className={inputCls} rows={2} value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={2000} placeholder="Briefly describe what this order is for (optional)." />
              </div>
            </div>
          </FormSection>

          {supplierPanel && (
            <FormSection title="Supplier information" description="Read-only — pulled from the supplier record.">
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p><p className="text-[var(--ink)]">{supplierPanel.contactPerson || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Payment terms</p><p className="text-[var(--ink)]">{supplierPanel.paymentTerms || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Email</p><p className="text-[var(--ink)]">{supplierPanel.contactEmail || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Phone</p><p className="text-[var(--ink)]">{supplierPanel.contactPhone || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Lead time</p><p className="text-[var(--ink)]">{supplierPanel.leadTimeDays != null ? `${supplierPanel.leadTimeDays} days` : "—"}</p></div>
              </div>
            </FormSection>
          )}

          <FormSection title="Items" description="Add one or more IRM items to this order. Prices and VAT pre-fill from each item's settings. Quantity must be greater than zero. Unit price can be adjusted if required. UK standard VAT is 20%.">
            <div className="space-y-3">
              {lineRows.map((row, idx) => {
                const qty = Number(row.quantity) || 0;
                const price = Number(row.unitPrice) || 0;
                // Surface the selected supplier's own code for this item (read-only). Lookup is
                // local — the item list already carries each item's supplier links + codes.
                const pickedItem = row.irmItemId ? itemOptions.map.get(row.irmItemId) : undefined;
                const supplierLink = pickedItem && supplierId ? pickedItem.suppliers.find((s) => s.supplierId === supplierId) : undefined;
                return (
                  <div key={row._key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                    <div className="grid gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-5">
                        <label className={labelCls}>Item</label>
                        <select className={inputCls} value={row.irmItemId} onChange={(e) => onPickItem(idx, e.target.value)}>
                          <option value="">— Select an item —</option>
                          {itemOptions.list.map((i) => (<option key={i.id} value={i.id}>{i.name} ({i.code})</option>))}
                        </select>
                        {pickedItem && supplierId && (
                          supplierLink?.supplierSku ? (
                            <p className="mt-1.5 text-[11px] text-[var(--muted)]">Supplier item code: <span className="font-mono text-[var(--ink)]">{supplierLink.supplierSku}</span></p>
                          ) : !supplierLink ? (
                            <p className="mt-1.5 text-[11px] text-[var(--warn)]">Not listed for the selected supplier.</p>
                          ) : null
                        )}
                      </div>
                      <div className="sm:col-span-2">
                        <label className={labelCls}>Quantity</label>
                        <NumberInput className={inputCls} min={1} value={row.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} placeholder="e.g. 100" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className={labelCls}>Unit price (£)</label>
                        <NumberInput className={inputCls} min={0} step="0.01" value={row.unitPrice} onChange={(e) => updateLine(idx, { unitPrice: e.target.value })} placeholder="e.g. 12.50" />
                      </div>
                      <div className="sm:col-span-1">
                        <label className={labelCls}>VAT %</label>
                        <NumberInput className={inputCls} min={0} max={100} step="0.01" value={row.vatRate} onChange={(e) => updateLine(idx, { vatRate: e.target.value })} placeholder="20" />
                      </div>
                      <div className="flex items-end justify-between sm:col-span-2">
                        <div className="text-xs">
                          <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Line total</span>
                          <span className="font-semibold text-[var(--ink)]">{formatMoney(qty * price)}</span>
                        </div>
                        <button type="button" onClick={() => removeLine(idx)} disabled={lineRows.length === 1} className="rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" title="Remove line" aria-label="Remove line">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)]">
                <Plus className="h-3.5 w-3.5" /> Add item
              </button>
              <FieldError id="err-items" message={errors.items} />
            </div>
          </FormSection>

          <FormSection title="Delivery" description="Where the supplier should deliver this order.">
            <div className="grid gap-4">
              {selectedWarehouse && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    {deliveryAddress.trim() ? "Selected warehouse address" : "Delivering to"}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
                    {selectedWarehouse.name} ({selectedWarehouse.code})
                  </p>
                  {warehouseAddressLines.length > 0 ? (
                    <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--muted)]">{warehouseAddressLines.join(", ")}</p>
                  ) : (
                    <p className="mt-1 text-[13px] text-[var(--faint)]">No address on file for this warehouse — add one on the warehouse record, or enter a delivery address below.</p>
                  )}
                </div>
              )}
              <label className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={overrideAddress}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setOverrideAddress(on);
                    if (!on && deliveryAddress) setDeliveryAddress("");
                    touch();
                  }}
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--ink)]">
                  <span className="font-bold">Deliver to a different address</span>
                  <span className="block text-[11px] text-[var(--faint)]">Tick only when goods go somewhere other than this warehouse.</span>
                </span>
              </label>
              {overrideAddress && (
                <div>
                  <label className={labelCls}>Delivery address</label>
                  <textarea className={inputCls} rows={2} value={deliveryAddress} onChange={(e) => { setDeliveryAddress(e.target.value); touch(); }} maxLength={300} placeholder="Enter the full delivery address." autoFocus />
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">This replaces the warehouse address for this order only.</p>
                </div>
              )}
              <div>
                <label className={labelCls}>Delivery instructions</label>
                <input className={inputCls} value={deliveryInstructions} onChange={(e) => { setDeliveryInstructions(e.target.value); touch(); }} maxLength={500} placeholder="Access hours, contact person, loading bay instructions (optional)." />
              </div>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal notes stay private. Supplier notes appear on the purchase order.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Internal notes</label>
                <textarea className={inputCls} rows={3} value={internalNotes} onChange={(e) => { setInternalNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Never shown to the supplier." />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Internal procurement notes.</p>
              </div>
              <div>
                <label className={labelCls}>Supplier notes</label>
                <textarea className={inputCls} rows={3} value={supplierNotes} onChange={(e) => { setSupplierNotes(e.target.value); touch(); }} maxLength={2000} placeholder="Shown to the supplier on the order." />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Special delivery or handling instructions.</p>
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Financial summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-[var(--muted)]">Subtotal</span><span className="font-semibold text-[var(--ink)]">{formatMoney(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">VAT</span><span className="font-semibold text-[var(--ink)]">{formatMoney(totals.vat)}</span></div>
              <div className="flex justify-between border-t border-[var(--border-2)] pt-2.5"><span className="font-bold text-[var(--ink)]">Grand total</span><span className="font-extrabold text-[var(--ink)]">{formatMoney(totals.grand)}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">Totals are calculated automatically from the order lines. The PO number is assigned when the draft is saved.</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
