"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as grnService from "@/services/goods-in.service";
import { listPurchaseOrders } from "@/services/purchase-order.service";
import { listIrmItems } from "@/services/irm.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import type { GoodsReceipt } from "@/types/goods-in";
import type { PurchaseOrder } from "@/types/purchase-order";

const GRN_LIST = "/dashboard/goods-in";
const QUALITY = ["passed", "partial", "failed"] as const;
const QUALITY_LABELS: Record<string, string> = { passed: "Passed", partial: "Partial", failed: "Failed" };

// `_key` is a stable, frontend-only React key (never sent to the backend) so batch rows keep their
// identity across add/remove and controlled inputs don't desync when a middle row is deleted.
type BatchRow = { _key: string; batchNumber: string; expiryDate: string; quantity: string };
type LineState = {
  purchaseOrderItemId: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  ordered: number;
  previouslyReceived: number;
  trackSerials: boolean;
  trackBatches: boolean;
  receive: string;
  damaged: string;
  notes: string;
  serialsText: string;
  batches: BatchRow[];
};

const today = () => new Date().toISOString().slice(0, 10);
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string) => Number(s) || 0;
const acceptedOf = (l: LineState) => Math.max(0, num(l.receive) - num(l.damaged));
const parseSerials = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

export function GoodsReceiptForm({ mode, order }: { mode: "create" | "edit"; order?: GoodsReceipt | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const o = order;
  const [poId, setPoId] = React.useState(o?.purchaseOrderId ?? "");
  const [receivedDate, setReceivedDate] = React.useState(o ? dateInput(o.receivedDate) : today());
  const [referenceNumber, setReferenceNumber] = React.useState(o?.referenceNumber ?? "");
  const [carrier, setCarrier] = React.useState(o?.carrier ?? "");
  const [deliveryNoteNumber, setDeliveryNoteNumber] = React.useState(o?.deliveryNoteNumber ?? "");
  const [vehicleRegistration, setVehicleRegistration] = React.useState(o?.vehicleRegistration ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [qualityStatus, setQualityStatus] = React.useState(o?.qualityStatus ?? "passed");
  const [qualityNotes, setQualityNotes] = React.useState(o?.qualityNotes ?? "");
  const [internalNotes, setInternalNotes] = React.useState(o?.internalNotes ?? "");

  const [lines, setLines] = React.useState<LineState[]>(() =>
    o
      ? o.items.map((i) => ({
          purchaseOrderItemId: i.purchaseOrderItemId,
          irmItemId: i.irmItemId,
          itemName: i.itemName,
          sku: i.sku,
          baseUnit: i.baseUnit,
          ordered: i.orderedQuantity,
          previouslyReceived: i.previouslyReceived,
          trackSerials: i.irmItem?.trackSerialNumbers ?? false,
          trackBatches: i.irmItem?.trackBatchNumbers ?? false,
          receive: String(i.receivedQuantity),
          damaged: String(i.damagedQuantity),
          notes: i.notes ?? "",
          serialsText: i.serials.map((s) => s.serialNumber).join("\n"),
          batches: i.batches.map((b) => ({ _key: crypto.randomUUID(), batchNumber: b.batchNumber, expiryDate: dateInput(b.expiryDate), quantity: String(b.quantity) })),
        }))
      : [],
  );

  const [receivablePos, setReceivablePos] = React.useState<PurchaseOrder[]>([]);
  const [flags, setFlags] = React.useState<Map<string, { serials: boolean; batches: boolean }>>(new Map());
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);

  // Read-only supplier/warehouse panels — from the selected PO (create) or the order (edit).
  const selectedPo = receivablePos.find((p) => p.id === poId) ?? null;
  const supplierPanel = o?.supplier ?? selectedPo?.supplier ?? null;
  const warehousePanel = o?.warehouse ?? selectedPo?.warehouse ?? null;
  const supplierName = o?.supplierName ?? selectedPo?.supplierName ?? null;

  React.useEffect(() => {
    if (mode !== "create") return;
    let active = true;
    // Receivable POs = sent + partially_received.
    Promise.all([
      listPurchaseOrders({ status: "sent", pageSize: 100 }),
      listPurchaseOrders({ status: "partially_received", pageSize: 100 }),
    ]).then(([a, b]) => active && setReceivablePos([...a.purchaseOrders, ...b.purchaseOrders]), () => {});
    // IRM tracking flags, to decide which lines capture serials / batches.
    listIrmItems({ status: "active", pageSize: 200 }).then(
      (r) => active && setFlags(new Map(r.items.map((i) => [i.id, { serials: i.trackSerialNumbers, batches: i.trackBatchNumbers }]))),
      () => {},
    );
    return () => { active = false; };
  }, [mode]);

  useReportDirty("grn-form", dirty && !saved);

  // On create: when a PO is picked, build the received-item lines (only lines with remaining > 0).
  const onPickPo = (id: string) => {
    setPoId(id);
    touch();
    clearError("purchaseOrderId");
    clearError("items");
    const po = receivablePos.find((p) => p.id === id);
    if (!po) {
      setLines([]);
      return;
    }
    setLines(
      po.items
        .filter((i) => i.quantity - i.receivedQuantity > 0)
        .map((i) => {
          const f = flags.get(i.irmItemId);
          return {
            purchaseOrderItemId: i.id,
            irmItemId: i.irmItemId,
            itemName: i.itemName,
            sku: i.sku,
            baseUnit: i.baseUnit,
            ordered: i.quantity,
            previouslyReceived: i.receivedQuantity,
            trackSerials: f?.serials ?? false,
            trackBatches: f?.batches ?? false,
            receive: "",
            damaged: "0",
            notes: "",
            serialsText: "",
            batches: [],
          };
        }),
    );
  };

  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  const goBack = () => guard.attemptLeave(() => router.push(GRN_LIST));
  const updateLine = (idx: number, patch: Partial<LineState>) => {
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    touch();
    clearError("items");
  };
  const addBatch = (idx: number) => updateLine(idx, { batches: [...lines[idx].batches, { _key: crypto.randomUUID(), batchNumber: "", expiryDate: "", quantity: "" }] });
  const updateBatch = (idx: number, bi: number, patch: Partial<BatchRow>) =>
    updateLine(idx, { batches: lines[idx].batches.map((b, i) => (i === bi ? { ...b, ...patch } : b)) });
  const removeBatch = (idx: number, bi: number) => updateLine(idx, { batches: lines[idx].batches.filter((_, i) => i !== bi) });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (mode === "create" && !poId) errs.purchaseOrderId = "Select a purchase order.";
    if (!receivedDate) errs.receivedDate = "Received date is required.";

    const active = lines.filter((l) => num(l.receive) > 0);
    if (active.length === 0) {
      errs.items = "Receive a quantity for at least one item.";
      return errs;
    }
    for (const l of active) {
      const remaining = l.ordered - l.previouslyReceived;
      const receive = num(l.receive);
      const damaged = num(l.damaged);
      const accepted = receive - damaged;
      if (receive > remaining) { errs.items = `${l.itemName}: can't receive more than the ${remaining} remaining.`; break; }
      if (damaged > receive) { errs.items = `${l.itemName}: damaged can't exceed received.`; break; }
      if (l.trackSerials && parseSerials(l.serialsText).length !== accepted) { errs.items = `${l.itemName}: enter exactly ${accepted} serial number(s).`; break; }
      if (l.trackBatches) {
        const sum = l.batches.reduce((a, b) => a + num(b.quantity), 0);
        if (sum !== accepted) { errs.items = `${l.itemName}: batch quantities must total ${accepted}.`; break; }
      }
    }
    return errs;
  };

  const buildPayload = (): grnService.GoodsReceiptPayload => ({
    ...(mode === "create" ? { purchaseOrderId: poId } : {}),
    receivedDate,
    referenceNumber: referenceNumber.trim(),
    carrier: carrier.trim(),
    deliveryNoteNumber: deliveryNoteNumber.trim(),
    vehicleRegistration: vehicleRegistration.trim(),
    description: description.trim(),
    qualityStatus,
    qualityNotes: qualityNotes.trim(),
    internalNotes: internalNotes.trim(),
    items: lines
      .filter((l) => num(l.receive) > 0)
      .map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        receivedQuantity: num(l.receive),
        damagedQuantity: num(l.damaged),
        notes: l.notes.trim() || undefined,
        serials: l.trackSerials ? parseSerials(l.serialsText) : undefined,
        batches: l.trackBatches
          ? l.batches.map((b) => ({ batchNumber: b.batchNumber.trim(), expiryDate: b.expiryDate || undefined, quantity: num(b.quantity) }))
          : undefined,
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
        const created = await grnService.createGoodsReceipt(buildPayload());
        setSaved(true);
        pushToast(`Goods receipt ${created.code} created.`, "success");
        router.push(`/dashboard/goods-in/${created.code}`);
      } else if (o) {
        await grnService.updateGoodsReceipt(o.id, buildPayload());
        setSaved(true);
        pushToast("Goods receipt updated.", "success");
        router.push(`/dashboard/goods-in/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the goods receipt.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New goods receipt" : `Edit ${o?.code ?? "receipt"}`}
        subtitle={mode === "edit" && o ? o.code : "Receive a delivery against a purchase order"}
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
          <FormSection title="Goods In information" description="Which delivery this is and against which order.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Purchase order<RequiredMark /></label>
                {mode === "create" ? (
                  <>
                    <select className={inputCls} value={poId} onChange={(e) => onPickPo(e.target.value)} aria-invalid={Boolean(errors.purchaseOrderId)}>
                      <option value="">— Select a purchase order —</option>
                      {receivablePos.map((p) => (
                        <option key={p.id} value={p.id}>{p.code} — {p.supplierName ?? p.supplier?.name ?? ""} ({p.status === "sent" ? "Sent" : "Partially received"})</option>
                      ))}
                    </select>
                    <FieldError message={errors.purchaseOrderId} />
                    <p className="mt-1.5 text-[11px] text-[var(--faint)]">Choose a Sent or Partially Received purchase order to receive this delivery.</p>
                  </>
                ) : (
                  <input className={inputCls} value={`${o?.poCode ?? ""}`} disabled />
                )}
              </div>
              <div>
                <label className={labelCls}>Received date<RequiredMark /></label>
                <input type="date" className={inputCls} value={receivedDate} onChange={(e) => { setReceivedDate(e.target.value); touch(); clearError("receivedDate"); }} aria-invalid={Boolean(errors.receivedDate)} placeholder="dd-mm-yyyy" />
                <FieldError message={errors.receivedDate} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The date this delivery physically arrived at the warehouse.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery warehouse</label>
                <input className={inputCls} value={warehousePanel ? `${warehousePanel.name} (${warehousePanel.code})` : "—"} disabled />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Inherited from the purchase order and locked for this receipt.</p>
              </div>
              <div>
                <label className={labelCls}>Delivery note number</label>
                <input className={inputCls} value={deliveryNoteNumber} onChange={(e) => { setDeliveryNoteNumber(e.target.value); touch(); }} maxLength={80} placeholder="e.g. DN-2026-001" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Enter the supplier&apos;s delivery note or dispatch reference if available.</p>
              </div>
              <div>
                <label className={labelCls}>Carrier</label>
                <input className={inputCls} value={carrier} onChange={(e) => { setCarrier(e.target.value); touch(); }} maxLength={120} placeholder="e.g. DPD, DHL, FedEx or Own Transport" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Who delivered the goods to the warehouse.</p>
              </div>
              <div>
                <label className={labelCls}>Vehicle registration</label>
                <input className={inputCls} value={vehicleRegistration} onChange={(e) => { setVehicleRegistration(e.target.value); touch(); }} maxLength={20} placeholder="e.g. AB12 CDE" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional. Enter the delivery vehicle registration if recorded.</p>
              </div>
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. REF-2026-01" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional internal reference for this receipt.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea className={inputCls} rows={2} value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Pallets arrived in two separate deliveries." />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional operational notes about this delivery.</p>
              </div>
            </div>
          </FormSection>

          {supplierPanel && (
            <FormSection title="Supplier information" description="Read-only — from the purchase order.">
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Supplier</p><p className="text-[var(--ink)]">{supplierName ?? supplierPanel.name}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p><p className="text-[var(--ink)]">{supplierPanel.contactPerson || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Email</p><p className="text-[var(--ink)]">{supplierPanel.contactEmail || "—"}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Phone</p><p className="text-[var(--ink)]">{supplierPanel.contactPhone || "—"}</p></div>
              </div>
            </FormSection>
          )}

          <FormSection title="Received items" description="Enter the quantities physically received. Accepted quantity (Received − Damaged) is added to inventory when the receipt is completed.">
            {lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted)]">
                {mode === "create" ? "Select a purchase order to load its outstanding items." : "This receipt has no lines."}
              </p>
            ) : (
              <div className="space-y-3">
                {lines.map((l, idx) => {
                  const remaining = l.ordered - l.previouslyReceived;
                  const accepted = acceptedOf(l);
                  const batchSum = l.batches.reduce((a, b) => a + num(b.quantity), 0);
                  const serialCount = parseSerials(l.serialsText).length;
                  return (
                    <div key={l.purchaseOrderItemId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-[var(--ink)]">{l.itemName}{l.sku ? <span className="ml-1.5 text-[11px] font-normal text-[var(--faint)]">{l.sku}</span> : null}</span>
                        <span className="text-[11px] text-[var(--muted)]">Ordered {l.ordered} · Already received {l.previouslyReceived} · <strong className="text-[var(--ink)]">Remaining {remaining}</strong></span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-4">
                        <div>
                          <label className={labelCls}>Receive qty</label>
                          <input className={inputCls} type="number" min={0} max={remaining} value={l.receive} onChange={(e) => updateLine(idx, { receive: e.target.value })} placeholder="e.g. 100" />
                        </div>
                        <div>
                          <label className={labelCls}>Damaged</label>
                          <input className={inputCls} type="number" min={0} value={l.damaged} onChange={(e) => updateLine(idx, { damaged: e.target.value })} placeholder="e.g. 2" />
                        </div>
                        <div>
                          <label className={labelCls}>Accepted</label>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm font-semibold text-[var(--ink)]">{accepted}{l.baseUnit ? ` ${l.baseUnit}` : ""}</div>
                        </div>
                        <div>
                          <label className={labelCls}>Line notes</label>
                          <input className={inputCls} value={l.notes} onChange={(e) => updateLine(idx, { notes: e.target.value })} maxLength={2000} placeholder="e.g. Outer box damaged" />
                        </div>
                      </div>

                      {l.trackSerials && (
                        <div className="mt-3">
                          <label className={labelCls}>Serial numbers (one per line)</label>
                          <textarea className={inputCls} rows={Math.min(6, Math.max(2, accepted))} value={l.serialsText} onChange={(e) => updateLine(idx, { serialsText: e.target.value })} placeholder="One serial per accepted unit" />
                          <p className={`mt-1 text-[11px] ${serialCount === accepted ? "text-[var(--faint)]" : "text-[var(--neg)]"}`}>{serialCount} of {accepted} serial number(s) entered.</p>
                        </div>
                      )}

                      {l.trackBatches && (
                        <div className="mt-3">
                          <label className={labelCls}>Batches</label>
                          <div className="space-y-2">
                            {l.batches.map((b, bi) => (
                              <div key={b._key} className="grid gap-2 sm:grid-cols-12">
                                <input className={`${inputCls} sm:col-span-5`} value={b.batchNumber} onChange={(e) => updateBatch(idx, bi, { batchNumber: e.target.value })} maxLength={120} placeholder="Batch / lot number" />
                                <input className={`${inputCls} sm:col-span-4`} type="date" value={b.expiryDate} onChange={(e) => updateBatch(idx, bi, { expiryDate: e.target.value })} />
                                <input className={`${inputCls} sm:col-span-2`} type="number" min={1} value={b.quantity} onChange={(e) => updateBatch(idx, bi, { quantity: e.target.value })} placeholder="Qty" />
                                <button type="button" onClick={() => removeBatch(idx, bi)} className="flex items-center justify-center rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] sm:col-span-1" aria-label="Remove batch"><Trash2 className="h-4 w-4" /></button>
                              </div>
                            ))}
                            <button type="button" onClick={() => addBatch(idx)} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add batch</button>
                            <p className={`text-[11px] ${batchSum === accepted ? "text-[var(--faint)]" : "text-[var(--neg)]"}`}>Batch total {batchSum} of {accepted} accepted.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <FieldError message={errors.items} />
          </FormSection>

          <FormSection title="Quality check" description="A summary flag for this delivery.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Quality status</label>
                <select className={inputCls} value={qualityStatus} onChange={(e) => { setQualityStatus(e.target.value as typeof qualityStatus); touch(); }}>
                  {QUALITY.map((q) => (<option key={q} value={q}>{QUALITY_LABELS[q]}</option>))}
                </select>
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Overall quality outcome for this delivery.</p>
              </div>
              <div>
                <label className={labelCls}>Quality notes</label>
                <input className={inputCls} value={qualityNotes} onChange={(e) => { setQualityNotes(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. 2 connectors damaged during transport" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Record issues found during inspection.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Internal notes</label>
                <textarea className={inputCls} rows={2} value={internalNotes} onChange={(e) => { setInternalNotes(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Stored in Rack A3 after inspection" />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Internal notes visible only to staff.</p>
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Receipt summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-[var(--muted)]">Lines receiving</span><span className="font-semibold text-[var(--ink)]">{lines.filter((l) => num(l.receive) > 0).length}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total received</span><span className="font-semibold text-[var(--ink)]">{lines.reduce((a, l) => a + num(l.receive), 0)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total accepted</span><span className="font-extrabold text-[var(--ink)]">{lines.reduce((a, l) => a + acceptedOf(l), 0)}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">Inventory is updated only when the receipt is completed. The GRN number is assigned when the draft is saved.</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
