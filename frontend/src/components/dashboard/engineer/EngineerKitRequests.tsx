"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronRight, Loader2, PackagePlus, Plus, Search, Trash2 } from "lucide-react";

import * as kitRequestService from "@/services/jobKitRequest.service";
import type { KitItemCustomerStockOption, KitItemOption, KitItemRentalOption, KitRequest, KitRequestLinePayload } from "@/services/jobKitRequest.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { FieldError, RequiredMark } from "@/components/ui/FormScaffold";
import { capQty } from "./kitRequestQty";
import { EmptyState, fmtDate } from "@/components/dashboard/portal/portalUi";
import type { Job } from "@/types/job";
import type { Msg } from "@/components/ui/types";
import { availabilityParts, kitItemAvailability, rentalAvailabilityParts } from "./kitItemAvailability";

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

// Requested items, rendered the way the Field Stock (VSR) list renders its lines — a compact one-line
// summary that expands to a real table. Shared by the engineer's own request list and the PM review
// card, so those two can't drift from each other either.
//
// This replaced a flat row of chips. Chips read fine for two or three items, but a request carrying
// eight wrapped into a block that filled the card and buried the code, status and Approve/Decline
// underneath it — and the quantity, the thing a reviewer is actually checking, was a tiny pill inside
// each chip rather than a column you can scan down. VSR had already solved exactly this.
const KIT_SUMMARY_MAX = 3;

// What the reviewer actually granted. `approvedQty` is null on a pending request and on every line
// approved before the trim shipped, so null means "as asked" — never 0. Zero is a real decision: the
// planner refused that one item and approved the rest, and it is the only trace an excluded line
// leaves, because it grows no kit line at all.
function kitLineOutcome(l: KitRequest["lines"][number]): { qty: number; excluded: boolean; trimmed: boolean } {
  if (l.approvedQty == null) return { qty: l.qty, excluded: false, trimmed: false };
  return { qty: l.approvedQty, excluded: l.approvedQty === 0, trimmed: l.approvedQty < l.qty };
}

// Source tint, matching the chips this replaced: company IRM plain, customer consignment accented,
// misc muted — a reviewer sourcing the request needs to see at a glance which pool each line comes
// from, because they're fulfilled from different places.
function KitSourceBadge({ source }: { source: KitRequest["lines"][number]["source"] }) {
  if (source === "customer_stock") {
    return <span className="shrink-0 rounded border border-[var(--accent)]/30 bg-[var(--accent-10)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--accent)]">Customer stock</span>;
  }
  if (source === "rental") {
    // Hired kit needs its own chip, not the IRM blank: it is the one pool that is collected from a
    // specific depot's live hire, can never come off a van, and has to go back to a provider. A
    // reviewer sourcing the request has to see that before they pick where it comes from.
    return <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600">Rental</span>;
  }
  if (source === "misc") {
    return <span className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--faint)]">Misc</span>;
  }
  return null;
}

