"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, Upload, X } from "lucide-react";

import * as vanStockSvc from "@/services/vanStockRequest.service";
import type {
  HoldingOption,
  VanStockItemOption,
  VanStockLinePayload,
  VanStockPriority,
  WarehouseAvailability,
} from "@/services/vanStockRequest.service";
import { useDashboard } from "@/hooks/useDashboard";
import { readFileAsDataUrl } from "@/lib/image";
import { VanStockCartTable, VanStockItemSearch, type VanStockCartItem } from "@/components/dashboard/van-requests/vanRequestUi";
import { FormPageHeader, FormSection, FormAsideCard, RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

// Full-page composers for the engineer's NON-job field-stock flow, on the shared FormScaffold
// (sticky header + sectioned main column + sticky summary aside) so they read exactly like the
// transfer/user/role form pages.
//  - Restock: item cart → availability-aware "collect from" warehouse (per-warehouse in-stock
//    counts, per-line shelf counts — ADVISORY, never blocking) → priority/reason/attachments.
//  - Return: pick from own on-hand (qty capped) → warehouse → reason.

const LIST_URL = "/dashboard/engineer/van-stock";

const PRIORITY_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

// Non-blocking duplicate warning (spec §8): items already on one of the engineer's OPEN requests.
function useOpenLineMap(type: "restock" | "return"): Map<string, string> {
  const [map, setMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    vanStockSvc
      .myOpenLineItems(type)
      .then((items) => setMap(new Map(items.map((i) => [i.irmItemId, i.code]))))
      .catch(() => setMap(new Map()));
  }, [type]);
  return map;
}

function DuplicateWarning({ cart, openLines }: { cart: VanStockCartItem[]; openLines: Map<string, string> }) {
  const dups = cart.filter((c) => openLines.has(c.irmItemId));
  if (dups.length === 0) return null;
  return (
    <div className="mt-3">
      <Notice
        msg={{
          type: "error",
          text: `Heads up — you already have an open request for: ${dups.map((d) => `${d.name} (${openLines.get(d.irmItemId)})`).join(", ")}. You can still send this one.`,
        }}
      />
    </div>
  );
}

// ── Restock composer page ────────────────────────────────────────────────────────────────────────

