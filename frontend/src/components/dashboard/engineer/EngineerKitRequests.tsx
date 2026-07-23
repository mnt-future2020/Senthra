"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Loader2, PackagePlus, Plus, Search, Trash2 } from "lucide-react";

import * as kitRequestService from "@/services/jobKitRequest.service";
import type { KitItemCustomerStockOption, KitItemOption, KitRequest, KitRequestLinePayload } from "@/services/jobKitRequest.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { EmptyState, fmtDate } from "@/components/dashboard/portal/portalUi";
import type { Job } from "@/types/job";
import type { Msg } from "@/components/ui/types";

// Engineer-portal panel on a job: raise a request for MORE kit (extra units of a planned item, or a
// new item picked from the catalogue) for the planner to review, and track the status of the
// engineer's own requests. The request form lives in a focused modal opened from the top-right, so the
// "Send request" action is prominent rather than buried at the foot of an inline form.

const KIT_STATUS: Record<KitRequest["status"], { cls: string; label: string }> = {
  pending: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", label: "Pending" },
  approved: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", label: "Approved" },
  declined: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", label: "Declined" },
  cancelled: { cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]", label: "Cancelled" },
};

export function KitRequestStatusChip({ value }: { value: KitRequest["status"] }) {
  const s = KIT_STATUS[value] ?? KIT_STATUS.pending;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}>{s.label}</span>;
}

