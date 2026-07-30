"use client";

import * as React from "react";
import { Check, Lock, PackagePlus, X } from "lucide-react";

import * as kitRequestService from "@/services/jobKitRequest.service";
import type { ApproveKitRequestPayload, KitRequest, LineSourceType } from "@/services/jobKitRequest.service";
import { listWarehouseOptions } from "@/services/warehouse.service";
import { listItemWarehouseStock } from "@/services/inventory.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/styles";
import { Skeleton } from "@/components/ui/Skeleton";
import { KitLineChips, KitRequestStatusChip } from "@/components/dashboard/engineer/EngineerKitRequests";
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
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[var(--ink)]">{r.code}</span>
                    <KitRequestStatusChip value={r.status} />
                    <span className="text-[11px] text-[var(--faint)]">{r.requestedByEngineerName} · {formatDate(r.createdAt)}</span>
                  </div>
                  <KitLineChips lines={r.lines} />
                  <p className="mt-1 text-[11px] italic text-[var(--muted)]">“{r.reason}”</p>
                  {r.status === "approved" && r.fulfillmentMode && (
                    <p className="mt-0.5 text-[11px] text-[var(--pos)]">Approved · {FULFILMENT_LABELS[r.fulfillmentMode] ?? r.fulfillmentMode}{r.reviewedByEmail ? ` by ${r.reviewedByEmail}` : ""}</p>
                  )}
                  {r.status === "declined" && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Declined{r.decisionNote ? ` — ${r.decisionNote}` : ""}</p>}
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

type Opt = { value: string; label: string };

