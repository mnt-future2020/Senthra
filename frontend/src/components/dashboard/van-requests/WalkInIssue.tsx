"use client";

import * as React from "react";
import { ArrowLeft, Loader2, PackagePlus } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockItemOption, VanStockPriority } from "@/services/vanStockRequest.service";
import { listEngineerOptions } from "@/services/warehouse.service";
import { FormAsideCard, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { VanStockCartTable, VanStockItemSearch, type VanStockCartItem } from "./vanRequestUi";

// Counter issue: the reviewer builds a PRE-APPROVED request for an engineer standing in front of them,
// then scan-fulfils it. Mirrors the engineer's own composer (same FormSection shell, same shared item
// search + cart) — it is the same act of composing a request, so it reads the same.
//
// A page inside the tab, not a modal: this stacks a catalogue search over a cart the backend lets run
// to 100 lines, and in a `<Modal size="lg" scrollBody>` that meant three nested scroll regions inside
// 32rem — the search results, the cart, and the modal body. Three items was already uncomfortable.

const PRIORITY_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export function WalkInIssue({
  warehouse,
  onClose,
  onCreated,
}: {
  warehouse: { id: string; name: string; code: string | null };
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const [engineers, setEngineers] = React.useState<Array<{ id: string; name: string }>>([]);
  const [engineerId, setEngineerId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [priority, setPriority] = React.useState<VanStockPriority>("normal");
  const [cart, setCart] = React.useState<VanStockCartItem[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  // Synchronous mirror of `submitting`. `disabled={submitting}` alone can't stop two submits dispatched
  // inside ONE React commit — a double-click, or a scan gun's trailing Enter while the Create button has
  // focus. setSubmitting is async, so both handlers would read submitting===false and both POST, issuing
  // the engineer two duplicate pre-approved requests (each deducting stock on scan). The ref flips
  // synchronously. Same guard, same reason, as VanRequestDetail's busyRef.
  const submittingRef = React.useRef(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    listEngineerOptions()
      .then((us) => setEngineers(us.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => setEngineers([]));
  }, []);

  const excludeIds = React.useMemo(() => new Set(cart.map((c) => c.irmItemId)), [cart]);
  const addItem = (it: VanStockItemOption) =>
    setCart((c) => (c.some((x) => x.irmItemId === it.irmItemId) ? c : [...c, { irmItemId: it.irmItemId, name: it.name, code: it.code, qty: 1 }]));
  const setQty = (id: string, qty: number) => setCart((c) => c.map((x) => (x.irmItemId === id ? { ...x, qty } : x)));
  const remove = (id: string) => setCart((c) => c.filter((x) => x.irmItemId !== id));

  const totalQty = cart.reduce((s, c) => s + c.qty, 0);
  const engineerName = engineers.find((e) => e.id === engineerId)?.name;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!engineerId) { setMsg({ type: "error", text: "Pick the engineer receiving the stock." }); return; }
    if (cart.length === 0) { setMsg({ type: "error", text: "Add at least one item." }); return; }
    if (!reason.trim()) { setMsg({ type: "error", text: "A reason is required." }); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setMsg(null);
    try {
      const req = await vanStockSvc.createVanStockWalkIn({
        engineerId,
        warehouseId: warehouse.id, // the tab's warehouse — a walk-in is issued HERE by definition
        reason: reason.trim(),
        priority,
        lines: cart.map((c) => ({ irmItemId: c.irmItemId, itemName: c.name, qty: c.qty })),
      });
      onCreated(req.code);
    } catch (err) {
      // Released only on failure — a success navigates away, and re-arming there would let a late
      // second dispatch through on the way out.
      submittingRef.current = false;
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not create the walk-in request." });
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] pb-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          title={submitting ? "Finishing the current action…" : "Back to the queue"}
          className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Queue
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-extrabold text-[var(--ink)]">Walk-in issue</h2>
          <p className="truncate text-xs text-[var(--muted)]">
            Pre-approved request for an engineer at the counter — scan it out next · {warehouse.name}
          </p>
        </div>
        <button type="submit" disabled={submitting} className={`${primaryBtn} shrink-0`}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
          {submitting ? "Creating…" : "Create pre-approved"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 pt-4">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <FormSection title="Add items" description="Search the catalogue for the stock being handed over.">
              <VanStockItemSearch excludeIds={excludeIds} onAddItem={addItem} placeholder="Search the catalogue…" />
            </FormSection>

            <FormSection title={`Selected items${cart.length ? ` (${cart.length})` : ""}`} description="Set the quantity for each item.">
              <VanStockCartTable cart={cart} onQty={setQty} onRemove={remove} />
            </FormSection>

            <FormSection title="Who & why" description="The engineer receives this stock onto their van the moment it's scanned out.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Engineer <RequiredMark /></label>
                  <Select
                    ariaLabel="Engineer"
                    value={engineerId}
                    onChange={setEngineerId}
                    options={[{ value: "", label: "Pick an engineer…" }, ...engineers.map((e) => ({ value: e.id, label: e.name }))]}
                  />
                </div>
                <div>
                  <label className={labelCls}>Priority</label>
                  <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority(v as VanStockPriority)} options={PRIORITY_OPTIONS} />
                </div>
              </div>
              <div className="mt-4">
                <label className={labelCls}>Reason <RequiredMark /></label>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                  placeholder="e.g. Engineer collected consumables at the counter."
                  className={inputCls}
                />
              </div>
              {msg && <div className="mt-4"><Notice msg={msg} /></div>}
            </FormSection>
          </div>

          <div className="lg:sticky lg:top-4 lg:self-start">
            <FormAsideCard title="Summary">
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Issuing warehouse</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{warehouse.code ? `${warehouse.name} (${warehouse.code})` : warehouse.name}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Engineer</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{engineerName ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Items</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{cart.length}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Total qty</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{totalQty}</dd>
                </div>
              </dl>
              <p className="mt-4 text-[11px] text-[var(--faint)]">
                Creating this skips review — it opens already approved, ready to scan out.
              </p>
            </FormAsideCard>
          </div>
        </div>
      </div>
    </form>
  );
}
