import { withTransactionRetry } from "../../lib/prisma.js";
import { conflict, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

import * as policyRepo from "./policy.repository.js";
import { PRIVACY_POLICY_KEY } from "./policy.repository.js";
import { parsePolicyBody, type PolicyBlock } from "./policy.content.js";

export { PRIVACY_POLICY_KEY };

// --- public read ---------------------------------------------------------------------------------

/** What a PUBLIC reader receives. `published: null` is the honest answer when nothing is published. */
export interface PublicPolicy {
  version: number;
  publishedAt: string;
  blocks: PolicyBlock[];
}

/**
 * The published policy, for the unauthenticated endpoint.
 *
 * Reads PolicyVersion, never PolicyDocument.draftBody — the draft is not merely filtered out here,
 * it is in a row this function does not load. Nothing published returns null and the caller shows an
 * unavailable state; there is no fallback to the draft, because a draft that renders publicly is
 * exactly the failure this whole design exists to prevent.
 *
 * The response carries BLOCKS, not the raw body. The parse happens here so the public page and the
 * admin preview render identical structures, and so the client never holds parsing logic that could
 * drift from this one.
 */
export async function getPublishedPolicy(key = PRIVACY_POLICY_KEY): Promise<PublicPolicy | null> {
  const version = await policyRepo.findPublishedVersion(key);
  if (!version) return null;
  return {
    version: version.version,
    publishedAt: version.publishedAt.toISOString(),
    blocks: parsePolicyBody(version.body),
  };
}

// --- admin read ----------------------------------------------------------------------------------

export interface PublishedVersionSummary {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
}

export interface AdminPolicy {
  key: string;
  draftBody: string;
  /** The token an edit or a publish must carry back. See saveDraft / publish. */
  draftRevision: number;
  draftUpdatedAt: string | null;
  draftUpdatedBy: string | null;
  /** Null until something is published. */
  published: (PublishedVersionSummary & { body: string }) | null;
  /** True when the draft differs from what is live — what the UI calls "unpublished changes". */
  hasUnpublishedChanges: boolean;
  history: PublishedVersionSummary[];
}

const summarise = (v: {
  id: string;
  version: number;
  publishedAt: Date;
  publishedBy: string | null;
}): PublishedVersionSummary => ({
  id: v.id,
  version: v.version,
  publishedAt: v.publishedAt.toISOString(),
  publishedBy: v.publishedBy,
});

/**
 * Everything the management screen needs, in one read.
 *
 * The lifecycle STATE is derived here rather than stored: an enum column would be a second source of
 * truth that a failed write could leave disagreeing with the rows themselves. "Published with
 * unpublished changes" is simply draft ≠ published body.
 */
export async function getPolicyForAdmin(key = PRIVACY_POLICY_KEY): Promise<AdminPolicy> {
  const doc = await policyRepo.findDocument(key);
  if (!doc) throw notFound("Policy document not found.");

  const published = doc.publishedVersionId
    ? await policyRepo.findVersionById(doc.publishedVersionId)
    : null;
  const history = await policyRepo.listVersions(key);

  return {
    key: doc.key,
    draftBody: doc.draftBody,
    draftRevision: doc.draftRevision,
    draftUpdatedAt: doc.draftUpdatedAt?.toISOString() ?? null,
    draftUpdatedBy: doc.draftUpdatedBy,
    published: published ? { ...summarise(published), body: published.body } : null,
    hasUnpublishedChanges: (published?.body ?? "") !== doc.draftBody,
    history: history.map(summarise),
  };
}

/** One published version, with its body — the read behind "View" in Previous versions. */
export interface PublishedVersionDetail extends PublishedVersionSummary {
  /** The immutable stored text, byte for byte. */
  body: string;
  /**
   * The same text parsed by the SAME parser the public page renders through.
   *
   * Returned from the server rather than parsed in the browser so a historical version is displayed
   * exactly as it was served — a second parser on the client would be a second answer to "what does
   * this document look like", and the whole point of reading an archived version is fidelity.
   */
  blocks: PolicyBlock[];
  /** True when this is the version `/privacy` is serving right now. */
  isCurrent: boolean;
}

/**
 * Read ONE published version, including its immutable body.
 *
 * A separate call rather than a `body` on every row of `history`: the list is metadata and is read on
 * every visit to the settings screen, while the text is wanted occasionally and for one version at a
 * time. Putting the bodies in the list would send every policy this company has ever published on
 * each page load to answer a question nobody asked yet.
 *
 * Gated on `policy.view` at the route — the same right that already shows the history it belongs to.
 * Deliberately NOT `policy.publish`: reading what was published is not publishing.
 *
 * This function performs no write of any kind, and there is no update or delete on PolicyVersion in
 * the repository for it to reach even by mistake.
 */
export async function getPublishedVersion(
  id: string,
  key = PRIVACY_POLICY_KEY,
): Promise<PublishedVersionDetail> {
  const version = await policyRepo.findVersionForDocument(key, id);
  if (!version) throw notFound("That policy version does not exist.");

  const doc = await policyRepo.findDocument(key);
  return {
    ...summarise(version),
    body: version.body,
    blocks: parsePolicyBody(version.body),
    isCurrent: doc?.publishedVersionId === version.id,
  };
}

/** Render an arbitrary body to blocks — the editor's preview, before anything is saved. */
export function previewBody(body: string): PolicyBlock[] {
  return parsePolicyBody(body);
}

// --- draft write ---------------------------------------------------------------------------------

/**
 * Save the draft. Touches `draftBody` and nothing else — no published version is reachable from
 * here, which is what makes "editing never changes what the public sees" structural rather than
 * careful.
 */
export async function saveDraft(
  body: string,
  expectedRevision: number,
  actor?: AuditActor,
  key = PRIVACY_POLICY_KEY,
): Promise<AdminPolicy> {
  const doc = await policyRepo.findDocument(key);
  if (!doc) throw notFound("Policy document not found.");

  const count = await policyRepo.saveDraftIfUnchanged(
    key,
    expectedRevision,
    body,
    actor?.email ?? null,
  );
  if (count === 0) {
    throw conflict("This draft was changed by someone else. Reload before saving again.");
  }

  audit.record({
    actor,
    action: "policy.draft_saved",
    targetType: "policy",
    targetId: doc.id,
    targetLabel: key,
    // The body is NOT recorded: the working copy lives on the document and every published copy
    // lives on its version, so putting it here would be a third store of the same text.
    metadata: { revision: expectedRevision + 1 },
  });

  return getPolicyForAdmin(key);
}

/**
 * Throw away the working copy and put the PUBLISHED text back in the draft.
 *
 * The only "undo" this screen has. Without it a mistaken edit is unrecoverable except by retyping the
 * live policy from the version beside it, which is both tedious and a fresh chance to introduce a
 * difference nobody intended.
 *
 * Implemented as an ordinary draft write, deliberately:
 *
 *   • it goes through `saveDraftIfUnchanged`, so it carries the SAME revision guard every other draft
 *     write has — a discard cannot silently clobber an edit somebody else saved a second earlier;
 *   • it touches `draftBody` and nothing else. No version is created, no version is modified, and the
 *     document's `publishedVersionId` is not reachable from here. What the public sees is untouched
 *     by construction rather than by intent.
 *
 * With NOTHING published, the target is the empty string — the draft's own starting state, and what
 * `hasUnpublishedChanges` already compares against (`published?.body ?? ""`). That is the existing
 * empty-draft semantic, not a new lifecycle: discarding before a first publish clears the draft.
 *
 * Requires `policy.edit`, not `policy.publish`: this is an edit to the working copy.
 */
export async function discardDraft(
  expectedRevision: number,
  actor?: AuditActor,
  key = PRIVACY_POLICY_KEY,
): Promise<AdminPolicy> {
  const doc = await policyRepo.findDocument(key);
  if (!doc) throw notFound("Policy document not found.");

  const published = doc.publishedVersionId
    ? await policyRepo.findVersionById(doc.publishedVersionId)
    : null;
  const target = published?.body ?? "";

  // Nothing to discard. Refused rather than treated as a no-op success, so the UI cannot report that
  // it undid something it did not: the same equality `hasUnpublishedChanges` is derived from.
  if (doc.draftBody === target) {
    throw conflict("There is nothing to discard — the draft already matches the published policy.");
  }

  const count = await policyRepo.saveDraftIfUnchanged(key, expectedRevision, target, actor?.email ?? null);
  if (count === 0) {
    throw conflict("This draft was changed by someone else. Reload before discarding.");
  }

  audit.record({
    actor,
    action: "policy.draft_discarded",
    targetType: "policy",
    targetId: doc.id,
    targetLabel: key,
    // Version restored TO, never the text — same rule as draft_saved. `null` means the draft was
    // cleared because nothing has been published yet.
    metadata: { revision: expectedRevision + 1, restoredToVersion: published?.version ?? null },
  });

  return getPolicyForAdmin(key);
}

// --- publish -------------------------------------------------------------------------------------

/**
 * Publish the current draft as a new immutable version.
 *
 * Atomic, and the atomicity is the point: creating the version and repointing the document must not
 * be separable, or a crash between them leaves either a version nothing points at or a pointer to
 * nothing. `withTransactionRetry` (not plain `withTransaction`) because two concurrent publishes
 * DELIBERATELY converge on the document row — Mongo aborts the loser with a write conflict and the
 * helper replays it against committed state, where it allocates the next number instead of reusing
 * one. The `@@unique([documentKey, version])` index stands behind that as a hard backstop.
 *
 * `expectedRevision` guards the other race: publishing what you reviewed, not what someone saved
 * while you were reading it.
 *
 * The audit record is written AFTER the transaction, deliberately — the transaction body can run
 * more than once on replay, and an audit trail that double-counts a single publish is worse than
 * none.
 */
export async function publishDraft(
  expectedRevision: number,
  actor?: AuditActor,
  key = PRIVACY_POLICY_KEY,
): Promise<AdminPolicy> {
  const result = await withTransactionRetry(async (tx) => {
    const doc = await policyRepo.findDocumentTx(tx, key);
    if (!doc) throw notFound("Policy document not found.");

    if (doc.draftRevision !== expectedRevision) {
      throw conflict("This draft was changed by someone else. Reload before publishing.");
    }
    if (!doc.draftBody.trim()) {
      throw conflict("There is nothing to publish — the draft is empty.");
    }

    // Republishing byte-identical text would mint a permanent version that says nothing, and because
    // versions are immutable by design there is no way to take it back — the one case where "no
    // delete" stops being purely protective.
    //
    // Checked INSIDE the transaction, against the row this transaction read. A check before the
    // transaction would be a read that another publish could invalidate before this one commits; here
    // the same snapshot that allocates the version number decides whether there should be one, and a
    // loser is aborted and replayed by `withTransactionRetry` against the committed state — where it
    // now sees the identical body and refuses. That is what makes a concurrent double-publish of the
    // same content impossible rather than unlikely.
    //
    // EXACT equality, matching `hasUnpublishedChanges` — the codebase's one comparison rule for this.
    // Nothing is trimmed or normalised: whitespace is meaningful in this content model (a blank line
    // starts a paragraph, a leading `#` makes a heading), so text differing only in whitespace is a
    // different document and is allowed to publish.
    if (doc.publishedVersionId) {
      const current = await policyRepo.findVersionByIdTx(tx, doc.publishedVersionId);
      if (current && current.body === doc.draftBody) {
        throw conflict("Nothing changed since the current published version.");
      }
    }

    const version = doc.lastPublishedVersion + 1;
    const created = await policyRepo.createVersionTx(tx, {
      documentKey: key,
      version,
      body: doc.draftBody,
      publishedById: actor?.id ?? null,
      publishedBy: actor?.email ?? null,
    });
    await policyRepo.setPublishedVersionTx(tx, key, created.id, version);

    return { documentId: doc.id, versionId: created.id, version, previousVersion: doc.lastPublishedVersion };
  });

  audit.record({
    actor,
    action: "policy.published",
    targetType: "policy",
    targetId: result.versionId,
    targetLabel: key,
    // Version numbers, not content: the text is already immutable on the version row this points at.
    metadata: {
      version: result.version,
      previousVersion: result.previousVersion || null,
      documentId: result.documentId,
    },
  });

  return getPolicyForAdmin(key);
}
