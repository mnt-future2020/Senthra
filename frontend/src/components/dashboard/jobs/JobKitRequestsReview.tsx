"use client";

import * as React from "react";
import { Check, PackagePlus, X } from "lucide-react";

import * as kitRequestService from "@/services/jobKitRequest.service";
import type { ApproveKitRequestPayload, FulfillmentMode, KitRequest } from "@/services/jobKitRequest.service";
import { listWarehouseOptions } from "@/services/warehouse.service";
import { listItemWarehouseStock } from "@/services/inventory.service";
import { subscribe } from "@/lib/socket";
import { useDashboard } from "@/hooks/useDashboard";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/styles";
import { KitRequestStatusChip } from "@/components/dashboard/engineer/EngineerKitRequests";
import { formatDate } from "./jobStatus";

// PM/planner review of a job's additional-kit requests: approve (grow the kit + open fulfilment via a
// warehouse issue or a job-scoped engineer transfer) or decline. Rendered on the office job detail,
// gated by jobs.kit_request.review. Calls onJobChanged after an approval so the parent refetches the
// job and the grown kit shows immediately.

export function JobKitRequestsReview({ jobId, assignedEngineerId, onJobChanged }: { jobId: string; assignedEngineerId: string | null; onJobChanged: () => void }) {
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

      {requests === null ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
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
                  <p className="mt-1 text-xs text-[var(--ink)]">{r.lines.map((l) => `${l.itemName} ×${l.qty}`).join(", ")}</p>
                  <p className="mt-0.5 text-[11px] italic text-[var(--muted)]">“{r.reason}”</p>
                  {r.status === "approved" && r.fulfillmentMode && (
                    <p className="mt-0.5 text-[11px] text-[var(--pos)]">Approved · {r.fulfillmentMode === "engineer_transfer" ? "engineer transfer" : "warehouse issue"}{r.reviewedByEmail ? ` by ${r.reviewedByEmail}` : ""}</p>
                  )}
                  {r.status === "declined" && <p className="mt-0.5 text-[11px] text-[var(--neg)]">Declined{r.decisionNote ? ` — ${r.decisionNote}` : ""}</p>}
                </div>
                {r.status === "pending" && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => setApproving(r)} className="flex items-center gap-1 rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-extrabold text-white hover:opacity-90">
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
  const [mode, setMode] = React.useState<FulfillmentMode>("warehouse_issue");
  const [lineWh, setLineWh] = React.useState<Record<string, string>>({}); // requestLineId → warehouseId (IRM lines)
  const [fromEngineerId, setFromEngineerId] = React.useState("");
  const [decisionNote, setDecisionNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const [whOptions, setWhOptions] = React.useState<Record<string, Opt[]>>({}); // per IRM line: warehouses (stock-aware)
  const [whLoading, setWhLoading] = React.useState(true);
  const [holders, setHolders] = React.useState<Opt[] | null>(null); // engineers holding ALL stock-tracked lines
  const [unstocked, setUnstocked] = React.useState<Set<string>>(new Set()); // IRM lines stocked in no warehouse

  const irmLines = request.lines.filter((l) => l.source === "irm");
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
    kitRequestService.eligibleKitHolders(request.id).then(
      (hs) => active && setHolders(hs.map((h) => ({ value: h.engineerId, label: h.name }))),
      () => active && setHolders([]),
    );
    return () => { active = false; };
  }, [request]);

  const whComplete = irmLines.every((l) => !!lineWh[l.id]);
  const canSubmit = !busy && (mode === "warehouse_issue" ? whComplete : !!fromEngineerId);

  const submit = async () => {
    setBusy(true);
    try {
      const payload: ApproveKitRequestPayload = {
        fulfillmentMode: mode,
        lineWarehouses: mode === "warehouse_issue" ? irmLines.map((l) => ({ requestLineId: l.id, warehouseId: lineWh[l.id] })) : undefined,
        fromEngineerId: mode === "engineer_transfer" ? fromEngineerId : undefined,
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
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Fulfilment</p>
          <div className="grid grid-cols-2 gap-2">
            <ModeButton active={mode === "warehouse_issue"} onClick={() => setMode("warehouse_issue")} title="Warehouse issue" hint="Collect from stock" />
            <ModeButton active={mode === "engineer_transfer"} onClick={() => setMode("engineer_transfer")} title="Engineer transfer" hint="From another van" disabled={allMisc} />
          </div>
          {allMisc && <p className="mt-1 text-[11px] text-[var(--faint)]">Misc-only request — issue from a warehouse.</p>}
        </div>

        {/* Warehouse issue: a pickup warehouse PER IRM item — each on its own row, full-width select so
            the "name (code) · N in stock" label is never clipped. Defaults to the most-stocked warehouse. */}
        {mode === "warehouse_issue" && (
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Pickup warehouse — per item</p>
            {irmLines.length === 0 ? (
              <p className="text-[11px] text-[var(--muted)]">No IRM items on this request — customer-stock and misc items are handled automatically.</p>
            ) : whLoading ? (
              <p className="text-[11px] text-[var(--muted)]">Checking stock…</p>
            ) : (
              <div className="space-y-2.5">
                {irmLines.map((l) => {
                  const opts = whOptions[l.id] ?? [];
                  const notStocked = unstocked.has(l.id);
                  return (
                    <div key={l.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                      <p className="mb-1.5 truncate text-xs font-semibold text-[var(--ink)]">
                        {l.itemName} <span className="font-normal text-[var(--faint)]">×{l.qty}</span>
                      </p>
                      {opts.length === 0 ? (
                        <p className="text-[11px] font-semibold text-[var(--neg)]">No warehouses configured — add one to issue this item.</p>
                      ) : (
                        <>
                          <Select value={lineWh[l.id] ?? ""} onChange={(v) => setLineWh((p) => ({ ...p, [l.id]: v }))} options={opts} placeholder="— Pick warehouse —" ariaLabel={`Warehouse for ${l.itemName}`} />
                          {notStocked && (
                            <p className="mt-1 text-[11px] text-amber-600">Not in stock in any warehouse right now — pick where it will be issued once restocked, or switch to Engineer transfer.</p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {stockLines.length < request.lines.length && <p className="mt-2 text-[11px] text-[var(--faint)]">Misc items are handed over without a warehouse; customer-stock uses its stored location.</p>}
          </div>
        )}

        {/* Engineer transfer: pick a holder — NO warehouse (stock comes from their van). */}
        {mode === "engineer_transfer" && (
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Transfer from engineer *</p>
            {holders === null ? (
              <p className="text-[11px] text-[var(--muted)]">Finding engineers who hold these items…</p>
            ) : holders.length === 0 ? (
              <p className="text-[11px] font-semibold text-[var(--neg)]">No engineer currently holds all these items — use warehouse issue instead.</p>
            ) : (
              <>
                <Select value={fromEngineerId} onChange={setFromEngineerId} options={holders} placeholder="— Select engineer —" ariaLabel="Source engineer" />
                <p className="mt-1 text-[11px] text-[var(--muted)]">Only engineers currently holding every requested item are listed. They approve the transfer from their portal; it then counts on this job&apos;s kit.</p>
              </>
            )}
          </div>
        )}

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
