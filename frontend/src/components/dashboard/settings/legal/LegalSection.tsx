"use client";

import * as React from "react";
import { FileText, Loader2, Send } from "lucide-react";

import * as policyService from "@/services/policy.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { PolicyBlocks } from "@/components/policy/PolicyBlocks";
import { Notice } from "@/components/ui/Notice";
import { inputCls, hintCls, primaryBtn } from "@/components/ui/styles";
import type { AdminPolicy, PolicyBlock } from "@/types/policy";
import type { Msg } from "@/components/ui/types";

/**
 * Privacy-policy management: edit the draft, preview it, publish it.
 *
 * The two states this screen exists to keep apart are the draft and the published version, so they
 * are shown separately and never merged into one "current content" box. Editing the draft cannot
 * change what the public sees; only Publish does that, and only for someone holding `policy.publish`.
 *
 * No legal wording lives in this file. The draft starts empty and the client writes it.
 */
export function LegalSection() {
  const { can } = useAuth();
  const canEdit = can("policy.edit");
  const canPublish = can("policy.publish");
  const { pushToast } = useDashboard();

  const [policy, setPolicy] = React.useState<AdminPolicy | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<PolicyBlock[] | null>(null);
  // Errors only — a failure stays until it is fixed; a success is a toast.
  const [msg, setMsg] = React.useState<Msg>(null);

  // Initial load. Inline async IIFE with empty deps — the same shape every other settings section
  // uses, and the one the React-Compiler lint rule accepts (a hoisted callback invoked from the
  // effect reads as a synchronous setState to it). Save and publish do not re-fetch: both endpoints
  // return the updated policy, so the response IS the refresh.
  React.useEffect(() => {
    (async () => {
      try {
        const p = await policyService.getPolicyForAdmin();
        setPolicy(p);
        setDraft(p.draftBody);
      } catch (e) {
        setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not load the policy." });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const dirty = policy !== null && draft !== policy.draftBody;

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    setMsg(null);
    try {
      // The revision the editor loaded with — the server refuses the write if anyone else saved.
      const updated = await policyService.saveDraft(draft, policy.draftRevision);
      setPolicy(updated);
      setDraft(updated.draftBody);
      setPreview(null);
      pushToast("Draft saved. It is not public until you publish it.", "success");
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not save the draft." });
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setMsg(null);
    try {
      setPreview(await policyService.previewPolicy(draft));
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not render the preview." });
    }
  };

  const publish = async () => {
    if (!policy) return;
    setPublishing(true);
    setMsg(null);
    try {
      const updated = await policyService.publishPolicy(policy.draftRevision);
      setPolicy(updated);
      setDraft(updated.draftBody);
      setConfirmOpen(false);
      pushToast(`Published version ${updated.published?.version}.`, "success");
    } catch (e) {
      setConfirmOpen(false);
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not publish." });
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-[var(--muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading policy…
      </div>
    );
  }

  const published = policy?.published ?? null;

  return (
    <div className="space-y-6">
      <Notice msg={msg} />

      <SettingsCard
        title="Published policy"
        desc="What the public privacy notice shows today. Published versions are permanent and cannot be edited."
        icon={FileText}
      >
        {published ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--ink)]">
              <span className="font-bold">Version {published.version}</span>
              {policy?.hasUnpublishedChanges && (
                <span className="ml-2 rounded border border-amber-500 bg-amber-50 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  Unpublished changes in draft
                </span>
              )}
            </p>
            <p className={hintCls}>
              Published {new Date(published.publishedAt).toLocaleString("en-GB")}
              {published.publishedBy ? ` by ${published.publishedBy}` : ""}
            </p>
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            Nothing is published. The public privacy page shows an{" "}
            <span className="font-semibold text-[var(--ink)]">unavailable</span> notice, and no draft
            content is visible to anyone outside this screen.
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Draft"
        desc="The working copy. Saving it never changes the published policy — only Publish does that."
        icon={FileText}
      >
        {!canEdit && <ReadOnlyNotice />}
        <div className="space-y-3">
          <textarea
            className={`${inputCls} min-h-[22rem] font-mono text-xs leading-relaxed`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setPreview(null);
            }}
            disabled={!canEdit}
            placeholder="Paste the approved privacy notice here."
            aria-label="Privacy policy draft"
          />
          <p className={hintCls}>
            Formatting: a line starting with <code>#</code> and a space is a heading, a line starting
            with <code>-</code> and a space is a bullet, and a blank line starts a new paragraph.
            Everything else is shown exactly as typed.
          </p>
          {policy?.draftUpdatedAt && (
            <p className={hintCls}>
              Draft last saved {new Date(policy.draftUpdatedAt).toLocaleString("en-GB")}
              {policy.draftUpdatedBy ? ` by ${policy.draftUpdatedBy}` : ""}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={runPreview} className={`${primaryBtn} bg-[var(--surface-2)] text-[var(--ink)]`}>
              Preview
            </button>
            {canEdit && (
              <button type="button" onClick={save} disabled={saving || !dirty} className={primaryBtn}>
                {saving ? "Saving…" : "Save draft"}
              </button>
            )}
            {canPublish && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={publishing || dirty || !draft.trim()}
                className={`${primaryBtn} inline-flex items-center gap-1.5`}
                title={dirty ? "Save the draft before publishing it." : undefined}
              >
                <Send className="h-3.5 w-3.5" />
                Publish
              </button>
            )}
          </div>
          {canEdit && !canPublish && (
            <p className={hintCls}>
              You can edit this draft but not publish it. Someone with the Publish permission must
              approve it before it becomes the public policy.
            </p>
          )}
          {dirty && canPublish && (
            <p className={hintCls}>Save your changes before publishing — publishing sends the saved draft.</p>
          )}
        </div>
      </SettingsCard>

      {preview && (
        <SettingsCard title="Preview" desc="Exactly how the published page will render this draft." icon={FileText}>
          {preview.length ? (
            <PolicyBlocks blocks={preview} />
          ) : (
            <p className="text-sm text-[var(--muted)]">The draft is empty.</p>
          )}
        </SettingsCard>
      )}

      {policy && policy.history.length > 0 && (
        <SettingsCard title="Version history" desc="Every published version, newest first. These are permanent records." icon={FileText}>
          <ul className="divide-y divide-[var(--border-2)] text-sm">
            {policy.history.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                <span className="font-bold text-[var(--ink)]">Version {v.version}</span>
                <span className={hintCls}>
                  {new Date(v.publishedAt).toLocaleString("en-GB")}
                  {v.publishedBy ? ` · ${v.publishedBy}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg"
            style={{ borderRadius: "var(--radius)" }}
          >
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Publish this policy?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              This saves a permanent version {(published?.version ?? 0) + 1} and makes it the policy
              shown at <code>/privacy</code>. Published versions cannot be edited or deleted.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              The page stays hidden from search engines and unlinked from the sign-in screen until
              those are switched on separately.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className={`${primaryBtn} bg-[var(--surface-2)] text-[var(--ink)]`}
              >
                Cancel
              </button>
              <button type="button" onClick={publish} disabled={publishing} className={primaryBtn}>
                {publishing ? "Publishing…" : "Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
