"use client";

import * as React from "react";
import { Copy, Eye, FileText, Loader2, RotateCcw, Send } from "lucide-react";

import * as policyService from "@/services/policy.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { PolicyBlocks } from "@/components/policy/PolicyBlocks";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { inputCls, hintCls, primaryBtn, secondaryBtn } from "@/components/ui/styles";
import type { AdminPolicy, PolicyBlock, PublishedVersionDetail } from "@/types/policy";
import type { Msg } from "@/components/ui/types";

/**
 * The two cards this section ALWAYS renders, loaded or not.
 *
 * Declared once because both branches below use them. Their titles and descriptions are fixed
 * copy — nothing here depends on the request — which is the whole reason the loading state can show
 * the real thing rather than a grey rectangle where a heading will eventually be.
 *
 * Preview and Previous versions are deliberately absent: the first exists only once the user asks
 * for a preview, the second only once a version has been superseded. Neither is knowable while the
 * request is in flight, and a skeleton for a card that never arrives is a worse lie than no
 * skeleton at all.
 */
const ALWAYS_SHOWN_CARDS = {
  published: {
    title: "Published policy",
    desc: "What the public privacy notice shows today. Published versions are permanent and cannot be edited.",
    icon: FileText,
  },
  draft: {
    title: "Draft",
    desc: "The working copy. Saving it never changes the published policy — only Publish does that.",
    icon: FileText,
  },
} as const;

/**
 * The shape of this screen, before its content is known.
 *
 * Mirrors the real layout block for block — the status line, the tall draft textarea, the hint under
 * it, the two buttons — because a skeleton that does not match what replaces it is just a slower
 * spinner: the page still jumps, it simply jumps later.
 *
 * This replaced `if (loading) return <spinner>`, which collapsed all four cards into one line of
 * text and left the screen empty until the request landed.
 */
