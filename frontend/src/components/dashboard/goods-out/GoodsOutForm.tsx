"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import * as goodsOutService from "@/services/goods-out.service";
import { listIrmItems } from "@/services/irm.service";
import { listWarehouses, listManagerOptions } from "@/services/warehouse.service";
import { getAvailability } from "@/services/inventory.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { inputCls, ghostBtn, labelCls, primaryBtn } from "@/components/ui/styles";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { DISPATCH_REASONS, DISPATCH_REASON_LABELS } from "./goodsOutStatus";
import type { GoodsOut } from "@/types/goods-out";

const GOODS_OUT_LIST = "/dashboard/goods-out";
const today = () => new Date().toISOString().slice(0, 10);
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const num = (s: string) => Number(s) || 0;

type ItemOption = { id: string; code: string; name: string; sku: string | null; baseUnit: string | null };
type StaffOption = { id: string; name: string; jobTitle: string | null };
type LineState = { _key: string; irmItemId: string; baseUnit: string | null; quantity: string; notes: string; available: number | null; loadingAvail: boolean };

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{message}</p>;
}

const newLine = (): LineState => ({ _key: crypto.randomUUID(), irmItemId: "", baseUnit: null, quantity: "", notes: "", available: null, loadingAvail: false });

export function GoodsOutForm({ mode, order }: { mode: "create" | "edit"; order?: GoodsOut | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const o = order;
  const [warehouseId, setWarehouseId] = React.useState(o?.warehouseId ?? "");
  const [engineerId, setEngineerId] = React.useState(o?.engineerId ?? "");
  const [dispatchDate, setDispatchDate] = React.useState(o ? dateInput(o.dispatchDate) : today());
  const [dispatchReason, setDispatchReason] = React.useState<string>(o?.dispatchReason ?? "");
  const [expectedReturnDate, setExpectedReturnDate] = React.useState(o ? dateInput(o.expectedReturnDate) : "");
  const [authorizedById, setAuthorizedById] = React.useState(o?.authorizedById ?? "");
  const [referenceNumber, setReferenceNumber] = React.useState(o?.referenceNumber ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [internalNotes, setInternalNotes] = React.useState(o?.internalNotes ?? "");

  const [lines, setLines] = React.useState<LineState[]>(() =>
    o ? o.items.map((i) => ({ _key: crypto.randomUUID(), irmItemId: i.irmItemId, baseUnit: i.baseUnit, quantity: String(i.quantity), notes: i.notes ?? "", available: null, loadingAvail: false })) : [newLine()],
  );

  const [items, setItems] = React.useState<ItemOption[]>([]);
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [staff, setStaff] = React.useState<StaffOption[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const touch = () => setDirty(true);
  const clearError = (f: string) => setErrors((p) => { if (!p[f]) return p; const n = { ...p }; delete n[f]; return n; });
  useReportDirty("goods-out-form", dirty && !saved);

  // Dispatchable items = active, inventory-tracked, NOT serial/batch (serialised dispatch is future).
  React.useEffect(() => {
    let active = true;
    listIrmItems({ status: "active", pageSize: 200 }).then(
      (r) => active && setItems(r.items.filter((i) => i.trackInventory && !i.trackSerialNumbers && !i.trackBatchNumbers).map((i) => ({ id: i.id, code: i.code, name: i.name, sku: i.sku, baseUnit: i.baseUnit }))),
      () => {},
    );
    listWarehouses({ status: "active", pageSize: 100 }).then((r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))), () => {});
    listManagerOptions().then((us) => active && setStaff(us.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle }))), () => {});
    return () => { active = false; };
  }, []);

  const setLine = (key: string, patch: Partial<LineState>) => setLines((rows) => rows.map((r) => (r._key === key ? { ...r, ...patch } : r)));

  // Live available for a line at the chosen warehouse.
  const loadAvailability = React.useCallback((key: string, itemId: string, whId: string) => {
    if (!itemId || !whId) { setLine(key, { available: null, loadingAvail: false }); return; }
    setLine(key, { loadingAvail: true });
    getAvailability(itemId, whId).then(
      (a) => setLine(key, { available: a.available, loadingAvail: false }),
      () => setLine(key, { available: null, loadingAvail: false }),
    );
  }, []);

  // On opening an EXISTING draft, load each line's availability immediately (once) so the hint
  // and the client-side over-quantity guard are correct without the user re-picking anything.
  // Lines open seeded with `available: null`; without this they'd show "no stock" until touched.
  const didLoadInitialAvail = React.useRef(false);
  React.useEffect(() => {
    if (didLoadInitialAvail.current || !o || !warehouseId) return;
    didLoadInitialAvail.current = true;
    lines.forEach((l) => { if (l.irmItemId) loadAvailability(l._key, l.irmItemId, warehouseId); });
  }, [o, warehouseId, lines, loadAvailability]);

  // When the warehouse changes, re-check availability for every line that has an item.
  const onPickWarehouse = (whId: string) => {
    setWarehouseId(whId);
    touch();
    clearError("warehouseId");
    lines.forEach((l) => { if (l.irmItemId) loadAvailability(l._key, l.irmItemId, whId); });
  };

  const onPickItem = (key: string, itemId: string) => {
    const opt = items.find((i) => i.id === itemId) ?? null;
    setLine(key, { irmItemId: itemId, baseUnit: opt?.baseUnit ?? null });
    touch();
    clearError("items");
    loadAvailability(key, itemId, warehouseId);
  };

  const addLine = () => { setLines((rows) => [...rows, newLine()]); touch(); };
  const removeLine = (key: string) => { setLines((rows) => (rows.length === 1 ? rows : rows.filter((r) => r._key !== key))); touch(); };

  const goBack = () => guard.attemptLeave(() => router.push(GOODS_OUT_LIST));

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!warehouseId) errs.warehouseId = "Select a source warehouse.";
    if (!engineerId) errs.engineerId = "Select an engineer.";
    if (!dispatchDate) errs.dispatchDate = "Dispatch date is required.";
    if (!dispatchReason) errs.dispatchReason = "Select a dispatch reason.";

    const active = lines.filter((l) => l.irmItemId && num(l.quantity) > 0);
    if (active.length === 0) { errs.items = "Add at least one item with a quantity."; return errs; }
    const seen = new Set<string>();
    for (const l of active) {
      if (seen.has(l.irmItemId)) { errs.items = "The same item appears more than once — combine the quantities."; break; }
      seen.add(l.irmItemId);
      if (!Number.isInteger(num(l.quantity)) || num(l.quantity) < 1) { errs.items = "Quantities must be whole numbers of at least 1."; break; }
      if (l.available !== null && num(l.quantity) > l.available) { errs.items = "A line exceeds the available stock at the source warehouse."; break; }
    }
    return errs;
  };

  const buildPayload = (): goodsOutService.GoodsOutPayload => ({
    warehouseId,
    engineerId,
    dispatchDate,
    dispatchReason,
    expectedReturnDate: expectedReturnDate || undefined,
    authorizedById: authorizedById || undefined,
    authorizedByName: authorizedById ? staff.find((s) => s.id === authorizedById)?.name : undefined,
    referenceNumber: referenceNumber.trim() || undefined,
    description: description.trim() || undefined,
    internalNotes: internalNotes.trim() || undefined,
    items: lines.filter((l) => l.irmItemId && num(l.quantity) > 0).map((l) => ({ irmItemId: l.irmItemId, quantity: num(l.quantity), notes: l.notes.trim() || undefined })),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
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
        const created = await goodsOutService.createGoodsOut(buildPayload());
        setSaved(true);
        pushToast(`Dispatch ${created.code} created.`, "success");
        router.push(`/dashboard/goods-out/${created.code}`);
      } else if (o) {
        await goodsOutService.updateGoodsOut(o.id, buildPayload());
        setSaved(true);
        pushToast("Dispatch updated.", "success");
        router.push(`/dashboard/goods-out/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the dispatch.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  const totalUnits = lines.reduce((a, l) => a + num(l.quantity), 0);
  const engineerLabel = (s: StaffOption) => (s.jobTitle ? `${s.name} — ${s.jobTitle}` : s.name);

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "New dispatch" : `Edit ${o?.code ?? "dispatch"}`}
        subtitle={mode === "edit" && o ? o.code : "Dispatch stock from a warehouse to an engineer"}
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
          <FormSection title="Dispatch details" description="Where the stock comes from, who it goes to, and why.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Source warehouse<RequiredMark /></label>
                <select className={inputCls} value={warehouseId} onChange={(e) => onPickWarehouse(e.target.value)} aria-invalid={Boolean(errors.warehouseId)}>
                  <option value="">— Select warehouse —</option>
                  {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name} ({w.code})</option>))}
                </select>
                <FieldError message={errors.warehouseId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Changing the warehouse re-checks available stock for each line.</p>
              </div>
              <div>
                <label className={labelCls}>Engineer<RequiredMark /></label>
                <select className={inputCls} value={engineerId} onChange={(e) => { setEngineerId(e.target.value); touch(); clearError("engineerId"); }} aria-invalid={Boolean(errors.engineerId)}>
                  <option value="">— Select engineer —</option>
                  {staff.map((s) => (<option key={s.id} value={s.id}>{engineerLabel(s)}</option>))}
                </select>
                <FieldError message={errors.engineerId} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">The dispatched stock is added to this engineer&apos;s personal holding.</p>
              </div>
              <div>
                <label className={labelCls}>Dispatch date<RequiredMark /></label>
                <input type="date" className={inputCls} value={dispatchDate} onChange={(e) => { setDispatchDate(e.target.value); touch(); clearError("dispatchDate"); }} aria-invalid={Boolean(errors.dispatchDate)} />
                <FieldError message={errors.dispatchDate} />
              </div>
              <div>
                <label className={labelCls}>Dispatch reason<RequiredMark /></label>
                <select className={inputCls} value={dispatchReason} onChange={(e) => { setDispatchReason(e.target.value); touch(); clearError("dispatchReason"); }} aria-invalid={Boolean(errors.dispatchReason)}>
                  <option value="">— Select reason —</option>
                  {DISPATCH_REASONS.map((r) => (<option key={r} value={r}>{DISPATCH_REASON_LABELS[r]}</option>))}
                </select>
                <FieldError message={errors.dispatchReason} />
              </div>
              <div>
                <label className={labelCls}>Expected return date</label>
                <input type="date" className={inputCls} value={expectedReturnDate} onChange={(e) => { setExpectedReturnDate(e.target.value); touch(); }} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional. When the engineer is expected to return any unused stock.</p>
              </div>
              <div>
                <label className={labelCls}>Authorised by</label>
                <select className={inputCls} value={authorizedById} onChange={(e) => { setAuthorizedById(e.target.value); touch(); }}>
                  <option value="">— None —</option>
                  {staff.map((s) => (<option key={s.id} value={s.id}>{engineerLabel(s)}</option>))}
                </select>
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">Optional. The PM / administrator who authorised this dispatch.</p>
              </div>
              <div>
                <label className={labelCls}>Reference number</label>
                <input className={inputCls} value={referenceNumber} onChange={(e) => { setReferenceNumber(e.target.value); touch(); }} maxLength={60} placeholder="e.g. DSP-2026-01" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <input className={inputCls} value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Kit for the Leeds Basinghall install" />
              </div>
            </div>
          </FormSection>

          <FormSection title="Items to dispatch" description="Serial- and batch-tracked items can't be dispatched yet and are not listed. Quantities are checked against live warehouse stock.">
            <div className="space-y-3">
              {lines.map((l) => (
                <div key={l._key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
                  <div className="grid gap-3 sm:grid-cols-12">
                    <div className="sm:col-span-6">
                      <label className={labelCls}>Item</label>
                      <select className={inputCls} value={l.irmItemId} onChange={(e) => onPickItem(l._key, e.target.value)}>
                        <option value="">— Select item —</option>
                        {items.map((i) => (<option key={i.id} value={i.id}>{i.code} — {i.name}{i.sku ? ` (${i.sku})` : ""}</option>))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelCls}>Quantity</label>
                      <input className={inputCls} type="number" min={1} step={1} max={l.available ?? undefined} value={l.quantity} onChange={(e) => { setLine(l._key, { quantity: e.target.value }); touch(); clearError("items"); }} placeholder="0" />
                    </div>
                    <div className="sm:col-span-3">
                      <label className={labelCls}>Line note</label>
                      <input className={inputCls} value={l.notes} onChange={(e) => { setLine(l._key, { notes: e.target.value }); touch(); }} maxLength={2000} placeholder="Optional" />
                    </div>
                    <div className="flex items-end sm:col-span-1">
                      <button type="button" onClick={() => removeLine(l._key)} disabled={lines.length === 1} className="flex h-[42px] w-full items-center justify-center rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--neg)] disabled:opacity-40" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {l.irmItemId && (
                    <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                      {!warehouseId ? "Select a source warehouse to see available stock." : l.loadingAvail ? "Checking available stock…" : l.available !== null ? `${l.available} available to dispatch${l.baseUnit ? ` ${l.baseUnit}` : ""}.` : "No stock of this item at the selected warehouse."}
                    </p>
                  )}
                </div>
              ))}
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-2)]"><Plus className="h-3.5 w-3.5" /> Add item</button>
            </div>
            <FieldError message={errors.items} />
          </FormSection>

          <FormSection title="Internal notes" description="Notes visible only to staff.">
            <textarea className={inputCls} rows={2} value={internalNotes} onChange={(e) => { setInternalNotes(e.target.value); touch(); }} maxLength={2000} placeholder="e.g. Collected in person at the Leeds depot." />
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Dispatch summary">
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Warehouse</span><span className="text-right font-semibold text-[var(--ink)]">{warehouses.find((w) => w.id === warehouseId)?.name ?? "—"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-[var(--muted)]">Engineer</span><span className="text-right font-semibold text-[var(--ink)]">{staff.find((s) => s.id === engineerId)?.name ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Lines</span><span className="font-semibold text-[var(--ink)]">{lines.filter((l) => l.irmItemId && num(l.quantity) > 0).length}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Total units</span><span className="font-extrabold text-[var(--ink)]">{totalUnits}</span></div>
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">Stock leaves the warehouse only when the draft is dispatched. The GDN number is assigned when the draft is saved.</p>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
