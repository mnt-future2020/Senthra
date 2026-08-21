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
