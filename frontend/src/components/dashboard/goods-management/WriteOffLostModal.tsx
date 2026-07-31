"use client";

// WriteOffLostModal — book a job's unaccounted stock as LOST, then reconcile and lock the job.
//
// Two things this exists to prevent, both of which the old inline "Confirm / Cancel" allowed:
//
//  1. Confirming blind. The button used to reconcile immediately, so nobody could see WHAT was about to
//     be written off. The API has always supported a preview — call close with no payload and it returns
//     the unaccounted items instead of acting — and the scan panel already used it. This modal makes that
//     the only path, so the Overdue tab and the scan panel now ask the same question the same way.
//
//  2. Writing stock off anonymously. Every other destructive stock action here — report damage, close a
//     delivery short, adjust stock down — demands a reason. Losing units was the one exception, and it is
//     the one that costs money: the reason lands on every ledger row the write-off produces AND in the
//     audit entry, so "where did three cables go?" has an answer months later.
//
// The action is irreversible: reconciling locks the job.

import * as React from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import { WRITE_OFF_REASONS, type WriteOffReason } from "@/types/goodsManagement";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { dangerBtn, ghostBtn, inputCls, labelCls } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

export interface WriteOffTarget {
  jobId: string;
  jobNumber: string;
  /** What the engineer still holds — from the preview call, so the user sees it before agreeing. */
  unaccounted: { itemName: string; itemCode: string | null; qty: number }[];
}

export function WriteOffLostModal({
  target,
  onClose,
  onWrittenOff,
}: {
  target: WriteOffTarget | null;
  onClose: () => void;
  onWrittenOff: () => void;
}) {
  const [reason, setReason] = React.useState<WriteOffReason | "">("");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  // Reset when a DIFFERENT job is opened (and on close, so reopening starts clean). Carrying a reason
  // over onto another job's write-off would put the wrong explanation in a permanent ledger row.
  // Adjusted during render — React's documented "reset state when a prop changes" pattern, the same one
  // ReportDamageModal uses.
  const [prevJobId, setPrevJobId] = React.useState(target?.jobId ?? null);
  if ((target?.jobId ?? null) !== prevJobId) {
    setPrevJobId(target?.jobId ?? null);
    setReason("");
    setNotes("");
    setMsg(null);
  }

  const totalUnits = (target?.unaccounted ?? []).reduce((n, u) => n + u.qty, 0);
  // Mirrors the server's rule (closeReconcileSchema): a reason always, and a note when it's "Other".
  const valid = reason !== "" && (reason !== "other" || notes.trim().length > 0);

  const submit = async () => {
    if (!target || saving || !valid) return;
    setSaving(true);
    setMsg(null);
    try {
      await gmService.closeReconcile(target.jobId, {
        writeOffLost: true,
        writeOffReason: reason as WriteOffReason,
        writeOffNotes: notes.trim() || undefined,
      });
      onWrittenOff();
      onClose();
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not write off the stock." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      onClose={saving ? () => {} : onClose}
      title={`Write off as lost — ${target?.jobNumber ?? ""}`}
    >
      <div className="space-y-4">
        <div className="flex gap-2.5 rounded-xl border border-[var(--neg)]/30 bg-[var(--neg)]/5 px-4 py-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--neg)]" />
          <p className="text-xs text-[var(--ink)]">
            These units leave the engineer&rsquo;s holding permanently and the job is reconciled and{" "}
            <span className="font-bold">locked</span>. This cannot be undone.
          </p>
        </div>

        {/* WHAT is being written off. The whole reason this modal exists — the old inline confirm asked
            you to agree to a number you were never shown. */}
        <div>
          <span className={labelCls}>
            Being written off ({totalUnits} unit{totalUnits === 1 ? "" : "s"})
          </span>
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
            {(target?.unaccounted ?? []).map((u, i) => (
              <li key={`${u.itemCode ?? u.itemName}-${i}`} className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs">
                <span className="min-w-0">
                  {/* Code first, and in mono: the name is a kit-line snapshot and two different
                      catalogue items can carry near-identical names. On a screen that permanently
                      destroys stock, the unambiguous identifier leads. */}
                  {u.itemCode && (
                    <span className="mr-2 font-mono font-bold text-[var(--faint)]">{u.itemCode}</span>
                  )}
                  <span className="text-[var(--ink)]">{u.itemName}</span>
                </span>
                <span className="shrink-0 font-bold tabular-nums text-[var(--neg)]">{u.qty}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label className={labelCls}>
            Reason <RequiredMark />
          </label>
          <Select
            value={reason}
            onChange={(v) => setReason(v as WriteOffReason)}
            options={WRITE_OFF_REASONS.map((r) => ({ value: r.value, label: r.label }))}
            placeholder="Select a reason…"
            ariaLabel="Reason for writing off as lost"
          />
        </div>

        <div>
          <label className={labelCls}>
            Notes {reason === "other" && <RequiredMark />}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            className={inputCls}
            placeholder={reason === "other" ? "Describe what happened…" : "Anything worth recording (optional)"}
            aria-label="Write-off notes"
          />
        </div>

        <Notice msg={msg} />

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={ghostBtn}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={saving || !valid} className={dangerBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Write off {totalUnits} unit{totalUnits === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
