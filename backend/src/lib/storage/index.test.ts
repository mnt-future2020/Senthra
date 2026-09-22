import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── The active-provider configuration error ───────────────────────────────────────────────────
//
// `getActiveStorage` resolves WHICHEVER provider is active, so the sentence it throws has to be true
// for either one. It used to say "Add Cloudinary credentials in Settings" and point at Settings →
// Integrations, which was wrong twice over once a second provider existed: an administrator running
// Spaces was told to go and configure a provider they were not using, in a tab that no longer holds
// those fields at all. Both halves of that are what these tests pin.
//
// The provider-from-row path is deliberately NOT in scope here: those callers log the provider they
// actually resolved (`[attachment] spaces not configured …`), which names a provider because it
// knows which one, and is a log rather than something a user reads.

const h = vi.hoisted(() => ({
  getStoredProviderId: vi.fn(),
  getCloudinaryCreds: vi.fn(),
  getSpacesConfig: vi.fn(),
}));

vi.mock("#modules/settings/settings.service.js", () => h);

const { getActiveStorage, findActiveStorage, normalizeProviderId } = await import("./index.js");

/** The thrown message, whatever shape the error took. */
const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a throw, got none");
};

beforeEach(() => {
  h.getStoredProviderId.mockReset();
  h.getCloudinaryCreds.mockReset().mockResolvedValue(null);
  h.getSpacesConfig.mockReset().mockResolvedValue(null);
});

describe("the message when the active provider is not configured", () => {
  it("points at Settings → Storage when Cloudinary is active", async () => {
    h.getStoredProviderId.mockResolvedValue("cloudinary");

    const msg = await messageOf(getActiveStorage);
    expect(msg).toMatch(/Settings → Storage/);
  });

  // The whole point. Same sentence, because the user's problem is the same one.
  it("says exactly the same thing when Spaces is active", async () => {
    h.getStoredProviderId.mockResolvedValue("cloudinary");
    const whenCloudinary = await messageOf(getActiveStorage);

    h.getStoredProviderId.mockResolvedValue("spaces");
    const whenSpaces = await messageOf(getActiveStorage);

    expect(whenSpaces).toBe(whenCloudinary);
  });

  it("never sends anyone to Integrations", async () => {
    for (const provider of ["cloudinary", "spaces", null]) {
      h.getStoredProviderId.mockResolvedValue(provider);
      expect(await messageOf(getActiveStorage)).not.toMatch(/Integrations/i);
    }
  });

  // A Spaces install has no Cloudinary credentials to add, and telling someone to add them is an
  // instruction that cannot be followed.
  it("never tells a Spaces user to configure Cloudinary", async () => {
    h.getStoredProviderId.mockResolvedValue("spaces");
    expect(await messageOf(getActiveStorage)).not.toMatch(/cloudinary/i);
  });

  it("carries the same 400 it always did", async () => {
    h.getStoredProviderId.mockResolvedValue("spaces");
    try {
      await getActiveStorage();
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as { status?: number }).status).toBe(400);
    }
  });
});

// Unchanged behaviour, re-pinned here because the message edit sits directly on top of it.
describe("provider resolution is untouched", () => {
  it("still treats null, missing and junk as Cloudinary", () => {
    expect(normalizeProviderId(null)).toBe("cloudinary");
    expect(normalizeProviderId(undefined)).toBe("cloudinary");
    expect(normalizeProviderId("")).toBe("cloudinary");
    expect(normalizeProviderId("nonsense")).toBe("cloudinary");
    expect(normalizeProviderId("spaces")).toBe("spaces");
  });

  it("still returns null rather than throwing, for the callers that word their own message", async () => {
    h.getStoredProviderId.mockResolvedValue("spaces");
    await expect(findActiveStorage()).resolves.toBeNull();
  });
});

// ── The sweep, as a guard ─────────────────────────────────────────────────────────────────────
//
// Nine separate call sites carried a variant of the old sentence, and a fix applied nine times is a
// fix that comes back the tenth. This walks the tree instead, so the next person to write
// "configure Cloudinary in Settings → Integrations" is told at test time rather than by a user who
// followed the instruction and found nothing there.

const SRC = join(import.meta.dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const production = walk(SRC)
  .map((path) => ({ rel: path.slice(SRC.length + 1).replace(/\\/g, "/"), src: readFileSync(path, "utf8") }))
  .filter((f) => !f.rel.includes(".test.") && !f.rel.includes("/__tests__/") && !f.rel.includes(".testkit."));

/** Only the string literals — the prose in a comment may still discuss what changed and why. */
const literalsOf = (src: string): string =>
  (src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []).join("\n");

describe("no stale guidance anywhere in the tree", () => {
  it("routes nobody to Settings → Integrations for storage", () => {
    const offenders = production.filter((f) => /Settings\s*(→|>)\s*Integrations/.test(literalsOf(f.src)));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  /**
   * The one file allowed to name Cloudinary in a configuration message.
   *
   * Settings → Storage tests each provider SEPARATELY, on a card that already says which one it is.
   * "Add the Cloudinary cloud name, API key and API secret first" is addressed at a named provider
   * because the caller named it — `testStorageConnection({ provider: "cloudinary" })` — not because
   * the code assumed one. That is a genuine provider-specific diagnostic and must stay specific:
   * making it neutral would leave an administrator staring at three empty Cloudinary fields being
   * told that "a storage provider" is unconfigured.
   *
   * Everything else resolves whichever provider is ACTIVE, and has no business naming one.
   */
  const PROVIDER_SPECIFIC_BY_DESIGN = ["modules/settings/settings.service.ts"];

  it("asks nobody to add Cloudinary credentials as the fix for a storage failure", () => {
    const offenders = production
      .filter((f) => !PROVIDER_SPECIFIC_BY_DESIGN.includes(f.rel))
      .filter((f) =>
        /(Add|add)\s+(your\s+)?Cloudinary\s+credentials|Cloudinary (isn't|is not) configured/.test(literalsOf(f.src)),
      );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  // The allowlist is an exception for ONE file, not a blanket one: it still may not send anyone to
  // the old tab, which the first test above already checks across the whole tree including this file.
  it("keeps the allowlist honest — it covers a per-provider test, not active-provider guidance", () => {
    const src = production.find((f) => f.rel === PROVIDER_SPECIFIC_BY_DESIGN[0])!.src;
    expect(src).toMatch(/testStorageConnection/);
    expect(literalsOf(src)).not.toMatch(/Settings\s*(→|>)\s*Integrations/);
  });
});
