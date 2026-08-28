"use client";

import * as React from "react";
import { ArrowLeft, Loader2, PackagePlus } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type { VanStockPriority } from "@/services/vanStockRequest.service";
import { listEngineerOptions } from "@/services/warehouse.service";
import { FieldError, FormAsideCard, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { VAN_STOCK_PRIORITY_OPTIONS, VanStockCartTable, VanStockItemSearch, vanStockItemKey, type SearchItemOption, type VanStockCartItem } from "./vanRequestUi";

// Counter issue: the reviewer builds a PRE-APPROVED request for an engineer standing in front of them,
// then scan-fulfils it. Mirrors the engineer's own composer (same FormSection shell, same shared item
// search + cart) — it is the same act of composing a request, so it reads the same.
//
// A page inside the tab, not a modal: this stacks a catalogue search over a cart the backend lets run
// to 100 lines, and in a `<Modal size="lg" scrollBody>` that meant three nested scroll regions inside
// 32rem — the search results, the cart, and the modal body. Three items was already uncomfortable.

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
  // Field-level errors, kept apart from `msg` (cart-wide + server failures) so each renders against
  // the control it describes.
  const [errors, setErrors] = React.useState<{ engineerId?: string; reason?: string }>({});
  const noticeRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    listEngineerOptions()
      .then((us) => setEngineers(us.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => setEngineers([]));
  }, []);

  // On-hand + reorder level at THIS warehouse for every item added, captured from the search hit that
  // added it (the walk-in search annotates each hit). Drives the cart's on-hand line, the per-item qty
  // cap, and the reorder advisory below. Keyed by item id; cart-scoped reads ignore stale keys.
  const [stockById, setStockById] = React.useState<Record<string, { onHand: number; reorderLevel: number | null }>>({});

  // BOTH POOLS. The counter hands out company stock and hired kit, so a row's `source` is the thing
  // that tells them apart all the way to the server — which is why the cart is keyed on the shared
  // composite key rather than a bare item id: a tester and a cable can share neither.
  const excludeIds = React.useMemo(() => new Set(cart.map((c) => c.key)), [cart]);
  const addItem = (it: SearchItemOption) => {
    const key = vanStockItemKey(it);
    // hireEndDate rides along so the cart can show WHEN the kit is due back while the counter is
    // still deciding — the shared cart table already renders it. Display only: which hire actually
    // supplies the units is the server's decision at posting, never this screen's.
    setCart((c) => (c.some((x) => x.key === key) ? c : [...c, { key, source: it.source, irmItemId: it.irmItemId, rentalItemId: it.rentalItemId, name: it.name, code: it.code, qty: 1, maxQty: it.quantityOnHand, hireEndDate: it.hireEndDate ?? null }]));
    if (typeof it.quantityOnHand === "number") {
      setStockById((m) => ({ ...m, [key]: { onHand: it.quantityOnHand as number, reorderLevel: it.reorderLevel ?? null } }));
    }
  };
  const setQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, qty } : x)));
  const remove = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  // On-hand at this counter per cart item — feeds the cart's coloured "In stock: N" line.
  const shelfByItem = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cart) { const s = stockById[c.key]; if (s) m.set(c.key, s.onHand); }
    return m;
  }, [cart, stockById]);

  // ADVISORY only (never blocks): items whose on-hand AFTER this issue would sit at/below the item's
  // reorder level. Reorder level is a planning threshold that should trigger a reorder — not stop an
  // issue — so this is a soft heads-up, not a guard. Only items with a positive reorder policy count.
  const reorderWarnings = React.useMemo(
    () =>
      cart.flatMap((c) => {
        const s = stockById[c.key];
        // Rentals never reach the reorder engine (reorderLevel is null on a hire master), so they
        // fall out here naturally rather than needing a source test.
        if (!s || s.reorderLevel == null || s.reorderLevel <= 0) return [];
        const after = s.onHand - c.qty;
        return after <= s.reorderLevel ? [{ id: c.key, name: c.name, after, reorderLevel: s.reorderLevel }] : [];
      }),
    [cart, stockById],
  );

  const totalQty = cart.reduce((s, c) => s + c.qty, 0);
  const engineerName = engineers.find((e) => e.id === engineerId)?.name;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    // Field problems are attached to their control and focused; only the cart-wide one stays in the
    // notice. All three used to land in that notice, which sits at the BOTTOM of a scrolling modal
    // body — pressing Send with an empty reason looked like nothing happened until you scrolled.
    // Collected together rather than returned one at a time so a form with two gaps shows both.
    const fieldErrors: { engineerId?: string; reason?: string } = {};
    if (!engineerId) fieldErrors.engineerId = "Pick the engineer receiving the stock.";
    if (!reason.trim()) fieldErrors.reason = "A reason is required.";
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      focusFirstInvalid();
      return;
    }
    setErrors({});
    if (cart.length === 0) {
      setMsg({ type: "error", text: "Add at least one item." });
      noticeRef.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setMsg(null);
    try {
      const req = await vanStockSvc.createVanStockWalkIn({
        engineerId,
        warehouseId: warehouse.id, // the tab's warehouse — a walk-in is issued HERE by definition
        reason: reason.trim(),
        priority,
        // BOTH ids are carried — the server reads whichever the line's `source` names. Dropping
        // rentalItemId here is what would make a hired line arrive as an unresolvable rental.
        lines: cart.map((c) => ({ source: c.source, irmItemId: c.irmItemId ?? undefined, rentalItemId: c.rentalItemId ?? undefined, itemName: c.name, qty: c.qty })),
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
            <FormSection title="Add items" description="Company stock and hired kit this warehouse can hand over right now — anything with nothing free here is left out.">
              <VanStockItemSearch excludeIds={excludeIds} onAddItem={addItem} warehouseId={warehouse.id} placeholder="Search this warehouse's stock…" />
            </FormSection>

            <FormSection title={`Selected items${cart.length ? ` (${cart.length})` : ""}`} description="Set the quantity for each item — capped at what's on the shelf here.">
              <VanStockCartTable cart={cart} onQty={setQty} onRemove={remove} shelfByItem={shelfByItem} shelfLabel="In stock" />
              {reorderWarnings.length > 0 && (
                <div className="mt-3 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  Heads up — issuing this leaves stock at or below the reorder level:
                  <ul className="mt-1 list-disc pl-4 font-medium">
                    {reorderWarnings.map((w) => (
                      <li key={w.id}>{w.name}: {w.after} left (reorder at {w.reorderLevel})</li>
                    ))}
                  </ul>
                </div>
              )}
            </FormSection>

            <FormSection title="Who & why" description="The engineer receives this stock onto their van the moment it's scanned out.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Engineer <RequiredMark /></label>
                  <Select
                    ariaLabel="Engineer"
                    value={engineerId}
                    // Clears the moment they pick — a red ring on a field they've just answered
                    // reads as "still wrong".
                    onChange={(v) => { setEngineerId(v); if (errors.engineerId) setErrors((p) => ({ ...p, engineerId: undefined })); }}
                    invalid={Boolean(errors.engineerId)}
                    options={[{ value: "", label: "Pick an engineer…" }, ...engineers.map((e) => ({ value: e.id, label: e.name }))]}
                  />
                  <FieldError message={errors.engineerId} />
                </div>
                <div>
                  <label className={labelCls}>Priority</label>
                  <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority(v as VanStockPriority)} options={VAN_STOCK_PRIORITY_OPTIONS} />
                </div>
              </div>
              <div className="mt-4">
                <label className={labelCls} htmlFor="walkin-reason">Reason <RequiredMark /></label>
                <input
                  id="walkin-reason"
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); if (errors.reason) setErrors((p) => ({ ...p, reason: undefined })); }}
                  maxLength={2000}
                  aria-required="true"
                  aria-invalid={Boolean(errors.reason)}
                  aria-describedby={errors.reason ? "walkin-reason-error" : undefined}
                  placeholder="e.g. Engineer collected consumables at the counter."
                  className={inputCls}
                />
                <FieldError id="walkin-reason-error" message={errors.reason} />
              </div>
              <div ref={noticeRef}>{msg && <div className="mt-4"><Notice msg={msg} /></div>}</div>
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
