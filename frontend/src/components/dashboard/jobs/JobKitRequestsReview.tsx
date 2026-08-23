"use client";

import * as React from "react";
import { Check, Lock, PackagePlus, X } from "lucide-react";

import * as kitRequestService from "@/services/jobKitRequest.service";
import type { ApproveKitRequestPayload, KitRequest, LineSourceType } from "@/services/jobKitRequest.service";
import { listWarehouseOptions } from "@/services/warehouse.service";
import { listItemWarehouseStock } from "@/services/inventory.service";
import { getRentalItemAvailability } from "@/services/rental.service";
import { getJobsDemand } from "@/services/goodsManagement.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/styles";
import { Skeleton } from "@/components/ui/Skeleton";
import { KitRequestLines, KitRequestStatusChip } from "@/components/dashboard/engineer/EngineerKitRequests";
import { formatDate } from "./jobStatus";

// PM/planner review of a job's additional-kit requests: approve (grow the kit + open fulfilment via a
// warehouse issue or a job-scoped engineer transfer) or decline. Rendered on the office job detail,
// gated by jobs.kit_request.review. Calls onJobChanged after an approval so the parent refetches the
// job and the grown kit shows immediately.

// Keyed lookup, not a two-way ternary: sourcing is per line now, so an approval can come back
// "mixed" (some items from stock, some from a van). A ternary silently labelled those "warehouse
// issue" — telling the PM the opposite of what they chose for half the request.
const FULFILMENT_LABELS: Record<string, string> = {
  warehouse_issue: "warehouse issue",
  engineer_transfer: "engineer transfer",
  mixed: "warehouse + engineer transfer",
};

