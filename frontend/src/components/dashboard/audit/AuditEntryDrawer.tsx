"use client";

import * as React from "react";
import { X } from "lucide-react";

import type { AuditEntry } from "@/types/audit";
import { actionLabel, absoluteTime } from "./auditDisplay";

// Right-side slide-over showing the full audit entry incl. pretty-printed metadata.
// Closes on backdrop click, Escape, or the close button.
export function AuditEntryDrawer({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  const metadataText =
    entry.metadata == null ? null : JSON.stringify(entry.metadata, null, 2);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="anim-fade-in h-full w-full max-w-md overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-2)] p-5">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">
              {actionLabel(entry.action)}
            </h3>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">{entry.action}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <dl className="space-y-3 p-5 text-xs">
          <Row label="When">{absoluteTime(entry.createdAt)}</Row>
          <Row label="Actor">
            {entry.actorEmail ?? "—"}
            <span className="ml-2 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
              {entry.actorType}
            </span>
          </Row>
          <Row label="Actor ID">
            <span className="font-mono text-[var(--muted)]">{entry.actorId ?? "—"}</span>
          </Row>
          <Row label="Target">
            {entry.targetType ? (
              <>
                <span className="font-semibold text-[var(--ink)]">{entry.targetType}</span>
                {entry.targetLabel ? `: ${entry.targetLabel}` : ""}
              </>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Target ID">
            <span className="font-mono text-[var(--muted)]">{entry.targetId ?? "—"}</span>
          </Row>
        </dl>

        <div className="border-t border-[var(--border-2)] p-5">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            Metadata
          </p>
          {metadataText ? (
            <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink)]">
              {metadataText}
            </pre>
          ) : (
            <p className="text-xs text-[var(--muted)]">No metadata recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // The drawer is narrow and these values are raw record data — actor emails, ObjectIds, target
    // labels — none of which contain break opportunities. Without wrap-break-word a single long id
    // pushes the drawer's content past its own width.
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
        {label}
      </dt>
      <dd className="wrap-break-word text-[var(--ink)]">{children}</dd>
    </div>
  );
}
