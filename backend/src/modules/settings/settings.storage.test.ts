import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@prisma/client";

// ── Settings → Storage ────────────────────────────────────────────────────────────────────────
//
// The provider setting decides ONE thing: where a NEW upload goes. It must never decide where an
// EXISTING asset lives — that is recorded on the asset's own row and resolved from there.
//
// The Spaces probe is mocked at the adapter boundary, so nothing here needs a bucket or a network.
const { probe, getOrCreate, update, record } = vi.hoisted(() => ({
  probe: vi.fn(),
  getOrCreate: vi.fn(),
  update: vi.fn(),
  record: vi.fn(),
}));

vi.mock("./settings.repository.js", () => ({ getOrCreate, update, findFirst: vi.fn(), create: vi.fn(), count: vi.fn() }));
vi.mock("../../lib/storage/spaces.js", () => ({ probeSpacesConnection: probe }));
vi.mock("#modules/audit/audit.service.js", () => ({ record }));
vi.mock("../../lib/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({ findActiveStorage: vi.fn() }));
vi.mock("../../lib/storage/derivatives.js", () => ({ generateDerivatives: vi.fn() }));

import {
  __resetStorageVerifications,
  getSettings,
  getSpacesConfig,
  getBranding,
  getStoredProviderId,
  testStorageConnection,
  updateSettings,
} from "./settings.service.js";

const SECRET = "spaces-secret-never-leaks";
/** A settings row with a COMPLETE, encrypted-at-rest Spaces configuration. */
const row = (over: Partial<Settings> = {}) =>
  ({
    id: "s1",
    storageProvider: null,
    spacesEndpoint: "https://ams3.digitaloceanspaces.com",
    spacesRegion: "ams3",
    spacesBucket: "senthra-prod",
    spacesAccessKeyId: "DO00EXAMPLE",
    // Stored encrypted; `decryptSecret` passes a non-prefixed value through as legacy plaintext,
    // which is what lets this fixture stay readable.
    spacesSecretKey: SECRET,
    spacesCdnUrl: null,
    cloudinaryCloudName: "demo",
    cloudinaryApiKey: "key",
    cloudinaryApiSecret: "sec",
    ...over,
  }) as unknown as Settings;

const ACTOR = { id: "u1", email: "admin@x.co", type: "user" as const };

beforeEach(() => {
  vi.clearAllMocks();
  __resetStorageVerifications();
  getOrCreate.mockResolvedValue(row());
  update.mockImplementation(async (_id: string, data: Partial<Settings>) => row(data));
  probe.mockResolvedValue({ ok: true, message: "Connected to senthra-prod (ams3)." });
});

// ── The active provider ───────────────────────────────────────────────────────────────────────
describe("the stored provider", () => {
  it("is null on an install that never touched it — which the storage layer reads as Cloudinary", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: null }));
    expect(await getStoredProviderId()).toBeNull();
  });

  it('returns "cloudinary" when explicitly set', async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "cloudinary" }));
    expect(await getStoredProviderId()).toBe("cloudinary");
  });

  it('returns "spaces" when selected', async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));
    expect(await getStoredProviderId()).toBe("spaces");
  });
});

// ── Spaces configuration completeness ─────────────────────────────────────────────────────────
//
// All five of endpoint/region/bucket/key/secret are required TOGETHER. A partial set is not a
// usable provider, and returning one would push the failure into the SDK, where it surfaces as an
// opaque credentials error instead of "you have not finished setting this up".
describe("Spaces configuration is all-or-nothing", () => {
  it("resolves a complete configuration", async () => {
    await expect(getSpacesConfig()).resolves.toMatchObject({
      endpoint: "https://ams3.digitaloceanspaces.com",
      region: "ams3",
      bucket: "senthra-prod",
      accessKeyId: "DO00EXAMPLE",
    });
  });

  it.each([
    ["endpoint", { spacesEndpoint: null }],
    ["region", { spacesRegion: null }],
    ["bucket", { spacesBucket: null }],
    ["access key", { spacesAccessKeyId: null }],
    ["secret key", { spacesSecretKey: null }],
  ])("refuses a configuration missing the %s", async (_name, missing) => {
    getOrCreate.mockResolvedValue(row(missing as Partial<Settings>));
    await expect(getSpacesConfig()).resolves.toBeNull();
  });
});

