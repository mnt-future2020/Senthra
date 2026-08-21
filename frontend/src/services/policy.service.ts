import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import type { AdminPolicy, PolicyBlock } from "@/types/policy";

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