export function KitRequestLines({ lines }: { lines: KitRequest["lines"] }) {
  const [open, setOpen] = React.useState(false);
  if (lines.length === 0) return null;

  const shown = lines.slice(0, KIT_SUMMARY_MAX);
  const extra = lines.length - shown.length;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
      >
        <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 font-semibold">{lines.length} item{lines.length === 1 ? "" : "s"}</span>
        <span aria-hidden className="shrink-0 text-[var(--faint)]">·</span>
        <span className="min-w-0 truncate">
          {shown.map((l, i) => {
            const o = kitLineOutcome(l);
            return (
              <React.Fragment key={l.id}>
                {i > 0 && <span className="text-[var(--faint)]"> • </span>}
                <span className={o.excluded ? "line-through opacity-70" : ""}>
                  {l.itemName} <span className="font-semibold text-[var(--ink)]">×{o.excluded ? l.qty : o.qty}</span>
                </span>
              </React.Fragment>
            );
          })}
        </span>
        {extra > 0 && (
          <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--faint)]">+{extra} more</span>
        )}
      </button>

      {open && (
        // `relative` contains the table's sr-only header labels — see the note in vanRequestUi.tsx.
        <div className="relative mt-2 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[18rem] text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const o = kitLineOutcome(l);
                return (
                <tr key={l.id} className={`border-b border-[var(--border)] last:border-0 ${o.excluded ? "opacity-60" : ""}`}>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`truncate font-semibold ${o.excluded ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>{l.itemName}</span>
                      <KitSourceBadge source={l.source} />
                      {o.excluded && <span className="shrink-0 rounded border border-[var(--neg)]/30 bg-[var(--neg)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--neg)]">Not approved</span>}
                    </div>
                    {/* The warehouse a consignment line is issued from — the planner can't change it,
                        and it is the one thing the item name doesn't already say. */}
                    {l.warehouseName && (
                      <div className="text-[10px] text-[var(--muted)]">
                        {l.warehouseName}{l.warehouseCode ? ` (${l.warehouseCode})` : ""}
                      </div>
                    )}
                  </td>
                  {/* The GRANTED quantity, with the ask beside it when the planner trimmed — "asked 5,
                      got 4" is the question this table exists to answer, and showing only one number
                      loses half of it. */}
                  <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-[var(--ink)]">
                    {o.excluded ? (
                      <span className="text-[var(--muted)] line-through">×{l.qty}</span>
                    ) : (
                      <>
                        ×{o.qty}
                        {o.trimmed && <span className="ml-1 font-normal text-[11px] text-[var(--faint)]">of {l.qty} asked</span>}
                      </>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
              {/* Only the HEADER shares a row with the action. The lines table and the notes sit
                  BELOW it at full card width — inside the flex row they were bounded by the button,
                  so a pending request's table stopped short while a cancelled one (no button) ran to
                  the edge, and the two rows in the same list didn't line up. VSR lays its expanded
                  lines out the same way, below the row rather than beside the controls. */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[var(--ink)]">{r.code}</span>
                  <KitRequestStatusChip value={r.status} />
                  <span className="text-[11px] text-[var(--faint)]">{fmtDate(r.createdAt)}</span>
                </div>
                {r.status === "pending" && (
                  <button type="button" onClick={() => setConfirmId(r.id)} disabled={cancellingId === r.id} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-60">
                    {cancellingId === r.id ? "…" : "Cancel"}
                  </button>
                )}
              </div>
              <div className="min-w-0">
                  <KitRequestLines lines={r.lines} />
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

/**
 * What a composer row knows about where its stock is.
 *
 * `depots` is present ONLY for hired equipment, and doubles as the discriminator: owned stock and
 * consignment have no hire behind them, so a row carrying depots is a rental and must be described as
 * "available to issue" rather than as stock we hold. See rentalAvailabilityParts.
 */
interface Stock {
  warehouse: number;
  van: number;
  depots?: readonly { warehouseName: string | null }[];
}

interface PlannedOption {
  key: string;
  source: "irm" | "customer_stock" | "rental" | "misc";
  irmItemId: string | null;
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  qty: number;
}
interface CartItem {
  // dedup key: `irm:<id>`, `rental:<id>`, `cse:<id>` (customer stock), or `misc:<name>` (typed custom)
  key: string;
  source: "irm" | "customer_stock" | "rental" | "misc";
  irmItemId: string | null;
  // The CATALOGUE item, never a hire — and deliberately no depot either. The engineer asks for "a
  // fibre tester"; WHICH depot's live hire supplies it is the reviewer's call at approve, exactly as
  // the pickup warehouse for an IRM line is.
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  name: string;
  code: string | null; // IRM/RNT code or the customer-stock warehouse label; null for misc
  qty: number;
}

// One-line label for a customer-stock search option: "Warehouse (CODE) · N in stock · SN ...". Falls
// back to "Stored location" when the warehouse name is missing (only an orphaned FK — the schema makes
// the warehouse mandatory), so the label never starts with a stray space.
function customerStockLabel(it: KitItemCustomerStockOption): string {
  const where = it.warehouseName ? `${it.warehouseName}${it.warehouseCode ? ` (${it.warehouseCode})` : ""}` : "Stored location";
  return `${where} · ${it.qty} in stock${it.serialNumber ? ` · SN ${it.serialNumber}` : ""}`;
}

/**
 * One-line label for a rental option: "RNT-0007 · Leeds +1 more · 4 available to issue".
 *
 * Phrased to match the planned-row sub-line (rentalAvailabilityParts) rather than the older "N free on
 * hire", because the two sit in the SAME modal describing the same figure and read as two different
 * facts when they are worded differently. "Available to issue" is also the accurate claim now that the
 * server excludes hires whose period has ended.
 */
function rentalLabel(it: KitItemRentalOption): string {
  if (it.depots.length === 0) return `${it.code} · none available to issue`;
  const [first, ...rest] = it.depots;
  const where = `${first.warehouseName ?? "Depot"}${rest.length ? ` +${rest.length} more` : ""}`;
  return `${it.code} · ${where} · ${it.quantityOnHand} available to issue`;
}

function plannedOptionsFrom(job: Job): PlannedOption[] {
  const seen = new Set<string>();
  const out: PlannedOption[] = [];
  for (const l of job.kitLines) {
    // Rental IS offerable here. It was skipped in the first pass on the belief that a hire could only
    // ever be ordered from a provider — which stopped being true once rentals became collectable from
    // a depot holding one. "I need another tester" is an ordinary request the planner can fulfil.
    //
    // The key must be keyed on the rental id and NOT fall through to the misc arm: misc keys on the
    // NAME, so a hired line would dedupe against a free-text item that happened to share it.
    const key =
      l.lineType === "irm"
        ? `irm:${l.irmItemId}`
        : l.lineType === "rental"
          ? `rental:${l.rentalItemId}`
          : l.lineType === "customer_stock"
            ? `cse:${l.customerStockEntryId}`
            : `misc:${l.itemName.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      source: l.lineType,
      irmItemId: l.irmItemId,
      rentalItemId: l.rentalItemId,
      customerStockEntryId: l.customerStockEntryId,
      itemName: l.itemName,
      qty: 0,
    });
  }
  return out;
}

