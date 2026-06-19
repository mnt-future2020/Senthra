"use client";

import { Loader2, Undo2 } from "lucide-react";

import { primaryBtn, secondaryBtn } from "@/components/ui/styles";

// Shared submit row for the Settings forms: an "Unsaved changes" cue while there
// are pending edits, and a Save button that's disabled when there's nothing to
// save. Pair with useReportDirty() so leaving with unsaved edits is guarded.
// Pass onDiscard to also show a "Discard" button that reverts pending edits.
export function SaveBar({
  isDirty,
  saving,
  label,
  onDiscard,
}: {
  isDirty: boolean;
  saving: boolean;
  label: string;
  onDiscard?: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {isDirty && (
        <span className="mr-auto flex items-center gap-1.5 text-xs font-semibold text-[var(--muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          Unsaved changes
        </span>
      )}
      {isDirty && onDiscard && (
        <button type="button" onClick={onDiscard} disabled={saving} className={secondaryBtn}>
          <Undo2 className="h-3.5 w-3.5" />
          Discard
        </button>
      )}
      <button type="submit" disabled={saving || !isDirty} className={primaryBtn}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {label}
      </button>
    </div>
  );
}