// ── The connection test ───────────────────────────────────────────────────────────────────────
describe("testStorageConnection", () => {
  it("reports success for a working Spaces configuration", async () => {
    await expect(testStorageConnection({ provider: "spaces" })).resolves.toMatchObject({ ok: true });
  });

  it("reports the probe's failure rather than swallowing it", async () => {
    probe.mockResolvedValue({ ok: false, message: "Could not reach the bucket — access was denied." });
    await expect(testStorageConnection({ provider: "spaces" })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("access was denied"),
    });
  });

  it("refuses to test an incomplete configuration instead of calling out", async () => {
    getOrCreate.mockResolvedValue(row({ spacesBucket: null }));
    const r = await testStorageConnection({ provider: "spaces" });
    expect(r.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  // THE VALUES ON SCREEN, not the ones stored. Testing the saved row while the form holds unsaved
  // edits would confirm a configuration nobody is about to use.
  it("tests the SUBMITTED values, not the persisted ones", async () => {
    await testStorageConnection({ provider: "spaces", spacesBucket: "a-different-bucket" });
    expect(probe.mock.calls[0]![0]).toMatchObject({ bucket: "a-different-bucket" });
  });

  it("falls back to the stored secret when the form leaves it blank", async () => {
    await testStorageConnection({ provider: "spaces", spacesBucket: "other", spacesSecretKey: "" });
    expect(probe.mock.calls[0]![0]).toMatchObject({ secretAccessKey: SECRET });
  });

  it("checks Cloudinary by whether its credentials resolve", async () => {
    await expect(testStorageConnection({ provider: "cloudinary" })).resolves.toMatchObject({ ok: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports Cloudinary as unconfigured when its credentials are incomplete", async () => {
    getOrCreate.mockResolvedValue(row({ cloudinaryApiSecret: null, cloudinaryCloudName: null }));
    await expect(testStorageConnection({ provider: "cloudinary" })).resolves.toMatchObject({ ok: false });
  });

  it("never returns the secret in its message", async () => {
    probe.mockResolvedValue({ ok: false, message: "the secret key was rejected" });
    const r = await testStorageConnection({ provider: "spaces" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

// ── The switch guard ──────────────────────────────────────────────────────────────────────────
//
// Selecting a provider decides where every future file goes. Saving it and finding out later is the
// failure this prevents: uploads start failing for everyone, with the only clue an error on a form
// nobody is looking at.
describe("switching the active provider", () => {
  it("refuses to select Spaces without a passing test", async () => {
    await expect(updateSettings({ storageProvider: "spaces" }, ACTOR)).rejects.toThrow(/test the digitalocean spaces connection/i);
  });

  it("does not write storageProvider when the guard refuses", async () => {
    await expect(updateSettings({ storageProvider: "spaces" }, ACTOR)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses to select Spaces when the configuration is incomplete", async () => {
    getOrCreate.mockResolvedValue(row({ spacesRegion: null }));
    await expect(updateSettings({ storageProvider: "spaces" }, ACTOR)).rejects.toThrow(/complete the digitalocean spaces/i);
  });

  it("allows the switch once the exact configuration has passed", async () => {
    await testStorageConnection({ provider: "spaces" });
    await updateSettings({ storageProvider: "spaces" }, ACTOR);
    expect(update.mock.calls[0]![1]).toMatchObject({ storageProvider: "spaces" });
  });

  // A pass unlocks the values that PASSED, nothing else. Change the bucket afterwards and the guard
  // is back — which is the whole guarantee: what was verified is what gets saved.
  it("refuses again when the configuration changes after the test", async () => {
    await testStorageConnection({ provider: "spaces" });
    await expect(
      updateSettings({ storageProvider: "spaces", spacesBucket: "swapped-after-testing" }, ACTOR),
    ).rejects.toThrow(/test the digitalocean spaces connection/i);
  });

  it("validates the configuration this save LEAVES BEHIND, not the stored one", async () => {
    // Test the new bucket, then save it together with the switch: the guard must accept.
    await testStorageConnection({ provider: "spaces", spacesBucket: "new-bucket" });
    await updateSettings({ storageProvider: "spaces", spacesBucket: "new-bucket" }, ACTOR);
    expect(update.mock.calls[0]![1]).toMatchObject({ storageProvider: "spaces", spacesBucket: "new-bucket" });
  });

  // The one direction that must always stay open. Cloudinary is the default every install runs on,
  // and gating the way back would be a trap.
  it("allows switching back to Cloudinary with no test at all", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));
    await updateSettings({ storageProvider: "cloudinary" }, ACTOR);
    expect(update.mock.calls[0]![1]).toMatchObject({ storageProvider: "cloudinary" });
  });

  it("does not rewrite the provider when it is unchanged", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "cloudinary" }));
    await updateSettings({ storageProvider: "cloudinary", brandName: "Senthra" }, ACTOR);
    expect(update.mock.calls[0]![1]).not.toHaveProperty("storageProvider");
  });
});

// ── Secrets ───────────────────────────────────────────────────────────────────────────────────
describe("the Spaces secret never reaches the browser", () => {
  it("exposes only whether one is stored", async () => {
    const s = await getSettings();
    expect(s.spacesSecretKeySet).toBe(true);
    expect(s).not.toHaveProperty("spacesSecretKey");
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("reports the flag as false when none is stored", async () => {
    getOrCreate.mockResolvedValue(row({ spacesSecretKey: null }));
    expect((await getSettings()).spacesSecretKeySet).toBe(false);
  });

  it("exposes the non-secret configuration, which the form needs to render", async () => {
    await expect(getSettings()).resolves.toMatchObject({
      storageProvider: "cloudinary",
      spacesEndpoint: "https://ams3.digitaloceanspaces.com",
      spacesRegion: "ams3",
      spacesBucket: "senthra-prod",
      spacesAccessKeyId: "DO00EXAMPLE",
      spacesConfigured: true,
    });
  });

  it("encrypts a submitted secret rather than storing it as typed", async () => {
    await updateSettings({ spacesSecretKey: "brand-new-secret" }, ACTOR);
    const written = update.mock.calls[0]![1] as { spacesSecretKey: string };
    expect(written.spacesSecretKey).toMatch(/^enc:v1:/);
    expect(written.spacesSecretKey).not.toContain("brand-new-secret");
  });

  it("leaves the stored secret alone when the field is blank", async () => {
    await updateSettings({ spacesSecretKey: "   ", spacesBucket: "b" }, ACTOR);
    expect(update.mock.calls[0]![1]).not.toHaveProperty("spacesSecretKey");
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────────────────────────
describe("a provider change is audited", () => {
  it("records the change, both providers and the actor", async () => {
    await testStorageConnection({ provider: "spaces" });
    await updateSettings({ storageProvider: "spaces" }, ACTOR);

    expect(record).toHaveBeenCalledWith({
      actor: ACTOR,
      action: "settings.storage_provider_changed",
      targetType: "settings",
      metadata: { from: "cloudinary", to: "spaces" },
    });
  });

  it("records the reverse direction too", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));
    await updateSettings({ storageProvider: "cloudinary" }, ACTOR);
    expect(record.mock.calls[0]![0]).toMatchObject({ metadata: { from: "spaces", to: "cloudinary" } });
  });

  it("does not audit a save that leaves the provider alone", async () => {
    await updateSettings({ brandName: "Senthra" }, ACTOR);
    const actions = record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).not.toContain("settings.storage_provider_changed");
  });

  it("puts no credential in the payload", async () => {
    // The secret is tested WITH the switch, because the guard verifies the configuration the save
    // leaves behind — submitting a new secret changes what has to have been verified.
    await testStorageConnection({ provider: "spaces", spacesSecretKey: "typed-in-secret" });
    await updateSettings({ storageProvider: "spaces", spacesSecretKey: "typed-in-secret" }, ACTOR);

    const payload = JSON.stringify(record.mock.calls.map((c) => c[0]));
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain("typed-in-secret");
    expect(payload).not.toContain("DO00EXAMPLE");
  });
});

// ── What the switch does NOT do ───────────────────────────────────────────────────────────────
//
// The switch is configuration, and only configuration. Everything about assets that already exist
// is decided by what is recorded on those assets — see Task 3. These state that here so a future
// change to this file has to break them deliberately.
describe("switching provider touches nothing that already exists", () => {
  it("writes ONLY the provider column — no asset, URL or provider field is rewritten", async () => {
    await testStorageConnection({ provider: "spaces" });
    await updateSettings({ storageProvider: "spaces" }, ACTOR);

    // The whole write, and nothing else in it.
    expect(update.mock.calls[0]![1]).toEqual({ storageProvider: "spaces" });
  });

  it("never touches a pending upload, an attachment or a stored URL", async () => {
    await testStorageConnection({ provider: "spaces" });
    await updateSettings({ storageProvider: "spaces" }, ACTOR);

    const written = JSON.stringify(update.mock.calls[0]![1]);
    for (const forbidden of ["logoUrl", "faviconUrl", "poDocLogoUrl", "publicId", "resourceType"]) {
      expect(written, forbidden).not.toContain(forbidden);
    }
  });
});

// The guard is not satisfied by "some configuration passed" — it is satisfied by "THIS one did".
// Pasting a new secret after testing is exactly the case that would otherwise slip through.
describe("a new secret re-arms the guard", () => {
  it("refuses a switch whose secret was never tested", async () => {
    await testStorageConnection({ provider: "spaces" });
    await expect(
      updateSettings({ storageProvider: "spaces", spacesSecretKey: "pasted-after-testing" }, ACTOR),
    ).rejects.toThrow(/test the digitalocean spaces connection/i);
  });

  it("accepts it once that secret has itself been tested", async () => {
    await testStorageConnection({ provider: "spaces", spacesSecretKey: "pasted-after-testing" });
    await updateSettings({ storageProvider: "spaces", spacesSecretKey: "pasted-after-testing" }, ACTOR);
    expect(update.mock.calls[0]![1]).toMatchObject({ storageProvider: "spaces" });
  });
});

// ── The public upload-host list ───────────────────────────────────────────────────────────────
//
// How the browser tells a file WE stored from a link somebody pasted. It rides on the PUBLIC
// branding payload because the engineer and customer portals both render job attachments and
// neither can read Settings.
//
// Public delivery hostnames only. Anything else here would be a credential leak on an endpoint that
// requires no authentication at all.
describe("branding.uploadHosts", () => {
  const hosts = async () => (await getBranding()).uploadHosts;

  it("always lists the Cloudinary delivery host", async () => {
    expect(await hosts()).toContain("res.cloudinary.com");
  });

  it("derives the Spaces bucket host from the endpoint and bucket", async () => {
    expect(await hosts()).toContain("senthra-prod.ams3.digitaloceanspaces.com");
  });

  // Assets uploaded before a CDN was added still carry ORIGIN urls, and those rows are never
  // rewritten — so both have to be listed, not one or the other.
  it("lists the CDN host AND the bucket host when a CDN is configured", async () => {
    getOrCreate.mockResolvedValue(row({ spacesCdnUrl: "https://files.senthra.co.uk" }));
    const h = await hosts();
    expect(h).toContain("files.senthra.co.uk");
    expect(h).toContain("senthra-prod.ams3.digitaloceanspaces.com");
  });

  // THE INVARIANT THIS EXISTS FOR. An asset stays on the provider that stored it, so the inactive
  // provider's host must survive a switch — otherwise every older attachment starts rendering as a
  // pasted link the moment somebody changes the setting.
  it("keeps BOTH providers' hosts whichever one is active", async () => {
    for (const storageProvider of [null, "cloudinary", "spaces"]) {
      getOrCreate.mockResolvedValue(row({ storageProvider } as never));
      const h = await hosts();
      expect(h, `active=${storageProvider}`).toContain("res.cloudinary.com");
      expect(h, `active=${storageProvider}`).toContain("senthra-prod.ams3.digitaloceanspaces.com");
    }
  });

  // Derived from DELIVERY configuration alone. Rotating a secret must not blank the host and make
  // every stored Spaces attachment look pasted while the administrator types.
  it("still lists the Spaces host while the secret is absent", async () => {
    getOrCreate.mockResolvedValue(row({ spacesSecretKey: null }));
    expect(await hosts()).toContain("senthra-prod.ams3.digitaloceanspaces.com");
  });

  it("omits a Spaces host entirely when no Space is configured", async () => {
    getOrCreate.mockResolvedValue(row({ spacesEndpoint: null, spacesBucket: null, spacesCdnUrl: null }));
    expect(await hosts()).toEqual(["res.cloudinary.com"]);
  });

  // HOSTNAMES, not URLs. A protocol or a path here would either never match `url.hostname` or turn
  // the browser's check into something looser than an equality test.
  it("contains bare hostnames — no protocol, path or slash", async () => {
    getOrCreate.mockResolvedValue(row({ spacesCdnUrl: "https://files.senthra.co.uk/" }));
    for (const h of await hosts()) {
      expect(h).not.toMatch(/^https?:/);
      expect(h).not.toContain("/");
      expect(h).toBe(h.toLowerCase());
    }
  });

  it("ignores an unparseable CDN value rather than emitting rubbish", async () => {
    getOrCreate.mockResolvedValue(row({ spacesCdnUrl: "not a url" }));
    const h = await hosts();
    expect(h).not.toContain("not a url");
    expect(h).toContain("res.cloudinary.com");
  });

  // The payload is UNAUTHENTICATED. Nothing that could identify or authorise an account may be in it.
  it("carries no credential of any kind", async () => {
    getOrCreate.mockResolvedValue(row({ spacesCdnUrl: "https://files.senthra.co.uk" }));
    const payload = JSON.stringify(await getBranding());
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain("DO00EXAMPLE");
    for (const key of ["spacesSecretKey", "spacesAccessKeyId", "cloudinaryApiSecret", "signature", "policy"]) {
      expect(payload, key).not.toContain(key);
    }
  });
});

// ── Configuration is independent of selection ─────────────────────────────────────────────────
//
// Two different acts, and conflating them is the usability bug this fixes: CONFIGURING a provider
// and CHOOSING it. An administrator must be able to set up and verify a provider while continuing
// to run on the other one, and switch later when they are ready.
describe("configuring a provider never switches to it", () => {
  it("saving Spaces credentials while Cloudinary is active leaves the provider alone", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "cloudinary" }));
    await updateSettings({ spacesBucket: "prepared-ahead", spacesRegion: "ams3" }, ACTOR);

    expect(update.mock.calls[0]![1]).toMatchObject({ spacesBucket: "prepared-ahead" });
    expect(update.mock.calls[0]![1]).not.toHaveProperty("storageProvider");
  });

  it("saving Cloudinary credentials while Spaces is active leaves the provider alone", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));
    await updateSettings({ cloudinaryCloudName: "a-new-cloud" }, ACTOR);

    expect(update.mock.calls[0]![1]).toMatchObject({ cloudinaryCloudName: "a-new-cloud" });
    expect(update.mock.calls[0]![1]).not.toHaveProperty("storageProvider");
  });

  // The guard protects the SWITCH, not the configuration. Blocking credential saves behind a test
  // would make the provider impossible to set up in the first place.
  it("does not demand a connection test merely to save Spaces credentials", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "cloudinary" }));
    await expect(
      updateSettings({ spacesBucket: "never-tested", spacesSecretKey: "fresh" }, ACTOR),
    ).resolves.toBeDefined();
  });

  it("audits nothing when only credentials change", async () => {
    await updateSettings({ spacesBucket: "b", cloudinaryApiKey: "k" }, ACTOR);
    const actions = record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).not.toContain("settings.storage_provider_changed");
  });
});