// Mounted only while open (conditional render in the parent), so each open starts from fresh state.
function RequestModal({ job, onClose, onSent }: { job: Job; onClose: () => void; onSent: () => void }) {
  const [planned, setPlanned] = React.useState<PlannedOption[]>(() => plannedOptionsFrom(job));
  const [cart, setCart] = React.useState<CartItem[]>([]);
  // Stock behind the rows the composer already holds. The search annotates its own hits, but the
  // planned-item rows come from the job's kit list and the cart rows from an earlier search, so both
  // rendered a bare quantity box with nothing to check it against — an engineer could ask for 50 of
  // an item with 2 free and only find out when the planner couldn't source it.
  // The availability figures TOGETHER WITH the item set they describe. Stapling the key on is what lets
  // "still loading" be derived (`availKey` moved on, the answer hasn't caught up) instead of stored in
  // a second state — a synchronous setState in the fetch effect is what the React Compiler lint
  // forbids, and a separate boolean would have needed exactly that on every refetch.
  //
  // Why the distinction matters at all: "no figure yet" and "no figure at all" both read as
  // `free == null`, and the latter must stay UNCAPPED (misc lines, or a failed lookup — never cap on a
  // guess). So a quantity typed in the moment before the numbers landed went in uncapped, and the cap
  // only ran again on the next keystroke — which is how a row reading "None free to request" could
  // still be submitted with 1.
  const [availState, setAvailState] = React.useState<{ key: string; data: kitRequestService.KitAvailabilityMap }>({ key: "", data: { irm: {}, cse: {}, rental: {} } });
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  // Field-level error for the reason box, kept separate from `msg` (which carries cart-wide and
  // server errors) so it can sit against the control it describes.
  const [reasonError, setReasonError] = React.useState<string | undefined>(undefined);
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const noticeRef = React.useRef<HTMLDivElement>(null);

  // Keys already on the request (planned IRM + customer-stock lines + everything in the cart) — so the
  // search can grey out an item that's already added and the cart can't hold duplicates.
  // Keyed on the item SET only: quantities change on every keystroke of a stepper, and refetching
  // stock because someone typed "3" would be pure noise.
  const availKey = React.useMemo(() => {
    const irm = [...planned.filter((p) => p.source === "irm" && p.irmItemId).map((p) => p.irmItemId!), ...cart.filter((c) => c.source === "irm" && c.irmItemId).map((c) => c.irmItemId!)];
    const cse = [...planned.filter((p) => p.source === "customer_stock" && p.customerStockEntryId).map((p) => p.customerStockEntryId!), ...cart.filter((c) => c.source === "customer_stock" && c.customerStockEntryId).map((c) => c.customerStockEntryId!)];
    const rental = [...planned.filter((p) => p.source === "rental" && p.rentalItemId).map((p) => p.rentalItemId!), ...cart.filter((c) => c.source === "rental" && c.rentalItemId).map((c) => c.rentalItemId!)];
    return JSON.stringify({ irm: [...new Set(irm)].sort(), cse: [...new Set(cse)].sort(), rental: [...new Set(rental)].sort() });
  }, [planned, cart]);

  React.useEffect(() => {
    let active = true;
    const key = availKey;
    const { irm, cse, rental } = JSON.parse(key) as { irm: string[]; cse: string[]; rental: string[] };
    kitRequestService
      .kitItemAvailabilityFor(job.id, irm, cse, rental)
      .then((a) => { if (active) setAvailState({ key, data: a }); })
      // Advisory only — losing it must never block the request. The steppers simply go uncapped, and
      // approve() still re-checks before any stock moves. Tagged with the key either way, so a failed
      // lookup settles into "known-unknown" rather than looking like it is still loading forever.
      .catch(() => { if (active) setAvailState({ key, data: { irm: {}, cse: {}, rental: {} } }); });
    return () => { active = false; };
  }, [availKey, job.id]);

  // Derived, not stored: the answer we hold doesn't describe the item set we're showing.
  const availLoading = availState.key !== availKey;
  const avail = availState.data;

  // Where a row's stock actually is — kept SPLIT rather than merged. The cap needs the total, but the
  // engineer needs to know how much of it is a collection versus a transfer off a colleague's van;
  // showing only the sum is what made this modal read "1995 free to request" for an item the
  // field-stock composer showed as "1992 in stock", with nothing explaining the difference.
  // `null` = unknown (misc lines, or the lookup failed) — never cap on a guess.
  const stockFor = (source: string, irmItemId: string | null, cseId: string | null, rentalItemId?: string | null): Stock | null => {
    if (source === "irm" && irmItemId) {
      const a = avail.irm[irmItemId];
      return a ? { warehouse: a.quantityOnHand, van: a.heldByEngineers } : null;
    }
    if (source === "rental" && rentalItemId) {
      const a = avail.rental[rentalItemId];
      // van is structurally 0: hired kit is never transferable between engineers, so the split reads
      // "N available to issue, none on a van" rather than leaving the second figure unknown.
      //
      // `depots` rides along so the sub-line can NAME where the kit is. That is not decoration for a
      // rental: a hire is collected from the depot that took delivery and can never come off a van, so
      // "where" is the only thing that tells the engineer whether the number is reachable. Its presence
      // is also what marks this row as hired equipment for AvailabilityLine, which must not describe it
      // as stock we own.
      return a ? { warehouse: a.quantityOnHand, van: 0, depots: a.depots } : null;
    }
    if (source === "customer_stock" && cseId) {
      // Consignment has no van figure by design — see the note on qty in jobKitRequest.service.
      const a = avail.cse[cseId];
      return a ? { warehouse: a.qty, van: 0 } : null;
    }
    return null;
  };
  const freeFor = (source: string, irmItemId: string | null, cseId: string | null, rentalItemId?: string | null): number | null => {
    const s = stockFor(source, irmItemId, cseId, rentalItemId);
    return s ? s.warehouse + s.van : null;
  };

  // Clamp at READ time, not by writing corrected state back. A quantity can outlive the figure it was
  // typed against — set before the lookup landed, or left standing when a refetch returns a smaller
  // number — and rewriting state from an effect is both a React Compiler violation and one render too
  // late. Deriving it means the box and the payload are clamped by construction: a value the screen
  // calls impossible can never be shown, and never submitted. The edge cases (unknown figure, and a
  // figure of zero against a row whose minimum is 1) live in capQty with their own tests.
  const cappedQty = (qty: number, source: string, irmItemId: string | null, cseId: string | null, min = 0, rentalItemId?: string | null): number =>
    capQty(qty, freeFor(source, irmItemId, cseId, rentalItemId), min);

  // A row is only held while ITS OWN figure is outstanding. `availLoading` alone would disable every
  // quantity box on the whole request each time the item set changes — and it changes on every cart
  // add/remove, so adding a second item froze the first item's stepper too. Rows we already have an
  // answer for keep working through the refetch; rows with no figure AT ALL (misc, or a lookup that
  // failed and settled) were never capped in the first place and stay editable.
  const qtyPending = (source: string, irmItemId: string | null, cseId: string | null, rentalItemId?: string | null): boolean =>
    availLoading && freeFor(source, irmItemId, cseId, rentalItemId) === null && source !== "misc";

  const excludeKeys = React.useMemo(
    () =>
      new Set<string>([
        ...planned.filter((p) => p.source === "irm" && p.irmItemId).map((p) => `irm:${p.irmItemId}`),
        ...planned.filter((p) => p.source === "customer_stock" && p.customerStockEntryId).map((p) => `cse:${p.customerStockEntryId}`),
        ...planned.filter((p) => p.source === "rental" && p.rentalItemId).map((p) => `rental:${p.rentalItemId}`),
        ...cart.map((c) => c.key),
      ]),
    [planned, cart],
  );

  const setPlannedQty = (key: string, qty: number) => setPlanned((rows) => rows.map((r) => (r.key === key ? { ...r, qty } : r)));
  const addItem = (it: KitItemOption) =>
    setCart((c) => {
      if (it.source === "irm") {
        const key = `irm:${it.irmItemId}`;
        return c.some((x) => x.key === key) ? c : [...c, { key, source: "irm" as const, irmItemId: it.irmItemId, rentalItemId: null, customerStockEntryId: null, name: it.name, code: it.code, qty: 1 }];
      }
      // Explicit arm, not a fallthrough. This function ended in a bare customer-stock `return`, so a
      // rental option became a customer_stock row keyed `cse:undefined` — which then submitted as a
      // misc line with the item id gone.
      if (it.source === "rental") {
        const key = `rental:${it.rentalItemId}`;
        return c.some((x) => x.key === key) ? c : [...c, { key, source: "rental" as const, irmItemId: null, rentalItemId: it.rentalItemId, customerStockEntryId: null, name: it.name, code: rentalLabel(it), qty: 1 }];
      }
      const key = `cse:${it.customerStockEntryId}`;
      return c.some((x) => x.key === key) ? c : [...c, { key, source: "customer_stock" as const, irmItemId: null, rentalItemId: null, customerStockEntryId: it.customerStockEntryId, name: it.name, code: customerStockLabel(it), qty: 1 }];
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
    setCart((c) => (c.some((x) => x.key === key) ? c : [...c, { key, source: "misc" as const, irmItemId: null, rentalItemId: null, customerStockEntryId: null, name: n, code: null, qty: 1 }]));
  };
  const setCartQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, qty } : x)));
  const removeCart = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  // Merge planned + cart into request lines, deduped/summed by identity (backend rejects dup items).
  const buildLines = (): KitRequestLinePayload[] => {
    const byKey = new Map<string, KitRequestLinePayload>();
    // Rows we could not classify — see the final `else` in the cart loop below.
    const unresolved: string[] = [];
    const push = (key: string, line: KitRequestLinePayload) => {
      const existing = byKey.get(key);
      if (existing) existing.qty += line.qty;
      else byKey.set(key, line);
    };
    // Every quantity goes through the SAME cap the boxes render. Reading `p.qty` straight here is what
    // let a value typed before the figures landed reach the server — the row said "None free to
    // request" and the request still carried 1. A line clamped to 0 drops out below.
    for (const p of planned) {
      const qty = cappedQty(p.qty, p.source, p.irmItemId, p.customerStockEntryId, 0, p.rentalItemId);
      if (qty <= 0) continue;
      if (p.source === "irm" && p.irmItemId) push(`irm:${p.irmItemId}`, { source: "irm", irmItemId: p.irmItemId, itemName: p.itemName, qty });
      else if (p.source === "rental" && p.rentalItemId) push(`rental:${p.rentalItemId}`, { source: "rental", rentalItemId: p.rentalItemId, itemName: p.itemName, qty });
      else if (p.source === "customer_stock" && p.customerStockEntryId) push(`cse:${p.customerStockEntryId}`, { source: "customer_stock", customerStockEntryId: p.customerStockEntryId, itemName: p.itemName, qty });
      else if (p.source === "misc") push(`misc:${p.itemName.trim().toLowerCase()}`, { source: "misc", itemName: p.itemName, qty });
    }
    for (const c of cart) {
      const qty = cappedQty(c.qty, c.source, c.irmItemId, c.customerStockEntryId, 0, c.rentalItemId);
      if (qty <= 0) continue;
      if (c.source === "irm" && c.irmItemId) push(c.key, { source: "irm", irmItemId: c.irmItemId, itemName: c.name, qty });
      else if (c.source === "rental" && c.rentalItemId) push(c.key, { source: "rental", rentalItemId: c.rentalItemId, itemName: c.name, qty });
      else if (c.source === "customer_stock" && c.customerStockEntryId) push(c.key, { source: "customer_stock", customerStockEntryId: c.customerStockEntryId, itemName: c.name, qty });
      // The final `else` is MISC, and only rows that are genuinely misc may reach it. It used to be a
      // bare catch-all, so any row that was not irm/customer_stock — a rental, or an irm row that had
      // somehow lost its id — was submitted as free text: item id gone, no custody, and the API
      // accepted it without complaint. Now anything unrecognised is dropped and reported, because a
      // request that silently becomes something else is worse than one that refuses to send.
      else if (c.source === "misc") push(c.key, { source: "misc", itemName: c.name, qty });
      else unresolved.push(c.name);
    }
    if (unresolved.length > 0) {
      throw new Error(`Couldn't work out where to source: ${unresolved.join(", ")}. Remove ${unresolved.length === 1 ? "it" : "them"} and search again.`);
    }
    return [...byKey.values()];
  };

  // Validation errors are attached to the CONTROL they're about and the control is focused, rather
  // than only appended to the notice at the bottom of the body. This modal has `scrollBody`, so with a
  // full cart that notice sits below the fold — pressing "Send request" (in the fixed footer) looked
  // like it did nothing until you scrolled down to find out why.
  //
  // Not a toast: a toast dismisses itself and leaves you hunting for the field it was about, and it
  // isn't tied to the input for a screen reader. Focusing the control scrolls it into view for free,
  // puts the cursor where the fix has to be typed, and `inputCls` already renders the red
  // aria-invalid ring — so the error is visible, announced, and actionable in one move.
  const onSubmit = async () => {
    let lines: KitRequestLinePayload[];
    try {
      lines = buildLines();
    } catch (err) {
      // buildLines throws only for a row it could not classify. Reported in the notice like any other
      // cart-wide problem rather than thrown on: the engineer needs to know WHICH row to remove.
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Couldn't build the request." });
      noticeRef.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (lines.length === 0) {
      // Not a field error — it's about the cart as a whole, so it stays in the notice. The notice is
      // scrolled into view because it sits at the bottom of the scrolling body.
      setMsg({ type: "error", text: "Add at least one item with a quantity." });
      noticeRef.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (!reason.trim()) {
      setReasonError("Tell the planner why you need these items.");
      reasonRef.current?.focus();
      return;
    }
    setReasonError(undefined);
    setSubmitting(true);
    setMsg(null);
    try {
      await kitRequestService.createKitRequest({ jobId: job.id, reason: reason.trim(), lines });
      onSent();
    } catch (err) {
      // A rejected save lands in the same bottom-of-the-body notice, so it needs the same nudge —
      // otherwise pressing Send and having it fail looks identical to nothing happening.
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not send the request." });
      noticeRef.current?.scrollIntoView({ block: "nearest" });
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
            {/* `relative` contains the "Remove" header's sr-only span (Tailwind's sr-only is
                position:absolute). Without a positioned ancestor it resolves against the initial
                containing block, escapes this scroll container and pushes the PAGE into a horizontal
                scroll at phone widths — see the note in van-requests/vanRequestUi.tsx. */}
            <div className="relative overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="w-28 px-3 py-2 text-right">Extra qty</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.map((p) => {
                    const free = freeFor(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId);
                    return (
                      <tr key={p.key} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2">
                          <span className="font-semibold text-[var(--ink)]">{p.itemName}</span>
                          <AvailabilityLine stock={stockFor(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId)} want={cappedQty(p.qty, p.source, p.irmItemId, p.customerStockEntryId, 0, p.rentalItemId)} />
                        </td>
                        <td className="px-3 py-2">
                          {/* Capped at what could actually be sourced, so the box can't promise more
                              than exists. Uncapped when free is unknown (misc, or the lookup failed) —
                              never guess a limit. */}
                          <input
                            type="number"
                            min={0}
                            max={free ?? undefined}
                            step={1}
                            value={cappedQty(p.qty, p.source, p.irmItemId, p.customerStockEntryId, 0, p.rentalItemId)}
                            disabled={qtyPending(p.source, p.irmItemId, p.customerStockEntryId, p.rentalItemId)}
                            aria-label={`Extra quantity for ${p.itemName}`}
                            onChange={(e) => {
                              const raw = Math.max(0, Math.floor(Number(e.target.value) || 0));
                              // Same rule as the rendered value, so typing can't push state past what
                              // the box would show back.
                              setPlannedQty(p.key, capQty(raw, free));
                            }}
                            className={`${inputCls} py-1.5 text-right`}
                          />
                        </td>
                      </tr>
                    );
                  })}
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
                  {cart.map((c) => {
                    const cartFree = freeFor(c.source, c.irmItemId, c.customerStockEntryId, c.rentalItemId);
                    return (
                    <tr key={c.key} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[var(--ink)]">{c.name}</span>
                          {c.source === "misc" && <span className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--faint)]">Misc</span>}
                          {c.source === "customer_stock" && <span className="rounded border border-[var(--accent)]/30 bg-[var(--accent-10)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--accent)]">Customer stock</span>}
                        </div>
                        {c.code && <div className={c.source === "customer_stock" ? "text-[10px] text-[var(--muted)]" : "font-mono text-[10px] text-[var(--muted)]"}>{c.code}</div>}
                        <AvailabilityLine stock={stockFor(c.source, c.irmItemId, c.customerStockEntryId, c.rentalItemId)} want={cappedQty(c.qty, c.source, c.irmItemId, c.customerStockEntryId, 1, c.rentalItemId)} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          // `min` follows the cap rather than sitting at a flat 1. With nothing free
                          // the row is legitimately 0 (and drops out of the request), and a box
                          // showing 0 under min={1} is a control that contradicts itself — the
                          // browser reports it invalid and a stepper click jumps it back to 1.
                          min={cartFree === 0 ? 0 : 1}
                          max={cartFree ?? undefined}
                          step={1}
                          value={cappedQty(c.qty, c.source, c.irmItemId, c.customerStockEntryId, 1, c.rentalItemId)}
                          disabled={qtyPending(c.source, c.irmItemId, c.customerStockEntryId, c.rentalItemId)}
                          aria-label={`Quantity for ${c.name}`}
                          onChange={(e) => {
                            const raw = Math.max(1, Math.floor(Number(e.target.value) || 1));
                            // Same rule as the rendered value, so typing can't push state past what
                            // the box would show back.
                            setCartQty(c.key, capQty(raw, cartFree, 1));
                          }}
                          className={`${inputCls} py-1.5`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => removeCart(c.key)} aria-label="Remove item" className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <label className={labelCls} htmlFor="kit-reason">Why do you need these?<RequiredMark /></label>
          <textarea
            id="kit-reason"
            ref={reasonRef}
            value={reason}
            // Clears as soon as they start answering — leaving a red ring under a box they're
            // actively filling in reads as "still wrong" when it isn't.
            onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(undefined); }}
            rows={2}
            maxLength={2000}
            aria-required="true"
            aria-invalid={Boolean(reasonError)}
            aria-describedby={reasonError ? "kit-reason-error" : undefined}
            placeholder="e.g. Two cables damaged during install; need extras to finish."
            className={`${inputCls} resize-none`}
          />
          <FieldError id="kit-reason-error" message={reasonError} />
        </div>

        <div ref={noticeRef}>{msg && <Notice msg={msg} />}</div>
      </div>
    </Modal>
  );
}


