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
