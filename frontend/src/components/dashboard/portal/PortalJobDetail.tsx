"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, FileText, Image as ImageIcon, Link as LinkIcon } from "lucide-react";

import * as jobService from "@/services/job.service";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import {
  JOB_LINE_TYPE_LABELS,
  JOB_PRIORITY_LABELS,
  JOB_TYPE_LABELS,
  formatDate,
  formatDateTime,
} from "@/components/dashboard/jobs/jobStatus";
import { JobStageChip } from "./portalUi";
import { parseJobAttachment } from "@/components/dashboard/jobs/jobAttachment";
import type { JobLineType, JobPriority, JobType, PortalJobDetail as PortalJobDetailData } from "@/types/job";

// Customer portal — one job.
//
// The office page (/dashboard/jobs/[id]) rendered for a customer: the same shared DetailHeader, the
// same kit table, the same Identification / Customer & project / Location / Schedule & engineer /
// Attachments / Record cards in the same order and grid — and the same label maps from jobStatus,
// so a job type or priority renamed there is renamed here rather than drifting. A customer on the
// phone to their account team should be looking at the screen the account team is looking at.
//
// FOUR things are withheld, each a decision rather than a design difference, and each enforced by
// the server's projection (see portalJobDetailSelect) so it never reaches the browser at all:
//
//   · Supplier + Installer type   — which subcontractor we use is commercial
//   · Staff contact details       — engineer email, created-by / accepted-by / rejected-by
//   · Notes                       — office-to-engineer free text ("Anything the engineer should
//                                   know"), routinely written ABOUT the customer
//   · Reject reason               — why one of OUR engineers declined the job
//
// Everything else the office sees, the customer sees. `plannerName`/`plannerPhone` are included
// because the schema notes they come off the customer's OWN job pack — that is their contact.

// The office's columns minus Notes — see the exclusion list above. The five numeric ones are
// right-aligned there, and the index range below picks out exactly those.
const KIT_HEADERS = ["Source", "Item", "Warehouse", "Planned", "Issued", "Used", "Returned", "Remaining"];

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
    // min-w-0 + wrap-break-word, verbatim from the office card: a grid item defaults to
    // min-width:auto, so a long unbroken value refuses to shrink and spills into the next column.
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm wrap-break-word text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

