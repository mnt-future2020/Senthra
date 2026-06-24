"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, CheckCircle2, ChevronRight, Loader2, Package, Plus, RotateCcw, Trash2, Truck, Warehouse as WarehouseIcon } from "lucide-react";

import * as poService from "@/services/purchase-order.service";
import { listSuppliers } from "@/services/supplier.service";
import { listWarehouses, listWarehouseOptions, type WarehouseOption } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { formatDate, formatMoney, PoStatusBadge } from "./poStatus";
import type { PoPriority, PurchaseOrder } from "@/types/purchase-order";
import type { Supplier } from "@/types/supplier";
import type { Warehouse } from "@/types/warehouse";
import type { IrmItem } from "@/types/irm";

const PO_LIST = "/dashboard/purchase-orders";
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const PRIORITY_LABELS: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

// `_key` is a stable, frontend-only React key (never sent to the backend) so rows
// keep their identity across add/remove and controlled inputs don't desync. `warehouseId` is the
// per-row destination warehouse (create flow only — the backend auto-splits POs by it).
type LineRow = { _key: string; irmItemId: string; warehouseId: string; quantity: string; unitPrice: string; vatRate: string; notes: string };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

// A small pill for the shared context shown on the split-create success screen (supplier / item
// count / expected date). Long values truncate instead of stretching the pill.
function ContextChip({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--ink)]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
      <span className="truncate">{children}</span>
    </span>
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const blankLine = (): LineRow => ({ _key: crypto.randomUUID(), irmItemId: "", warehouseId: "", quantity: "1", unitPrice: "", vatRate: "20", notes: "" });

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
      ? o.items.map((i) => ({ _key: crypto.randomUUID(), irmItemId: i.irmItemId, warehouseId: o.warehouseId ?? "", quantity: String(i.quantity), unitPrice: i.unitPrice.toFixed(2), vatRate: String(i.vatRate), notes: i.notes ?? "" }))
      : [blankLine()],
  );

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  // Active-warehouse OPTIONS for the per-row picker (create flow). Server-scoped: a Warehouse Manager
  // receives only their assigned warehouses, so the picker can never offer one they aren't allowed.
  const [warehouseOptions, setWarehouseOptions] = React.useState<WarehouseOption[]>([]);
  const [items, setItems] = React.useState<IrmItem[]>([]);
  // After a successful auto-split create: the POs that were generated (drives the success summary).
  const [splitResult, setSplitResult] = React.useState<PurchaseOrder[] | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);

  React.useEffect(() => {
    let active = true;
    listSuppliers({ status: "active", pageSize: 100 }).then((r) => active && setSuppliers(r.suppliers), () => {});
    if (mode === "create") {
      // Create: per-row warehouse picker sources from the SCOPED options endpoint (manager → only
      // their warehouses). No header default-warehouse anymore — warehouse is chosen per item row.
      listWarehouseOptions().then((opts) => active && setWarehouseOptions(opts), () => {});
    } else {
      // Edit: keep the single-warehouse model — load full warehouses for the header + address panel.
      listWarehouses({ status: "active", pageSize: 100 }).then((r) => active && setWarehouses(r.warehouses), () => {});
    }
    listIrmItems({ status: "active", pageSize: 100 }).then((r) => active && setItems(r.items), () => {});
    return () => {
      active = false;
    };
  }, [mode]);

  // Warehouse-scoped manager with exactly ONE warehouse → auto-select + lock every row's warehouse.
  const lockedWarehouseId = mode === "create" && warehouseOptions.length === 1 ? warehouseOptions[0].id : null;
  const rowWarehouseId = (r: LineRow) => lockedWarehouseId ?? r.warehouseId;

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
    // The delivery warehouse is per-row in the create flow; only the edit flow keeps a header one.
    if (mode === "edit" && !warehouseId) errs.warehouseId = "Select a delivery warehouse.";
    if (!orderDate) errs.orderDate = "Order date is required.";
    if (!expectedDeliveryDate) errs.expectedDeliveryDate = "Expected delivery date is required.";
    else if (orderDate && expectedDeliveryDate < orderDate) errs.expectedDeliveryDate = "Can't be before the order date.";

    const effective = lineRows.filter((r) => r.irmItemId);
    if (effective.length === 0) errs.items = "Add at least one item.";
    else if (mode === "create" && effective.some((r) => !rowWarehouseId(r))) errs.items = "Select a warehouse for every item.";
    else if (
      // Create: the same item to the same warehouse twice clashes (one PO per warehouse can't hold a
      // duplicate item). The same item to DIFFERENT warehouses is fine. Edit: simple per-item dedup.
      mode === "create"
        ? new Set(effective.map((r) => `${rowWarehouseId(r)}:${r.irmItemId}`)).size !== effective.length
        : new Set(effective.map((r) => r.irmItemId)).size !== effective.length
    )
      errs.items =
        mode === "create"
          ? "The same item can't be added twice for the same warehouse."
          : "Each item can only be added once.";
    else if (effective.some((r) => !(Number(r.quantity) >= 1))) errs.items = "Every line needs a quantity of at least 1.";
    else if (effective.some((r) => Number(r.unitPrice) < 0 || Number.isNaN(Number(r.unitPrice)))) errs.items = "Enter a valid unit price for every line.";
    return errs;
  };

  const sharedHeader = () => ({
    supplierId,
    orderDate,
    expectedDeliveryDate,
    referenceNumber: referenceNumber.trim(),
    description: description.trim(),
    priority,
    deliveryAddress: deliveryAddress.trim(),
    deliveryInstructions: deliveryInstructions.trim(),
    internalNotes: internalNotes.trim(),
    supplierNotes: supplierNotes.trim(),
  });
  const lineCore = (r: LineRow) => ({
    irmItemId: r.irmItemId,
    quantity: Number(r.quantity),
    unitPricePence: Math.round((Number(r.unitPrice) || 0) * 100),
    vatRate: Number(r.vatRate) || 0,
    notes: r.notes.trim() || undefined,
  });

  // Edit keeps the single header warehouse (a PO is never split after creation).
  const buildEditPayload = (): poService.PurchaseOrderPayload => ({
    ...sharedHeader(),
    warehouseId,
    items: lineRows.filter((r) => r.irmItemId).map(lineCore),
  });

  // Create sends each line WITH its warehouse; the backend groups + auto-splits into one PO each.
  const buildSplitPayload = (): poService.PurchaseOrderSplitPayload => ({
    ...sharedHeader(),
    items: lineRows.filter((r) => r.irmItemId).map((r) => ({ ...lineCore(r), warehouseId: rowWarehouseId(r) })),
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
        const created = await poService.createPurchaseOrdersSplit(buildSplitPayload());
        setSaved(true);
        // One PO → straight to its detail (old behaviour). Multiple → show the split summary so the
        // user sees exactly which POs (code + warehouse + item count) were generated.
        if (created.length === 1) {
          pushToast(`Purchase order ${created[0].code} created.`, "success");
          router.replace(`/dashboard/purchase-orders/${created[0].code}`);
        } else {
          pushToast(`${created.length} purchase orders created.`, "success");
          setSplitResult(created);
        }
      } else if (o) {
        await poService.updatePurchaseOrder(o.id, buildEditPayload());
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

  // Start a fresh order without leaving the page (keeps supplier/dates for a quick follow-up batch).
  const createAnother = () => {
    setSplitResult(null);
    setSaved(false);
    setDirty(false);
    setError(null);
    setErrors({});
    setLineRows([blankLine()]);
  };

  // Auto-split success summary — shown after a multi-warehouse create. The shared context (supplier,
  // item count, expected date) is surfaced once at the top since every split PO carries it; each row
  // then shows only what differs (warehouse + value) as a clickable link to that PO.
  if (splitResult) {
    const totalValue = splitResult.reduce((sum, po) => sum + (po.grandTotal ?? 0), 0);
    const totalItems = splitResult.reduce((sum, po) => sum + po.items.length, 0);
    const first = splitResult[0];
    const supplierName = first?.supplierName ?? null;
    const expected = first?.expectedDeliveryDate ?? null;
    return (
      <div className="anim-fade-in mx-auto max-w-2xl space-y-6 py-4" style={{ animationFillMode: "backwards" }}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--pos)]/10 text-[var(--pos)] ring-8 ring-[var(--pos)]/5">
            <CheckCircle2 className="h-8 w-8" />
          </span>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">
              {splitResult.length} purchase {splitResult.length === 1 ? "order" : "orders"} created
            </h1>
            <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
              Split by delivery warehouse — one independent draft per warehouse, each ready to review and send.
            </p>
          </div>
        </div>

        {/* Shared context — every split PO carries the same supplier, items and expected date. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {supplierName && <ContextChip icon={Truck}>{supplierName}</ContextChip>}
          <ContextChip icon={Package}>
            {totalItems} item{totalItems === 1 ? "" : "s"} total
          </ContextChip>
          {expected && <ContextChip icon={CalendarDays}>Expected {formatDate(expected)}</ContextChip>}
        </div>

        <div
          className="overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-xs"
          style={{ borderRadius: "var(--radius)" }}
        >
          <div className="divide-y divide-[var(--border)]">
            {splitResult.map((po, i) => (
              <button
                key={po.id}
                type="button"
                onClick={() => router.push(`/dashboard/purchase-orders/${po.code}`)}
                className="anim-fade-in group flex w-full items-center gap-3.5 px-4 py-4 text-left transition-colors hover:bg-[var(--surface-2)]"
                style={{ animationDelay: `${i * 60}ms`, animationFillMode: "backwards" }}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-10)] text-[var(--accent)]">
                  <WarehouseIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-extrabold text-[var(--ink)]">{po.code}</span>
                    <PoStatusBadge status={po.status} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                    {po.warehouse ? `${po.warehouse.name} (${po.warehouse.code})` : "—"} · {po.items.length} item
                    {po.items.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-extrabold text-[var(--ink)]">{formatMoney(po.grandTotal)}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">incl. VAT</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Total value</span>
            <span className="text-base font-extrabold text-[var(--ink)]">{formatMoney(totalValue)}</span>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-center">
          <button type="button" onClick={createAnother} className={ghostBtn}>
            <RotateCcw className="h-3.5 w-3.5" /> Create another
          </button>
          <button type="button" onClick={() => router.push(PO_LIST)} className={primaryBtn}>
            View all purchase orders
          </button>
        </div>
      </div>
    );
  }

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
                <Select value={supplierId} onChange={(v) => { setSupplierId(v); touch(); clearError("supplierId"); }} options={suppliers.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))} placeholder="— Select a supplier —" ariaLabel="Supplier" invalid={Boolean(errors.supplierId)} />
                <FieldError id="err-supplierId" message={errors.supplierId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Choose who this order is being placed with.</p>
              </div>
              {/* Delivery warehouse is per ITEM ROW on create (the order auto-splits by warehouse).
                  Only the edit flow keeps a single header warehouse (a PO never spans warehouses). */}
              {mode === "edit" && (
                <div>
                  <label className={labelCls}>Delivery warehouse<RequiredMark /></label>
                  <Select value={warehouseId} onChange={(v) => { setWarehouseId(v); touch(); clearError("warehouseId"); }} options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})${w.isDefault ? " — default" : ""}` }))} placeholder="— Select a warehouse —" ariaLabel="Delivery warehouse" invalid={Boolean(errors.warehouseId)} />
                  <FieldError id="err-warehouseId" message={errors.warehouseId} />
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">The warehouse this order delivers to.</p>
                </div>
              )}
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
                <Select value={priority} onChange={(v) => { setPriority(v as typeof priority); touch(); }} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} ariaLabel="Priority" />
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
                    <div className="space-y-3">
                      {/* Item (+ per-row Warehouse on create) — these hold long labels, so they get
                          full width and only sit side-by-side once there's room (md+). `min-w-0`
                          lets the Select truncate instead of overflowing the column. */}
                      <div className={mode === "create" ? "grid gap-3 md:grid-cols-2" : undefined}>
                        <div className="min-w-0">
                          <label className={labelCls}>Item</label>
                          <Select value={row.irmItemId} onChange={(v) => onPickItem(idx, v)} options={itemOptions.list.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))} placeholder="— Select an item —" ariaLabel="Item" />
                          {pickedItem && supplierId && (
                            supplierLink?.supplierSku ? (
                              <p className="mt-1.5 text-[11px] text-[var(--muted)]">Supplier item code: <span className="font-mono text-[var(--ink)]">{supplierLink.supplierSku}</span></p>
                            ) : !supplierLink ? (
                              <p className="mt-1.5 text-[11px] text-[var(--warn)]">Not listed for the selected supplier.</p>
                            ) : null
                          )}
                        </div>
                        {/* Per-row destination warehouse (create only) — the order auto-splits by this.
                            A manager with a single assigned warehouse has it auto-selected + locked. */}
                        {mode === "create" && (
                          <div className="min-w-0">
                            <label className={labelCls}>Warehouse</label>
                            <Select
                              value={rowWarehouseId(row)}
                              onChange={(v) => updateLine(idx, { warehouseId: v })}
                              options={warehouseOptions.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
                              placeholder="— Select —"
                              ariaLabel="Destination warehouse"
                              disabled={Boolean(lockedWarehouseId)}
                            />
                          </div>
                        )}
                      </div>
                      {/* Numerics — narrow, kept on their own row so the Quantity stepper never gets
                          squeezed. Three-up from the smallest tablet width; stacks 1-up on phones. */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="min-w-0">
                          <label className={labelCls}>Quantity</label>
                          <NumberInput className={inputCls} min={1} value={row.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} placeholder="e.g. 100" />
                        </div>
                        <div className="min-w-0">
                          <label className={labelCls}>Unit price (£)</label>
                          <NumberInput className={inputCls} min={0} step="0.01" value={row.unitPrice} onChange={(e) => updateLine(idx, { unitPrice: e.target.value })} placeholder="e.g. 12.50" />
                        </div>
                        <div className="min-w-0">
                          <label className={labelCls}>VAT %</label>
                          <NumberInput className={inputCls} min={0} max={100} step="0.01" value={row.vatRate} onChange={(e) => updateLine(idx, { vatRate: e.target.value })} placeholder="20" />
                        </div>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border)] pt-2.5">
                      <div className="text-xs">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Line total </span>
                        <span className="font-semibold text-[var(--ink)]">{formatMoney(qty * price)}</span>
                      </div>
                      <button type="button" onClick={() => removeLine(idx)} disabled={lineRows.length === 1} className="rounded-lg p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" title="Remove line" aria-label="Remove line">
                        <Trash2 className="h-4 w-4" />
                      </button>
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
