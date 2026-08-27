import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure unit tests of the publishing invariants. The repository, audit log and the transaction helper
// are mocked; `withTransactionRetry` is replaced by a pass-through that runs the body once, so the
// publish logic itself (revision guard, version allocation, ordering) is what is under test.
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
// discardDraft / getPublishedVersion are exercised in policy.lifecycle.test.ts, which owns the
// three lifecycle additions and their own harness.
import {
  getPolicyForAdmin,
  getPublishedPolicy,
  previewBody,
  publishDraft,
  saveDraft,
} from "./policy.service.js";

const KEY = "privacy_policy";
const DOC_ID = "d".repeat(24);
const actor = { id: "u".repeat(24), email: "admin@x.com", type: "user" as const, permissions: [] };

const PUBLISHED_BODY = "# Published\n\nThis is the live policy.";
const DRAFT_BODY = "# Draft\n\nThis text is NOT live yet.";

function doc(over: Record<string, unknown> = {}) {
  return {
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
  };
}

function version(over: Record<string, unknown> = {}) {
  return {
    id: "v".repeat(24),
    documentKey: KEY,
    version: 1,
    body: PUBLISHED_BODY,
    publishedAt: new Date("2026-08-02T00:00:00Z"),
    publishedById: actor.id,
    publishedBy: actor.email,
    ...over,
  };
}

const mockFindDoc = policyRepo.findDocument as ReturnType<typeof vi.fn>;
const mockFindDocTx = policyRepo.findDocumentTx as ReturnType<typeof vi.fn>;
const mockSaveDraft = policyRepo.saveDraftIfUnchanged as ReturnType<typeof vi.fn>;
const mockCreateVersion = policyRepo.createVersionTx as ReturnType<typeof vi.fn>;
const mockSetPublished = policyRepo.setPublishedVersionTx as ReturnType<typeof vi.fn>;
const mockFindVersionById = policyRepo.findVersionById as ReturnType<typeof vi.fn>;
const mockFindPublished = policyRepo.findPublishedVersion as ReturnType<typeof vi.fn>;
const mockListVersions = policyRepo.listVersions as ReturnType<typeof vi.fn>;
const mockFindVersionForDoc = policyRepo.findVersionForDocument as ReturnType<typeof vi.fn>;
const mockAudit = audit.record as ReturnType<typeof vi.fn>;

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
  mockFindPublished.mockResolvedValue(null);
  mockListVersions.mockResolvedValue([]);
  // Nothing published by default, so the identical-republish guard has nothing to compare against.
  vi.mocked(policyRepo.findVersionByIdTx).mockResolvedValue(null);
});

/** Invariant: the public endpoint can never serve unpublished text. */
describe("public read — the draft is unreachable", () => {
  it("returns null when nothing has been published", async () => {
    mockFindPublished.mockResolvedValue(null);
    expect(await getPublishedPolicy()).toBeNull();
  });

  it("resolves through the PUBLISHED version, never the document", async () => {
    mockFindPublished.mockResolvedValue(version());
    await getPublishedPolicy();
    // The one read that could reach `draftBody` is not made at all on this path.
    expect(mockFindDoc).not.toHaveBeenCalled();
  });

  it("returns the published body's blocks and no draft text, when the two differ", async () => {
    mockFindPublished.mockResolvedValue(version({ body: PUBLISHED_BODY }));
    const result = await getPublishedPolicy();
    const serialised = JSON.stringify(result);
    expect(serialised).toContain("This is the live policy.");
    expect(serialised).not.toContain("NOT live yet");
    expect(serialised).not.toContain("draftBody");
  });

  it("exposes only version, publishedAt and blocks — no internal identifiers", async () => {
    mockFindPublished.mockResolvedValue(version());
    const result = await getPublishedPolicy();
    expect(Object.keys(result!).sort()).toEqual(["blocks", "publishedAt", "version"]);
  });
});