function LegalSkeleton({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  return (
    /* A skeleton is SILENT — it has no text for a screen reader to read. The spinner this replaced
       carried the visible words "Loading policy…", so swapping one for the other removed the only
       announcement this screen had and left a non-sighted user facing two apparently empty cards.

       Two attributes on two elements, and the sentence is the busy container's SIBLING, not its
       child:

         aria-busy   on the cards — the content still arriving.
         role=status on the sentence — a polite live region holding nothing but the words.

       `aria-busy` marks an element AND ITS WHOLE SUBTREE as mid-update, and screen readers that
       honour it (JAWS especially) hold back announcements anywhere inside. So the sentence must not
       be inside it. It took two attempts to get this right: first both attributes were on one
       element, which cancels them outright; then the sentence moved to its own element but stayed a
       child, which is still inside the busy subtree. Only a sibling is outside it.

       Where a screen reader does not announce a region that arrives with its text already in it,
       the sentence is still in the page, so moving through the section reads it out. */
    <div>
      <span role="status" className="sr-only">
        Loading the privacy policy…
      </span>
      <div className="space-y-6" aria-busy="true">
        <SettingsCard {...ALWAYS_SHOWN_CARDS.published}>
          {/* Sized for the PUBLISHED state: a version line and its timestamp.
            
              The card has a second, taller shape — the bordered "No policy published yet" strip,
              around 40px more — and no skeleton can match both, because which one renders is the very
              thing the request answers. Published wins because it is the steady state: once a policy
              is live every subsequent load shows it, while the unpublished strip belongs to a screen
              an install passes through once before launch. */}
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
        </SettingsCard>

        <SettingsCard {...ALWAYS_SHOWN_CARDS.draft}>
          {/* Rendered here too, because `canEdit` comes from the permission hook rather than the
              request — it is known before the first paint. Omitting it meant a read-only viewer
              watched a bordered banner appear on arrival and shove the entire draft card down, which
              is the exact jump this skeleton exists to prevent. */}
          {!canEdit && <ReadOnlyNotice />}
          <div className="space-y-3">
            {/* Same min-height as the real textarea, so the page below it does not move. */}
            <Skeleton className="min-h-[22rem] w-full" />
            <Skeleton className="h-3.5 w-full max-w-2xl" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
            {/* The buttons this viewer will actually get. Preview is everyone's; Save needs edit;
                Publish needs publish. All three are decided by permission, which is known before the
                request — so drawing a fixed two made one placeholder vanish for a view-only user and
                one appear for someone who can do both. (Discard is the exception: it depends on
                whether the draft differs from the live policy, which is exactly what is loading.) */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Skeleton className="h-9 w-24" />
              {canEdit && <Skeleton className="h-9 w-28" />}
              {canPublish && <Skeleton className="h-9 w-24" />}
            </div>
            {/* The real card explains to an editor who cannot publish why there is no Publish button.
                Also permission-driven, so also known in advance; leaving it out pushed the page down
                for that role the moment the data arrived. */}
            {canEdit && !canPublish && <Skeleton className="h-3.5 w-full max-w-xl" />}
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}

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
  /**
   * The version viewer's OWN error line. The page-level notice above sits behind the viewer's
   * backdrop, on a page whose scroll is locked while it is open, so an error sent there during a
   * copy was invisible: the button re-enabled and nothing else happened.
   */
  const [viewerMsg, setViewerMsg] = React.useState<Msg>(null);
  /**
   * Which "View" request the viewer is currently waiting on. Every open, and every close, takes a
   * new number; a response only lands if its number is still the current one. Without it, closing
   * the viewer during loading reopened it the moment the response arrived, and a slow earlier
   * version could replace one requested after it.
   */
  const viewRequest = React.useRef(0);

  const draftRef = React.useRef<HTMLTextAreaElement>(null);
  const publishedRef = React.useRef<HTMLDivElement>(null);
  /**
   * Somewhere to put focus once the next render has committed.
   *
   * A dialog hands focus back to the button that opened it. After a successful Discard that button
   * has been removed, and after a successful Publish it is disabled — so focus fell to the top of
   * the document and a keyboard or screen-reader user lost their place. The handlers name where it
   * should go instead; this runs it after the DOM it points at exists.
   *
   * Runs after the dialog's own clean-up, because React runs every effect clean-up in a commit
   * before any effect body — so this is the last word, not a race.
   */
  const afterCommit = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const run = afterCommit.current;
    afterCommit.current = null;
    run?.();
  });

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
      // The draft is what just changed — and discarding needs `policy.edit`, so it is editable.
      afterCommit.current = () => draftRef.current?.focus();
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
    setViewerMsg(null);
    try {
      const updated = await policyService.saveDraft(viewing.detail.body, policy.draftRevision);
      setPolicy(updated);
      setDraft(updated.draftBody);
      setPreview(null);
      const from = viewing.version;
      closeViewer();
      // Says what happened AND what has not: publishing stays a separate, deliberate act.
      pushToast(`Draft now holds version ${from}. Review it, then publish to make it live.`, "success");
    } catch (e) {
      // Into the viewer, which is still open and is where the user is looking.
      setViewerMsg({ type: "error", text: e instanceof Error ? e.message : "Could not copy that version into the draft." });
    } finally {
      setCopying(false);
    }
  };

  /** Fetch one historical body on demand — never shipped with the history list. */
  const viewVersion = async (id: string, version: number) => {
    const ticket = ++viewRequest.current;
    setViewerMsg(null);
    setViewing({ version, detail: null });
    try {
      const detail = await policyService.getPublishedVersion(id);
      // Closed, or another version asked for, while this was in flight: the user has moved on.
      if (ticket !== viewRequest.current) return;
      setViewing({ version, detail });
    } catch (e) {
      if (ticket !== viewRequest.current) return;
      setViewing(null);
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not load that version." });
    }
  };

  /** The ONE way the viewer closes — Escape, backdrop, X, Close and a finished copy all use it. */
  const closeViewer = () => {
    viewRequest.current += 1; // anything still loading is now stale
    setViewing(null);
    setViewerMsg(null);
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
      // The new live version — not the draft: Publish needs only `policy.publish`, and for someone
      // without `policy.edit` the draft is disabled and cannot take focus at all.
      afterCommit.current = () => publishedRef.current?.focus();
      pushToast(`Published version ${updated.published?.version}.`, "success");
    } catch (e) {
      setConfirmOpen(false);
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Could not publish." });
    } finally {
      setPublishing(false);
    }
  };

  if (loading) return <LegalSkeleton canEdit={canEdit} canPublish={canPublish} />;

  const published = policy?.published ?? null;

  return (
    <div className="space-y-6">
      <Notice msg={msg} />

      <SettingsCard {...ALWAYS_SHOWN_CARDS.published}>
        {published ? (
          /* Focusable from script only (tabIndex -1): where focus goes after a publish, so a
             keyboard user lands on the version they just made live. Not a tab stop.

             The ring is the app's own custom-focus style — `outline-2 outline-offset-2` in the
             accent colour, the same classes RoleForm and PurchaseRequestDetail use — shown only for
             keyboard users (`focus-visible`), never after a mouse click.

             `p-2 -m-2` is what lets it match. Those other rings sit around PADDED buttons, so they
             clear the text by the button's own padding. This block has none, and the browser's
             default ring was drawn hard against the letters, square-cornered, with the second line
             touching its bottom edge. The padding gives the ring room; the equal negative margin
             cancels it, so the text itself does not move by a pixel. */
          <div
            ref={publishedRef}
            tabIndex={-1}
            className="-m-2 space-y-3 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
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

      <SettingsCard {...ALWAYS_SHOWN_CARDS.draft}>
        {!canEdit && <ReadOnlyNotice />}
        <div className="space-y-3">
          <textarea
            ref={draftRef}
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

      {/* THE THREE DIALOGS ON THIS SCREEN USE THE APP'S OWN — ConfirmDialog and Modal.

          They were hand-built overlays: a fixed <div> with a panel in it. They looked like dialogs
          and were not ones. No role="dialog", so a screen reader was never told one had opened. No
          Escape. No focus management, so focus stayed on the page button BEHIND the overlay and Tab
          walked out through controls nobody could see. And Cancel stayed live while the action ran,
          so it could "cancel" a publish that was already minting a permanent version.

          The shared components already solve every one of those, and every other dialog in the app
          inherits the fixes from them. Hand-rolling a third copy here is how a screen ends up the
          one place those fixes never reached.

          Discard is `danger`: it throws away draft work that cannot be recovered. Publish is NOT —
          it is permanent, but it is the action this screen exists for, and painting the intended
          outcome red would tell people it is the wrong thing to do. */}
      <ConfirmDialog
        open={discardOpen && policy !== null}
        danger
        busy={discarding}
        title="Discard draft changes?"
        confirmLabel={discarding ? "Discarding…" : "Discard draft"}
        message={
          <>
            {/* A confirm because the work is unrecoverable, even though nothing public is touched —
                so the copy says both, and the risk is neither hidden nor overstated. */}
            <p>
              The draft will be replaced with the currently published policy
              {policy?.published ? ` (version ${policy.published.version})` : ""}. Anything written since
              then is lost.
            </p>
            <p className="mt-2">The published policy does not change, and no new version is created.</p>
          </>
        }
        onConfirm={() => void discard()}
        onClose={() => setDiscardOpen(false)}
      />

      {/* A published version, READ ONLY.
          
          Rendered through the same PolicyBlocks the public page uses, so what is shown is what was
          served. No editor, no save, no restore — the only controls are Close, because the entire
          value of an immutable record is that looking at it cannot change it. */}
      {/* Modal rather than ConfirmDialog: this is a document to READ, not a question to answer.
          `scrollBody` keeps the header and footer fixed while a long policy scrolls between them,
          which is the layout the hand-built version drew for itself.

          "Read only" moves from a pill beside the title into the subtitle, because Modal's title
          is plain text. It is still the first thing under the heading, and still always visible.

          `busy` locks every way out while Copy to draft runs — Escape, backdrop AND the header X,
          which Modal now renders disabled. The older `onClose={busy ? () => {} : onClose}` shape
          left that X enabled and silently inert beside a visibly disabled Close. */}
      <Modal
        open={viewing !== null}
        title={viewing ? `Version ${viewing.version}` : ""}
        subtitle={
          viewing?.detail
            ? `Read only · Published ${new Date(viewing.detail.publishedAt).toLocaleString("en-GB")}` +
              (viewing.detail.publishedBy ? ` by ${viewing.detail.publishedBy}` : "") +
              (viewing.detail.isCurrent ? " · currently live" : " · superseded")
            : "Read only"
        }
        onClose={closeViewer}
        busy={copying}
        scrollBody
        footer={
          /* The error sits in the FOOTER, directly above the button that caused it. The footer stays
             fixed while the body scrolls, so it is visible however far down the policy the user
             has read — the top of the body would not be. */
          <div className="flex w-full flex-col gap-3">
            <Notice msg={viewerMsg} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* The viewer itself stays READ ONLY — this writes the DRAFT, never this version.
                  Labelled for what it does: not "Restore", not "Make live", not "Revert", none of
                  which would be true. Requires `policy.edit`; publishing remains separate and
                  still needs `policy.publish`. */}
              {canEdit && viewing?.detail && (
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
              <button type="button" onClick={closeViewer} disabled={copying} className={primaryBtn}>
                Close
              </button>
            </div>
          </div>
        }
      >
        {viewing?.detail ? (
          <PolicyBlocks blocks={viewing.detail.blocks} />
        ) : (
          <p className="flex items-center gap-2 py-8 text-sm text-[var(--muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading version…
          </p>
        )}
      </Modal>

      {/* `busy` locks the dialog for the length of the request: Escape, the backdrop and Cancel
          all stop working. Once a permanent version is being minted there is nothing left to
          cancel — closing would only hide the outcome and invite a second click on Publish. */}
      <ConfirmDialog
        open={confirmOpen}
        busy={publishing}
        title="Publish this policy?"
        confirmLabel={publishing ? "Publishing…" : "Publish"}
        message={
          <>
            <p>
              This saves a permanent version {(published?.version ?? 0) + 1} and makes it the policy
              shown at <code>/privacy</code>. Published versions cannot be edited or deleted.
            </p>
            <p className="mt-2">
              The page stays hidden from search engines and unlinked from the sign-in screen until
              those are switched on separately.
            </p>
          </>
        }
        onConfirm={() => void publish()}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}
