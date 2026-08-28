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
import { RentalBadge, VAN_STOCK_PRIORITY_OPTIONS, VanStockCartTable, VanStockItemSearch, vanStockItemKey, type VanStockCartItem } from "@/components/dashboard/van-requests/vanRequestUi";
import { FieldError, FormPageHeader, FormSection, FormAsideCard, RequiredMark } from "@/components/ui/FormScaffold";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { hintCls, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { uploadDirectForUrl } from "@/lib/upload";
import { formatHireDate, splitItemKeys, toLinePayload } from "@/components/dashboard/van-requests/vanStockLine";

import { openLineAdvisory } from "./openLineAdvisory";

// Full-page composers for the engineer's NON-job field-stock flow, on the shared FormScaffold
// (sticky header + sectioned main column + sticky summary aside) so they read exactly like the
// transfer/user/role form pages.
//  - Restock: item cart → availability-aware "collect from" warehouse (per-warehouse in-stock
//    counts, per-line shelf counts — ADVISORY, never blocking) → priority/reason/attachments.
//  - Return: pick from own on-hand (qty capped) → warehouse → reason.

const LIST_URL = "/dashboard/engineer/van-stock";

// Non-blocking duplicate warning (spec §8): items already on one of the engineer's OPEN requests.
function useOpenLineMap(type: "restock" | "return"): Map<string, string> {
  const [map, setMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    vanStockSvc
      .myOpenLineItems(type)
      // Keyed the same way the cart is, so a duplicate HIRE is caught as well as a duplicate IRM item.
      .then((items) => setMap(new Map(items.map((i) => [vanStockItemKey(i), i.code]))))
      .catch(() => setMap(new Map()));
  }, [type]);
  return map;
}

