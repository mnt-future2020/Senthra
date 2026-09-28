import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Upload presets, managed from here ─────────────────────────────────────────────────────────
//
// A direct browser upload is signed over `upload_preset`, so the preset has to EXIST in the account
// the credentials point at, carrying the format allowlist the catalog expects. A fresh Cloudinary
// account has neither, and the failure is a Cloudinary 400 on every attachment upload — long after
// the credentials were saved with a green "configured" message. These functions are what make
// saving credentials also mean "the account is ready", and the Admin API call they make is the
// first REAL check the credentials have ever had.
//
// The SDK is mocked at its boundary: what is pinned is exactly what is sent (a SIGNED preset with
// the catalog's allowlist), what counts as "already right", and how each failure is worded.
const { config, getPreset, createPreset, updatePreset } = vi.hoisted(() => ({
  config: vi.fn(),
  getPreset: vi.fn(),
  createPreset: vi.fn(),
  updatePreset: vi.fn(),
}));
vi.mock("cloudinary", () => ({
  v2: {
    config,
    api: { upload_preset: getPreset, create_upload_preset: createPreset, update_upload_preset: updatePreset },
  },
}));
// Not the real defaults, so a hard-coded "senthra_image" anywhere in the transport would fail here.
vi.mock("../../config/env.js", () => ({
  env: { CLOUDINARY_UPLOAD_PRESET_IMAGE: "configured-image", CLOUDINARY_UPLOAD_PRESET_RAW: "configured-raw" },
}));

import { ensureUploadPresets, inspectUploadPresets, uploadPresetNames } from "./cloudinary.js";
import { env } from "../../config/env.js";

const SECRET = "top-secret-never-in-a-message";
const CREDS = { cloudName: "cloud", apiKey: "key", apiSecret: SECRET };
/** The same credentials as the SDK expects them ON EACH CALL — never via its global config. */
const AUTH = { cloud_name: "cloud", api_key: "key", api_secret: SECRET };
const IMAGE = { name: "senthra_image", allowedFormats: ["gif", "jpeg", "jpg", "png", "webp"] };
const RAW = { name: "senthra_raw", allowedFormats: ["csv", "docx", "pdf", "xls", "xlsx"] };

/** How the SDK reports an Admin API error status. */
const apiError = (http_code: number, message: string) => ({ error: { message, http_code } });
const notFound = () => Promise.reject(apiError(404, "Cannot find upload preset"));
/** How the SDK's promise path reports a socket-level failure: the BARE error (`request.on("error", reject)`). */
const networkDown = () =>
  Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND api.cloudinary.com"), { code: "ENOTFOUND" }));
/** Its callback path wraps the same error instead; both shapes must read the same. */
const networkDownWrapped = () =>
  Promise.reject({ error: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }) });
