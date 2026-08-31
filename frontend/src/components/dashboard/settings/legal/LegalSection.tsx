"use client";

import * as React from "react";
import { Copy, Eye, FileText, Loader2, RotateCcw, Send, X } from "lucide-react";

import * as policyService from "@/services/policy.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { PolicyBlocks } from "@/components/policy/PolicyBlocks";
import { Notice } from "@/components/ui/Notice";
import { inputCls, hintCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import type { AdminPolicy, PolicyBlock, PublishedVersionDetail } from "@/types/policy";
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
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  /** The historical version being READ. `body: null` while its fetch is in flight. */
  const [viewing, setViewing] = React.useState<{ version: number; detail: PublishedVersionDetail | null } | null>(null);
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

  /**
   * Does the SAVED draft differ from the live policy?
   *
   * Server-derived (`hasUnpublishedChanges` = published body !== draft body), not recomputed here —
   * one comparison rule, and the server is the one that decides. `dirty` is a different question:
   * that is about the editor's unsaved keystrokes.
   *
   * Gates both Publish and Discard, from opposite directions: with nothing changed there is nothing
   * to publish (it would mint a permanent duplicate version) and nothing to discard.
   */
  const hasUnpublishedChanges = policy?.hasUnpublishedChanges ?? false;

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

  const discard = async () => {
    if (!policy) return;
    setDiscarding(true);
    setMsg(null);
    try {
      // Same revision the editor loaded with — a discard is a draft write and carries the same guard
      // a save does, so it cannot silently overwrite an edit somebody else just saved.
      const updated = await policyService.discardDraft(policy.draftRevision);
      setPolicy(updated);
      setDraft(updated.draftBody);
      setPreview(null);
      setDiscardOpen(false);
      pushToast("Draft discarded. The published policy is unchanged.", "success");
    } catch (e) {
      setDiscardOpen(false);
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not discard the draft." });
    } finally {
      setDiscarding(false);
    }
  };

  const [copying, setCopying] = React.useState(false);

  /**
   * Put a historical version's text back in the DRAFT. Never live.
   *
   * The only safe way to reuse an old policy. Repointing the live version at an old row would make
   * the same version number occupy two different periods on the timeline, and "what was live on the
   * 26th?" would stop having one answer — which is the whole thing the immutable history exists to
   * guarantee. So the old text becomes a new draft, is reviewed, and is published as a NEW version.
   *
   * Deliberately the EXISTING `saveDraft` call and nothing else. It therefore inherits, rather than
   * re-implements: the `policy.edit` gate, the revision guard (a stale draft is refused, never
   * silently overwritten) and the `policy.draft_saved` audit entry. No endpoint was added for this,
   * because none is needed — copying to the draft IS saving the draft.
   *
   * `detail.body` — the raw stored source, NOT `detail.blocks`. The viewer renders parsed blocks, so
   * copying what is on screen would drop the `#` and `-` markers and the paragraph breaks, and paste
   * back a document that had lost its structure.
   */
  const copyToDraft = async () => {
    if (!policy || !viewing?.detail) return;
    setCopying(true);
    setMsg(null);
    try {
      const updated = await policyService.saveDraft(viewing.detail.body, policy.draftRevision);
      setPolicy(updated);
      setDraft(updated.draftBody);
      setPreview(null);
      const from = viewing.version;
      setViewing(null);
      // Says what happened AND what has not: publishing stays a separate, deliberate act.
      pushToast(`Draft now holds version ${from}. Review it, then publish to make it live.`, "success");
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not copy that version into the draft." });
    } finally {
      setCopying(false);
    }
  };

  /** Fetch one historical body on demand — never shipped with the history list. */
  const viewVersion = async (id: string, version: number) => {
    setViewing({ version, detail: null });
    try {
      setViewing({ version, detail: await policyService.getPublishedVersion(id) });
    } catch (e) {
      setViewing(null);
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not load that version." });
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
          /* A compact STATUS STRIP, matching EmailSection's "Enable email sending" row — the shape
             Settings already uses to state the current state of a thing in one line.
             
             This started as a bare sentence (which left the card looking like a failed load) and I
             over-corrected into a tall centred empty state with its own icon, which was heavier than
             anything else in Settings and made the section read as more important than the draft
             editor below it. One row, bold status, supporting line — same density as its neighbours. */
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5">
            <span className="block text-sm font-bold text-[var(--ink)]">No policy published yet</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-[var(--muted)]">
              The public privacy page shows an <span className="font-semibold text-[var(--ink)]">unavailable</span>{" "}
              notice. Nothing in the draft below is visible outside this screen until you publish it.
            </span>
          </div>
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
            {/* `secondaryBtn`, NOT primaryBtn with the colours overridden.
                
                It was `${primaryBtn} bg-[var(--surface-2)] text-[var(--ink)]`, and that does not do
                what it reads like: Tailwind resolves competing utilities by CSS SOURCE order, not by
                the order they appear in the class string, so primaryBtn's `text-white` beat
                `text-[var(--ink)]`. The result was white text on a near-white surface — the button was
                on the page, focusable and clickable, and simply could not be seen.
                
                secondaryBtn exists for exactly this pairing (same height and radius as primary,
                outline style so the primary stays the obvious default) and has no colour to fight. */}
            <button
              type="button"
              onClick={runPreview}
              disabled={!draft.trim()}
              className={secondaryBtn}
              title={!draft.trim() ? "Write or paste a draft first." : "Render the draft exactly as the public page will"}
            >
              Preview
            </button>
            {canEdit && (
              <button type="button" onClick={save} disabled={saving || !dirty} className={primaryBtn}>
                {saving ? "Saving…" : "Save draft"}
              </button>
            )}
            {/* The only undo this screen has. Offered when the SAVED draft differs from the live
                policy — with nothing changed there is nothing to put back, and the server refuses it
                anyway. `policy.edit`, not `policy.publish`: undoing your own working copy is not an
                act of publication. */}
            {canEdit && hasUnpublishedChanges && (
              <button
                type="button"
                onClick={() => setDiscardOpen(true)}
                disabled={discarding}
                className={secondaryBtn}
                title="Replace the draft with the published policy. The published policy does not change."
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Discard draft
              </button>
            )}
            {canPublish && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                /* `!hasUnpublishedChanges` is the new half. Publishing text identical to the live
                   version mints a permanent version that says nothing, and versions cannot be
                   deleted — so the duplicate is forever. The SERVER refuses it too, inside the
                   publish transaction; this only saves the round trip and explains why. */
                disabled={publishing || dirty || !draft.trim() || !hasUnpublishedChanges}
                className={`${primaryBtn} inline-flex items-center gap-1.5`}
                title={
                  dirty
                    ? "Save the draft before publishing it."
                    : !hasUnpublishedChanges
                      ? "Nothing changed since the current published version."
                      : undefined
                }
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

      {/* SUPERSEDED versions only — never the live one.
          
          `history` is newest-first, so `history[0]` IS the published policy, and listing it here
          reprinted the "Published policy" card at the top of this screen line for line: same version,
          same timestamp, same author. Hiding the whole card at one version fixed that case and left
          it at two, because the duplicate row simply came back as soon as there was a list to show.
          
          Slicing it off fixes it at every count. The card above answers "what is live"; this one
          answers "what was live before", and the two never say the same thing. It also means no LIVE
          badge is needed — nothing in this list is live, by construction.
          
          Rendered only when something has actually been superseded. */}
      {policy && policy.history.length > 1 && (
        <SettingsCard
          title="Previous versions"
          desc="Superseded policies, newest first. Permanent records — kept so you can show what was live and when."
          icon={FileText}
        >
          <ul className="divide-y divide-[var(--border-2)] text-sm">
            {policy.history.slice(1).map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="font-bold text-[var(--ink)]">Version {v.version}</span>
                <span className="flex items-center gap-3">
                  <span className={hintCls}>
                    {new Date(v.publishedAt).toLocaleString("en-GB")}
                    {v.publishedBy ? ` · ${v.publishedBy}` : ""}
                  </span>
                  {/* READ ONLY, and fetched on demand. Without this the immutable history was a list
                      of dates whose content nothing in the product could show — the very question
                      keeping old versions exists to answer. Needs `policy.view` alone. */}
                  <button
                    type="button"
                    onClick={() => void viewVersion(v.id, v.version)}
                    className={`${secondaryBtn} !px-3 !py-1.5`}
                    title={`Read version ${v.version} as it was published`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}

      {/* Discard confirm. A confirm because it throws away work that is not recoverable, even though
          it cannot touch anything public — the copy says so plainly so the risk is not overstated. */}
      {discardOpen && policy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg"
            style={{ borderRadius: "var(--radius)" }}
          >
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Discard draft changes?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              The draft will be replaced with the currently published policy
              {policy.published ? ` (version ${policy.published.version})` : ""}. Anything written since
              then is lost.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              The published policy does not change, and no new version is created.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDiscardOpen(false)} className={secondaryBtn}>
                Cancel
              </button>
              <button type="button" onClick={discard} disabled={discarding} className={primaryBtn}>
                {discarding ? "Discarding…" : "Discard draft"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A published version, READ ONLY.
          
          Rendered through the same PolicyBlocks the public page uses, so what is shown is what was
          served. No editor, no save, no restore — the only controls are Close, because the entire
          value of an immutable record is that looking at it cannot change it. */}
      {viewing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
          <div
            className="my-8 flex max-h-[calc(100dvh-4rem)] w-full max-w-2xl flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-lg"
            style={{ borderRadius: "var(--radius)" }}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border-2)] p-5">
              <div className="min-w-0">
                <h3 className="text-sm font-extrabold text-[var(--ink)]">
                  Version {viewing.version}
                  <span className="ml-2 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                    Read only
                  </span>
                </h3>
                {viewing.detail && (
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Published {new Date(viewing.detail.publishedAt).toLocaleString("en-GB")}
                    {viewing.detail.publishedBy ? ` by ${viewing.detail.publishedBy}` : ""}
                    {viewing.detail.isCurrent ? " · currently live" : " · superseded"}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setViewing(null)}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {viewing.detail ? (
                <PolicyBlocks blocks={viewing.detail.blocks} />
              ) : (
                <p className="flex items-center gap-2 py-8 text-sm text-[var(--muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading version…
                </p>
              )}
            </div>
            {/* The viewer itself stays READ ONLY — this writes the DRAFT, never this version.
                Labelled for what it does: not "Restore", not "Make live", not "Revert", none of
                which would be true. Requires `policy.edit`; publishing remains separate and still
                needs `policy.publish`. */}
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-2)] p-5">
              {canEdit && viewing.detail && (
                <button
                  type="button"
                  onClick={copyToDraft}
                  disabled={copying}
                  className={secondaryBtn}
                  title="Replace the draft with this version's text. Nothing is published until you publish it."
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copying ? "Copying…" : "Copy to draft"}
                </button>
              )}
              <button type="button" onClick={() => setViewing(null)} className={primaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
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
              {/* Same fix as Preview: primaryBtn's `text-white` wins on CSS source order, so
                  overriding it in the class string left white text on a near-white surface. Worse
                  here than there — this is the CANCEL on an irreversible publish, so the way out of
                  the dialog was the control you could not see. */}
              <button type="button" onClick={() => setConfirmOpen(false)} className={secondaryBtn}>
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
