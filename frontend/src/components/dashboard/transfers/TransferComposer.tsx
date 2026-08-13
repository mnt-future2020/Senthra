"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Check, Loader2, Plus, Search, Trash2, Upload, X } from "lucide-react";

import * as transferSvc from "@/services/engineerTransfer.service";
import * as stockSvc from "@/services/stockPosition.service";
import { useDashboard } from "@/hooks/useDashboard";
import { FormPageHeader, FormSection, FormAsideCard, RequiredMark } from "@/components/ui/FormScaffold";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { EngineerHoldingOption, TransferOwnership } from "@/services/engineerTransfer.service";
import type { EngineerOverviewRow } from "@/services/stockPosition.service";
import type { Msg } from "@/components/ui/types";
import { uploadDirectForUrl } from "@/lib/upload";

// A single picked item in the transfer cart. Every line in one transfer shares ONE source engineer
// (`fromEngineerId`) and goes to ONE recipient — the backend `EngineerStockTransfer` has a single
// from/to with N item lines, so the cart is "many items, one route".
export interface CartLine {
  ownership: TransferOwnership;
  irmItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
  sku: string | null;
  uom: string | null;
  available: number;
  quantity: number;
  fromEngineerId: string;
  fromEngineerName: string;
}

function lineKey(l: { ownership: string; irmItemId?: string | null; customerStockEntryId?: string | null }): string {
  return `${l.ownership}:${l.irmItemId ?? l.customerStockEntryId ?? ""}`;
}

// ── Admin item picker — adds from what the chosen source engineer actually holds ───────────────

