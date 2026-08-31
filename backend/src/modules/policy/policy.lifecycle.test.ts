import { beforeEach, describe, expect, it, vi } from "vitest";

// The three operations added to round out the policy lifecycle: reading one historical version,
// discarding the working copy, and refusing to republish text that has not changed.
//
// Same harness as policy.service.test.ts — repository, audit and the transaction helper mocked, so
// what is under test is the SERVICE's rules rather than Prisma.
vi.mock("./policy.repository.js", () => ({
  PRIVACY_POLICY_KEY: "privacy_policy",
  findDocument: vi.fn(),
  ensureDocument: vi.fn(),
  saveDraftIfUnchanged: vi.fn(),
  findDocumentTx: vi.fn(),
  createVersionTx: vi.fn(),
  setPublishedVersionTx: vi.fn(),
  findVersionById: vi.fn(),
  findVersionByIdTx: vi.fn(),
  findVersionForDocument: vi.fn(),
  findPublishedVersion: vi.fn(),
  listVersions: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

// The publish transaction reads the CURRENT version to reject an identical republish. That read is
// `policyRepo.findVersionByIdTx` — a REPOSITORY call, so the transaction client is opaque here and
// the test controls the repository instead of impersonating a Prisma client. Previously this mock
// had to fake a `{ policyVersion: { findUnique } }` shape, which meant the test knew what table the
// service touched: exactly the coupling the repository layer exists to remove.
const TX = vi.hoisted(() => Symbol("tx"));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransactionRetry: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
}));

import * as policyRepo from "./policy.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { withTransactionRetry } from "../../lib/prisma.js";
import { discardDraft, getPublishedVersion, publishDraft, saveDraft } from "./policy.service.js";

const KEY = "privacy_policy";
const DOC_ID = "d".repeat(24);
const VERSION_ID = "v".repeat(24);
const actor = { id: "u".repeat(24), email: "admin@x.com", type: "user" as const, permissions: [] };

const PUBLISHED_BODY = "# Published\n\nThis is the live policy.";
const DRAFT_BODY = "# Draft\n\nThis text is NOT live yet.";

const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  key: KEY,
  draftBody: DRAFT_BODY,
  draftRevision: 4,
  draftUpdatedAt: new Date("2026-08-01T00:00:00Z"),
  draftUpdatedBy: "editor@x.com",
  publishedVersionId: null as string | null,
  lastPublishedVersion: 0,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  ...over,
});

const version = (over: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  documentKey: KEY,
  version: 1,
  body: PUBLISHED_BODY,
  publishedAt: new Date("2026-08-02T00:00:00Z"),
  publishedById: actor.id,
  publishedBy: actor.email,
  ...over,
});

const mockFindDoc = policyRepo.findDocument as ReturnType<typeof vi.fn>;
const mockFindDocTx = policyRepo.findDocumentTx as ReturnType<typeof vi.fn>;
const mockSaveDraft = policyRepo.saveDraftIfUnchanged as ReturnType<typeof vi.fn>;
const mockCreateVersion = policyRepo.createVersionTx as ReturnType<typeof vi.fn>;
const mockSetPublished = policyRepo.setPublishedVersionTx as ReturnType<typeof vi.fn>;
const mockFindVersionById = policyRepo.findVersionById as ReturnType<typeof vi.fn>;
const mockFindVersionForDoc = policyRepo.findVersionForDocument as ReturnType<typeof vi.fn>;
const mockListVersions = policyRepo.listVersions as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

/** A document with `live` published, for the cases that need something to compare against. */
const live = version({ id: VERSION_ID, version: 2, body: PUBLISHED_BODY });
const publishedDoc = (over: Record<string, unknown> = {}) =>
  doc({ publishedVersionId: live.id, lastPublishedVersion: 2, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDoc.mockResolvedValue(doc());
  mockFindDocTx.mockResolvedValue(doc());
  mockSaveDraft.mockResolvedValue(1);
  mockCreateVersion.mockImplementation((_tx: unknown, data: Record<string, unknown>) =>
    Promise.resolve(version({ ...data, id: `v${String(data.version).padStart(23, "0")}` })),
  );
  mockSetPublished.mockResolvedValue(doc());
  mockFindVersionById.mockResolvedValue(null);
  mockFindVersionForDoc.mockResolvedValue(null);
  mockListVersions.mockResolvedValue([]);
  vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(null); // nothing published by default
});