/** Invariant: editing the draft must not change what the public sees. */
describe("draft edits are isolated from the published version", () => {
  it("saving the draft writes only the document, never a version", async () => {
    await saveDraft("# New draft", 4, actor);
    expect(mockSaveDraft).toHaveBeenCalledWith(KEY, 4, "# New draft", actor.email);
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
  });

  it("leaves the published body untouched after a draft save", async () => {
    const live = version({ body: PUBLISHED_BODY });
    mockFindDoc.mockResolvedValue(doc({ publishedVersionId: live.id, lastPublishedVersion: 1 }));
    mockFindVersionById.mockResolvedValue(live);

    const after = await saveDraft("# Completely different", 4, actor);
    expect(after.published?.body).toBe(PUBLISHED_BODY);
  });

  it("reports unpublished changes when the draft diverges from the live version", async () => {
    const live = version({ body: PUBLISHED_BODY });
    mockFindDoc.mockResolvedValue(doc({ publishedVersionId: live.id, draftBody: DRAFT_BODY }));
    mockFindVersionById.mockResolvedValue(live);
    expect((await getPolicyForAdmin()).hasUnpublishedChanges).toBe(true);
  });

  it("reports no unpublished changes when they match", async () => {
    const live = version({ body: PUBLISHED_BODY });
    mockFindDoc.mockResolvedValue(doc({ publishedVersionId: live.id, draftBody: PUBLISHED_BODY }));
    mockFindVersionById.mockResolvedValue(live);
    expect((await getPolicyForAdmin()).hasUnpublishedChanges).toBe(false);
  });

  it("rejects a save based on a stale revision, without writing", async () => {
    mockSaveDraft.mockResolvedValue(0); // conditional update matched nothing
    await expect(saveDraft("# Racing edit", 2, actor)).rejects.toThrow(/changed by someone else/i);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

/** Invariant: publishing creates a new immutable version and never rewrites an old one. */
describe("publishing", () => {
  it("creates version 1 from an unpublished document", async () => {
    await publishDraft(4, actor);
    expect(mockCreateVersion.mock.calls[0][1]).toMatchObject({
      documentKey: KEY,
      version: 1,
      body: DRAFT_BODY,
      publishedBy: actor.email,
      publishedById: actor.id,
    });
  });

  it("allocates the NEXT number from the document, not from a count", async () => {
    mockFindDocTx.mockResolvedValue(doc({ lastPublishedVersion: 7 }));
    await publishDraft(4, actor);
    expect(mockCreateVersion.mock.calls[0][1]).toMatchObject({ version: 8 });
  });

  it("snapshots the draft body — a copy, not a reference", async () => {
    mockFindDocTx.mockResolvedValue(doc({ draftBody: "# Snapshot me" }));
    await publishDraft(4, actor);
    expect(mockCreateVersion.mock.calls[0][1].body).toBe("# Snapshot me");
  });

  it("only ever CREATES versions — no update or delete path exists", () => {
    // The repository is the sole Prisma surface for versions; if it grew a mutator, publishing an
    // amendment could overwrite history instead of appending to it.
    expect(Object.keys(policyRepo)).not.toContain("updateVersion");
    expect(Object.keys(policyRepo)).not.toContain("deleteVersion");
  });

  it("repoints the document at the new version, inside the same transaction", async () => {
    await publishDraft(4, actor);
    const [txCreate] = mockCreateVersion.mock.calls[0];
    const [txSet] = mockSetPublished.mock.calls[0];
    expect(txCreate).toBe(txSet); // same transaction client
    expect(mockSetPublished.mock.calls[0].slice(1)).toEqual([KEY, "v00000000000000000000001", 1]);
  });

  it("runs inside withTransactionRetry, so a concurrent publish is replayed not lost", async () => {
    await publishDraft(4, actor);
    expect(withTransactionRetry).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale revision — you publish what you reviewed", async () => {
    mockFindDocTx.mockResolvedValue(doc({ draftRevision: 9 }));
    await expect(publishDraft(4, actor)).rejects.toThrow(/changed by someone else/i);
    expect(mockCreateVersion).not.toHaveBeenCalled();
    expect(mockSetPublished).not.toHaveBeenCalled();
  });

  it("refuses to publish an empty draft", async () => {
    mockFindDocTx.mockResolvedValue(doc({ draftBody: "   \n  " }));
    await expect(publishDraft(4, actor)).rejects.toThrow(/nothing to publish/i);
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it("two sequential publishes produce two distinct versions", async () => {
    await publishDraft(4, actor);
    mockFindDocTx.mockResolvedValue(doc({ draftRevision: 5, lastPublishedVersion: 1 }));
    await publishDraft(5, actor);

    const versions = mockCreateVersion.mock.calls.map((c) => c[1].version);
    expect(versions).toEqual([1, 2]);
    expect(new Set(versions).size).toBe(2);
  });
});

/** Invariant: the audit trail records the publish without becoming a second copy of the document. */
describe("audit", () => {
  it("records the publish with version numbers, not content", async () => {
    await publishDraft(4, actor);
    const entry = mockAudit.mock.calls[0][0];
    expect(entry.action).toBe("policy.published");
    expect(entry.metadata).toMatchObject({ version: 1, previousVersion: null });
    expect(JSON.stringify(entry)).not.toContain(DRAFT_BODY);
  });

  it("records a draft save with the new revision, not the body", async () => {
    await saveDraft("# Secret draft text", 4, actor);
    const entry = mockAudit.mock.calls[0][0];
    expect(entry.action).toBe("policy.draft_saved");
    expect(entry.metadata).toEqual({ revision: 5 });
    expect(JSON.stringify(entry)).not.toContain("Secret draft text");
  });

  it("audits AFTER the transaction, so a replay cannot double-count a publish", async () => {
    const order: string[] = [];
    vi.mocked(withTransactionRetry).mockImplementationOnce(async (fn) => {
      order.push("tx");
      return fn({} as never);
    });
    mockAudit.mockImplementation(() => order.push("audit"));
    await publishDraft(4, actor);
    expect(order).toEqual(["tx", "audit"]);
  });
});

describe("preview", () => {
  it("renders arbitrary text to blocks without writing anything", () => {
    expect(previewBody("# Preview")).toEqual([{ type: "heading", text: "Preview" }]);
    expect(mockSaveDraft).not.toHaveBeenCalled();
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });
});

describe("admin read", () => {
  it("reports a null published version before anything is published", async () => {
    const p = await getPolicyForAdmin();
    expect(p.published).toBeNull();
    expect(p.history).toEqual([]);
  });

  it("returns the history newest-first as the repository ordered it", async () => {
    mockListVersions.mockResolvedValue([version({ version: 2 }), version({ version: 1 })]);
    expect((await getPolicyForAdmin()).history.map((h) => h.version)).toEqual([2, 1]);
  });

  it("throws when the document row is missing rather than inventing one", async () => {
    mockFindDoc.mockResolvedValue(null);
    await expect(getPolicyForAdmin()).rejects.toThrow(/not found/i);
  });
});