// The stock line under a composer row. Silent when availability is unknown (a misc line has none, and
// a failed lookup must not render a confident "0") — saying nothing beats saying something wrong.
// Turns negative once the asked-for quantity passes what could be sourced, which is the moment the
// planner would have had to reject it.
function AvailabilityLine({ stock, want }: { stock: Stock | null; want: number }) {
  if (stock == null) return null;
  const free = stock.warehouse + stock.van;
  if (free <= 0) return <div className="text-[10px] font-semibold text-[var(--neg)]">None free to request</div>;
  const short = want > free;
  // Hired equipment gets its own sentence. This row used to read "23 in stock" for a fibre tester —
  // false twice over: it is not our stock, and the figure is bounded by a hire period rather than by
  // what we own. The item SEARCH list above already said "N free on hire" for the very same item, so
  // the modal contradicted itself. `depots` marks the row as a rental (see Stock).
  const text = stock.depots
    ? rentalAvailabilityParts(free, stock.depots)
    : availabilityParts(stock.warehouse, stock.van);
  return (
    <div className={`text-[10px] font-semibold ${short ? "text-amber-600" : "text-[var(--muted)]"}`}>
      {text}
      {short ? " — more than that isn’t available" : ""}
    </div>
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
      {touched && !loading && !failed && results.length === 0 && <p className="text-xs text-[var(--muted)]">No matching catalogue, rental or customer-stock item.</p>}

      {results.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-auto">
          {results.map((it) => {
            // Three-way. The old two-way form treated everything that was not IRM as customer stock,
            // so a rental option keyed `cse:undefined` — colliding with every other rental in the
            // list and with any customer row whose id was missing.
            const key =
              it.source === "irm" ? `irm:${it.irmItemId}` : it.source === "rental" ? `rental:${it.rentalItemId}` : `cse:${it.customerStockEntryId}`;
            const added = excludeKeys.has(key);
            // An item no warehouse and no van holds can't be approved from any source, so it is
            // offered but not selectable — see kitItemAvailability. Shown rather than filtered out:
            // an item that silently vanishes from a search teaches nothing, so the engineer just
            // retypes; one that says "out of stock" answers the question and sends them to the misc
            // escape hatch below instead.
            const avail = kitItemAvailability(it);
            const locked = added || !avail.requestable;
            // Sub-line: IRM shows its catalogue code (mono); customer stock shows warehouse · qty · serial.
            const sub = it.source === "irm" ? it.code : it.source === "rental" ? rentalLabel(it) : customerStockLabel(it);
            return (
              <button
                key={key}
                type="button"
                disabled={locked}
                onClick={() => onAddItem(it)}
                title={avail.requestable ? undefined : avail.label}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${locked ? "cursor-not-allowed border-[var(--border)] bg-[var(--surface-2)] opacity-60" : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]"}`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
                    {it.source === "customer_stock" && <span className="shrink-0 rounded border border-[var(--accent)]/30 bg-[var(--accent-10)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--accent)]">Customer stock</span>}
                    {it.source === "rental" && <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600">Rental</span>}
                  </span>
                  {sub && <span className={`block truncate text-[11px] text-[var(--muted)] ${it.source === "irm" || it.source === "rental" ? "font-mono" : ""}`}>{sub}</span>}
                  {avail.label && (
                    <span className={`block truncate text-[11px] font-semibold ${avail.requestable ? "text-[var(--muted)]" : "text-[var(--neg)]"}`}>
                      {avail.label}
                    </span>
                  )}
                </span>
                {added ? <Check className="h-4 w-4 shrink-0 text-[var(--pos)]" /> : !avail.requestable ? null : <Plus className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
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