function ApproveDialog({ request, onClose, onDone, onError }: { request: KitRequest; assignedEngineerId: string | null; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  // Requested stock is rarely all in one place: the warehouse may hold some items while another
  // engineer's van holds the rest. So the SOURCE is chosen per line — there is no request-level mode.
  const [lineSrc, setLineSrc] = React.useState<Record<string, LineSourceType>>({}); // lineId → warehouse | engineer
  const [lineWh, setLineWh] = React.useState<Record<string, string>>({}); // lineId → warehouseId (IRM lines)
  const [lineEng, setLineEng] = React.useState<Record<string, string>>({}); // lineId → source engineer
  const [decisionNote, setDecisionNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const [whOptions, setWhOptions] = React.useState<Record<string, Opt[]>>({}); // per IRM line: warehouses (stock-aware)
  const [whLoading, setWhLoading] = React.useState(true);
  const [vanOptions, setVanOptions] = React.useState<Record<string, Opt[]>>({}); // per line: engineers with enough
  const [holdersFailed, setHoldersFailed] = React.useState(false); // lookup errored ≠ nobody holds it
  const [unstocked, setUnstocked] = React.useState<Set<string>>(new Set()); // IRM lines stocked in no warehouse

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
      await Promise.all(
        request.lines
          .filter((l) => l.source === "irm" && l.irmItemId)
          .map(async (l) => {
            let stocked: Opt[] = [];
            try {
              const rows = await listItemWarehouseStock(l.irmItemId!);
              stocked = rows
                .filter((r) => r.onHand > 0)
                .sort((a, b) => b.onHand - a.onHand)
                .map((r) => ({ value: r.warehouseId, label: `${r.warehouseName}${r.warehouseCode ? ` (${r.warehouseCode})` : ""} · ${r.onHand} in stock` }));
            } catch {
              /* lookup failed (e.g. no inventory-read permission) — fall through to the full list below */
            }
            if (stocked.length) {
              opts[l.id] = stocked;
              defaults[l.id] = stocked[0].value; // auto-default to the most-stocked warehouse
            } else {
              // Stocked nowhere (or lookup failed): still offer the full warehouse list so the PM can PLAN
              // an issue (fulfilled once restocked) — but require an EXPLICIT pick (no silent auto-select of
              // a zero-stock location) and flag it. Keeps unstocked items approvable instead of a dead-end,
              // while never quietly issuing from a location holding none.
              opts[l.id] = fallback;
              noStock.add(l.id);
            }
          }),
      );
      if (!active) return;
      setWhOptions(opts);
      setUnstocked(noStock);
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
  const lineReady = (l: KitRequest["lines"][number]) => {
    if (l.source === "misc") return true;
    if (srcOf(l.id) === "engineer") return !!lineEng[l.id];
    return l.source !== "irm" || !!lineWh[l.id]; // customer stock issues from where it's stored
  };
  const canSubmit = !busy && request.lines.every(lineReady);

  const submit = async () => {
    setBusy(true);
    try {
      // A misc-only request has no stock lines to source; the API's per-line shape requires at least one
      // source, so fall back to the legacy warehouse-issue mode (which just grows the kit, moving no stock).
      const payload: ApproveKitRequestPayload = allMisc
        ? { fulfillmentMode: "warehouse_issue", decisionNote: decisionNote.trim() || undefined }
        : {
            lineSources: stockLines.map((l) =>
              srcOf(l.id) === "engineer"
                ? { requestLineId: l.id, sourceType: "engineer" as const, engineerId: lineEng[l.id] }
                : { requestLineId: l.id, sourceType: "warehouse" as const, warehouseId: l.source === "irm" ? lineWh[l.id] : undefined },
            ),
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

  const footer = (
    <>
      <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:opacity-60">Cancel</button>
      <button type="button" onClick={submit} disabled={!canSubmit} className="flex items-center gap-1.5 rounded-xl bg-[var(--pos)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">
        <Check className="h-3.5 w-3.5" /> {busy ? "Approving…" : "Approve & grow kit"}
      </button>
    </>
  );

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Approve ${request.code}`} subtitle={request.lines.map((l) => `${l.itemName} ×${l.qty}`).join(", ")} footer={footer} size="lg" scrollBody>
      <div className="space-y-4">
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
                  <div key={l.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                    <p className="mb-1.5 truncate text-xs font-semibold text-[var(--ink)]">
                      {l.itemName} <span className="font-normal text-[var(--faint)]">×{l.qty}</span>
                    </p>

                    {/* Source switch — only where a van is genuinely an option for THIS item. */}
                    {l.source !== "misc" && vans.length > 0 && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <ModeButton active={src === "warehouse"} onClick={() => setLineSrc((p) => ({ ...p, [l.id]: "warehouse" }))} title="Warehouse" hint="Collect from stock" />
                        <ModeButton active={src === "engineer"} onClick={() => setLineSrc((p) => ({ ...p, [l.id]: "engineer" }))} title="Engineer" hint="From another van" />
                      </div>
                    )}

                    {l.source !== "misc" && src === "engineer" ? (
                      <Select value={lineEng[l.id] ?? ""} onChange={(v) => setLineEng((p) => ({ ...p, [l.id]: v }))} options={vans} placeholder="— Select engineer —" ariaLabel={`Source engineer for ${l.itemName}`} />
                    ) : l.source === "irm" ? (
                      (whOptions[l.id] ?? []).length === 0 ? (
                        <p className="text-[11px] font-semibold text-[var(--neg)]">No warehouses configured — add one to issue this item.</p>
                      ) : (
                        <>
                          <Select value={lineWh[l.id] ?? ""} onChange={(v) => setLineWh((p) => ({ ...p, [l.id]: v }))} options={whOptions[l.id] ?? []} placeholder="— Pick warehouse —" ariaLabel={`Warehouse for ${l.itemName}`} />
                          {unstocked.has(l.id) && (
                            <p className="mt-1.5 text-[11px] text-amber-600">
                              Not in stock in any warehouse right now — pick where it will be issued once restocked
                              {vans.length > 0 ? ", or take it from an engineer's van above." : "."}
                            </p>
                          )}
                          {/* Tells the PM WHY there's no van option, instead of silently offering only one route. */}
                          {vans.length === 0 && !holdersFailed && (
                            <p className="mt-1.5 text-[11px] text-[var(--faint)]">No engineer holds enough of this item — warehouse only.</p>
                          )}
                          {holdersFailed && <p className="mt-1.5 text-[11px] text-amber-600">Couldn&apos;t check engineer vans — warehouse issue only.</p>}
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
                          </span>
                          <Lock aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" />
                        </div>
                        <p className="mt-1.5 text-[11px] text-[var(--faint)]">Customer stock — issued from where it’s stored. This can’t be changed.</p>
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
