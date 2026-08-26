import { api } from "@/lib/api";

/**
 * The policy content model. Mirrors the web's `types/policy.ts`, which mirrors the backend's
 * `policy.content.ts` — the server parses the authored text into these blocks and every client only
 * ever RENDERS them, so there is one parser and no way for the three sides to disagree about what a
 * draft will look like once published.
 *
 * Every block carries TEXT. Nothing here is markup, and nothing downstream turns it into markup.
 */
export type PolicyBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/** What the PUBLIC endpoint returns. A `null` policy means nothing has been published. */
export interface PublicPolicy {
  version: number;
  publishedAt: string;
  blocks: PolicyBlock[];
}

/**
 * The PUBLISHED privacy notice — the one unauthenticated call in the app besides login and branding.
 *
 * Returned as the server's envelope rather than a bare `PublicPolicy | null` on purpose: the screen
 * has to tell "nothing has been published" apart from "this hasn't loaded", and a bare null collapses
 * those into the same value. `{ policy: null }` is a LOADED state.
 *
 * It also deliberately does NOT swallow failures the way the web's `fetchPublishedPolicy` does. The
 * web renders this during SSR with no way to retry, so one honest unavailable state is all it can
 * offer. A handset is the opposite case: it loses signal in a riser or a basement, and telling an
 * engineer "no privacy notice has been published" when the truth is "you have no bars" is both wrong
 * and unrecoverable — there is no retry on a message that claims to be the final answer. Letting the
 * ApiError through puts the failure in `useLoad`'s `error`, where pull-to-refresh fixes it.
 *
 * It cannot return draft text: the backend resolves this through PolicyVersion, so only published
 * content is reachable from this path.
 */
export function getPublishedPolicy(): Promise<{ policy: PublicPolicy | null }> {
  return api<{ policy: PublicPolicy | null }>("/policies/privacy");
}