export function PortalJobDetail({ id }: { id: string }) {
  const [job, setJob] = React.useState<PortalJobDetailData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const j = await jobService.getOwnJob(id);
        if (active) setJob(j);
      } catch (err) {
        // The server answers "not found" for another company's job as well as a missing one — see
        // getJobForCustomer — so its message is the one to show rather than a guess made here.
        if (active) setError(err instanceof Error ? err.message : "Could not load this job.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) return <FormPageSkeleton />;
  if (error || !job) return <FormError message={error ?? "Job not found."} />;

  return (
    <div className="space-y-5">
      {/* A Link to the list rather than history.back(): it behaves the same from a pasted or
          bookmarked URL, where "back" would leave the app entirely. The browser's own Back button
          still returns to the list with its filters and page intact. */}
      <Link
        href="/dashboard/portal/jobs"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to jobs
      </Link>

      {/* A separate storageKey from the office's "job-detail": a customer and a staff user never
          share a browser, and tying them together would make one surface's remembered collapse
          state depend on the other's. */}
      <DetailHeader
        storageKey="portal-job-detail"
        title={job.jobNumber}
        badges={<JobStageChip value={job.stage} />}
        meta={
          <>
            <span className="font-semibold text-[var(--ink)]">{job.name}</span>
            <span aria-hidden>·</span>
            <span>{job.customerName ?? "—"}</span>
            {job.projectName && (
              <>
                <span aria-hidden>·</span>
                <span>{job.projectName}</span>
              </>
            )}
            <span aria-hidden>·</span>
            {/* "Being assigned", not the office's "Unassigned": that word states a fact about our
                own queue, which to a customer reads as their job having been forgotten. */}
            <span>{job.engineerName ?? "Being assigned"}</span>
          </>
        }
      />

      {/* Kit list */}
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {KIT_HEADERS.map((h, i) => (
                  <th key={h} className={`cell-y px-4 ${i >= 3 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {job.kitLines.length === 0 ? (
                <tr>
                  <td colSpan={KIT_HEADERS.length} className="px-4 py-6 text-center text-[var(--muted)]">
                    No kit lines.
                  </td>
                </tr>
              ) : (
                job.kitLines.map((l) => {
                  // Misc is free text with no barcode or stock balance: never scanned back, skipped
                  // by reconcile. These three would sit at 0 / 0 / issued forever, so the office
                  // page dashes them out and this does the same rather than reporting units owed.
                  const isMisc = l.lineType === "misc";
                  return (
                    <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="cell-y px-4 text-[var(--muted)]">
                        {JOB_LINE_TYPE_LABELS[l.lineType as JobLineType] ?? l.lineType}
                      </td>
                      <td className="cell-y px-4">
                        <div className="font-semibold text-[var(--ink)]">{l.itemName}</div>
                        {l.seCode && <div className="text-[11px] text-[var(--faint)]">{l.seCode}</div>}
                        {l.description && <div className="text-[11px] text-[var(--muted)]">{l.description}</div>}
                      </td>
                      {/* Just the warehouse name. The office cell also breaks the row down by origin
                          and prints where each part must be RETURNED — instructions to an engineer
                          with kit in a van, which a customer has no part in. */}
                      <td className="cell-y px-4 text-[var(--muted)]">{l.warehouseName ?? "—"}</td>
                      <td className="cell-y px-4 text-right font-semibold text-[var(--ink)]">{l.qty}</td>
                      <td className="cell-y px-4 text-right text-[var(--ink)]">{l.issued}</td>
                      <td className="cell-y px-4 text-right text-[var(--ink)]">{isMisc ? "—" : l.used}</td>
                      <td className="cell-y px-4 text-right text-[var(--ink)]">{isMisc ? "—" : l.returned}</td>
                      <td className="cell-y px-4 text-right font-bold text-[var(--ink)]">{isMisc ? "—" : l.remaining}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
            <Field label="Engineer">{job.engineerName}</Field>
            <Field label="Planner">{job.plannerName}</Field>
            <Field label="Planner phone">{job.plannerPhone}</Field>
            <Field label="Assigned">{formatDate(job.assignedAt)}</Field>
            <Field label="Accepted">{formatDate(job.acceptedAt)}</Field>
            <Field label="Work started">{formatDateTime(job.startedAt)}</Field>
            <Field label="Work completed">{formatDateTime(job.completedAt)}</Field>
          </div>
        </Card>

        {job.attachments.length > 0 && (
          <Card title={`Attachments (${job.attachments.length})`}>
            <ul className="space-y-2 text-sm">
              {job.attachments.map((a, i) => {
                // The internal ones are already filtered out upstream; parsing here still strips the
                // marker so a stray one could never reach a customer's screen as a visible URL.
                const meta = parseJobAttachment(a);
                if (!meta || meta.isInternal) return null;
                const { rawUrl: clean, name, isImg, isPdf, isDoc } = meta;

                return (
                  <li key={i} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--accent)]">
                      {isImg ? (
                        <ImageIcon className="h-4 w-4" />
                      ) : isPdf || isDoc ? (
                        <FileText className="h-4 w-4" />
                      ) : (
                        <LinkIcon className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-[var(--ink)]" title={name}>
                        {name}
                      </p>
                      <a
                        href={clean}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] hover:underline"
                      >
                        Open attachment <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <Card title="Record">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Created">{formatDate(job.createdAt)}</Field>
            <Field label="Cancelled">{formatDate(job.cancelledAt)}</Field>
            {job.cancelReason && <div className="col-span-2"><Field label="Cancel reason">{job.cancelReason}</Field></div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
