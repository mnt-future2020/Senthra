import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@prisma/client";

// ── Settings → Storage → Cloudinary: the account is made ready when credentials are saved ───────
//
// Saving Cloudinary credentials used to be a database write and nothing more: a wrong secret was
// stored with a green message, and the account's missing upload presets were discovered by the
// first user whose attachment failed. Now a save makes the account READY — the presets uploads are
// signed over are created or repaired in the account the NEW credentials point at, and a failure
// refuses the save, so what is stored is always something uploads can use.
//
// The transport is mocked at its boundary (`ensureUploadPresets` / `inspectUploadPresets`), so
// these tests pin the service's decisions: WHEN the account is touched, WITH WHICH credentials,
// what a failure does to the save, and what reaches the audit log. The preset allowlists are the
// real ones, derived from the upload catalog — a second list here would be the drift this prevents.
const h = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  update: vi.fn(),
  record: vi.fn(),
  ensure: vi.fn(),
  inspect: vi.fn(),
  names: vi.fn(),
  env: {} as Record<string, string | undefined>,
}));

vi.mock("./settings.repository.js", () => ({
  getOrCreate: h.getOrCreate,
  update: h.update,
  findFirst: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: h.record }));
vi.mock("../../lib/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("../../lib/storage/index.js", () => ({ findActiveStorage: vi.fn() }));
vi.mock("../../lib/storage/derivatives.js", () => ({ generateDerivatives: vi.fn() }));
vi.mock("../../lib/storage/spaces.js", () => ({ probeSpacesConnection: vi.fn() }));
vi.mock("../../lib/storage/cloudinary.js", () => ({
  ensureUploadPresets: h.ensure,
  inspectUploadPresets: h.inspect,
  uploadPresetNames: h.names,
}));
vi.mock("../../config/env.js", () => ({ env: h.env, isProduction: false }));
// Secrets at rest are not under test; without a real ENCRYPTION_KEY the helpers pass values through.
vi.mock("../../utils/crypto.js", () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string | null) => v }));

import { setupCloudinaryPresets, testStorageConnection, updateSettings } from "./settings.service.js";

const STORED_SECRET = "stored-cloudinary-secret";
const row = (over: Partial<Settings> = {}) =>
  ({
    id: "s1",
    storageProvider: null,
    cloudinaryCloudName: "demo",
    cloudinaryApiKey: "key",
    // Stored encrypted in production; `decryptSecret` passes a non-prefixed value through.
    cloudinaryApiSecret: STORED_SECRET,
    ...over,
  }) as unknown as Settings;

/** The two presets, exactly as the upload catalog defines their allowlists. */
const SPECS = [
  { name: "senthra_image", allowedFormats: ["gif", "jpeg", "jpg", "png", "webp"] },
  { name: "senthra_raw", allowedFormats: ["csv", "docx", "pdf", "xls", "xlsx"] },
];
const ACTOR = { id: "u1", email: "admin@x.co", type: "user" as const };
const REJECTED = "Cloudinary rejected the API key or secret — check them against the Cloudinary dashboard.";

const allUnchanged = () => ({
  ok: true,
  presets: SPECS.map((s) => ({ name: s.name, outcome: "unchanged" as const })),
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.env)) delete h.env[k];
  h.getOrCreate.mockResolvedValue(row());
  h.update.mockImplementation(async (_id: string, data: Partial<Settings>) => row(data));
  h.names.mockReturnValue({ image: "senthra_image", raw: "senthra_raw" });
  h.ensure.mockResolvedValue(allUnchanged());
  h.inspect.mockResolvedValue({ ok: true, presets: SPECS.map((s) => ({ name: s.name, status: "ready" })) });
});