function AdminItemPicker({
  holdings,
  loading,
  addedKeys,
  disabled,
  onAdd,
}: {
  holdings: EngineerHoldingOption[] | null;
  loading: boolean;
  addedKeys: Set<string>;
  disabled: boolean;
  onAdd: (h: EngineerHoldingOption) => void;
}) {
  if (disabled) return <p className="text-xs text-[var(--muted)]">Select a source engineer first.</p>;
  if (loading) return <p className="text-xs text-[var(--muted)]">Loading holdings…</p>;
  if (holdings && holdings.length === 0) {
    return <p className="text-xs font-semibold text-[var(--neg)]">This engineer holds no transferable stock.</p>;
  }
  return (
    <div className="max-h-72 space-y-1.5 overflow-auto">
      {(holdings ?? []).map((h, i) => {
        const added = addedKeys.has(lineKey(h));
        return (
          <button
            key={`${lineKey(h)}-${i}`}
            type="button"
            disabled={added}
            onClick={() => onAdd(h)}
            className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${
              added
                ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60"
                : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"
            }`}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-[var(--ink)]">{h.itemName}</span>
              {h.code && (
                <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{h.code}</span>
              )}
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {h.ownership === "company" ? "IRM" : `Customer${h.customerName ? ` · ${h.customerName}` : ""}`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-[var(--muted)]">{h.available} avail.</span>
              {added ? (
                <Check className="h-4 w-4 text-[var(--pos)]" />
              ) : (
                <Plus className="h-4 w-4 text-[var(--accent)]" />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Engineer item picker — one search over what OTHER engineers hold; one source per request ───

interface UnifiedCandidate {
  key: string;
  ownership: TransferOwnership;
  irmItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  tag: string;
  engineerId: string;
  engineerName: string;
  available: number;
}

function EngineerItemPicker({
  lockedFrom,
  lockedFromName,
  addedKeys,
  onAdd,
}: {
  lockedFrom: string | null;
  lockedFromName: string | null;
  addedKeys: Set<string>;
  onAdd: (line: CartLine) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [results, setResults] = React.useState<UnifiedCandidate[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request token: each dispatched search bumps it, and a resolved batch only commits its
  // results if it is still the latest. The 300ms debounce collapses fast keystrokes but does NOT
  // serialise in-flight requests, so without this a slow earlier request could land after a newer one
  // and clobber the results with stale candidates.
  const reqId = React.useRef(0);

  // Search company (IRM) + customer stock held by OTHER engineers in parallel, then merge. Engineers
  // can't browse the catalogue, so discovery is "what does someone actually hold that I can ask for".
  //
  // We use allSettled (not a blanket `.catch(() => [])`) so a FAILED request surfaces as a distinct
  // "search failed" state instead of silently masquerading as "no engineer holds a matching item" —
  // an empty result and a network/server error are very different things to show the user.
  const runSearch = (v: string) => {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    // Bump the token so any in-flight request is invalidated (also covers the cleared-input case).
    reqId.current++;
    if (!q) { setResults([]); setTouched(false); setFailed(false); return; }
    timer.current = setTimeout(async () => {
      const myId = ++reqId.current;
      setLoading(true);
      setTouched(true);
      setFailed(false);
      try {
        // Send the TRIMMED term so a leading/trailing space never reaches the backend regex.
        const [companyRes, customerRes] = await Promise.allSettled([
          transferSvc.searchCompanyCandidates(q),
          transferSvc.searchCustomerCandidates(q),
        ]);
        if (myId !== reqId.current) return; // a newer search superseded this one — discard.
        if (companyRes.status === "rejected") console.error("Company candidate search failed:", companyRes.reason);
        if (customerRes.status === "rejected") console.error("Customer candidate search failed:", customerRes.reason);
        // Both legs down → the search itself failed; surface it rather than show a misleading empty.
        if (companyRes.status === "rejected" && customerRes.status === "rejected") setFailed(true);
        const company = companyRes.status === "fulfilled" ? companyRes.value : [];
        const customer = customerRes.status === "fulfilled" ? customerRes.value : [];
        const merged: UnifiedCandidate[] = [
          ...company.map((c) => ({
            key: `company:${c.irmItemId}:${c.engineerId}`,
            ownership: "company" as TransferOwnership,
            irmItemId: c.irmItemId,
            itemName: c.itemName,
            code: c.code,
            sku: c.sku,
            uom: c.uom,
            tag: "IRM",
            engineerId: c.engineerId,
            engineerName: c.engineerName,
            available: c.available,
          })),
          ...customer.map((c) => ({
            key: `customer:${c.customerStockEntryId}:${c.engineerId}`,
            ownership: "customer" as TransferOwnership,
            customerStockEntryId: c.customerStockEntryId,
            itemName: c.itemName,
            code: c.code ?? c.barcode ?? c.sku,
            sku: c.sku,
            uom: c.uom,
            tag: c.customerName ? `Customer · ${c.customerName}` : "Customer",
            engineerId: c.engineerId,
            engineerName: c.engineerName,
            available: c.available,
          })),
        ];
        merged.sort((a, b) => a.itemName.localeCompare(b.itemName));
        setResults(merged);
      } catch (e) {
        if (myId !== reqId.current) return;
        console.error("Candidate search failed:", e);
        setResults([]);
        setFailed(true);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 300);
  };

  const add = (c: UnifiedCandidate) => {
    onAdd({
      ownership: c.ownership,
      irmItemId: c.irmItemId,
      customerStockEntryId: c.customerStockEntryId,
      itemName: c.itemName,
      sku: c.sku,
      uom: c.uom,
      available: c.available,
      quantity: 1,
      fromEngineerId: c.engineerId,
      fromEngineerName: c.engineerName,
    });
  };

  // One transfer = one source engineer. Once locked, only that engineer's stock can be added.
  const visible = lockedFrom ? results.filter((c) => c.engineerId === lockedFrom) : results;
  const cartKey = (c: UnifiedCandidate) => `${c.ownership}:${c.ownership === "company" ? c.irmItemId : c.customerStockEntryId}`;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input
          type="search"
          value={search}
          onChange={(e) => runSearch(e.target.value)}
          aria-label={lockedFrom ? `Search ${lockedFromName ?? "this engineer"}’s stock` : "Search items to request"}
          placeholder={lockedFrom ? `Search ${lockedFromName ?? "this engineer"}’s stock…` : "Search the item you need…"}
          className={`${inputCls} pl-9`}
        />
        {loading && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--faint)]" />}
      </div>

      {touched && !loading && failed && visible.length === 0 && (
        <p className="text-xs font-semibold text-[var(--neg)]">
          Couldn’t run the search just now. Check your connection and try again.
        </p>
      )}

      {touched && !loading && !failed && visible.length === 0 && (
        <p className="text-xs text-[var(--muted)]">
          {!lockedFrom
            ? "No engineer holds a matching item."
            : results.length > 0
              ? `${lockedFromName ?? "This engineer"} doesn’t hold a match, but another engineer does — use “Start over” to switch source.`
              : `${lockedFromName ?? "This engineer"} holds no matching stock. Use “Start over” to request from someone else.`}
        </p>
      )}

      {visible.length > 0 && (
        <div className="space-y-2">
          {visible.map((c) => {
            const added = addedKeys.has(cartKey(c));
            return (
              <button
                key={c.key}
                type="button"
                disabled={added}
                onClick={() => add(c)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                  added
                    ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60"
                    : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--ink)]">{c.itemName}</span>
                  {c.code && (
                    <span className="block truncate font-mono text-[11px] text-[var(--muted)]">{c.code}</span>
                  )}
                  <span className="text-[11px] text-[var(--faint)]">
                    <span className="font-bold uppercase tracking-wider">{c.tag}</span> · held by {c.engineerName}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-[var(--muted)]">{c.available} avail.</span>
                  {added ? <Check className="h-4 w-4 text-[var(--pos)]" /> : <Plus className="h-4 w-4 text-[var(--accent)]" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── The cart (selected items, editable quantities) ────────────────────────────────────────────

function CartTable({
  lines,
  onQty,
  onRemove,
}: {
  lines: CartLine[];
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center">
        <ArrowRightLeft className="mx-auto mb-2 h-6 w-6 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No items added yet</p>
        <p className="text-xs text-[var(--muted)]">Add one or more items above to build the transfer.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2 w-28">Quantity</th>
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const key = lineKey(l);
            return (
              <tr key={key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2.5">
                  <div className="font-semibold text-[var(--ink)]">{l.itemName}</div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    {l.ownership === "company" ? "IRM" : "Customer"} · max {l.available}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <input
                    type="number"
                    min={1}
                    max={l.available}
                    value={l.quantity}
                    onChange={(e) => onQty(key, Number(e.target.value))}
                    className={`${inputCls} py-1.5`}
                  />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => onRemove(key)}
                    aria-label="Remove item"
                    className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main composer ──────────────────────────────────────────────────────────────────────────────

export function TransferComposer({ mode, returnUrl }: { mode: "admin" | "engineer"; returnUrl: string }) {
  const router = useRouter();
  const { pushToast } = useDashboard();

  const [lines, setLines] = React.useState<CartLine[]>([]);
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [attachments, setAttachments] = React.useState<string[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Admin-only: source + recipient engineers
  const [engineers, setEngineers] = React.useState<EngineerOverviewRow[]>([]);
  const [fromId, setFromId] = React.useState("");
  const [toId, setToId] = React.useState("");
  const [holdings, setHoldings] = React.useState<EngineerHoldingOption[] | null>(null);
  const [holdingsLoading, setHoldingsLoading] = React.useState(false);

  React.useEffect(() => {
    if (mode !== "admin") return;
    stockSvc.listEngineerInventory().then(setEngineers).catch(() => setEngineers([]));
  }, [mode]);

  const addedKeys = React.useMemo(() => new Set(lines.map(lineKey)), [lines]);

  // Engineer mode: every line shares one source holder; the first line locks it.
  const lockedFrom = lines[0]?.fromEngineerId ?? null;
  const lockedFromName = lines[0]?.fromEngineerName ?? null;

  const addLine = (l: CartLine) => {
    const key = lineKey(l);
    setLines((prev) => (prev.some((p) => lineKey(p) === key) ? prev : [...prev, l]));
    setMsg(null);
  };

  const setQty = (key: string, qty: number) => {
    setLines((prev) => prev.map((l) => (lineKey(l) === key ? { ...l, quantity: qty } : l)));
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((l) => lineKey(l) !== key));
  };

  // Admin: choosing / changing the source engineer reloads its holdings and clears the cart.
  const changeFrom = async (id: string) => {
    setFromId(id);
    setLines([]);
    setHoldings(null);
    if (toId === id) setToId("");
    if (!id) return;
    setHoldingsLoading(true);
    try {
      setHoldings(await transferSvc.listEngineerHoldings(id));
    } catch {
      setHoldings([]);
    } finally {
      setHoldingsLoading(false);
    }
  };

  const addHolding = (h: EngineerHoldingOption) => {
    addLine({
      ownership: h.ownership,
      irmItemId: h.irmItemId ?? undefined,
      customerStockEntryId: h.customerStockEntryId ?? undefined,
      itemName: h.itemName,
      sku: h.sku,
      uom: h.uom,
      available: h.available,
      quantity: 1,
      fromEngineerId: fromId,
      fromEngineerName: engineers.find((e) => e.engineerId === fromId)?.name ?? "",
    });
  };

  const clearSource = () => { setLines([]); setMsg(null); };

  const onFile = async (file: File) => {
    if (!file.type.startsWith("image/")) { pushToast("Use an image file.", "alert"); return; }
    setUploading(true);
    try {
      // Straight to Cloudinary — the file no longer passes through our API.
      const url = await uploadDirectForUrl({ purpose: "transfer_attachment", file });
      setAttachments((prev) => [...prev, url]);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Upload failed.", "alert");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const totalQty = lines.reduce((s, l) => s + (Number.isFinite(l.quantity) ? l.quantity : 0), 0);

  const validate = (): string | null => {
    if (mode === "admin") {
      if (!fromId) return "Select a source engineer.";
      if (!toId) return "Select a recipient engineer.";
      if (fromId === toId) return "Source and recipient must be different.";
    }
    if (lines.length === 0) return "Add at least one item.";
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > l.available) {
        return `Quantity for “${l.itemName}” must be between 1 and ${l.available}.`;
      }
    }
    if (!reason.trim()) return "Reason is required.";
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) { setMsg({ type: "error", text: err }); return; }
    setMsg(null);
    setSubmitting(true);
    try {
      await transferSvc.createTransfer({
        fromEngineerId: mode === "admin" ? fromId : lockedFrom ?? undefined,
        toEngineerId: mode === "admin" ? toId : undefined,
        lines: lines.map((l) => ({
          ownership: l.ownership,
          irmItemId: l.irmItemId,
          customerStockEntryId: l.customerStockEntryId,
          quantity: l.quantity,
        })),
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        attachments: attachments.length ? attachments : undefined,
      });
      pushToast(mode === "admin" ? "Transfer created." : "Transfer request sent.");
      router.push(returnUrl);
    } catch (err2) {
      setMsg({ type: "error", text: err2 instanceof Error ? err2.message : "Failed to create transfer." });
    } finally {
      setSubmitting(false);
    }
  };

  const otherEngineers = engineers.filter((e) => e.engineerId !== fromId);
  const isAdmin = mode === "admin";

  const submitBtn = (
    <button type="submit" form="transfer-composer" disabled={submitting} className={primaryBtn}>
      {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {isAdmin ? "Create transfer" : "Send request"}
    </button>
  );

  return (
    <form id="transfer-composer" onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={isAdmin ? "New transfer" : "Request stock transfer"}
        subtitle={isAdmin ? "Move stock from one engineer to another." : "Request stock held by another engineer."}
        onBack={() => router.push(returnUrl)}
        actions={submitBtn}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {isAdmin && (
            <FormSection title="Engineers" description="Stock moves from the source engineer to the recipient.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>From (holder) <RequiredMark /></label>
                  <Select
                    value={fromId}
                    onChange={(v) => void changeFrom(v)}
                    placeholder="Select…"
                    options={engineers.map((en) => ({ value: en.engineerId, label: en.name }))}
                    ariaLabel="From engineer"
                  />
                </div>
                <div>
                  <label className={labelCls}>To (recipient) <RequiredMark /></label>
                  <Select
                    value={toId}
                    onChange={setToId}
                    placeholder="Select…"
                    disabled={!fromId}
                    options={otherEngineers.map((en) => ({ value: en.engineerId, label: en.name }))}
                    ariaLabel="To engineer"
                  />
                </div>
              </div>
            </FormSection>
          )}

          <FormSection
            title="Add items"
            description={
              isAdmin
                ? "Pick from what the source engineer holds."
                : lockedFrom
                  ? "Add more items from the same engineer."
                  : "Search for the stock you need — we’ll show who has it."
            }
          >
            {!isAdmin && lockedFrom && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">Transfer from</span>
                  <span className="truncate text-sm font-bold text-[var(--ink)]">{lockedFromName}</span>
                </span>
                <button type="button" onClick={clearSource} className="shrink-0 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
                  Start over
                </button>
              </div>
            )}
            {isAdmin ? (
              <AdminItemPicker
                holdings={holdings}
                loading={holdingsLoading}
                addedKeys={addedKeys}
                disabled={!fromId}
                onAdd={addHolding}
              />
            ) : (
              <EngineerItemPicker
                lockedFrom={lockedFrom}
                lockedFromName={lockedFromName}
                addedKeys={addedKeys}
                onAdd={addLine}
              />
            )}
          </FormSection>

          <FormSection title={`Selected items${lines.length ? ` (${lines.length})` : ""}`} description="Set the quantity for each item.">
            <CartTable lines={lines} onQty={setQty} onRemove={removeLine} />
          </FormSection>

          <FormSection title="Details" description="Tell the holder why you need this stock.">
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Reason <RequiredMark /></label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this stock being moved?"
                  className={inputCls}
                  aria-required
                />
              </div>
              <div>
                <label className={labelCls}>Notes (optional)</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional context…" className={`${inputCls} resize-none`} />
              </div>
              <div>
                <label className={labelCls}>Attachments (optional)</label>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((url, i) => (
                    <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-[var(--border)]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`Attachment ${i + 1}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
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
                {isAdmin && (
                  <>
                    <div className="flex justify-between gap-2">
                      <dt className="text-[var(--muted)]">From</dt>
                      <dd className="font-semibold text-[var(--ink)]">{engineers.find((e) => e.engineerId === fromId)?.name ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-[var(--muted)]">To</dt>
                      <dd className="font-semibold text-[var(--ink)]">{engineers.find((e) => e.engineerId === toId)?.name ?? "—"}</dd>
                    </div>
                  </>
                )}
                {!isAdmin && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-[var(--muted)]">From</dt>
                    <dd className="font-semibold text-[var(--ink)]">{lockedFromName ?? "—"}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Items</dt>
                  <dd className="font-semibold text-[var(--ink)]">{lines.length}</dd>
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