export function JobKitRequestsReview({ jobId, assignedEngineerId, locked, onJobChanged }: { jobId: string; assignedEngineerId: string | null; locked: boolean; onJobChanged: () => void }) {
  const { pushToast } = useDashboard();
  const [requests, setRequests] = React.useState<KitRequest[] | null>(null);
  const [approving, setApproving] = React.useState<KitRequest | null>(null);
  const [declining, setDeclining] = React.useState<KitRequest | null>(null);

  const load = React.useCallback(() => {
    kitRequestService
      .listKitRequests({ jobId, pageSize: 50 })
      .then((r) => setRequests(r.requests))
      .catch(() => setRequests([]));
  }, [jobId]);

  React.useEffect(() => load(), [load]);
  React.useEffect(() => subscribe(["kit_request:updated"], load), [load]);

  const pending = requests?.filter((r) => r.status === "pending") ?? [];
  const history = requests?.filter((r) => r.status !== "pending") ?? [];

  // Hide the card entirely when there's nothing to show (keeps the office detail clean).
  if (requests !== null && requests.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <PackagePlus className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-extrabold text-[var(--ink)]">Kit requests</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600">{pending.length} pending</span>
        )}
      </div>

      {locked && pending.length > 0 && (
        <p className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--muted)]">
          This job&apos;s goods have been reconciled and locked, so pending requests can&apos;t be approved. Decline them to clear the list.
        </p>
      )}

      {requests === null ? (
        // Card skeletons, not a "Loading…" line: the loaded state is a stack of request cards, so a
        // one-line placeholder collapses the panel and then snaps open. Mirrors the card's own
        // shell (rounded-xl, border, surface-2, p-3) so nothing shifts when the data lands.
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-4 w-20 rounded-full" />
              </div>
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {[...pending, ...history].map((r) => (
            <div key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
              {/* Only the HEADER shares a row with the actions. The lines table and notes sit BELOW at
                  full card width — inside the flex row they were bounded by the buttons, so a pending
                  request's table stopped short while a decided one (no buttons) ran to the edge, and
                  two rows in the same list didn't line up. Mirrors the engineer's own card, and VSR. */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[var(--ink)]">{r.code}</span>
                  <KitRequestStatusChip value={r.status} />
                  <span className="text-[11px] text-[var(--faint)]">{r.requestedByEngineerName} · {formatDate(r.createdAt)}</span>
                </div>
                {r.status === "pending" && (
                  // Reconciled goods lock the job — approving grows the kit (a goods write the server
                  // rejects), so disable Approve and say why. Decline stays available to clear it out.
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setApproving(r)}
                      disabled={locked}
                      title={locked ? "This job's goods are reconciled and locked — the kit can't be grown." : undefined}
                      className="flex items-center gap-1 rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-extrabold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button type="button" onClick={() => setDeclining(r)} className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--ink)] hover:bg-[var(--surface)]">
                      <X className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <KitRequestLines lines={r.lines} />
                <p className="mt-1 text-[11px] italic text-[var(--muted)]">“{r.reason}”</p>
                {r.status === "approved" && r.fulfillmentMode && (
                  <p className="mt-0.5 text-[11px] text-[var(--pos)]">Approved · {FULFILMENT_LABELS[r.fulfillmentMode] ?? r.fulfillmentMode}{r.reviewedByEmail ? ` by ${r.reviewedByEmail}` : ""}</p>
                )}
                {r.status === "declined" && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Declined{r.decisionNote ? ` — ${r.decisionNote}` : ""}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {approving && (
        <ApproveDialog
          request={approving}
          assignedEngineerId={assignedEngineerId}
          onClose={() => setApproving(null)}
          onDone={() => { setApproving(null); load(); onJobChanged(); pushToast("Kit request approved.", "success"); }}
          onError={(m) => pushToast(m, "alert")}
        />
      )}
      {declining && (
        <DeclineDialog
          request={declining}
          onClose={() => setDeclining(null)}
          onDone={() => { setDeclining(null); load(); pushToast("Kit request declined.", "success"); }}
          onError={(m) => pushToast(m, "alert")}
        />
      )}
    </section>
  );
}

// `free` rides along so the dialog can VALIDATE against a warehouse's stock, not merely print it.
// Without it the reviewer could approve 3 against a site the same dropdown said held 2 — the kit line
// homes at ONE warehouse, so the shortfall is unissuable and sits on the job forever.
type Opt = { value: string; label: string; free?: number };

function ApproveDialog({ request, onClose, onDone, onError }: { request: KitRequest; assignedEngineerId: string | null; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  // Requested stock is rarely all in one place: the warehouse may hold some items while another
  // engineer's van holds the rest. So the SOURCE is chosen per line — there is no request-level mode.
  const [lineSrc, setLineSrc] = React.useState<Record<string, LineSourceType>>({}); // lineId → warehouse | engineer
  const [lineWh, setLineWh] = React.useState<Record<string, string>>({}); // lineId → warehouseId (IRM lines)
  const [lineEng, setLineEng] = React.useState<Record<string, string>>({}); // lineId → source engineer
  // The reviewer's trim (lineId → approved qty) and, within it, how many come off the van. Both
  // default to "all of it": an untouched request approves exactly what was asked for, from one source.
  const [lineQty, setLineQty] = React.useState<Record<string, number>>({});
  const [lineVanQty, setLineVanQty] = React.useState<Record<string, number>>({});
  const [decisionNote, setDecisionNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const [whOptions, setWhOptions] = React.useState<Record<string, Opt[]>>({}); // per IRM line: warehouses (stock-aware)
  const [whLoading, setWhLoading] = React.useState(true);
  const [vanOptions, setVanOptions] = React.useState<Record<string, Opt[]>>({}); // per line: engineers with enough
  const [holdersFailed, setHoldersFailed] = React.useState(false); // lookup errored ≠ nobody holds it
  const [unstocked, setUnstocked] = React.useState<Set<string>>(new Set()); // IRM lines stocked in no warehouse
  // Kept apart from `unstocked` on purpose: a failed stock lookup must not read as an empty shelf.
  const [stockCheckFailed, setStockCheckFailed] = React.useState<Set<string>>(new Set());

  const stockLines = request.lines.filter((l) => l.source !== "misc");
  const allMisc = stockLines.length === 0;

  // On open: load each IRM item's warehouses-with-stock (fallback: all active warehouses), default each
  // to its most-stocked warehouse; and load the engineers who hold every stock-tracked line (transfer).
  React.useEffect(() => {
    let active = true;
    (async () => {
      let fallback: Opt[] = [];
      try {
        fallback = (await listWarehouseOptions()).map((w) => ({ value: w.id, label: w.code ? `${w.name} (${w.code})` : w.name }));
      } catch { /* no warehouse read permission → per-item stock still works */ }
      const opts: Record<string, Opt[]> = {};
      const defaults: Record<string, string> = {};
      const noStock = new Set<string>();
      const failedCheck = new Set<string>();
      // Planned demand from every other active job, so a rental depot's `free` means the same thing
      // the IRM dropdown's does. `listItemWarehouseStock` nets this off server-side and hands the IRM
      // branch a finished figure; `getRentalItemAvailability` is the gross twin of `getAvailability`
      // and does not, so the netting has to happen here or the two halves of ONE dialog would print
      // "free" to two different definitions — and only the rental half would disagree with the number
      // approve() enforces. No excludeJobId: approve() checks against undiminished open demand, and
      // this request has no kit lines of its own yet to exclude.
      // Advisory, like every other lookup here — on failure the gross figure stands and the server
      // still refuses authoritatively.
      const rentalLines = request.lines.filter((l) => l.source === "rental" && l.rentalItemId);
      const rentalDemand = new Map<string, number>();
      if (rentalLines.length > 0) {
        try {
          for (const d of await getJobsDemand()) {
            if (!d.rentalItemId || !d.warehouseId) continue;
            const k = `${d.rentalItemId}|${d.warehouseId}`;
            rentalDemand.set(k, (rentalDemand.get(k) ?? 0) + d.demand);
          }
        } catch { /* no inventory.view → fall back to the gross figure below */ }
      }
      await Promise.all([
        // Hired kit resolves its depots from the LIVE HIRES of the catalogue item — a rental has no
        // stock balance to read, so `listItemWarehouseStock` has nothing to say about it. Same shape
        // of option, same `free` semantics (net of other jobs' planned demand), so every downstream
        // guard — shortAt, maxApprovable, lineReady — works on a rental line unchanged.
        ...rentalLines
          .map(async (l) => {
            try {
              const rows = await getRentalItemAvailability(l.rentalItemId!);
              const depots = rows
                .map((r) => ({ ...r, free: Math.max(0, r.available - (rentalDemand.get(`${l.rentalItemId}|${r.warehouseId}`) ?? 0)) }))
                .filter((r) => r.free > 0)
                .sort((a, b) => b.free - a.free)
                .map((r) => ({ value: r.warehouseId, free: r.free, label: `${r.warehouseName ?? "Depot"}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.free} free on hire` }));
              if (depots.length) {
                opts[l.id] = depots;
                defaults[l.id] = depots[0].value;
              } else {
                // Nothing on hire anywhere with a spare unit. Unlike IRM there is no van fallback, so
                // this line genuinely cannot be sourced — offering depots would invite the reviewer to
                // nominate one holding none of it.
                opts[l.id] = [];
                noStock.add(l.id);
              }
            } catch {
              // Couldn't check ≠ there is none — same distinction the IRM branch draws.
              opts[l.id] = fallback;
              failedCheck.add(l.id);
            }
          }),
        ...request.lines
          .filter((l) => l.source === "irm" && l.irmItemId)
          .map(async (l) => {
            let stocked: Opt[] = [];
            let lookupFailed = false;
            try {
              const rows = await listItemWarehouseStock(l.irmItemId!);
              // `available`, not raw `onHand`: it is on-hand minus what other jobs have already
              // planned here, which is the same figure the engineer's composer and the Demand board
              // use. On raw on-hand this dropdown would offer stock that is already spoken for.
              stocked = rows
                .filter((r) => r.available > 0)
                .sort((a, b) => b.available - a.available)
                .map((r) => ({ value: r.warehouseId, free: r.available, label: `${r.warehouseName}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.available} free` }));
            } catch {
              // "Couldn't check" is NOT "there is none" — the two used to share a branch, which meant a
              // permission error looked identical to an empty shelf. Tracked separately below.
              lookupFailed = true;
            }
            if (stocked.length) {
              opts[l.id] = stocked;
              defaults[l.id] = stocked[0].value; // auto-default to the most-stocked warehouse
            } else if (lookupFailed) {
              // We could NOT see stock (no inventory-read permission, or the call errored). That is not
              // the same as "there is none", and treating it as such would strand a reviewer who can
              // approve but can't read balances. Offer the full list and say the check didn't run.
              opts[l.id] = fallback;
              failedCheck.add(l.id);
            } else {
              // Genuinely stocked NOWHERE. Previously this offered every warehouse so the PM could
              // "plan an issue, fulfilled once restocked" — which is why JKR-0026 dead-ended: the
              // engineer could request an item nobody had, and the reviewer's only route was to
              // nominate a warehouse holding none of it. Requests are now availability-gated at
              // source (see kitItemAvailability), so this state only survives a race: in stock when
              // asked for, gone by the time it was reviewed. There is no honest warehouse to pick,
              // so offer none — the line is fulfillable only from a van, or not at all.
              opts[l.id] = [];
              noStock.add(l.id);
            }
          }),
      ]);
      if (!active) return;
      setWhOptions(opts);
      setUnstocked(noStock);
      setStockCheckFailed(failedCheck);
      setLineWh((prev) => ({ ...defaults, ...prev }));
      setWhLoading(false);
    })();
    // Van options PER LINE — only engineers holding enough of that item, so a short source can't be
    // picked. Every line defaults to "warehouse": the warehouse is always a valid source (it can be
    // planned even at zero stock), whereas a van is only offered when someone actually holds it.
    kitRequestService.kitLineHolders(request.id).then(
      (rows) => {
        if (!active) return;
        const opts: Record<string, Opt[]> = {};
        for (const r of rows) {
          opts[r.requestLineId] = r.holders.map((h) => ({ value: h.engineerId, label: `${h.name} · holds ${h.available}` }));
        }
        setVanOptions(opts);
      },
      () => active && setHoldersFailed(true),
    );
    return () => { active = false; };
  }, [request]);

  const srcOf = (lineId: string): LineSourceType => lineSrc[lineId] ?? "warehouse";
  // Every stock line needs a resolved source: a warehouse pick (IRM only) or a chosen engineer.
  // How many units are being approved for a line, and how many of those come off a van.
  const approvedOf = (l: KitRequest["lines"][number]) => Math.min(lineQty[l.id] ?? l.qty, l.qty);
  // 0 EXCLUDES the line — the planner refuses this one item and approves the rest, instead of having
  // to decline the whole request and make the engineer raise it again minus one. Field Stock has
  // treated approvedQty 0 as "excluded" all along.
  const excluded = (l: KitRequest["lines"][number]) => l.source !== "misc" && approvedOf(l) === 0;
  // Only a van-sourced line has a split; the value is clamped so trimming the approved quantity can
  // never leave the van portion stranded above it.
  const vanOf = (l: KitRequest["lines"][number]) =>
    srcOf(l.id) === "engineer" ? Math.min(lineVanQty[l.id] ?? approvedOf(l), approvedOf(l)) : 0;
  const isSplit = (l: KitRequest["lines"][number]) => srcOf(l.id) === "engineer" && vanOf(l) < approvedOf(l);

  // What this warehouse must supply for the line: the approved quantity less anything a van brings.
  const warehousePortion = (l: KitRequest["lines"][number]) => approvedOf(l) - vanOf(l);
  // A kit line homes at ONE warehouse, so anything approved beyond what that site can cover is simply
  // unissuable — it would sit on the job as a permanent shortfall. The dropdown already SHOWED the
  // number; nothing checked the approval against it.
  const shortAt = (l: KitRequest["lines"][number]): { name: string; free: number } | null => {
    if (excluded(l)) return null;
    if (l.source === "customer_stock") {
      return l.availableQty != null && approvedOf(l) > l.availableQty
        ? { name: l.warehouseName ?? "That warehouse", free: l.availableQty }
        : null;
    }
    // Rental joins irm here rather than returning null: it now HAS depot options with a `free` figure,
    // so it can and must be shortfall-checked. Left out, a reviewer could approve more testers than
    // the depot has hired and only find out at the scan.
    if (l.source !== "irm" && l.source !== "rental") return null;
    const opt = (whOptions[l.id] ?? []).find((o) => o.value === lineWh[l.id]);
    if (!opt || opt.free === undefined) return null; // unknown stock (lookup failed) — never guess
    return warehousePortion(l) > opt.free ? { name: opt.label.split(" · ")[0], free: opt.free } : null;
  };

  // The most this line could actually be fulfilled for: whatever a van is bringing, plus what the
  // chosen warehouse genuinely has free. Returns null when that is unknowable (no warehouse picked
  // yet, or the stock lookup failed) — a cap must never be guessed.
  const maxApprovable = (l: KitRequest["lines"][number]): number | null => {
    // Consignment has no warehouse picker — the entry IS its location — so its ceiling comes straight
    // off the entry. It was previously uncapped, which made it the one source you could over-approve
    // against while the IRM lines beside it were guarded.
    if (l.source === "customer_stock") return l.availableQty ?? null;
    if (l.source !== "irm" && l.source !== "rental") return null;
    const opt = (whOptions[l.id] ?? []).find((o) => o.value === lineWh[l.id]);
    if (!opt || opt.free === undefined) return null;
    // vanOf is 0 for a rental — it can never be split with a van — so this reduces to the depot's own
    // free count, which is exactly the ceiling approve() enforces server-side.
    return vanOf(l) + opt.free;
  };

  const lineReady = (l: KitRequest["lines"][number]) => {
    if (l.source === "misc") return true;
    if (excluded(l)) return true; // nothing is sourced for a refused line
    if (srcOf(l.id) === "engineer") {
      if (!lineEng[l.id]) return false;
      // A partial split leaves a remainder that has to be collectable from somewhere.
      return !isSplit(l) || l.source !== "irm" || !!lineWh[l.id];
    }
    if (shortAt(l)) return false;
    // A rental needs a depot for the same reason an IRM line does — it is collected from one. Without
    // this arm the Approve button went live with `warehouseId: undefined`, and the request either
    // failed server-side or grew a kit line the engineer could not collect from anywhere.
    return (l.source !== "irm" && l.source !== "rental") || !!lineWh[l.id]; // customer stock issues from where it's stored
  };
  // Excluding EVERYTHING is a decline wearing an approval's clothes — it would mark the request
  // approved while giving the engineer nothing, and the reason belongs in the decline note.
  const allExcluded = request.lines.length > 0 && request.lines.every((l) => excluded(l) || l.source === "misc") && request.lines.some(excluded);
  const canSubmit = !busy && !allExcluded && request.lines.every(lineReady);

  const submit = async () => {
    setBusy(true);
    try {
      // A misc-only request has no stock lines to source; the API's per-line shape requires at least one
      // source, so fall back to the legacy warehouse-issue mode (which just grows the kit, moving no stock).
      const payload: ApproveKitRequestPayload = allMisc
        ? { fulfillmentMode: "warehouse_issue", decisionNote: decisionNote.trim() || undefined }
        : {
            lineSources: stockLines.map((l) => {
              // Only send a trim / split when the reviewer actually changed something — an untouched
              // line keeps the exact payload older servers already understand.
              const approvedQty = approvedOf(l) < l.qty ? approvedOf(l) : undefined; // includes 0 = excluded
              if (srcOf(l.id) !== "engineer") {
                // Rental sends its depot exactly as irm sends its warehouse. Omitted, approve() has
                // nowhere to collect the hire from and refuses — and before it did, the kit line grew
                // with no pickup location at all.
                const needsDepot = l.source === "irm" || l.source === "rental";
                return { requestLineId: l.id, sourceType: "warehouse" as const, warehouseId: needsDepot ? lineWh[l.id] : undefined, approvedQty };
              }
              return {
                requestLineId: l.id,
                sourceType: "engineer" as const,
                engineerId: lineEng[l.id],
                engineerQty: isSplit(l) ? vanOf(l) : undefined,
                // The remainder's pickup location — only meaningful on a split.
                warehouseId: isSplit(l) && l.source === "irm" ? lineWh[l.id] : undefined,
                approvedQty,
              };
            }),
            decisionNote: decisionNote.trim() || undefined,
          };
      await kitRequestService.approveKitRequest(request.id, payload);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not approve the request.");
    } finally {
      setBusy(false);
    }
  };

  // Approve is disabled until every line has a source, and on a request holding an unsourceable line
  // the button sat greyed out with nothing saying why — the only clue was a per-line note halfway up a
  // scrolling dialog. Name what is missing, next to the control that refuses to act, and distinguish
  // the two reasons: one is a pick the reviewer can make, the other has no pick at all and needs a
  // decline. Telling someone to "pick a warehouse" when no warehouse has it is worse than silence.
  const unresolved = allExcluded ? [] : request.lines.filter((l) => !lineReady(l));
  const blocked = unresolved.filter((l) => unstocked.has(l.id) && (vanOptions[l.id] ?? []).length === 0);
  // Over-approved against the chosen site: a source IS picked, it just can't cover the quantity — so
  // "pick a source" would be the wrong instruction.
  const overCommitted = unresolved.filter((l) => !blocked.includes(l) && !!shortAt(l));
  const pickable = unresolved.filter((l) => !blocked.includes(l) && !overCommitted.includes(l));
  const nameOrCount = (ls: typeof unresolved) => (ls.length === 1 ? ls[0].itemName : `${ls.length} items`);

  const footer = (
    <>
      {!busy && !whLoading && (allExcluded || blocked.length > 0 || overCommitted.length > 0 || pickable.length > 0) && (
        <span className={`mr-auto text-[11px] font-semibold ${allExcluded || blocked.length > 0 || overCommitted.length > 0 ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
          {allExcluded
            ? "Every item is excluded — use Decline instead, so the engineer gets the reason."
            : blocked.length > 0
              ? `${nameOrCount(blocked)} can't be sourced from anywhere — decline this request.`
              : overCommitted.length > 0
                ? `${nameOrCount(overCommitted)} — more approved than that warehouse can supply. Lower the quantity or pick another site.`
                : `Pick a source for ${nameOrCount(pickable)} to approve.`}
        </span>
      )}
      <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Cancel</button>
      <button type="button" onClick={submit} disabled={!canSubmit} className="flex items-center gap-1.5 rounded-xl bg-[var(--pos)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">
        <Check className="h-3.5 w-3.5" /> {busy ? "Approving…" : "Approve & grow kit"}
      </button>
    </>
  );

  return (
    // The subtitle used to be every line joined with commas — the same names and quantities that head
    // each source card two inches below, so it filled four lines of the header saying nothing new and
    // pushed the actual decision out of view. It names the request instead, and the one thing a
    // reviewer needs that ISN'T repeated below (the engineer's reason) now leads the body.
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={`Approve ${request.code}`}
      subtitle={`${request.lines.length} item${request.lines.length === 1 ? "" : "s"} · requested by ${request.requestedByEngineerName}`}
      footer={footer}
      size="lg"
      scrollBody
    >
      <div className="space-y-4">
        {/* Why the engineer asked. It was nowhere in this dialog, which meant approving or declining
            without the one piece of context the request was raised to carry.
            The label sits INSIDE the box on the same line as the quote. A stacked heading + panel
            spent two rows and a full section gap on what is usually three words, pushing the item
            list — the part being decided — below the fold. The label still has to be there: a bare
            italic quote under the title reads as a stray note, with nothing tying it to the
            engineer's "Why do you need these?" field. It wraps to a second line only when the reason
            is genuinely long. */}
        {request.reason && (
          <p className="flex flex-wrap items-baseline gap-x-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Reason</span>
            <span className="min-w-0 italic text-[var(--muted)]">“{request.reason}”</span>
          </p>
        )}
        {/* One row per requested item, each choosing its OWN source. Stock is rarely all in one place —
            the warehouse may hold some items while another engineer's van holds the rest — so a single
            request-level mode would force the PM into a dead end whenever neither covers everything.
            Misc lines have no stock source; they just ride along with the kit. */}
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Fulfil each item from</p>
          {whLoading ? (
            <p className="text-[11px] text-[var(--muted)]">Checking stock…</p>
          ) : (
            <div className="space-y-2.5">
              {request.lines.map((l) => {
                const vans = vanOptions[l.id] ?? [];
                const src = srcOf(l.id);
                return (
                  <div key={l.id} className={`rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 ${excluded(l) ? "opacity-60" : ""}`}>
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <p className={`min-w-0 truncate text-xs font-semibold ${excluded(l) ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>
                        {/* The requested quantity is the number the reviewer is sourcing AGAINST — it
                            decides which warehouses can cover the line and whether a van is short. In
                            --faint it read as decoration next to the name; it carries as much weight
                            as the item itself. */}
                        {l.itemName} <span className="font-semibold text-[var(--ink)]">×{l.qty}</span>
                      </p>
                      {/* The TRIM. Without it the only moves were "approve all 5" or "decline the
                          lot", so a request that was 80% reasonable got refused and the engineer had
                          to raise it again for the number the planner would have said yes to. Field
                          Stock has had this as approvedQty ("the trim") all along. */}
                      {l.source !== "misc" && (
                        // whitespace-nowrap on the whole control: "of 5" was breaking between the
                        // word and the number, so the row read as a stray "of" with a lone digit
                        // under it. The input is fixed-width, so the label never needs to wrap.
                        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]">
                          Approve
                          {/* Fixed width on a WRAPPER, never as a competing `w-` class: inputCls
                              already carries w-full, and which of two width utilities wins is decided
                              by stylesheet order, not by the order they appear in this string. The
                              van input below lost that race and rendered full-bleed. */}
                          <span className="inline-block w-14 shrink-0">
                            <input
                            type="number"
                            min={0}
                            // Capped at what can actually be supplied, so an over-approval simply
                            // can't be typed. The state used to be reachable and then explained in two
                            // lines of red prose under every offending row.
                            max={Math.min(l.qty, maxApprovable(l) ?? l.qty)}
                            step={1}
                            value={approvedOf(l)}
                            aria-label={`Approved quantity for ${l.itemName}`}
                            onChange={(e) => {
                              const ceiling = Math.min(l.qty, maxApprovable(l) ?? l.qty);
                              const n = Math.max(0, Math.min(ceiling, Math.floor(Number(e.target.value) || 0)));
                              setLineQty((p) => ({ ...p, [l.id]: n }));
                              // Keep the van portion inside the new cap, so trimming can never leave a
                              // split asking for more than was approved.
                              setLineVanQty((p) => (p[l.id] != null ? { ...p, [l.id]: Math.min(p[l.id], n) } : p));
                            }}
                            className={`${inputCls} py-1 text-right text-xs`}
                            />
                          </span>
                          <span className="whitespace-nowrap text-[var(--faint)]">of {l.qty}</span>
                        </label>
                      )}
                    </div>

                    {/* An excluded line has no source to choose — nothing is being collected or
                        transferred for it — so the pickers are replaced by a line saying so. Leaving
                        a dimmed warehouse dropdown behind would invite the reviewer to configure a
                        pickup for an item they just refused. */}
                    {excluded(l) && (
                      <p className="text-[11px] font-semibold text-[var(--neg)]">
                        Not approved — this item won&apos;t be added to the kit. Set a quantity above to include it again.
                      </p>
                    )}

                    {/* Source switch — only where a van is genuinely an option for THIS item.
                        Rental is excluded unconditionally, not by trusting the holders endpoint to
                        return nothing: hired kit is never transferable engineer-to-engineer, and
                        offering the choice at all would invite an approval the server refuses. */}
                    {!excluded(l) && l.source !== "misc" && l.source !== "rental" && vans.length > 0 && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <ModeButton active={src === "warehouse"} onClick={() => setLineSrc((p) => ({ ...p, [l.id]: "warehouse" }))} title="Warehouse" hint="Collect from stock" />
                        <ModeButton active={src === "engineer"} onClick={() => setLineSrc((p) => ({ ...p, [l.id]: "engineer" }))} title="Engineer" hint="From another van" />
                      </div>
                    )}

                    {excluded(l) ? null : l.source !== "misc" && l.source !== "rental" && src === "engineer" ? (
                      <>
                        <Select value={lineEng[l.id] ?? ""} onChange={(v) => setLineEng((p) => ({ ...p, [l.id]: v }))} options={vans} placeholder="— Select engineer —" ariaLabel={`Source engineer for ${l.itemName}`} />
                        {/* The SPLIT. A van rarely covers the whole line on its own — 5 requested with
                            2 on the shelf and 29 on a colleague's van had no answer before, because
                            the source was all-or-nothing. The kit line already merges sources
                            downstream, so this only removes a limit in the review step. */}
                        {/* Only once an engineer is actually chosen. It used to render the moment the
                            Engineer tab was clicked, so the reviewer was splitting a quantity away
                            from nobody — and the remainder warehouse appeared under an empty picker. */}
                        {approvedOf(l) > 1 && !!lineEng[l.id] && (
                          <label className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] font-semibold text-[var(--muted)]">
                            <span className="whitespace-nowrap">Take</span>
                            <span className="inline-block w-14 shrink-0">
                              <input
                                type="number"
                                min={1}
                                max={approvedOf(l)}
                                step={1}
                                value={vanOf(l)}
                                aria-label={`Units from the van for ${l.itemName}`}
                                onChange={(e) => {
                                  const n = Math.max(1, Math.min(approvedOf(l), Math.floor(Number(e.target.value) || 1)));
                                  setLineVanQty((p) => ({ ...p, [l.id]: n }));
                                }}
                                className={`${inputCls} py-1 text-right text-xs`}
                              />
                            </span>
                            <span className="whitespace-nowrap">of {approvedOf(l)} from this van</span>
                            {isSplit(l) && (
                              <span className="whitespace-nowrap text-[var(--faint)]">· {approvedOf(l) - vanOf(l)} from the warehouse below</span>
                            )}
                          </label>
                        )}
                        {/* A split still needs a pickup location for the remainder. */}
                        {isSplit(l) && !!lineEng[l.id] && l.source === "irm" && (
                          <div className="mt-2">
                            <Select value={lineWh[l.id] ?? ""} onChange={(v) => setLineWh((p) => ({ ...p, [l.id]: v }))} options={whOptions[l.id] ?? []} placeholder="— Warehouse for the remainder —" ariaLabel={`Warehouse for the remainder of ${l.itemName}`} />
                          </div>
                        )}
                      </>
                    ) : l.source === "irm" ? (
                      unstocked.has(l.id) ? (
                        // No warehouse holds it. There is no honest pick to offer, so none is shown —
                        // nominating a zero-stock location was the old dead-end. Requests are gated on
                        // availability now, so reaching here means stock ran out between the ask and
                        // the review; the route is a van if one has it, otherwise decline.
                        <p className="text-[11px] font-semibold text-[var(--neg)]">
                          {vans.length > 0
                            ? "No warehouse has this any more — take it from an engineer's van above."
                            : "No longer available — no warehouse or engineer has this. Decline the request, or wait for stock and review it again."}
                        </p>
                      ) : (whOptions[l.id] ?? []).length === 0 ? (
                        <p className="text-[11px] font-semibold text-[var(--neg)]">No warehouses configured — add one to issue this item.</p>
                      ) : (
                        <>
                          <Select
                            value={lineWh[l.id] ?? ""}
                            onChange={(v) => {
                              setLineWh((p) => ({ ...p, [l.id]: v }));
                              // Switching to a smaller site has to bring the quantity down with it,
                              // or the cap above is bypassed by the order of clicks.
                              const opt = (whOptions[l.id] ?? []).find((o) => o.value === v);
                              if (opt?.free === undefined) return;
                              const ceiling = Math.min(l.qty, vanOf(l) + opt.free);
                              setLineQty((p) => ({ ...p, [l.id]: Math.min(p[l.id] ?? l.qty, ceiling) }));
                            }}
                            options={whOptions[l.id] ?? []}
                            placeholder="— Pick warehouse —"
                            ariaLabel={`Warehouse for ${l.itemName}`}
                          />
                          {/* Couldn't READ stock ≠ there is none. The reviewer keeps a full pick here,
                              but is told the figures behind it are missing rather than trusting a list
                              that looks stock-aware and isn't. */}
                          {stockCheckFailed.has(l.id) && (
                            <p className="mt-1.5 text-[11px] text-amber-600">Couldn&apos;t check stock levels — pick the warehouse you know holds it.</p>
                          )}
                          {/* Tells the PM WHY there's no van option, instead of silently offering only one route. */}
                          {vans.length === 0 && !holdersFailed && (
                            <p className="mt-1.5 text-[11px] text-[var(--faint)]">No engineer holds enough of this item — warehouse only.</p>
                          )}
                          {holdersFailed && <p className="mt-1.5 text-[11px] text-amber-600">Couldn&apos;t check engineer vans — warehouse issue only.</p>}
                        </>
                      )
                    ) : l.source === "rental" ? (
                      // Hired kit is collected from the DEPOT whose live hire has the spare unit. The
                      // picker looks and behaves like the IRM one — same option shape, same `free`
                      // figure — because the decision is the same decision. What differs is that there
                      // is no van fallback to fall back on, so "none on hire" is a dead end here in a
                      // way it never is for IRM.
                      unstocked.has(l.id) ? (
                        <p className="text-[11px] font-semibold text-[var(--neg)]">
                          No depot has this on hire with a spare unit. It can&apos;t be transferred from a van —
                          hired equipment goes back to its provider from the depot that took delivery. Raise a purchase
                          request to hire another, or decline this request.
                        </p>
                      ) : (
                        <>
                          <Select
                            value={lineWh[l.id] ?? ""}
                            onChange={(v) => {
                              setLineWh((p) => ({ ...p, [l.id]: v }));
                              // Same clamp as the IRM picker: switching to a smaller depot has to bring
                              // the approved quantity down with it, or the cap is bypassed by the order
                              // of clicks.
                              const opt = (whOptions[l.id] ?? []).find((o) => o.value === v);
                              if (opt?.free === undefined) return;
                              const ceiling = Math.min(l.qty, opt.free);
                              setLineQty((p) => ({ ...p, [l.id]: Math.min(p[l.id] ?? l.qty, ceiling) }));
                            }}
                            options={whOptions[l.id] ?? []}
                            placeholder="— Pick depot —"
                            ariaLabel={`Depot for ${l.itemName}`}
                          />
                          {stockCheckFailed.has(l.id) && (
                            <p className="mt-1.5 text-[11px] text-amber-600">Couldn&apos;t check what&apos;s on hire — pick the depot you know holds it.</p>
                          )}
                          <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                            Rental item — collected from the depot holding it, never from an engineer&apos;s van.
                          </p>
                        </>
                      )
                    ) : l.source === "customer_stock" ? (
                      // Customer stock is issued from the warehouse its entry is stored in — the planner
                      // can't change it (the stock is physically there), so show the location as a
                      // disabled dropdown-look field: same visual language as the IRM picker, but locked.
                      <>
                        <div
                          aria-label={`Pickup warehouse for ${l.itemName} (fixed)`}
                          className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-xs text-[var(--muted)]"
                        >
                          <span className="min-w-0 truncate">
                            {l.warehouseName ? `${l.warehouseName}${l.warehouseCode ? ` (${l.warehouseCode})` : ""}` : "Stored location"}
                            {/* The same "· N free" the IRM picker shows. Consignment was the only
                                source with no quantity on screen at all, so a reviewer had nothing to
                                judge the approved amount against — and it was the only one the
                                over-approval cap didn't cover either. */}
                            {l.availableQty != null && <span className="text-[var(--faint)]"> · {l.availableQty} free</span>}
                          </span>
                          <Lock aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" />
                        </div>
                        {/* States a FACT about the data, not a restriction the app is imposing. A
                            CustomerStockEntry carries one required warehouseId, so the entry IS its
                            location — there is no other warehouse it could be issued from. (Moving
                            consignment between sites doesn't relocate an entry either:
                            transferCustomerStock decrements this one and increments/creates a
                            separate entry at the destination.) The old wording — "this can't be
                            changed" — read as a lock someone might go looking for a way around. */}
                        <p className="mt-1.5 text-[11px] text-[var(--faint)]">Stored at this warehouse — customer stock is issued from wherever it sits.</p>
                      </>
                    ) : (
                      <p className="text-[11px] text-[var(--muted)]">Misc item · handed over without a warehouse.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {allMisc && <p className="mt-1.5 text-[11px] text-[var(--faint)]">Misc-only request — nothing to source from stock.</p>}
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            Items taken from a van open a transfer that engineer approves from their portal; warehouse items are collected from stock. Both count on this job&apos;s kit.
          </p>
        </div>

        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Note (optional)</p>
          <textarea value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} rows={2} maxLength={2000} aria-label="Approval note" placeholder="Add a note for the engineer…" className={`${inputCls} resize-none`} />
        </div>
      </div>
    </Modal>
  );
}

function ModeButton({ active, onClick, title, hint, disabled }: { active: boolean; onClick: () => void; title: string; hint: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border px-3 py-2 text-left transition-all disabled:opacity-40 ${active ? "border-[var(--accent)] bg-[var(--accent-10)]" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}
    >
      <span className="block text-xs font-bold text-[var(--ink)]">{title}</span>
      <span className="block text-[10px] text-[var(--muted)]">{hint}</span>
    </button>
  );
}

function DeclineDialog({ request, onClose, onDone, onError }: { request: KitRequest; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await kitRequestService.declineKitRequest(request.id, note.trim() || undefined);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not decline the request.");
    } finally {
      setBusy(false);
    }
  };
  const footer = (
    <>
      <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Keep</button>
      <button type="button" onClick={submit} disabled={busy} className="rounded-xl bg-[var(--neg)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">{busy ? "Declining…" : "Decline"}</button>
    </>
  );
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Decline ${request.code}`} subtitle="Let the engineer know why (optional)." footer={footer} size="md">
      <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} aria-label="Decline reason" placeholder="Reason (optional)" className={`${inputCls} resize-none`} />
    </Modal>
  );
}
