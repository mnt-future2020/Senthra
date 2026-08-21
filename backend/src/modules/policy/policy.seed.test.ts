import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({ db: { findUnique: vi.fn(), upsert: vi.fn() } }));
vi.mock("../../lib/prisma.js", () => ({ prisma: { policyDocument: db } }));

import { ensureDocument, PRIVACY_POLICY_KEY } from "./policy.repository.js";

const EXISTING = {
  id: "d".repeat(24),
  key: PRIVACY_POLICY_KEY,
  // A LIVE draft with published history — the row a careless seed would trample.
  draftBody: "# In progress\n\nThe client's working text.",
  draftRevision: 6,
  draftUpdatedAt: new Date("2026-08-20T09:00:00Z"),
  draftUpdatedBy: "editor@x.com",
  publishedVersionId: "v".repeat(24),
  lastPublishedVersion: 3,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-08-20T09:00:00Z"),
};

/** The exact upsert the seed must issue — an existence check that writes nothing to a live row. */
const EXPECTED_UPSERT = {
  where: { key: PRIVACY_POLICY_KEY },
  create: { key: PRIVACY_POLICY_KEY, draftBody: "" },
  update: {},
};

beforeEach(() => {
  db.findUnique.mockReset();
  db.upsert.mockReset();
});

describe("ensureDocument — creation detection", () => {
  it("reports created when there was no row", async () => {
    const fresh = { ...EXISTING, draftBody: "", draftRevision: 0, publishedVersionId: null };
    db.findUnique.mockResolvedValue(null);
    db.upsert.mockResolvedValue(fresh);

    const { document, created } = await ensureDocument(PRIVACY_POLICY_KEY);
    expect(created).toBe(true);
    expect(document).toBe(fresh);
  });

  it("reports NOT created when the row already exists", async () => {
    db.findUnique.mockResolvedValue(EXISTING);
    db.upsert.mockResolvedValue(EXISTING);

    const { created } = await ensureDocument(PRIVACY_POLICY_KEY);
    expect(created).toBe(false);
  });

  it("does not use createdAt === updatedAt to decide — that stays true forever", async () => {
    // The bug this replaces: `update: {}` never touches the row, so an untouched document keeps
    // equal timestamps for life and every boot claimed a fresh insert.
    const untouched = { ...EXISTING, createdAt: EXISTING.createdAt, updatedAt: EXISTING.createdAt };
    db.findUnique.mockResolvedValue(untouched);
    db.upsert.mockResolvedValue(untouched);

    expect((await ensureDocument(PRIVACY_POLICY_KEY)).created).toBe(false);
  });
});

describe("ensureDocument — the upsert is unchanged", () => {
  it("issues the same upsert whether or not the row exists", async () => {
    db.findUnique.mockResolvedValue(null);
    db.upsert.mockResolvedValue(EXISTING);
    await ensureDocument(PRIVACY_POLICY_KEY);

    db.findUnique.mockResolvedValue(EXISTING);
    await ensureDocument(PRIVACY_POLICY_KEY);

    expect(db.upsert).toHaveBeenCalledTimes(2);
    expect(db.upsert.mock.calls[0][0]).toEqual(EXPECTED_UPSERT);
    expect(db.upsert.mock.calls[1][0]).toEqual(EXPECTED_UPSERT);
  });

  it("never writes to an existing document — update stays empty", async () => {
    db.findUnique.mockResolvedValue(EXISTING);
    db.upsert.mockResolvedValue(EXISTING);
    await ensureDocument(PRIVACY_POLICY_KEY);

    const { update } = db.upsert.mock.calls[0][0];
    expect(update).toEqual({});
    expect(Object.keys(update)).toHaveLength(0);
  });

  it("seeds an EMPTY draft — no policy content is ever written by the seed", async () => {
    db.findUnique.mockResolvedValue(null);
    db.upsert.mockResolvedValue(EXISTING);
    await ensureDocument(PRIVACY_POLICY_KEY);
    expect(db.upsert.mock.calls[0][0].create).toEqual({ key: PRIVACY_POLICY_KEY, draftBody: "" });
  });

  it("leaves a live draft and its published pointer untouched across repeated calls", async () => {
    db.findUnique.mockResolvedValue(EXISTING);
    db.upsert.mockResolvedValue(EXISTING);

    for (let i = 0; i < 3; i++) {
      const { document, created } = await ensureDocument(PRIVACY_POLICY_KEY);
      expect(created).toBe(false);
      expect(document).toEqual(EXISTING); // draftBody, draftRevision, publishedVersionId all intact
    }
    // Nothing in any call could have mutated the row.
    for (const [args] of db.upsert.mock.calls) expect(args.update).toEqual({});
  });
});

describe("the seed logs what it actually did", () => {
  const seed = readFileSync(join(import.meta.dirname, "..", "..", "db", "seed.ts"), "utf8");

  it("logs only when the document was created", () => {
    expect(seed).toContain("const { created } = await policyRepo.ensureDocument");
    expect(seed).toContain("if (created) {");
  });

  it("no longer decides from the timestamps", () => {
    expect(seed).not.toContain("createdAt.getTime() === created.updatedAt.getTime()");
  });

  it("still seeds no policy content", () => {
    expect(seed).toContain("(empty draft)");
  });
});
