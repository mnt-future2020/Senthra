// The policy content model. Mirrors backend `policy.content.ts` — the server parses the authored
// text into these blocks and the client only ever RENDERS them, so there is one parser and no way
// for the two sides to disagree about what a draft will look like once published.
//
// Every block carries TEXT. Nothing here is markup, and nothing downstream turns it into markup.
export type PolicyBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/** What the PUBLIC endpoint returns. `null` from the API means nothing has been published. */
export interface PublicPolicy {
  version: number;
  publishedAt: string;
  blocks: PolicyBlock[];
}

export interface PublishedVersionSummary {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
}

/** The management view: the working draft, what is live, and the history behind it. */
/**
 * One published version WITH its immutable body — the "View" read.
 *
 * Mirrors the backend's `PublishedVersionDetail`. Deliberately a separate shape from the summary the
 * history list uses: the body is fetched on demand, not shipped with every row.
 */
export interface PublishedVersionDetail extends PublishedVersionSummary {
  /** The immutable stored text, byte for byte. */
  body: string;
  /** Server-parsed, by the SAME parser the public page renders through — so what is shown is what
   *  was served. A second parser in the browser would be a second answer to the same question. */
  blocks: PolicyBlock[];
  /** True when this is the version /privacy is serving right now. */
  isCurrent: boolean;
}

export interface AdminPolicy {
  key: string;
  draftBody: string;
  /** The concurrency token. Every save and publish sends back the value it was given. */
  draftRevision: number;
  draftUpdatedAt: string | null;
  draftUpdatedBy: string | null;
  published: (PublishedVersionSummary & { body: string }) | null;
  hasUnpublishedChanges: boolean;
  history: PublishedVersionSummary[];
}