// ── Testing a provider is independent of selection ────────────────────────────────────────────
describe("either provider can be tested whichever is active", () => {
  it("tests Cloudinary while Spaces is the active provider", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));
    await expect(testStorageConnection({ provider: "cloudinary" })).resolves.toMatchObject({ ok: true });
  });

  it("tests Spaces while Cloudinary is the active provider", async () => {
    getOrCreate.mockResolvedValue(row({ storageProvider: "cloudinary" }));
    await expect(testStorageConnection({ provider: "spaces" })).resolves.toMatchObject({ ok: true });
  });

  // The Cloudinary test used to read the STORED credentials, so it confirmed the saved cloud while
  // the form held a different one. It now judges what is on screen, exactly as the Spaces test does.
  it("tests the Cloudinary values ON SCREEN, not the persisted ones", async () => {
    const r = await testStorageConnection({ provider: "cloudinary", cloudinaryCloudName: "typed-in-cloud" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("typed-in-cloud");
    expect(r.message).not.toContain("demo");
  });

  it("falls back to the stored Cloudinary secret when the form leaves it blank", async () => {
    const r = await testStorageConnection({
      provider: "cloudinary",
      cloudinaryCloudName: "other-cloud",
      cloudinaryApiSecret: "",
    });
    expect(r.ok).toBe(true);
  });

  it("reports incomplete Cloudinary credentials rather than guessing", async () => {
    getOrCreate.mockResolvedValue(row({ cloudinaryCloudName: null, cloudinaryApiKey: null, cloudinaryApiSecret: null }));
    await expect(testStorageConnection({ provider: "cloudinary", cloudinaryCloudName: "only-a-cloud" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("puts no Cloudinary secret in the result", async () => {
    const r = await testStorageConnection({ provider: "cloudinary", cloudinaryApiSecret: "typed-secret" });
    expect(JSON.stringify(r)).not.toContain("typed-secret");
    expect(JSON.stringify(r)).not.toContain("sec");
  });
});
