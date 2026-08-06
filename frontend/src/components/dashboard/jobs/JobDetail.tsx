"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Loader2, Pencil, UserCog, XCircle } from "lucide-react";

import * as jobService from "@/services/job.service";
import { listEngineerOptions } from "@/services/warehouse.service";
import type { WarehouseManager } from "@/types/warehouse";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { Select } from "@/components/ui/Select";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { JobKitRequestsReview } from "./JobKitRequestsReview";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import {
  INSTALLER_TYPE_LABELS,
  JOB_LINE_TYPE_LABELS,
  JOB_PRIORITY_LABELS,
  JOB_TYPE_LABELS,
  JobStatusChip,
  crossWarehouseReturnNote,
  kitLineSourceSplit,
  formatDate,
  formatDateTime,
} from "./jobStatus";
import { Notice } from "@/components/ui/Notice";
import { outstandingKitWarning } from "./outstandingKit";
import type { Job, JobLineType, JobPriority, JobType } from "@/types/job";

export function JobDetail({ idOrCode }: { idOrCode: string }) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    jobService
      .getJob(idOrCode)
      .then((j) => active && setJob(j))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this job."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !job) return <FormError message={error ?? "Job not found."} />;
  return <JobView initial={job} />;
}

function JobView({ initial }: { initial: Job }) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [job, setJob] = React.useState<Job>(initial);
  const [busy, setBusy] = React.useState(false);
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);

  const run = async (fn: () => Promise<Job>, ok: string) => {
    setBusy(true);
    try {
      setJob(await fn());
      pushToast(ok, "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Action failed.", "alert");
    } finally {
      setBusy(false);
    }
  };

  // Refetch the job after a kit request is approved so the grown kit list shows immediately.
  const reloadJob = React.useCallback(() => {
    jobService.getJob(job.id).then(setJob).catch(() => {});
  }, [job.id]);

  // Completed / cancelled jobs and reconciled goods are frozen — no edits (matches the backend lock).
  const editable = can("jobs.edit") && job.status !== "completed" && job.status !== "cancelled" && job.goodsStatus !== "reconciled";
  const cancellable = can("jobs.cancel") && job.status !== "cancelled" && job.status !== "completed";
  // Only these two statuses can go back to "assigned" — mirrors ALLOWED_TRANSITIONS in
  // backend/src/modules/job/job.service.ts. Listed positively rather than as "not completed,
  // not cancelled, not …": an accepted or in-progress job is already underway, so the server
  // refuses the move, and offering the button there just produced a guaranteed error toast.
  const reassignable = can("jobs.assign") && (job.status === "assigned" || job.status === "rejected");

  return (
    <div className="space-y-5">
      <DetailHeader
        storageKey="job-detail"
        title={job.jobNumber}
        badges={
          <>
            <JobStatusChip status={job.status} />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />}
          </>
        }
        meta={
          <>
            <span className="font-semibold text-[var(--ink)]">{job.name}</span>
            <span aria-hidden>·</span>
            <span>{job.customerName ?? "—"}</span>
            {job.projectName && (<><span aria-hidden>·</span><span>{job.projectName}</span></>)}
            <span aria-hidden>·</span>
            <span>{job.assignedEngineerName ?? "Unassigned"}</span>
          </>
        }
        actions={
          // Gate on the disjunction, not a bare fragment: a fragment is always truthy, so a read-only
          // viewer (no edit/assign/cancel rights) would otherwise render an empty actions container.
          (editable || reassignable || cancellable) && (
            <>
              {editable && <ActionBtn icon={Pencil} onClick={() => router.push(`/dashboard/jobs/${job.jobNumber}/edit`)} disabled={busy}>Edit</ActionBtn>}
              {reassignable && <ActionBtn icon={UserCog} onClick={() => setReassignOpen(true)} disabled={busy}>Reassign</ActionBtn>}
              {cancellable && <ActionBtn icon={XCircle} onClick={() => setCancelOpen(true)} disabled={busy}>Cancel</ActionBtn>}
            </>
          )
        }
      />

      {/* Kit list */}
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Source</th><th className="px-4 py-3">Item</th><th className="px-4 py-3">Warehouse</th><th className="px-4 py-3 text-right">Planned</th><th className="px-4 py-3 text-right">Issued</th><th className="px-4 py-3 text-right">Used</th><th className="px-4 py-3 text-right">Returned</th><th className="px-4 py-3 text-right">Remaining</th><th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {job.kitLines.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-6 text-center text-[var(--muted)]">No kit lines.</td></tr>
              ) : (
                job.kitLines.map((l) => (
                  <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-3 text-[var(--muted)]">{JOB_LINE_TYPE_LABELS[l.lineType as JobLineType] ?? l.lineType}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--ink)]">{l.itemName}</div>
                      {l.seCode && <div className="text-[11px] text-[var(--faint)]">{l.seCode}</div>}
                      {l.description && <div className="text-[11px] text-[var(--muted)]">{l.description}</div>}
                    </td>
                    {/* One row can hold BOTH origins (kit lines merge), so break it down per source
                        with quantities rather than naming a single place. */}
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {(() => {
                        const s = kitLineSourceSplit(l, { jobCancelled: job.status === "cancelled" });
                        if (!l.vanSources?.length) return l.warehouseName ?? "—";
                        return (
                          // Sources wrap on ONE line rather than stacking — see the note in
                          // EngineerJobDetail; a split row was standing twice as tall as its neighbours.
                          <div className="flex flex-col gap-0.5">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {/* warehouseSHARE — see the note in EngineerJobDetail. warehouseQty counts
                                only issued units, so a freshly split line showed no warehouse at all
                                and the planner couldn't see their own split. */}
                            {s.warehouseShare > 0 && l.warehouseName && (
                              <span className="text-[var(--ink)]">
                                {l.warehouseName} <span className="text-[var(--faint)]">×{s.warehouseShare}</span>
                                {s.outstandingWarehouseQty > 0 && s.warehouseQty > 0 && (
                                  <span className="ml-1 text-[10px] font-bold text-amber-600">{s.outstandingWarehouseQty} to collect</span>
                                )}
                              </span>
                            )}
                            {l.vanSources.map((v) => (
                              <span key={v.transferCode} className="font-semibold text-[var(--ink)]" title={`${v.transferCode} — ${v.quantity} from ${v.engineerName}`}>
                                {/* Callable here too: a planner chasing a handover shouldn't have to
                                    open the transfer to find the holder's number. */}
                                {v.engineerPhone ? (
                                  <a href={`tel:${v.engineerPhone}`} className="text-[var(--accent)] hover:underline" title={`Call ${v.engineerName} on ${v.engineerPhone}`}>
                                    {v.engineerName}
                                  </a>
                                ) : (
                                  v.engineerName
                                )}{" "}
                                <span className="font-normal text-[var(--faint)]">×{v.quantity}</span>
                                {v.status === "pending" && <span className="ml-1 text-[10px] font-bold text-amber-600">awaiting handover</span>}
                              </span>
                            ))}
                            </div>
                            {/* Van stock owes no warehouse, so it goes back anywhere; warehouse-issued
                                units owe their own site. A MERGED line has both, so state each part
                                — the server enforces exactly this split on return. */}
                            <span className="text-[10px] text-[var(--faint)]">
                              {s.vanOnly
                                ? "Return at any warehouse"
                                : s.vanReturnableQty > 0 && s.warehouseQty > 0 && l.warehouseName
                                  ? `Return ×${s.warehouseQty} at ${l.warehouseName}, ×${s.vanReturnableQty} at any warehouse`
                                  : l.warehouseName
                                    ? `Return at ${l.warehouseName}`
                                    : ""}
                            </span>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{l.qty}</td>
                    <td className="px-4 py-3 text-right text-[var(--ink)]">{l.issued}</td>
                    <td className="px-4 py-3 text-right text-[var(--ink)]">{l.used}</td>
                    <td className="px-4 py-3 text-right text-[var(--ink)]">
                      <div className="flex flex-col items-end gap-1">
                        <span>{l.returned}</span>
                        {l.returned > l.issued && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600" title="Returned here but issued from another warehouse">
                            <ArrowLeftRight className="h-2.5 w-2.5 shrink-0" />
                            {crossWarehouseReturnNote(l, job.kitLines)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[var(--ink)]">{l.remaining}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{l.notes ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {can("jobs.kit_request.review") && (
        <JobKitRequestsReview jobId={job.id} assignedEngineerId={job.assignedEngineerId} locked={job.goodsStatus === "reconciled"} onJobChanged={reloadJob} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Identification">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Job type">{JOB_TYPE_LABELS[job.jobType as JobType] ?? job.jobType}</Field>
            <Field label="Priority">{JOB_PRIORITY_LABELS[job.priority as JobPriority] ?? job.priority}</Field>
            <Field label="Customer reference">{job.customerRef}</Field>
            <Field label="Scheme number">{job.schemeNo}</Field>
            <Field label="Technology">{job.technology}</Field>
          </div>
        </Card>

        <Card title="Customer & project">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer">{job.customerName}</Field>
            <Field label="Project">{job.projectName}</Field>
            <Field label="Site">{job.siteName}</Field>
            <Field label="TRS area">{job.trsArea}</Field>
          </div>
        </Card>

        <Card title="Location">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Field label="Address line 1">{job.addressLine1}</Field></div>
            <div className="col-span-2"><Field label="Address line 2">{job.addressLine2}</Field></div>
            <Field label="City / town">{job.city}</Field>
            <Field label="County">{job.county}</Field>
            <Field label="Postcode">{job.postcode}</Field>
            <Field label="Country">{job.country}</Field>
            <Field label="Floor">{job.floor}</Field>
            <Field label="Suite">{job.suite}</Field>
            <Field label="Rack">{job.rack}</Field>
            <Field label="Shelf">{job.shelf}</Field>
          </div>
        </Card>

        <Card title="Schedule & engineer">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Completion date">{formatDate(job.completionDate)}</Field>
            <Field label="Installer type">{INSTALLER_TYPE_LABELS[job.installerType] ?? job.installerType}</Field>
            <Field label="Engineer">{job.assignedEngineerName}</Field>
            <Field label="Engineer email">{job.assignedEngineerEmail}</Field>
            <Field label="Supplier">{job.supplierName}</Field>
            <Field label="Planner">{job.plannerName}</Field>
            <Field label="Planner phone">{job.plannerPhone}</Field>
            <Field label="Assigned">{formatDate(job.assignedAt)}</Field>
            <Field label="Accepted">{formatDate(job.acceptedAt)}</Field>
            <Field label="Work started">{formatDateTime(job.startedAt)}</Field>
            <Field label="Work completed">{formatDateTime(job.completedAt)}</Field>
          </div>
        </Card>

        {job.attachments.length > 0 && (
          <Card title="Attachments">
            <ul className="space-y-1.5 text-sm">
              {job.attachments.map((a, i) => (
                <li key={i}>
                  <a href={a} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-[var(--accent)] hover:underline">{a}</a>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Record">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created by">{job.createdBy}</Field>
            <Field label="Created">{formatDate(job.createdAt)}</Field>
            <Field label="Accepted by">{job.acceptedBy}</Field>
            {job.status === "rejected" && <Field label="Rejected by">{job.rejectedBy}</Field>}
            {job.rejectReason && <div className="col-span-2"><Field label="Reject reason">{job.rejectReason}</Field></div>}
            {job.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{job.cancelReason}</Field></div>}
            {job.notes && <div className="col-span-2"><Field label="Notes">{job.notes}</Field></div>}
          </div>
        </Card>
      </div>

      {reassignOpen && (
        <ReassignDialog
          current={job.assignedEngineerId}
          busy={busy}
          onClose={() => setReassignOpen(false)}
          onConfirm={(engineerId) => { setReassignOpen(false); run(() => jobService.assignJob(job.id, engineerId), "Engineer reassigned."); }}
        />
      )}
      {cancelOpen && (
        <ReasonDialog
          busy={busy}
          warning={outstandingKitWarning(job.kitLines, job.assignedEngineerName)}
          onClose={() => setCancelOpen(false)}
          onConfirm={(reason) => { setCancelOpen(false); run(() => jobService.cancelJob(job.id, reason || undefined), "Job cancelled."); }}
        />
      )}
    </div>
  );
}

function ActionBtn({ icon: Icon, primary, disabled, onClick, children }: { icon: React.ElementType; primary?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition-all disabled:opacity-60 ${primary ? "bg-[var(--accent)] text-white hover:opacity-90" : "border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-2)]"}`}>
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // min-w-0 lets this grid cell shrink below its content (grid items default to min-width:auto,
    // so a long unbroken value refuses to shrink and spills into the neighbouring column);
    // wrap-break-word then lets that value actually break. Emails are the usual culprit.
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm wrap-break-word text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

function ReassignDialog({ current, busy, onConfirm, onClose }: { current: string | null; busy: boolean; onConfirm: (engineerId: string) => void; onClose: () => void }) {
  const [engineers, setEngineers] = React.useState<{ id: string; name: string; jobTitle: string | null }[]>([]);
  const [engineerId, setEngineerId] = React.useState(current ?? "");
  const { isLoading: engineersLoading } = useReferenceData([
    { label: "engineers", load: () => listEngineerOptions(), onData: (us: WarehouseManager[]) => setEngineers(us.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle }))) },
  ]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Reassign engineer</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">The new engineer is notified immediately and must accept the job.</p>
        <div className="mt-3">
          <Select value={engineerId} onChange={setEngineerId} options={engineers.map((s) => ({ value: s.id, label: s.jobTitle ? `${s.name} — ${s.jobTitle}` : s.name }))} placeholder={engineersLoading && !engineerId ? "Loading engineers…" : "— Select engineer —"} disabled={engineersLoading && !engineerId} ariaLabel="New engineer" />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Cancel</button>
          <button type="button" onClick={() => engineerId && onConfirm(engineerId)} disabled={busy || !engineerId} className="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">Reassign</button>
        </div>
      </div>
    </div>
  );
}

// `warning` is ADVISORY, never a blocker — see outstandingKitWarning for why cancelling can't wait for
// the van. It renders as a warn-tier Notice, not an error: nothing has gone wrong, there is simply
// something left to settle afterwards.
function ReasonDialog({ busy, warning, onConfirm, onClose }: { busy: boolean; warning: string | null; onConfirm: (reason: string) => void; onClose: () => void }) {
  const [value, setValue] = React.useState("");
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold text-[var(--ink)]">Cancel job</h3>
        {/* Bare, like every other Notice in the app — it draws its own amber panel (NOTICE_TONE_CLS +
            NOTICE_SIZE_CLS); a wrapper with its own border/background nests a second box inside it. */}
        {warning && (
          <div className="mt-3">
            <Notice msg={{ type: "warn", text: warning }} size="sm" />
          </div>
        )}
        <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={3} maxLength={500} placeholder="Reason (optional)" className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--ink)] hover:bg-[var(--surface-2)]">Keep</button>
          <button type="button" onClick={() => onConfirm(value.trim())} disabled={busy} className="rounded-xl bg-[var(--neg)] px-3.5 py-2 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-60">Cancel job</button>
        </div>
      </div>
    </div>
  );
}