export function RestockComposerPage() {
  const router = useRouter();
  const { pushToast } = useDashboard();
  const [cart, setCart] = React.useState<VanStockCartItem[]>([]);
  const [reason, setReason] = React.useState("");
  const [priority, setPriority] = React.useState<VanStockPriority>("normal");
  // irmItemId → the warehouse this line is collected from. Replaces the single request-level
  // "collect from": the engineer picks per item, seeing that warehouse's free stock.
  const [lineWarehouses, setLineWarehouses] = React.useState<Record<string, string>>({});
  const [attachments, setAttachments] = React.useState<string[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [availability, setAvailability] = React.useState<WarehouseAvailability[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const openLines = useOpenLineMap("restock");
  const excludeKeys = React.useMemo(() => new Set(cart.map((c) => c.irmItemId)), [cart]);

  // Refresh per-warehouse availability whenever the cart's ITEM SET changes (not on qty edits).
  // Empty cart resolves to [] inside the service, so state updates only happen in callbacks.
  const cartKey = React.useMemo(() => cart.map((c) => c.irmItemId).sort().join(","), [cart]);
  React.useEffect(() => {
    let cancelled = false;
    vanStockSvc
      .getVanStockAvailability(cartKey ? cartKey.split(",") : [])
      .then((rows) => { if (!cancelled) setAvailability(rows); })
      .catch(() => { if (!cancelled) { setAvailability([]); setMsg({ type: "error", text: "Couldn't load stock levels — warehouse counts may be unavailable. You can still send the request." }); } });
    return () => { cancelled = true; };
  }, [cartKey]);

  // Per ITEM: the warehouses that actually hold it, most stock first, each labelled with its free
  // count — the engineer's whole basis for choosing. Warehouses with none of that item are left OUT
  // rather than disabled: unlike the old single picker (where a zero-coverage warehouse was still a
  // legitimate-looking choice for the OTHER items), here the row is about this one item, so a
  // warehouse with none of it is simply not an answer.
  const warehouseOptionsByItem = React.useMemo(() => {
    const map = new Map<string, { value: string; label: string; free: number }[]>();
    for (const c of cart) {
      const opts = availability
        .map((w) => {
          const free = w.items.find((i) => i.irmItemId === c.irmItemId)?.quantityOnHand ?? 0;
          const name = w.warehouseCode ? `${w.warehouseName} (${w.warehouseCode})` : w.warehouseName;
          return { value: w.warehouseId, label: `${name} — ${free} free`, free };
        })
        .filter((o) => o.free > 0)
        .sort((a, b) => b.free - a.free || a.label.localeCompare(b.label));
      map.set(c.irmItemId, opts);
    }
    return map;
  }, [availability, cart]);

  // What each line ACTUALLY collects from: the engineer's explicit pick when they made one and it is
  // still stocked there, otherwise the warehouse holding the most of that item. Derived during render
  // rather than written back by an effect — an effect would set state on every availability refresh
  // (cascading renders, and the React Compiler lint rejects it), and it keeps `lineWarehouses` meaning
  // exactly one thing: what the ENGINEER chose. A pick that stops being valid (stock ran out there
  // between refreshes) silently falls back instead of leaving the line pointing at an empty shelf.
  const effectiveWarehouses = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of cart) {
      const opts = warehouseOptionsByItem.get(c.irmItemId) ?? [];
      const picked = lineWarehouses[c.irmItemId];
      const valid = picked && opts.some((o) => o.value === picked);
      const chosen = valid ? picked : opts[0]?.value;
      if (chosen) out[c.irmItemId] = chosen;
    }
    return out;
  }, [cart, warehouseOptionsByItem, lineWarehouses]);

  // How many separate places this request sends the engineer to. Shown while it can still be changed.
  const stops = React.useMemo(
    () => new Set(Object.values(effectiveWarehouses)).size,
    [effectiveWarehouses],
  );
  const unplaced = cart.filter((c) => !effectiveWarehouses[c.irmItemId]);
  const totalQty = cart.reduce((s, c) => s + c.qty, 0);

  // Free stock at the warehouse THIS line is collected from — the cap the qty box is judged against.
  // Sourced per line now, not from one request-level warehouse.
  const shelfByItem = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cart) {
      const whId = effectiveWarehouses[c.irmItemId];
      if (!whId) continue;
      const w = availability.find((a) => a.warehouseId === whId);
      const free = w?.items.find((i) => i.irmItemId === c.irmItemId)?.quantityOnHand;
      if (typeof free === "number") m.set(c.irmItemId, free);
    }
    return m;
  }, [availability, cart, effectiveWarehouses]);

  // Cap each line's qty at what is FREE at the warehouse that line collects from — the same rule the
  // job kit list applies to its own warehouse column. VanStockCartTable already clamps typing to
  // maxQty, so the number simply cannot be typed past the shelf.
  const cappedCart = React.useMemo(
    () => cart.map((c) => {
      const free = shelfByItem.get(c.irmItemId);
      return typeof free === "number" ? { ...c, maxQty: free } : c;
    }),
    [cart, shelfByItem],
  );
  // Switching a line to a warehouse with less stock leaves an already-typed qty above the new cap
  // (clamping it silently would rewrite a number the engineer chose), so it's caught here instead.
  const overCap = cart.find((c) => {
    const free = shelfByItem.get(c.irmItemId);
    return typeof free === "number" && c.qty > free;
  });


  const addItem = (it: VanStockItemOption) =>
    setCart((c) => (c.some((x) => x.irmItemId === it.irmItemId) ? c : [...c, { irmItemId: it.irmItemId, name: it.name, code: it.code, qty: 1 }]));
  const setQty = (id: string, qty: number) => setCart((c) => c.map((x) => (x.irmItemId === id ? { ...x, qty } : x)));
  const remove = (id: string) => setCart((c) => c.filter((x) => x.irmItemId !== id));

  const onFile = async (file: File) => {
    setUploading(true);
    setMsg(null);
    try {
      const dataUri = await readFileAsDataUrl(file);
      const url = await vanStockSvc.uploadVanStockAttachment(dataUri);
      setAttachments((a) => [...a, url]);
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not upload the attachment." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) { setMsg({ type: "error", text: "Add at least one item." }); return; }
    if (overCap) {
      const free = shelfByItem.get(overCap.irmItemId) ?? 0;
      setMsg({ type: "error", text: `Only ${free} of "${overCap.name}" are free at the warehouse you picked — lower the quantity or collect it from somewhere else.` });
      return;
    }
    if (unplaced.length > 0) {
      // Only reachable when an item is stocked NOWHERE (auto-select fills every other case).
      setMsg({ type: "error", text: `No warehouse has "${unplaced[0]!.name}" in stock — remove it or ask the office to order it.` });
      return;
    }
    if (!reason.trim()) { setMsg({ type: "error", text: "Tell the warehouse why you need this." }); return; }
    setSubmitting(true);
    setMsg(null);
    try {
      const lines: VanStockLinePayload[] = cart.map((c) => ({
        irmItemId: c.irmItemId,
        itemName: c.name,
        qty: c.qty,
        warehouseId: effectiveWarehouses[c.irmItemId]!,
      }));
      await vanStockSvc.createVanStockRequest({
        type: "restock",
        reason: reason.trim(),
        priority,
        // No request-level warehouse: the collection point is derived server-side from the lines.
        attachments: attachments.length ? attachments : undefined,
        lines,
      });
      pushToast("Restock request sent to the warehouse.", "success");
      router.push(LIST_URL);
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not send the request." });
      setSubmitting(false);
    }
  };

  const submitBtn = (
    <button type="submit" form="field-stock-restock" disabled={submitting} className={primaryBtn}>
      {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      Send request
    </button>
  );

  return (
    <form id="field-stock-restock" onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title="Request field stock"
        subtitle="The warehouse reviews, confirms the fulfilment warehouse and scans it out to you."
        onBack={() => router.push(LIST_URL)}
        actions={submitBtn}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Add items" description="Search the catalogue for the stock you need.">
            <VanStockItemSearch excludeIds={excludeKeys} onAddItem={addItem} placeholder="Search the item you need…" />
          </FormSection>

          <FormSection title={`Selected items${cart.length ? ` (${cart.length})` : ""}`} description="Set the quantity, and where you'll collect each item from.">
            <VanStockCartTable
              cart={cappedCart}
              onQty={setQty}
              onRemove={remove}
              shelfByItem={shelfByItem}
              shelfLabel="Free there"
              warehouseCell={(c) => {
                const opts = warehouseOptionsByItem.get(c.irmItemId) ?? [];
                if (opts.length === 0) {
                  return <span className="text-[11px] font-semibold text-[var(--neg)]">No warehouse has this in stock</span>;
                }
                return (
                  <Select
                    ariaLabel={`Collect ${c.name} from`}
                    value={effectiveWarehouses[c.irmItemId] ?? ""}
                    onChange={(v) => setLineWarehouses((prev) => ({ ...prev, [c.irmItemId]: v }))}
                    options={opts.map(({ value, label }) => ({ value, label }))}
                  />
                );
              }}
            />
            <DuplicateWarning cart={cart} openLines={openLines} />
            {stops > 1 && (
              // The engineer is the one who drives, so the cost of their own split is stated while
              // they can still change it — this used to be a reviewer's decision they learned about
              // only after approval.
              <p className="mt-2 text-[11px] font-semibold text-amber-600">
                This request collects from {stops} warehouses — you&apos;ll need {stops} stops. Move a line to a shared
                warehouse if one has everything.
              </p>
            )}
          </FormSection>

          <FormSection title="Priority" description="How soon you need this.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Priority</label>
                <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority((v || "normal") as VanStockPriority)} options={PRIORITY_OPTIONS} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Details" description="Tell the warehouse why you need this stock.">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Reason <RequiredMark /></label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. Van consumables low — cable ties nearly out; crimping tool damaged."
                  className={`${inputCls} resize-none`}
                  aria-required
                />
              </div>
              <div>
                <label className={labelCls}>Attachments (optional)</label>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((url, i) => (
                    <div key={url} className="relative h-16 w-16 overflow-hidden rounded-lg border border-[var(--border)]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`Attachment ${i + 1}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((u) => u !== url))}
                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading || attachments.length >= 10}
                    className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin text-[var(--faint)]" /> : <Upload className="h-4 w-4 text-[var(--faint)]" />}
                  </button>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
                />
              </div>
              <Notice msg={msg} />
            </div>
          </FormSection>
        </div>

        {/* Summary aside */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-24">
            <FormAsideCard title="Summary">
              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Collection stops</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{stops || "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Items</dt>
                  <dd className="font-semibold text-[var(--ink)]">{cart.length}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Total quantity</dt>
                  <dd className="font-semibold text-[var(--ink)]">{totalQty}</dd>
                </div>

                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Priority</dt>
                  <dd className="font-semibold capitalize text-[var(--ink)]">{priority}</dd>
                </div>
              </dl>
              <div className="mt-4">{submitBtn}</div>
            </FormAsideCard>
          </div>
        </div>
      </div>
    </form>
  );
}

// ── Return composer page ─────────────────────────────────────────────────────────────────────────

export function ReturnComposerPage() {
  const router = useRouter();
  const { pushToast } = useDashboard();
  const [holdings, setHoldings] = React.useState<HoldingOption[] | null>(null);
  const [cart, setCart] = React.useState<VanStockCartItem[]>([]);
  const [warehouseId, setWarehouseId] = React.useState("");
  const [warehouses, setWarehouses] = React.useState<Array<{ id: string; name: string; code: string | null }>>([]);
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [holdingsError, setHoldingsError] = React.useState(false); // fetch failed — distinct from "nothing to return"
  const [msg, setMsg] = React.useState<Msg>(null);

  const openLines = useOpenLineMap("return");

  React.useEffect(() => {
    vanStockSvc.myHoldings().then((h) => { setHoldings(h); setHoldingsError(false); }).catch(() => { setHoldings([]); setHoldingsError(true); });
    vanStockSvc.listWarehousesLite().then(setWarehouses).catch(() => { setWarehouses([]); setMsg({ type: "error", text: "Couldn't load warehouses. Refresh and try again." }); });
  }, []);

  const inCart = React.useMemo(() => new Set(cart.map((c) => c.irmItemId)), [cart]);
  const totalQty = cart.reduce((s, c) => s + c.qty, 0);

  const add = (h: HoldingOption) =>
    setCart((c) => (c.some((x) => x.irmItemId === h.irmItemId) ? c : [...c, { irmItemId: h.irmItemId, name: h.name, code: h.code, qty: h.quantityOnHand, maxQty: h.quantityOnHand }]));
  const setQty = (id: string, qty: number) => setCart((c) => c.map((x) => (x.irmItemId === id ? { ...x, qty } : x)));
  const remove = (id: string) => setCart((c) => c.filter((x) => x.irmItemId !== id));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) { setMsg({ type: "error", text: "Pick at least one item to return." }); return; }
    if (!warehouseId) { setMsg({ type: "error", text: "Pick the warehouse you'll return the stock to." }); return; }
    if (!reason.trim()) { setMsg({ type: "error", text: "Say why you're returning this stock." }); return; }
    setSubmitting(true);
    setMsg(null);
    try {
      const lines: VanStockLinePayload[] = cart.map((c) => ({ irmItemId: c.irmItemId, itemName: c.name, qty: c.qty }));
      await vanStockSvc.createVanStockRequest({ type: "return", reason: reason.trim(), warehouseId, lines });
      pushToast("Return raised — drive in and the warehouse will scan it in.", "success");
      router.push(LIST_URL);
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not raise the return." });
      setSubmitting(false);
    }
  };

  const submitBtn = (
    <button type="submit" form="field-stock-return" disabled={submitting} className={primaryBtn}>
      {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      Raise return
    </button>
  );

  return (
    <form id="field-stock-return" onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title="Return field stock"
        subtitle="No approval needed — the warehouse scans it in when you arrive."
        onBack={() => router.push(LIST_URL)}
        actions={submitBtn}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Pick from your stock" description="Only your free field stock — anything issued for a job goes back when you complete that job, not here.">
            {holdings === null ? (
              <div className="space-y-1.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-4 w-4 rounded-full" />
                  </div>
                ))}
              </div>
            ) : holdingsError ? (
              <p className="text-xs font-semibold text-[var(--neg)]">Couldn&apos;t load your on-hand stock. Refresh and try again.</p>
            ) : holdings.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">You&apos;re not holding any returnable stock right now.</p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-auto">
                {holdings.map((h) => {
                  const added = inCart.has(h.irmItemId);
                  return (
                    <button key={h.irmItemId} type="button" disabled={added} onClick={() => add(h)} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${added ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[var(--ink)]">{h.name}</span>
                        {/* Free-to-return qty = van holding MINUS stock committed to active jobs (that
                            goes back via the job's Close & Reconcile, not here). */}
                        <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{h.code} · {h.quantityOnHand} free to return</span>
                      </span>
                      {added ? <Check className="h-4 w-4 shrink-0 text-[var(--pos)]" /> : <Plus className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </FormSection>

          <FormSection title={`Selected items${cart.length ? ` (${cart.length})` : ""}`} description="Set the quantity you're bringing back.">
            <VanStockCartTable cart={cart} onQty={setQty} onRemove={remove} />
            <DuplicateWarning cart={cart} openLines={openLines} />
          </FormSection>

          <FormSection title="Details" description="Where you'll return it, and why.">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Return to warehouse <RequiredMark /></label>
                <Select
                  ariaLabel="Return warehouse"
                  value={warehouseId}
                  onChange={setWarehouseId}
                  options={[{ value: "", label: "Pick a warehouse…" }, ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }))]}
                />
              </div>
              <div>
                <label className={labelCls}>Reason <RequiredMark /></label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. Over-stocked after last month's jobs — returning the excess."
                  className={`${inputCls} resize-none`}
                  aria-required
                />
              </div>
              <Notice msg={msg} />
            </div>
          </FormSection>
        </div>

        {/* Summary aside */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-24">
            <FormAsideCard title="Summary">
              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Return to</dt>
                  <dd className="text-right font-semibold text-[var(--ink)]">{warehouses.find((w) => w.id === warehouseId)?.name ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Items</dt>
                  <dd className="font-semibold text-[var(--ink)]">{cart.length}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Total quantity</dt>
                  <dd className="font-semibold text-[var(--ink)]">{totalQty}</dd>
                </div>
              </dl>
              <div className="mt-4">{submitBtn}</div>
            </FormAsideCard>
          </div>
        </div>
      </div>
    </form>
  );
}