// Requested items as readable chips (one per line) instead of a cramped comma-joined sentence — each
// chip is the item name + a qty pill, with a subtle tint per source (customer stock / misc) so company
// IRM is distinguishable from customer-owned at a glance. Shared by the engineer's own request list and
// the PM review card, so both read the same.
export function KitLineChips({ lines }: { lines: KitRequest["lines"] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {lines.map((l) => {
        const tint =
          l.source === "customer_stock"
            ? "border-[var(--accent)]/30 bg-[var(--accent-10)] text-[var(--accent)]"
            : l.source === "misc"
              ? "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]"
              : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]";
        return (
          <span key={l.id} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold ${tint}`}>
            <span className="truncate">{l.itemName}</span>
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--faint)]">×{l.qty}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────────────────────────

// The "Request items" trigger lives in the page header (see EngineerJobDetail), so the modal is
// CONTROLLED from the parent via `open` / `onOpenChange` — this card owns only the request list and
// the modal body. A success message is surfaced here since it belongs with the list it refreshes.
// `locked` = the job's goods are reconciled: the request history stays visible but no new request
// can be raised — the button is replaced with a note saying why.
export function EngineerKitRequests({ job, locked, open, onOpenChange }: { job: Job; locked: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { pushToast } = useDashboard();
  const [requests, setRequests] = React.useState<KitRequest[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    kitRequestService
      .listMyKitRequests({ jobId: job.id, pageSize: 50 })
      .then((r) => { setRequests(r.requests); setError(null); })
      // A load failure gets its own state — never render it as "no requests yet" (which hides the failure).
      .catch((err) => { setRequests([]); setError(err instanceof Error ? err.message : "Could not load your kit requests."); });
  }, [job.id]);

  React.useEffect(() => load(), [load]);
  // Live-refresh when a request this engineer raised is reviewed by the planner.
  React.useEffect(() => subscribe(["kit_request:updated"], load), [load]);

  const onCancel = async (id: string) => {
    setCancellingId(id);
    try {
      await kitRequestService.cancelKitRequest(id);
      pushToast("Kit request cancelled.");
      load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "Could not cancel the request.", "alert");
    } finally {
      setCancellingId(null);
      setConfirmId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--faint)]">Additional kit</p>
          <p className="mt-0.5 text-xs text-[var(--muted)]">Need more? Request extra units of a planned item or a new item — the planner reviews and issues it.</p>
        </div>
        {/* Same trigger as the page header — both open the one (parent-controlled) modal. Convenient
            on this long page: request from the header, or from here beside the request list. Once the
            job's goods are reconciled the button is REPLACED by a lock note (never silently removed —
            the engineer must see why requesting is gone; their history below stays visible). */}
        {locked ? (
          <p className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] font-semibold text-[var(--muted)]">
            Goods reconciled — kit locked, no more requests.
          </p>
        ) : (
          <button type="button" onClick={() => onOpenChange(true)} className={`${primaryBtn} shrink-0`}>
            <PackagePlus className="h-4 w-4" /> Request items
          </button>
        )}
      </div>

      {error ? (
        <p className="py-6 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
      ) : requests === null ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-2)]" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <EmptyState icon={PackagePlus} title="No kit requests yet" hint="Need more kit? Use “Request items” above and it’ll show here." />
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[var(--ink)]">{r.code}</span>
                    <KitRequestStatusChip value={r.status} />
                    <span className="text-[11px] text-[var(--faint)]">{fmtDate(r.createdAt)}</span>
                  </div>
                  <KitLineChips lines={r.lines} />
                  {r.reason && <p className="mt-1 text-[11px] italic text-[var(--faint)]">“{r.reason}”</p>}
                  {r.status === "declined" && r.decisionNote && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Planner: {r.decisionNote}</p>}
                  {/* "mixed" = some items from stock, some from another van. It must say BOTH: the two
                      older checks were exact-equality, so a mixed approval matched neither and the
                      engineer was told nothing at all about how their kit was arriving. */}
                  {r.status === "approved" && (r.fulfillmentMode === "engineer_transfer" || r.fulfillmentMode === "mixed") && (
                    <p className="mt-0.5 text-[11px] text-[var(--pos)]">
                      {r.fulfillmentMode === "mixed"
                        ? "Approved — some items come from another engineer, the rest from the warehouse. "
                        : "Approved — coming via an engineer transfer. "}
                      {/* The holder's name + phone (to coordinate the handover) live on the Transfers page. */}
                      {/* The engineer viewing this card is the RECIPIENT of the transfer, so it lives on
                          their "My requests" (outgoing) tab — that's where the holder's name + phone show. */}
                      <Link href="/dashboard/engineer/transfers?view=outgoing" className="font-semibold text-[var(--accent)] hover:underline">
                        View transfer &amp; contact
                      </Link>
                    </p>
                  )}
                  {r.status === "approved" && r.fulfillmentMode === "warehouse_issue" && (
                    <p className="mt-0.5 text-[11px] text-[var(--pos)]">Approved — collect from the warehouse.</p>
                  )}
                </div>
                {r.status === "pending" && (
                  <button type="button" onClick={() => setConfirmId(r.id)} disabled={cancellingId === r.id} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-60">
                    {cancellingId === r.id ? "…" : "Cancel"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title="Cancel this kit request?"
        message="The planner will no longer see this request. This can't be undone."
        confirmLabel="Cancel request"
        danger
        busy={cancellingId !== null}
        onConfirm={() => confirmId && onCancel(confirmId)}
        onClose={() => setConfirmId(null)}
      />

      {open && !locked && (
        <RequestModal
          job={job}
          onClose={() => onOpenChange(false)}
          onSent={() => { onOpenChange(false); pushToast("Request sent to the planner."); load(); }}
        />
      )}
    </section>
  );
}

// ── Request modal ────────────────────────────────────────────────────────────────────────────

interface PlannedOption {
  key: string;
  source: "irm" | "customer_stock" | "misc";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  qty: number;
}
interface CartItem {
  key: string; // dedup key: `irm:<id>`, `cse:<id>` (customer stock), or `misc:<name>` (typed custom item)
  source: "irm" | "customer_stock" | "misc";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  name: string;
  code: string | null; // IRM code or the customer-stock warehouse label; null for misc
  qty: number;
}

// One-line label for a customer-stock search option: "Warehouse (CODE) · N in stock · SN ...". Falls
// back to "Stored location" when the warehouse name is missing (only an orphaned FK — the schema makes
// the warehouse mandatory), so the label never starts with a stray space.
function customerStockLabel(it: KitItemCustomerStockOption): string {
  const where = it.warehouseName ? `${it.warehouseName}${it.warehouseCode ? ` (${it.warehouseCode})` : ""}` : "Stored location";
  return `${where} · ${it.qty} in stock${it.serialNumber ? ` · SN ${it.serialNumber}` : ""}`;
}

function plannedOptionsFrom(job: Job): PlannedOption[] {
  const seen = new Set<string>();
  const out: PlannedOption[] = [];
  for (const l of job.kitLines) {
    const key = l.lineType === "irm" ? `irm:${l.irmItemId}` : l.lineType === "customer_stock" ? `cse:${l.customerStockEntryId}` : `misc:${l.itemName.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, source: l.lineType, irmItemId: l.irmItemId, customerStockEntryId: l.customerStockEntryId, itemName: l.itemName, qty: 0 });
  }
  return out;
}

// Mounted only while open (conditional render in the parent), so each open starts from fresh state.
function RequestModal({ job, onClose, onSent }: { job: Job; onClose: () => void; onSent: () => void }) {
  const [planned, setPlanned] = React.useState<PlannedOption[]>(() => plannedOptionsFrom(job));
  const [cart, setCart] = React.useState<CartItem[]>([]);
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  // Keys already on the request (planned IRM + customer-stock lines + everything in the cart) — so the
  // search can grey out an item that's already added and the cart can't hold duplicates.
  const excludeKeys = React.useMemo(
    () =>
      new Set<string>([
        ...planned.filter((p) => p.source === "irm" && p.irmItemId).map((p) => `irm:${p.irmItemId}`),
        ...planned.filter((p) => p.source === "customer_stock" && p.customerStockEntryId).map((p) => `cse:${p.customerStockEntryId}`),
        ...cart.map((c) => c.key),
      ]),
    [planned, cart],
  );

  const setPlannedQty = (key: string, qty: number) => setPlanned((rows) => rows.map((r) => (r.key === key ? { ...r, qty } : r)));
  const addItem = (it: KitItemOption) =>
    setCart((c) => {
      if (it.source === "irm") {
        const key = `irm:${it.irmItemId}`;
        return c.some((x) => x.key === key) ? c : [...c, { key, source: "irm" as const, irmItemId: it.irmItemId, customerStockEntryId: null, name: it.name, code: it.code, qty: 1 }];
      }
      const key = `cse:${it.customerStockEntryId}`;
      return c.some((x) => x.key === key) ? c : [...c, { key, source: "customer_stock" as const, irmItemId: null, customerStockEntryId: it.customerStockEntryId, name: it.name, code: customerStockLabel(it), qty: 1 }];
    });
  const addCustom = (name: string) => {
    const n = name.trim();
    if (!n) return;
    const key = `misc:${n.toLowerCase()}`;
    // If this item is already in the planned table above, steer the engineer there instead of adding a
    // second line whose quantity would be silently merged with the planned row on submit.
    if (planned.some((p) => p.key === key)) {
      setMsg({ type: "error", text: `“${n}” is already listed above under “More of a planned item” — set its extra quantity there.` });
      return;
    }
    setCart((c) => (c.some((x) => x.key === key) ? c : [...c, { key, source: "misc" as const, irmItemId: null, customerStockEntryId: null, name: n, code: null, qty: 1 }]));
  };
  const setCartQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, qty } : x)));
  const removeCart = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  // Merge planned + cart into request lines, deduped/summed by identity (backend rejects dup items).
  const buildLines = (): KitRequestLinePayload[] => {
    const byKey = new Map<string, KitRequestLinePayload>();
    const push = (key: string, line: KitRequestLinePayload) => {
      const existing = byKey.get(key);
      if (existing) existing.qty += line.qty;
      else byKey.set(key, line);
    };
    for (const p of planned) {
      if (p.qty <= 0) continue;
      if (p.source === "irm" && p.irmItemId) push(`irm:${p.irmItemId}`, { source: "irm", irmItemId: p.irmItemId, itemName: p.itemName, qty: p.qty });
      else if (p.source === "customer_stock" && p.customerStockEntryId) push(`cse:${p.customerStockEntryId}`, { source: "customer_stock", customerStockEntryId: p.customerStockEntryId, itemName: p.itemName, qty: p.qty });
      else if (p.source === "misc") push(`misc:${p.itemName.trim().toLowerCase()}`, { source: "misc", itemName: p.itemName, qty: p.qty });
    }
    for (const c of cart) {
      if (c.qty <= 0) continue;
      if (c.source === "irm" && c.irmItemId) push(c.key, { source: "irm", irmItemId: c.irmItemId, itemName: c.name, qty: c.qty });
      else if (c.source === "customer_stock" && c.customerStockEntryId) push(c.key, { source: "customer_stock", customerStockEntryId: c.customerStockEntryId, itemName: c.name, qty: c.qty });
      else push(c.key, { source: "misc", itemName: c.name, qty: c.qty });
    }
    return [...byKey.values()];
  };

  const onSubmit = async () => {
    const lines = buildLines();
    if (lines.length === 0) { setMsg({ type: "error", text: "Add at least one item with a quantity." }); return; }
    if (!reason.trim()) { setMsg({ type: "error", text: "Tell the planner why you need these items." }); return; }
    setSubmitting(true);
    setMsg(null);
    try {
      await kitRequestService.createKitRequest({ jobId: job.id, reason: reason.trim(), lines });
      onSent();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not send the request." });
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <button type="button" onClick={onClose} disabled={submitting} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Cancel</button>
      <button type="button" onClick={onSubmit} disabled={submitting} className={primaryBtn}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} {submitting ? "Sending…" : "Send request"}
      </button>
    </>
  );

  return (
    <Modal open onClose={submitting ? () => {} : onClose} title="Request additional kit" subtitle={`${job.jobNumber} · the planner reviews and issues it`} footer={footer} size="lg" scrollBody>
      <div className="space-y-5">
        {planned.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-bold text-[var(--faint)]">More of a planned item</p>
            <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="w-28 px-3 py-2 text-right">Extra qty</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.map((p) => (
                    <tr key={p.key} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2 font-semibold text-[var(--ink)]">{p.itemName}</td>
                      <td className="px-3 py-2">
                        <input type="number" min={0} step={1} value={p.qty} aria-label={`Extra quantity for ${p.itemName}`} onChange={(e) => setPlannedQty(p.key, Math.max(0, Math.floor(Number(e.target.value) || 0)))} className={`${inputCls} py-1.5 text-right`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-bold text-[var(--faint)]">Add another item</p>
          <KitItemSearch jobId={job.id} excludeKeys={excludeKeys} onAddItem={addItem} onAddCustom={addCustom} />
          {cart.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border)]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-3 py-2">Item</th>
                    <th className="w-24 px-3 py-2">Qty</th>
                    <th className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((c) => (
                    <tr key={c.key} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[var(--ink)]">{c.name}</span>
                          {c.source === "misc" && <span className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--faint)]">Misc</span>}
                          {c.source === "customer_stock" && <span className="rounded border border-[var(--accent)]/30 bg-[var(--accent-10)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--accent)]">Customer stock</span>}
                        </div>
                        {c.code && <div className={c.source === "customer_stock" ? "text-[10px] text-[var(--muted)]" : "font-mono text-[10px] text-[var(--muted)]"}>{c.code}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min={1} step={1} value={c.qty} aria-label={`Quantity for ${c.name}`} onChange={(e) => setCartQty(c.key, Math.max(1, Math.floor(Number(e.target.value) || 1)))} className={`${inputCls} py-1.5`} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => removeCart(c.key)} aria-label="Remove item" className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <label className={labelCls}>Why do you need these? <span className="text-[var(--neg)]">*</span></label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} placeholder="e.g. Two cables damaged during install; need extras to finish." className={`${inputCls} resize-none`} />
        </div>

        {msg && <Notice msg={msg} />}
      </div>
    </Modal>
  );
}

// ── Item search-select (debounced IRM catalogue search) ────────────────────────────────────────

function KitItemSearch({ jobId, excludeKeys, onAddItem, onAddCustom }: { jobId: string; excludeKeys: Set<string>; onAddItem: (it: KitItemOption) => void; onAddCustom: (name: string) => void }) {
  const [search, setSearch] = React.useState("");
  const [results, setResults] = React.useState<KitItemOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token so a slow earlier response can't clobber a newer search's results.
  const reqId = React.useRef(0);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    reqId.current++;
    setSearch(""); setResults([]); setTouched(false); setFailed(false); setLoading(false);
  };

  const run = (v: string) => {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    reqId.current++;
    if (!q) { setResults([]); setTouched(false); setFailed(false); return; }
    timer.current = setTimeout(async () => {
      const myId = ++reqId.current;
      setLoading(true);
      setTouched(true);
      setFailed(false);
      try {
        const items = await kitRequestService.searchKitItems(q, jobId);
        if (myId !== reqId.current) return; // superseded
        setResults(items);
      } catch (e) {
        if (myId !== reqId.current) return;
        console.error("Kit item search failed:", e);
        setResults([]);
        setFailed(true);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 300);
  };

  const term = search.trim();

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input type="search" value={search} onChange={(e) => run(e.target.value)} aria-label="Search items" placeholder="Search the item you need…" className={`${inputCls} pl-9`} />
        {loading && <Loader2 aria-hidden className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--faint)]" />}
      </div>

      {touched && !loading && failed && <p className="text-xs font-semibold text-[var(--neg)]">Couldn’t run the search just now. Check your connection and try again.</p>}
      {touched && !loading && !failed && results.length === 0 && <p className="text-xs text-[var(--muted)]">No matching catalogue or customer-stock item.</p>}

      {results.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-auto">
          {results.map((it) => {
            const key = it.source === "irm" ? `irm:${it.irmItemId}` : `cse:${it.customerStockEntryId}`;
            const added = excludeKeys.has(key);
            // Sub-line: IRM shows its catalogue code (mono); customer stock shows warehouse · qty · serial.
            const sub = it.source === "irm" ? it.code : customerStockLabel(it);
            return (
              <button key={key} type="button" disabled={added} onClick={() => onAddItem(it)} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${added ? "cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
                    {it.source === "customer_stock" && <span className="shrink-0 rounded border border-[var(--accent)]/30 bg-[var(--accent-10)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--accent)]">Customer stock</span>}
                  </span>
                  {sub && <span className={`block truncate text-[11px] text-[var(--muted)] ${it.source === "irm" ? "font-mono" : ""}`}>{sub}</span>}
                </span>
                {added ? <Check className="h-4 w-4 shrink-0 text-[var(--pos)]" /> : <Plus className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Escape hatch — request an item that isn't in the catalogue by name (saved as a misc line). */}
      {term.length > 0 && !loading && (
        <button type="button" onClick={() => { onAddCustom(term); reset(); }} className="flex w-full items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-3 py-2 text-left text-xs font-semibold text-[var(--muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]">
          <Plus className="h-3.5 w-3.5 shrink-0" /> Can’t find it? Add “{term}” as a misc item
        </button>
      )}
    </div>
  );
}