// The advisories that annotate the selected-items table: compact, evenly spaced, and — because BOTH
// composers render one — defined once rather than as a className at a call site.
//
// That distinction is the whole reason this exists. The gap used to live inside DuplicateWarning as
// its own `mt-3`, and moving it out to the restock call site silently left the return composer's
// notice sitting flush against the table, since FormSection renders {children} with no spacing of its
// own. A shared wrapper makes the two pages incapable of drifting apart again.
//
// `empty:mt-0` because the stack is always mounted but usually renders nothing — without it every
// composer with no advisories carries 12px of dead space under its table.
function AdvisoryStack({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 space-y-2 empty:mt-0">{children}</div>;
}

function DuplicateWarning({ cart, openLines, kind }: { cart: VanStockCartItem[]; openLines: Map<string, string>; kind: "restock" | "return" }) {
  // `kind` because ONE component serves both composers, and that is precisely how the return screen
  // came to talk about a "request" you "send". The wording now follows the screen — see
  // openLineAdvisory, where it lives as a pure function so it can be tested without a DOM.
  const advisory = openLineAdvisory(
    cart.filter((c) => openLines.has(c.key)).map((c) => ({ name: c.name, code: openLines.get(c.key) })),
    kind,
  );
  if (!advisory) return null;
  // No margin of its own — AdvisoryStack owns the spacing for every composer that renders one.
  //
  // The clashing items and their references ride on `title` rather than a second visible line. The
  // banner is advisory and sits directly under the cart table that already NAMES every selected item,
  // so a printed list mostly repeats the rows above it — and it was that list, not the padding, that
  // made this notice tall: the sentence is fixed-length now, so the banner is one line whether one
  // item clashes or ten.
  return (
    <div title={advisory.title ?? advisory.detail}>
      <Notice
        size="sm"
        msg={{
          // "info", not "warn": a duplicate is a LEGITIMATE choice — the sentence itself ends "you can
          // still include it here" — so nothing here is wrong, degraded or costing anyone anything.
          // It was amber only because Notice had no tier below caution; it first stopped being red for
          // the same reason. Amber stays for the messages that have a problem behind them.
          type: "info",
          text: advisory.text,
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
  // Field-level error for the reason box. Separate from `msg`, which carries the CART-wide problems
  // (empty cart, over-cap, unplaced item) and server failures — those aren't about one control.
  const [reasonError, setReasonError] = React.useState<string | undefined>(undefined);
  const noticeRef = React.useRef<HTMLDivElement>(null);
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
  const excludeKeys = React.useMemo(() => new Set(cart.map((c) => c.key)), [cart]);

  // Refresh per-warehouse availability whenever the cart's ITEM SET changes (not on qty edits).
  // Empty cart resolves to [] inside the service, so state updates only happen in callbacks.
  //
  // The two id lists stay separate all the way to the query string: they address different catalogues,
  // and one merged list keyed on a bare id could not tell a tester from a cable.
  const cartKey = React.useMemo(() => cart.map((c) => c.key).sort().join(","), [cart]);
  React.useEffect(() => {
    let cancelled = false;
    const { irmItemIds, rentalItemIds } = splitItemKeys(cartKey ? cartKey.split(",") : []);
    vanStockSvc
      .getVanStockAvailability(irmItemIds, rentalItemIds)
      .then((rows) => { if (!cancelled) setAvailability(rows); })
      // "warn": the counts are advisory (see the header note), so losing them degrades the form
      // rather than breaking it — the request still sends.
      .catch(() => { if (!cancelled) { setAvailability([]); setMsg({ type: "warn", text: "Couldn't load stock levels — warehouse counts may be unavailable. You can still send the request." }); } });
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
          // Two pools, read from the list that matches this line's catalogue. Hired kit has no stock
          // balance at all — its figure is free-on-hire at that depot — so reading `items` for a
          // rental line would silently report zero and hide every depot that actually holds it.
          const free =
            c.source === "rental"
              ? w.rentalItems.find((i) => i.rentalItemId === c.rentalItemId)?.quantityOnHand ?? 0
              : w.items.find((i) => i.irmItemId === c.irmItemId)?.quantityOnHand ?? 0;
          const name = w.warehouseCode ? `${w.warehouseName} (${w.warehouseCode})` : w.warehouseName;
          return { value: w.warehouseId, label: `${name} — ${free} free`, free };
        })
        .filter((o) => o.free > 0)
        .sort((a, b) => b.free - a.free || a.label.localeCompare(b.label));
      map.set(c.key, opts);
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
      const opts = warehouseOptionsByItem.get(c.key) ?? [];
      const picked = lineWarehouses[c.key];
      const valid = picked && opts.some((o) => o.value === picked);
      const chosen = valid ? picked : opts[0]?.value;
      if (chosen) out[c.key] = chosen;
    }
    return out;
  }, [cart, warehouseOptionsByItem, lineWarehouses]);

  // How many separate places this request sends the engineer to. Shown while it can still be changed.
  const stops = React.useMemo(
    () => new Set(Object.values(effectiveWarehouses)).size,
    [effectiveWarehouses],
  );
  const unplaced = cart.filter((c) => !effectiveWarehouses[c.key]);
  const totalQty = cart.reduce((s, c) => s + c.qty, 0);

  // Free stock at the warehouse THIS line is collected from — the cap the qty box is judged against.
  // Sourced per line now, not from one request-level warehouse.
  const shelfByItem = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cart) {
      const whId = effectiveWarehouses[c.key];
      if (!whId) continue;
      const w = availability.find((a) => a.warehouseId === whId);
      const free =
        c.source === "rental"
          ? w?.rentalItems.find((i) => i.rentalItemId === c.rentalItemId)?.quantityOnHand
          : w?.items.find((i) => i.irmItemId === c.irmItemId)?.quantityOnHand;
      if (typeof free === "number") m.set(c.key, free);
    }
    return m;
  }, [availability, cart, effectiveWarehouses]);

  // Cap each line's qty at what is FREE at the warehouse that line collects from — the same rule the
  // job kit list applies to its own warehouse column. VanStockCartTable already clamps typing to
  // maxQty, so the number simply cannot be typed past the shelf.
  const cappedCart = React.useMemo(
    () => cart.map((c) => {
      const free = shelfByItem.get(c.key);
      return typeof free === "number" ? { ...c, maxQty: free } : c;
    }),
    [cart, shelfByItem],
  );
  // Switching a line to a warehouse with less stock leaves an already-typed qty above the new cap
  // (clamping it silently would rewrite a number the engineer chose), so it's caught here instead.
  const overCap = cart.find((c) => {
    const free = shelfByItem.get(c.key);
    return typeof free === "number" && c.qty > free;
  });


  const addItem = (it: VanStockItemOption) =>
    setCart((c) => {
      const key = vanStockItemKey(it);
      if (c.some((x) => x.key === key)) return c;
      // The item's own source travels with the row from here all the way to the payload, so what the
      // engineer picked and what the server stores are the same value — never re-derived from a
      // nullable id further down.
      return [...c, { key, source: it.source, irmItemId: it.irmItemId, rentalItemId: it.rentalItemId, name: it.name, code: it.code, qty: 1 }];
    });
  const setQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, qty } : x)));
  const remove = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  const onFile = async (file: File) => {
    // `accept="image/*"` is a hint the file dialog lets the user override, and a file the browser
    // cannot type at all reads back as `application/octet-stream` — which the server now refuses. Check
    // it here so the answer arrives before the upload rather than after it, the same gate
    // TransferComposer already applies to its own picker.
    if (!file.type.startsWith("image/")) {
      setMsg({ type: "error", text: "Attach an image — PNG, JPG, GIF or WEBP." });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    setMsg(null);
    try {
      const url = await uploadDirectForUrl({ purpose: "vsr_attachment", file });
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
    if (cart.length === 0) { setMsg({ type: "error", text: "Add at least one item." }); noticeRef.current?.scrollIntoView({ block: "nearest" }); return; }
    if (overCap) {
      const free = shelfByItem.get(overCap.key) ?? 0;
      setMsg({ type: "error", text: `Only ${free} of "${overCap.name}" are free at the warehouse you picked — lower the quantity or collect it from somewhere else.` });
      return;
    }
    if (unplaced.length > 0) {
      // Only reachable when an item is available NOWHERE (auto-select fills every other case).
      const u = unplaced[0]!;
      setMsg({
        type: "error",
        text: u.source === "rental"
          ? `No warehouse has "${u.name}" free on hire — remove it or ask the office to arrange a hire.`
          : `No warehouse has "${u.name}" in stock — remove it or ask the office to order it.`,
      });
      return;
    }
    if (!reason.trim()) { setReasonError("Tell the warehouse why you need this."); focusFirstInvalid(); return; }
    setReasonError(undefined);
    setSubmitting(true);
    setMsg(null);
    try {
      const lines: VanStockLinePayload[] = cart.map((c) => toLinePayload(c, effectiveWarehouses[c.key]!));
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
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
                const opts = warehouseOptionsByItem.get(c.key) ?? [];
                if (opts.length === 0) {
                  return <span className="text-[11px] font-semibold text-[var(--neg)]">No warehouse has this in stock</span>;
                }
                return (
                  <Select
                    ariaLabel={`Collect ${c.name} from`}
                    value={effectiveWarehouses[c.key] ?? ""}
                    onChange={(v) => setLineWarehouses((prev) => ({ ...prev, [c.key]: v }))}
                    options={opts.map(({ value, label }) => ({ value, label }))}
                  />
                );
              }}
            />
            <AdvisoryStack>
              <DuplicateWarning cart={cart} openLines={openLines} kind="restock" />
              {stops > 1 && (
                // The engineer is the one who drives, so the cost of their own split is stated while
                // they can still change it — this used to be a reviewer's decision they learned
                // about only after approval.
                <Notice
                  size="sm"
                  msg={{
                    // "info": this is a FACT ABOUT THE PLAN the engineer just built, not a fault in it.
                    // Two warehouses is a valid request — sometimes the only possible one — and the
                    // line offers a change rather than demanding one ("if one has everything").
                    type: "info",
                    text: `Collects from ${stops} warehouses — ${stops} stops. Move a line if one has everything.`,
                  }}
                />
              )}
            </AdvisoryStack>
          </FormSection>

          {/* Priority sits WITH Reason and Attachments rather than in a card of its own: alone it was
              a full-width section wrapping one half-width Select, so most of the card was empty. The
              Return composer below already groups its request-shaping Select ("Return to warehouse")
              into Details the same way, and the file header describes this flow as one group —
              "priority/reason/attachments". */}
          <FormSection title="Details" description="How soon you need this, and why.">
            <div className="space-y-4">
              <div className="sm:max-w-xs">
                <label className={labelCls}>Priority</label>
                <Select ariaLabel="Priority" value={priority} onChange={(v) => setPriority((v || "normal") as VanStockPriority)} options={VAN_STOCK_PRIORITY_OPTIONS} />
              </div>
              <div>
                <label className={labelCls} htmlFor="restock-reason">Reason <RequiredMark /></label>
                <textarea
                  id="restock-reason"
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(undefined); }}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. Van consumables low — cable ties nearly out; crimping tool damaged."
                  className={`${inputCls} resize-none`}
                  aria-required
                  aria-invalid={Boolean(reasonError)}
                  aria-describedby={reasonError ? "restock-reason-error" : undefined}
                />
                <FieldError id="restock-reason-error" message={reasonError} />
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
              <div ref={noticeRef}><Notice msg={msg} /></div>
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
  // Field-level error for the reason box. Separate from `msg`, which carries the CART-wide problems
  // (empty cart, over-cap, unplaced item) and server failures — those aren't about one control.
  const [reasonError, setReasonError] = React.useState<string | undefined>(undefined);
  const noticeRef = React.useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [holdingsError, setHoldingsError] = React.useState(false); // fetch failed — distinct from "nothing to return"
  const [msg, setMsg] = React.useState<Msg>(null);

  const openLines = useOpenLineMap("return");

  React.useEffect(() => {
    vanStockSvc.myHoldings().then((h) => { setHoldings(h); setHoldingsError(false); }).catch(() => { setHoldings([]); setHoldingsError(true); });
    vanStockSvc.listWarehousesLite().then(setWarehouses).catch(() => { setWarehouses([]); setMsg({ type: "error", text: "Couldn't load warehouses. Refresh and try again." }); });
  }, []);

  const inCart = React.useMemo(() => new Set(cart.map((c) => c.key)), [cart]);
  const totalQty = cart.reduce((s, c) => s + c.qty, 0);

  const add = (h: HoldingOption) =>
    setCart((c) => {
      const key = vanStockItemKey(h);
      if (c.some((x) => x.key === key)) return c;
      // The hire deadline travels onto the cart row so the return list keeps showing WHY this one is
      // urgent — it is the only thing distinguishing a tester that must go back from a cable that need
      // not. Which hire each unit goes back on is the warehouse's scan to resolve, never the engineer's.
      return [...c, {
        key, source: h.source, irmItemId: h.irmItemId, rentalItemId: h.rentalItemId,
        name: h.name, code: h.code, qty: h.quantityOnHand, maxQty: h.quantityOnHand,
        hireEndDate: h.hireEndDate, overdue: h.overdue,
      }];
    });
  const setQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, qty } : x)));
  const remove = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) { setMsg({ type: "error", text: "Pick at least one item to return." }); return; }
    if (!warehouseId) { setMsg({ type: "error", text: "Pick the warehouse you'll return the stock to." }); return; }
    if (!reason.trim()) { setReasonError("Say why you're returning this stock."); focusFirstInvalid(); return; }
    setReasonError(undefined);
    setSubmitting(true);
    setMsg(null);
    try {
      // No per-line warehouse on a return: one destination governs the whole request.
      const lines: VanStockLinePayload[] = cart.map((c) => toLinePayload(c));
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
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
                  const key = vanStockItemKey(h);
                  const added = inCart.has(key);
                  const isRental = h.source === "rental";
                  return (
                    <button key={key} type="button" disabled={added} onClick={() => add(h)} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${added ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-[var(--ink)]">{h.name}</span>
                          {isRental && <RentalBadge />}
                        </span>
                        {/* Free-to-return qty = van holding MINUS stock committed to active jobs (that
                            goes back via the job's Close & Reconcile, not here). Hired kit is subject to
                            the same rule — a hire out on a job goes back through that job's scan-in. */}
                        <span className="block truncate font-mono text-[11px] text-[var(--muted)]">
                          {h.code} · {h.quantityOnHand} free to return
                          {/* The order(s) these units sit on — reference only. The engineer never picks
                              a hire; the warehouse binds it when they scan the kit back in. */}
                          {isRental && h.poCodes.length > 0 && ` · ${h.poCodes.join(", ")}`}
                        </span>
                        {/* WHERE IT CAME FROM. A hire goes back to the depot it was collected from
                            — the rule the posting has always enforced — and until this line the
                            engineer only met it as a refusal after picking a warehouse below. The
                            name is the hire order's own warehouse, the same authoritative field
                            that guard reads; no id is exposed, because this is context for a person
                            choosing where to drive. Company stock has no such source, so IRM rows
                            carry none. Muted 11px, the register the code line above already uses,
                            so the item name stays the loudest thing in the row. */}
                        {isRental && h.depots.length > 0 && (
                          <span className="block truncate text-[11px] text-[var(--muted)]" title={h.depots.join(", ")}>
                            Collected from {h.depots.length === 1 ? h.depots[0] : h.depots.join(" · ")}
                          </span>
                        )}
                        {isRental && h.hireEndDate && (
                          <span className={`block truncate text-[11px] font-semibold ${h.overdue ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                            {h.overdue ? "Overdue — was due back " : "Due back "}
                            {formatHireDate(h.hireEndDate)}
                          </span>
                        )}
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
            <AdvisoryStack>
              <DuplicateWarning cart={cart} openLines={openLines} kind="return" />
            </AdvisoryStack>
          </FormSection>

          <FormSection title="Details" description="Where you'll return it, and why.">
            <div className="space-y-4">
              <div>
                <label className={labelCls} id="return-warehouse-label">Return to warehouse <RequiredMark /></label>
                <Select
                  ariaLabel="Return warehouse"
                  value={warehouseId}
                  onChange={setWarehouseId}
                  options={[{ value: "", label: "Pick a warehouse…" }, ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }))]}
                />
                {/* Shown ONLY when the cart actually holds hired kit. The label is already accurate —
                    this is where the stock is booked in — so the field is not renamed; what was
                    missing is that a hire is not free to go back anywhere, which the engineer
                    otherwise discovered as a refusal after filling the form in. States the existing
                    rule at the point of choosing, and names nothing the picker above does not
                    already show on each hired row. */}
                {cart.some((c) => c.source === "rental") && (
                  <p className={hintCls}>Hired kit goes back to the depot it was collected from — shown on each hired item above.</p>
                )}
              </div>
              <div>
                <label className={labelCls} htmlFor="return-reason">Reason <RequiredMark /></label>
                <textarea
                  id="return-reason"
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(undefined); }}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. Over-stocked after last month's jobs — returning the excess."
                  className={`${inputCls} resize-none`}
                  aria-required
                  aria-invalid={Boolean(reasonError)}
                  aria-describedby={reasonError ? "return-reason-error" : undefined}
                />
                <FieldError id="return-reason-error" message={reasonError} />
              </div>
              <div ref={noticeRef}><Notice msg={msg} /></div>
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