// ── Saving credentials ────────────────────────────────────────────────────────────────────────
describe("saving Cloudinary credentials", () => {
  it("prepares the presets in the account the NEW credentials point at, before anything is stored", async () => {
    await updateSettings(
      { cloudinaryCloudName: "new-cloud", cloudinaryApiKey: "new-key", cloudinaryApiSecret: "new-secret" },
      ACTOR,
    );

    expect(h.ensure).toHaveBeenCalledWith(SPECS, { cloudName: "new-cloud", apiKey: "new-key", apiSecret: "new-secret" });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.invocationCallOrder[0]!).toBeLessThan(h.update.mock.invocationCallOrder[0]!);
  });

  it("uses the stored secret when the form leaves it blank — the convention every secret here follows", async () => {
    await updateSettings({ cloudinaryCloudName: "renamed-cloud", cloudinaryApiSecret: "" }, ACTOR);

    expect(h.ensure).toHaveBeenCalledWith(SPECS, { cloudName: "renamed-cloud", apiKey: "key", apiSecret: STORED_SECRET });
  });

  it("refuses the save when the account cannot be prepared, and stores nothing", async () => {
    h.ensure.mockResolvedValue({ ok: false, message: REJECTED });

    await expect(
      updateSettings({ cloudinaryCloudName: "new-cloud", cloudinaryApiSecret: "wrong" }, ACTOR),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining(REJECTED) });

    expect(h.update).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("says in the refusal that nothing was saved", async () => {
    h.ensure.mockResolvedValue({ ok: false, message: REJECTED });
    await expect(updateSettings({ cloudinaryApiKey: "other" }, ACTOR)).rejects.toMatchObject({
      message: expect.stringMatching(/not saved/i),
    });
  });

  it("leaves Cloudinary alone for a save that does not touch the credentials", async () => {
    await updateSettings({ brandName: "Senthra", smtpHost: "smtp.example.com" }, ACTOR);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  // The way back must always stay open (see the switch guard). Presets were prepared when the
  // credentials were saved; gating the return on them would turn a Cloudinary outage into a trap.
  it("does not gate switching back to Cloudinary on the presets", async () => {
    h.getOrCreate.mockResolvedValue(row({ storageProvider: "spaces" }));

    await updateSettings({ storageProvider: "cloudinary" }, ACTOR);

    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.update.mock.calls[0]![1]).toMatchObject({ storageProvider: "cloudinary" });
  });

  it("skips the account when the credentials this save leaves behind are incomplete", async () => {
    // Clearing the cloud name: nothing usable is left in Settings, so there is no account to prepare.
    await updateSettings({ cloudinaryCloudName: "" }, ACTOR);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("skips the account when no preset is configured for this deployment", async () => {
    h.names.mockReturnValue({});
    await updateSettings({ cloudinaryCloudName: "new-cloud" }, ACTOR);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("records what it created or repaired in the audit log, against the cloud it touched", async () => {
    h.ensure.mockResolvedValue({
      ok: true,
      presets: [
        { name: "senthra_image", outcome: "created" },
        { name: "senthra_raw", outcome: "updated" },
      ],
    });

    await updateSettings({ cloudinaryCloudName: "new-cloud" }, ACTOR);

    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ACTOR,
        action: "settings.cloudinary_presets_configured",
        metadata: { cloudName: "new-cloud", created: ["senthra_image"], updated: ["senthra_raw"] },
      }),
    );
  });

  it("writes nothing to the audit log when every preset was already in place", async () => {
    await updateSettings({ cloudinaryCloudName: "new-cloud" }, ACTOR);
    expect(h.record).not.toHaveBeenCalled();
  });
});

// ── The connection test ───────────────────────────────────────────────────────────────────────
describe("testing a Cloudinary configuration", () => {
  it("asks Cloudinary with the values ON SCREEN and reports each preset", async () => {
    h.inspect.mockResolvedValue({
      ok: true,
      presets: [
        { name: "senthra_image", status: "ready" },
        { name: "senthra_raw", status: "missing" },
      ],
    });

    const r = await testStorageConnection({ provider: "cloudinary", cloudinaryCloudName: "typed-cloud" });

    expect(h.inspect).toHaveBeenCalledWith(SPECS, { cloudName: "typed-cloud", apiKey: "key", apiSecret: STORED_SECRET });
    // Not green: a green tick on this row means "uploads will work", exactly as it does for Spaces.
    expect(r.ok).toBe(false);
    expect(r.message).toContain("typed-cloud");
    expect(r.message).toMatch(/senthra_image ready/);
    expect(r.message).toMatch(/senthra_raw missing/);
  });

  it("calls a preset whose allowlist drifted out for repair", async () => {
    h.inspect.mockResolvedValue({ ok: true, presets: [{ name: "senthra_image", status: "drifted" }] });
    const r = await testStorageConnection({ provider: "cloudinary" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/senthra_image needs repair/);
  });

  it("is green only when every preset is ready", async () => {
    const r = await testStorageConnection({ provider: "cloudinary" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/senthra_image ready, senthra_raw ready/);
  });

  it("fails the test when Cloudinary rejects the credentials — the first real check they get", async () => {
    h.inspect.mockResolvedValue({ ok: false, message: REJECTED });
    await expect(testStorageConnection({ provider: "cloudinary" })).resolves.toEqual({ ok: false, message: REJECTED });
  });

  it("does not call Cloudinary when the credentials are incomplete", async () => {
    h.getOrCreate.mockResolvedValue(row({ cloudinaryCloudName: null, cloudinaryApiKey: null, cloudinaryApiSecret: null }));
    const r = await testStorageConnection({ provider: "cloudinary" });
    expect(r.ok).toBe(false);
    expect(h.inspect).not.toHaveBeenCalled();
  });

  it("is honest when presets are disabled: nothing was verified against the account", async () => {
    h.names.mockReturnValue({});
    const r = await testStorageConnection({ provider: "cloudinary" });
    expect(h.inspect).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/disabled/i);
    expect(r.message).toMatch(/nothing was verified/i);
  });
});

// ── The explicit action ───────────────────────────────────────────────────────────────────────
//
// For a deployment whose credentials come from the environment rather than Settings, no save ever
// runs — this is how that account gets its presets. It is also the repair button for any account.
describe("setupCloudinaryPresets", () => {
  it("prepares the account the effective credentials point at — Settings first", async () => {
    h.ensure.mockResolvedValue({
      ok: true,
      presets: [
        { name: "senthra_image", outcome: "created" },
        { name: "senthra_raw", outcome: "updated" },
      ],
    });

    const r = await setupCloudinaryPresets(ACTOR);

    expect(h.ensure).toHaveBeenCalledWith(SPECS, { cloudName: "demo", apiKey: "key", apiSecret: STORED_SECRET });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("demo");
    expect(r.message).toMatch(/senthra_image created/);
    expect(r.message).toMatch(/senthra_raw repaired/);
  });

  it("falls back to the environment credentials when Settings holds none", async () => {
    h.getOrCreate.mockResolvedValue(row({ cloudinaryCloudName: null, cloudinaryApiKey: null, cloudinaryApiSecret: null }));
    Object.assign(h.env, { CLOUDINARY_CLOUD_NAME: "env-cloud", CLOUDINARY_API_KEY: "env-key", CLOUDINARY_API_SECRET: "env-secret" });

    await setupCloudinaryPresets(ACTOR);

    expect(h.ensure).toHaveBeenCalledWith(SPECS, { cloudName: "env-cloud", apiKey: "env-key", apiSecret: "env-secret" });
  });

  it("explains when there are no credentials anywhere, without calling Cloudinary", async () => {
    h.getOrCreate.mockResolvedValue(row({ cloudinaryCloudName: null, cloudinaryApiKey: null, cloudinaryApiSecret: null }));

    const r = await setupCloudinaryPresets(ACTOR);

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cloud name, API key and API secret/i);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("reports when everything was already in place", async () => {
    const r = await setupCloudinaryPresets(ACTOR);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/already in place/i);
  });

  it("words a single configured preset in the singular", async () => {
    h.names.mockReturnValue({ image: "senthra_image" });
    h.ensure.mockResolvedValue({ ok: true, presets: [{ name: "senthra_image", outcome: "unchanged" }] });
    const r = await setupCloudinaryPresets(ACTOR);
    expect(r.message).toMatch(/upload preset senthra_image is already in place/);
  });

  it("passes a failure through as the result, not as an exception", async () => {
    h.ensure.mockResolvedValue({ ok: false, message: REJECTED });
    await expect(setupCloudinaryPresets(ACTOR)).resolves.toEqual({ ok: false, message: REJECTED });
  });

  it("records created and repaired presets in the audit log", async () => {
    h.ensure.mockResolvedValue({ ok: true, presets: [{ name: "senthra_raw", outcome: "created" }] });

    await setupCloudinaryPresets(ACTOR);

    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ACTOR,
        action: "settings.cloudinary_presets_configured",
        metadata: { cloudName: "demo", created: ["senthra_raw"], updated: [] },
      }),
    );
  });

  it("is honest when presets are disabled for this deployment", async () => {
    h.names.mockReturnValue({});
    const r = await setupCloudinaryPresets(ACTOR);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/disabled/i) });
  });
});