// ── Reading ONE published version ─────────────────────────────────────────────────────────────
//
// The history list carries metadata only — version, date, author — so nothing in the product could
// answer "what did Version 1 actually say?". That is the question immutable versions exist to
// answer, so being unable to ask it made the guarantee unusable rather than wrong.
describe("getPublishedVersion", () => {
  it("returns the body EXACTLY as it was published", async () => {
    const stored = "# V1\n\n  indented   spacing  kept\n\n\n- bullet";
    mockFindVersionForDoc.mockResolvedValue(version({ version: 1, body: stored }));

    const v = await getPublishedVersion(VERSION_ID);

    // Byte-for-byte. A view that normalised whitespace would show a document that was never
    // published, which defeats the point of reading the historical record at all.
    expect(v.body).toBe(stored);
    expect(v.version).toBe(1);
    expect(v.publishedBy).toBe(actor.email);
  });

  // An id alone would let a caller authorised for one policy read another policy's version.
  it("scopes the lookup to the document, not the id alone", async () => {
    mockFindVersionForDoc.mockResolvedValue(version());
    await getPublishedVersion(VERSION_ID);
    expect(mockFindVersionForDoc).toHaveBeenCalledWith(KEY, VERSION_ID);
  });

  it("marks the version that is currently live", async () => {
    mockFindVersionForDoc.mockResolvedValue(live);
    mockFindDoc.mockResolvedValue(publishedDoc());
    expect((await getPublishedVersion(live.id)).isCurrent).toBe(true);
  });

  it("does not mark a superseded version as live", async () => {
    mockFindVersionForDoc.mockResolvedValue(version({ id: "older", version: 1 }));
    mockFindDoc.mockResolvedValue(publishedDoc());
    expect((await getPublishedVersion("older")).isCurrent).toBe(false);
  });

  it("404s on a version that does not exist", async () => {
    mockFindVersionForDoc.mockResolvedValue(null);
    await expect(getPublishedVersion("nope")).rejects.toThrow(/does not exist/i);
  });

  // THE property of a read: nothing about it may touch a row.
  it("writes nothing at all", async () => {
    mockFindVersionForDoc.mockResolvedValue(version());
    await getPublishedVersion(VERSION_ID);
    expect(mockSaveDraft).not.toHaveBeenCalled();
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
    expect(withTransactionRetry).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// ── Discarding the draft ──────────────────────────────────────────────────────────────────────
//
// The screen's only undo. Its entire risk is reaching a published version, so most of what is
// asserted here is what it does NOT do.
describe("discardDraft", () => {
  const withPublished = (over: Record<string, unknown> = {}) => {
    mockFindDoc.mockResolvedValue(publishedDoc(over));
    mockFindVersionById.mockResolvedValue(live);
  };

  it("puts the PUBLISHED body back into the draft", async () => {
    withPublished();
    await discardDraft(4, actor);
    expect(mockSaveDraft).toHaveBeenCalledWith(KEY, 4, PUBLISHED_BODY, actor.email);
  });

  it("carries the revision guard, so it cannot clobber a concurrent save", async () => {
    withPublished();
    mockSaveDraft.mockResolvedValue(0); // somebody else moved the revision
    await expect(discardDraft(4, actor)).rejects.toThrow(/changed by someone else/i);
  });

  // The same equality `hasUnpublishedChanges` is derived from. Refused rather than a no-op success,
  // so the UI cannot report that it undid something it did not.
  it("refuses when there is nothing to discard", async () => {
    withPublished({ draftBody: PUBLISHED_BODY });
    await expect(discardDraft(4, actor)).rejects.toThrow(/nothing to discard/i);
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  // With nothing published the target is "" — the draft's own starting state, and what
  // `hasUnpublishedChanges` already compares against. Existing semantics, not a new lifecycle.
  it("clears the draft when nothing has ever been published", async () => {
    await discardDraft(4, actor);
    expect(mockSaveDraft).toHaveBeenCalledWith(KEY, 4, "", actor.email);
  });

  it("NEVER creates or repoints a published version", async () => {
    withPublished();
    await discardDraft(4, actor);
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
    expect(withTransactionRetry).not.toHaveBeenCalled();
  });

  it("audits the discard, recording the version restored TO and never the text", async () => {
    withPublished();
    await discardDraft(4, actor);
    const entry = mockAudit.mock.calls.at(-1)![0];
    expect(entry.action).toBe("policy.draft_discarded");
    expect(entry.metadata).toMatchObject({ revision: 5, restoredToVersion: 2 });
    expect(JSON.stringify(entry)).not.toContain(PUBLISHED_BODY);
  });

  it("records a null restore target when nothing was published", async () => {
    await discardDraft(4, actor);
    expect(mockAudit.mock.calls.at(-1)![0].metadata).toMatchObject({ restoredToVersion: null });
  });
});

// ── Republishing identical text ───────────────────────────────────────────────────────────────
//
// Versions are immutable and undeletable, so a duplicate is permanent noise nobody can tidy away —
// the one case where "no delete" stops being purely protective.
describe("publishDraft refuses an identical republish", () => {
  const identicalDraft = () => {
    mockFindDocTx.mockResolvedValue(publishedDoc({ draftBody: PUBLISHED_BODY }));
    vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(live);
  };

  it("rejects a draft byte-identical to the current published version", async () => {
    identicalDraft();
    await expect(publishDraft(4, actor)).rejects.toThrow(/Nothing changed since the current published version/i);
  });

  it("does not allocate a version number, write, or audit when it refuses", async () => {
    identicalDraft();
    await expect(publishDraft(4, actor)).rejects.toThrow();
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("leaves the existing published version untouched", async () => {
    identicalDraft();
    await expect(publishDraft(4, actor)).rejects.toThrow();
    expect(live.body).toBe(PUBLISHED_BODY);
    expect(live.version).toBe(2);
  });

  it("still publishes a draft that DIFFERS", async () => {
    mockFindDocTx.mockResolvedValue(publishedDoc({ draftBody: DRAFT_BODY }));
    vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(live);

    await expect(publishDraft(4, actor)).resolves.toBeDefined();
    expect(mockCreateVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: 3, body: DRAFT_BODY }),
    );
  });

  // Whitespace is MEANINGFUL in this content model — a blank line starts a paragraph, a leading `#`
  // is a heading — so text differing only in whitespace is a different document. Exact equality,
  // matching `hasUnpublishedChanges`, is the correct rule here and not an oversight.
  it("treats a whitespace-only difference as a real change", async () => {
    mockFindDocTx.mockResolvedValue(publishedDoc({ draftBody: `${PUBLISHED_BODY}\n` }));
    vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(live);
    await expect(publishDraft(4, actor)).resolves.toBeDefined();
  });

  // The guard reads through `tx`, so a racing publish that committed first is visible on the replay
  // `withTransactionRetry` performs — which is what makes a concurrent duplicate impossible rather
  // than unlikely.
  it("checks INSIDE the transaction, against the transaction's own snapshot", async () => {
    identicalDraft();
    await expect(publishDraft(4, actor)).rejects.toThrow();
    expect(policyRepo.findVersionByIdTx).toHaveBeenCalledWith(TX, live.id);
  });

  it("publishes a first version normally when nothing is published yet", async () => {
    await expect(publishDraft(4, actor)).resolves.toBeDefined();
    expect(mockCreateVersion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ version: 1 }));
  });

  // The empty-draft refusal predates this guard and must survive it.
  it("still refuses an empty draft", async () => {
    mockFindDocTx.mockResolvedValue(publishedDoc({ draftBody: "   " }));
    await expect(publishDraft(4, actor)).rejects.toThrow(/nothing to publish/i);
  });
});

// ── Copying a historical version into the draft ───────────────────────────────────────────────
//
// The only safe way to reuse an old policy. Repointing the live version at an old row would put the
// same version number in two periods of the timeline and "what was live on the 26th?" would stop
// having one answer — so the old TEXT becomes a new draft, is reviewed, and is published as a NEW
// version.
//
// There is no copy endpoint and there should not be one: copying to the draft IS saving the draft,
// so it runs through `saveDraft` and inherits its permission gate, revision guard and audit entry.
// These tests pin that the historical body survives that path unchanged and that nothing else moves.
describe("copying a historical version into the draft", () => {
  // Every structural marker the parser depends on, plus the whitespace that carries meaning.
  const HISTORICAL = "# Heading one\n\n- bullet one\n- bullet two\n\n\nA paragraph with  double  spaces.\n\n## Sub heading\n   indented line\n";

  it("writes the historical body into the draft, byte for byte", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    await saveDraft(HISTORICAL, 4, actor);
    expect(mockSaveDraft).toHaveBeenCalledWith(KEY, 4, HISTORICAL, actor.email);
  });

  it("preserves heading markers, list markers, blank lines and indentation", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    await saveDraft(HISTORICAL, 4, actor);
    const written = mockSaveDraft.mock.calls[0]![2] as string;

    expect(written).toBe(HISTORICAL);              // the whole point: nothing normalised
    expect(written).toContain("# Heading one");    // heading marker intact
    expect(written).toContain("## Sub heading");
    expect(written).toContain("- bullet one");     // list markers intact
    expect(written).toContain("\n\n\n");           // consecutive blank lines intact
    expect(written).toContain("  double  spaces"); // internal whitespace intact
    expect(written).toContain("   indented line"); // leading whitespace intact
    expect(written.endsWith("\n")).toBe(true);     // trailing newline intact
  });

  it("creates NO published version and does not repoint the live one", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    await saveDraft(HISTORICAL, 4, actor);
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
    expect(withTransactionRetry).not.toHaveBeenCalled();
  });

  it("leaves the historical version and the live version untouched", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    const before = { ...live };
    await saveDraft(HISTORICAL, 4, actor);
    expect(live).toEqual(before);
    // Nothing in this path can even reach a version row: no version write is mocked as called.
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it("does not publish — that stays a separate act", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    await saveDraft(HISTORICAL, 4, actor);
    expect(mockAudit.mock.calls.map((c) => c[0].action)).not.toContain("policy.published");
  });

  it("rejects a stale revision instead of overwriting a newer edit", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    mockSaveDraft.mockResolvedValue(0); // somebody saved while the viewer was open
    await expect(saveDraft(HISTORICAL, 4, actor)).rejects.toThrow(/changed by someone else/i);
  });

  it("audits it as an ordinary draft save, recording no policy text", async () => {
    mockFindDoc.mockResolvedValue(publishedDoc());
    await saveDraft(HISTORICAL, 4, actor);
    const entry = mockAudit.mock.calls.at(-1)![0];
    expect(entry.action).toBe("policy.draft_saved");
    expect(JSON.stringify(entry)).not.toContain("Heading one");
  });

  // Copying the CURRENT live version back over an identical draft leaves nothing to publish — the
  // identical-publish guard then refuses, so no meaningless version can result from it.
  it("cannot lead to a meaningless version when the copy matches what is live", async () => {
    mockFindDocTx.mockResolvedValue(doc({ publishedVersionId: live.id, lastPublishedVersion: 2, draftBody: PUBLISHED_BODY }));
    vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(live);
    await expect(publishDraft(4, actor)).rejects.toThrow(/Nothing changed since the current published version/i);
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });
});