const stored = (over: Record<string, unknown> = {}) => ({
  name: "senthra_image",
  unsigned: false,
  settings: { overwrite: false, allowed_formats: ["gif", "jpeg", "jpg", "png", "webp"] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  createPreset.mockResolvedValue({ message: "created" });
  updatePreset.mockResolvedValue({ message: "updated" });
});

describe("uploadPresetNames", () => {
  it("reads both names from the environment", () => {
    expect(uploadPresetNames()).toEqual({ image: "configured-image", raw: "configured-raw" });
  });

  it("treats a blank name as no preset for that resource type", () => {
    const before = env.CLOUDINARY_UPLOAD_PRESET_RAW;
    (env as { CLOUDINARY_UPLOAD_PRESET_RAW: string }).CLOUDINARY_UPLOAD_PRESET_RAW = "  ";
    try {
      expect(uploadPresetNames()).toEqual({ image: "configured-image", raw: undefined });
    } finally {
      (env as { CLOUDINARY_UPLOAD_PRESET_RAW: string }).CLOUDINARY_UPLOAD_PRESET_RAW = before;
    }
  });
});

describe("ensureUploadPresets", () => {
  // The SDK reads its global `config()` at CALL time. A concurrent upload or delivery-URL signing
  // sets that global to the STORED credentials, so relying on it across the awaits here would point
  // the next call at the old account — during the very credential change this exists for. Every
  // call therefore carries its own credentials, and the global is never touched.
  it("authenticates every Admin API call with the credentials it was given, never via the SDK's global config", async () => {
    getPreset.mockImplementation(notFound);

    await ensureUploadPresets([IMAGE], CREDS);

    expect(config).not.toHaveBeenCalled();
    expect(getPreset).toHaveBeenCalledWith("senthra_image", expect.objectContaining(AUTH));
    expect(createPreset).toHaveBeenCalledWith(expect.objectContaining(AUTH));
  });

  it("creates a missing preset as SIGNED, with exactly the catalog allowlist", async () => {
    getPreset.mockImplementation(notFound);

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toEqual({ ok: true, presets: [{ name: "senthra_image", outcome: "created" }] });
    expect(createPreset).toHaveBeenCalledWith({
      name: "senthra_image",
      unsigned: false,
      overwrite: false,
      allowed_formats: "gif,jpeg,jpg,png,webp",
      ...AUTH,
    });
    expect(updatePreset).not.toHaveBeenCalled();
  });

  it("leaves a preset that already matches alone — no write, no churn", async () => {
    getPreset.mockResolvedValue(stored());

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toEqual({ ok: true, presets: [{ name: "senthra_image", outcome: "unchanged" }] });
    expect(createPreset).not.toHaveBeenCalled();
    expect(updatePreset).not.toHaveBeenCalled();
  });

  it("reads an allowlist Cloudinary reports as a comma string, in any order, as the same allowlist", async () => {
    getPreset.mockResolvedValue(stored({ settings: { allowed_formats: "webp, png,JPG,jpeg,gif" } }));

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toMatchObject({ ok: true, presets: [{ outcome: "unchanged" }] });
    expect(updatePreset).not.toHaveBeenCalled();
  });

  it("repairs a preset whose allowlist drifted, replacing it with the catalog allowlist", async () => {
    getPreset.mockResolvedValue(stored({ settings: { allowed_formats: ["png"] } }));

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toEqual({ ok: true, presets: [{ name: "senthra_image", outcome: "updated" }] });
    // The PUT REPLACES the preset's settings object, so a repair must resend every field the app's
    // presets carry — `overwrite: false` included — or the update silently drops it.
    expect(updatePreset).toHaveBeenCalledWith("senthra_image", {
      unsigned: false,
      overwrite: false,
      allowed_formats: "gif,jpeg,jpg,png,webp",
      ...AUTH,
    });
    expect(createPreset).not.toHaveBeenCalled();
  });

  // An unsigned preset with this name would let ANYONE upload into the account without a signature
  // — a hole the app did not open but would be blamed for. The app owns these names; it re-signs.
  it("repairs a preset whose overwrite protection was switched off", async () => {
    getPreset.mockResolvedValue(
      stored({ settings: { overwrite: true, allowed_formats: ["gif", "jpeg", "jpg", "png", "webp"] } }),
    );

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toMatchObject({ ok: true, presets: [{ outcome: "updated" }] });
    expect(updatePreset).toHaveBeenCalledWith("senthra_image", expect.objectContaining({ overwrite: false }));
  });

  it("reads an omitted overwrite flag as the default (off) — no churn on an account that never set it", async () => {
    getPreset.mockResolvedValue(stored({ settings: { allowed_formats: ["gif", "jpeg", "jpg", "png", "webp"] } }));
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: true, presets: [{ outcome: "unchanged" }] });
    expect(updatePreset).not.toHaveBeenCalled();
  });

  it("re-signs a preset someone made unsigned", async () => {
    getPreset.mockResolvedValue(stored({ unsigned: true }));

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toMatchObject({ ok: true, presets: [{ outcome: "updated" }] });
    expect(updatePreset).toHaveBeenCalledWith("senthra_image", expect.objectContaining({ unsigned: false }));
  });

  it("handles every preset and reports each outcome, in order", async () => {
    getPreset.mockImplementation((name: string) =>
      name === "senthra_image" ? Promise.resolve(stored()) : notFound(),
    );

    const r = await ensureUploadPresets([IMAGE, RAW], CREDS);

    expect(r).toEqual({
      ok: true,
      presets: [
        { name: "senthra_image", outcome: "unchanged" },
        { name: "senthra_raw", outcome: "created" },
      ],
    });
    expect(createPreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: "senthra_raw", allowed_formats: "csv,docx,pdf,xls,xlsx" }),
    );
  });

  it("does nothing at all when no preset is configured", async () => {
    await expect(ensureUploadPresets([], CREDS)).resolves.toEqual({ ok: true, presets: [] });
    expect(config).not.toHaveBeenCalled();
    expect(getPreset).not.toHaveBeenCalled();
  });

  it("reports rejected credentials in plain words, and writes nothing", async () => {
    getPreset.mockRejectedValue(apiError(401, "Invalid API key"));

    const r = await ensureUploadPresets([IMAGE, RAW], CREDS);

    expect(r.ok).toBe(false);
    // A well-formed but wrong CLOUD NAME is also answered 401 ("api_secret mismatch"), so the
    // message must point at all three fields, not just the two that sound like credentials.
    expect(r).toMatchObject({ message: expect.stringMatching(/cloud name, API key and API secret/i) });
    expect(createPreset).not.toHaveBeenCalled();
    expect(updatePreset).not.toHaveBeenCalled();
    // The first failure ends the run — the second preset is not even looked up.
    expect(getPreset).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure as unreachable, not as a Cloudinary refusal", async () => {
    getPreset.mockImplementation(networkDown);
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/could not reach cloudinary/i) });
  });

  it("reads the callback-style wrapped socket error the same way", async () => {
    getPreset.mockImplementation(networkDownWrapped);
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/could not reach cloudinary/i) });
  });

  // The SDK arms a 60 s socket timeout but never handles it, so a black-holed connection would hang
  // the settings save. The wait is bounded here, in words an administrator can act on.
  it("gives up on an Admin API call that never answers", async () => {
    getPreset.mockImplementation(() => new Promise(() => {}));
    const r = await ensureUploadPresets([IMAGE], CREDS, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/did not answer in time/i) });
  });

  // "Check the cloud name" is the reading of a 404 that never reached Cloudinary's API (see
  // isMissingPreset). A 404 Cloudinary itself returns to a WRITE — the preset deleted between the
  // read and the write, say — is not that, and must not be blamed on the cloud name.
  it("does not blame the cloud name for a 404 that is Cloudinary's own answer to a write", async () => {
    getPreset.mockImplementation(notFound);
    createPreset.mockRejectedValue(apiError(404, "Resource not found"));

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("Resource not found") });
    expect((r as { message: string }).message).not.toMatch(/cloud name/i);
  });

  it("names the admin API rate limit when that is what answered", async () => {
    getPreset.mockRejectedValue(apiError(420, "Rate Limited"));
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/rate limit/i) });
  });

  // Only Cloudinary's OWN "no such preset" answer means missing. A misrouted request (an empty or
  // malformed cloud name) also comes back 404, but as a bare error page the SDK reports as invalid
  // JSON — treating that as "missing" would try to create presets in a cloud that does not exist.
  it("does not mistake a misrouted 404 for a missing preset", async () => {
    getPreset.mockRejectedValue(apiError(404, "Server return invalid JSON response. Status Code 404"));

    const r = await ensureUploadPresets([IMAGE], CREDS);

    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/cloud name/i) });
    expect(createPreset).not.toHaveBeenCalled();
  });

  it("passes an unexpected Cloudinary error through in its own words", async () => {
    getPreset.mockRejectedValue(apiError(500, "Something odd happened"));
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("Something odd happened") });
  });

  it("never puts the secret in a message, whatever Cloudinary echoes", async () => {
    getPreset.mockRejectedValue(apiError(400, `bad request for ${SECRET}`));
    const r = await ensureUploadPresets([IMAGE], CREDS);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("inspectUploadPresets", () => {
  it("reports each preset as ready, missing or drifted — and writes nothing", async () => {
    getPreset.mockImplementation((name: string) => {
      if (name === "senthra_image") return Promise.resolve(stored());
      if (name === "senthra_raw") return notFound();
      return Promise.resolve(stored({ name, settings: { allowed_formats: ["png"] } }));
    });
    const DRIFTED = { name: "senthra_other", allowedFormats: ["png", "gif"] };

    const r = await inspectUploadPresets([IMAGE, RAW, DRIFTED], CREDS);

    expect(r).toEqual({
      ok: true,
      presets: [
        { name: "senthra_image", status: "ready" },
        { name: "senthra_raw", status: "missing" },
        { name: "senthra_other", status: "drifted" },
      ],
    });
    expect(createPreset).not.toHaveBeenCalled();
    expect(updatePreset).not.toHaveBeenCalled();
  });

  it("is the credentials check: rejected credentials come back as a failure", async () => {
    getPreset.mockRejectedValue(apiError(401, "Invalid API key"));
    const r = await inspectUploadPresets([IMAGE], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/cloud name, API key and API secret/i) });
  });

  it("authenticates each read with the credentials it was given, never via the SDK's global config", async () => {
    getPreset.mockResolvedValue(stored());
    await inspectUploadPresets([IMAGE], CREDS);
    expect(config).not.toHaveBeenCalled();
    expect(getPreset).toHaveBeenCalledWith("senthra_image", expect.objectContaining(AUTH));
  });

  it("gives up on a read that never answers", async () => {
    getPreset.mockImplementation(() => new Promise(() => {}));
    const r = await inspectUploadPresets([IMAGE], CREDS, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/did not answer in time/i) });
  });

  it("reports a misrouted 404 as a failure rather than as every preset missing", async () => {
    getPreset.mockRejectedValue(apiError(404, "Server return invalid JSON response. Status Code 404"));
    const r = await inspectUploadPresets([IMAGE, RAW], CREDS);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/cloud name/i) });
  });

  it("makes no call when no preset is configured", async () => {
    await expect(inspectUploadPresets([], CREDS)).resolves.toEqual({ ok: true, presets: [] });
    expect(getPreset).not.toHaveBeenCalled();
  });
});
