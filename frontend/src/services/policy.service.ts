import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import type { AdminPolicy, PolicyBlock, PublishedVersionDetail } from "@/types/policy";

// Typed wrappers around the /policies endpoints (admin side).
//
// The PUBLIC read is deliberately not here: the /privacy page fetches it on the server, so it
// renders with content on first paint and works for a signed-out visitor. See lib/policy.ts.

export function getPolicyForAdmin(): Promise<AdminPolicy> {
  return api<{ policy: AdminPolicy }>("/policies/privacy/admin").then((r) => r.policy);
}

/** Render unsaved editor content exactly as the public page would. Writes nothing. */
export function previewPolicy(body: string): Promise<PolicyBlock[]> {
  return api<{ blocks: PolicyBlock[] }>("/policies/privacy/preview", {
    method: "POST",
    body: { body },
  }).then((r) => r.blocks);
}

/**
 * Save the working copy. `expectedRevision` is the value the editor was loaded with — the server
 * rejects the write if anyone else saved in the meantime, so a stale tab cannot silently overwrite
 * someone's work.
 */
export function saveDraft(body: string, expectedRevision: number): Promise<AdminPolicy> {
  return api<{ policy: AdminPolicy }>("/policies/privacy/draft", {
    method: "PUT",
    body: { body, expectedRevision },
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.policy);
}

/**
 * Publish the draft as the live policy. Requires `policy.publish`, which is a different permission
 * from the one that saved it.
 */
export function publishPolicy(expectedRevision: number): Promise<AdminPolicy> {
  return api<{ policy: AdminPolicy }>("/policies/privacy/publish", {
    method: "POST",
    body: { expectedRevision },
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.policy);
}

/**
 * Read ONE published version, body included.
 *
 * A separate call rather than a `body` on every history row: the list is metadata, read on every
 * visit; the text is wanted occasionally and for one version at a time. Shipping every body with the
 * list would send every policy ever published on each page load to answer a question nobody asked.
 *
 * Requires `policy.view` only — reading what was published is not publishing.
 */
export function getPublishedVersion(id: string): Promise<PublishedVersionDetail> {
  return api<{ version: PublishedVersionDetail }>(`/policies/privacy/versions/${id}`).then((r) => r.version);
}

/**
 * Throw the working copy away and put the published text back.
 *
 * Carries `expectedRevision` for the same reason `saveDraft` does — a discard is a draft write, and
 * must not be the one way to silently overwrite an edit somebody else just saved.
 *
 * Cannot change what the public sees: the server writes `draftBody` and nothing else.
 */
export function discardDraft(expectedRevision: number): Promise<AdminPolicy> {
  return api<{ policy: AdminPolicy }>("/policies/privacy/draft/discard", {
    method: "POST",
    body: { expectedRevision },
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.policy);
}
