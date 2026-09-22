import { beforeEach, describe, expect, it, vi } from "vitest";

// The ADAPTER half of `cloudinary.ts` — the part that presents the transport as a StorageProvider.
//
// The transport's own behaviour is covered next door (`__tests__/cloudinary.destroy.test.ts` for what
// it sends and what it treats as success, `__tests__/cloudinary.sign.test.ts` for the signature
// itself). What is tested HERE is the seam: that the adapter chooses the right transport, passes the
// arguments through unchanged, and reshapes the result without deciding anything of its own.
//
// The Cloudinary SDK is mocked rather than the transport, because the transport now lives in the
// same file. That is the stronger test anyway: it pins the exact SDK options — `overwrite`,
// `invalidate`, `resource_type` — that every existing caller depends on, so an adapter that quietly
// routed an image through the file transport would fail here rather than in production.
const { upload, destroy, config, apiSign, cloudUrl } = vi.hoisted(() => ({
  upload: vi.fn(),
  destroy: vi.fn(),
  config: vi.fn(),
  apiSign: vi.fn(),
  cloudUrl: vi.fn(),
}));
vi.mock("cloudinary", () => ({
  v2: { config, uploader: { upload, destroy }, utils: { api_sign_request: apiSign }, url: cloudUrl },
}));
// Deliberately NOT the real defaults. If the adapter ever hard-coded a preset name, these tests would
// keep passing against "senthra_image"/"senthra_raw" and prove nothing.
vi.mock("../../config/env.js", () => ({
  env: { CLOUDINARY_UPLOAD_PRESET_IMAGE: "configured-image", CLOUDINARY_UPLOAD_PRESET_RAW: "configured-raw" },
}));

import { createCloudinaryProvider } from "./cloudinary.js";
import { env } from "../../config/env.js";

const CREDS = { cloudName: "cloud", apiKey: "key", apiSecret: "secret" };
const PNG = "data:image/png;base64,AAAA";
const PDF = "data:application/pdf;base64,AAAA";

const provider = () => createCloudinaryProvider(CREDS);

beforeEach(() => {
  upload.mockReset().mockResolvedValue({
    secure_url: "https://res.cloudinary.com/cloud/image/upload/v1/senthra/users/avatar",
    public_id: "senthra/users/avatar",
    resource_type: "image",
  });
  destroy.mockReset().mockResolvedValue({ result: "ok" });
  config.mockReset();
  apiSign.mockReset().mockReturnValue("signed-hex");
  cloudUrl.mockReset().mockReturnValue("https://res.cloudinary.com/cloud/image/upload/s--x--/v1/a");
});

// ── kind → transport ───────────────────────────────────────────────────────────────────────────
//
// The distinction every existing caller depends on. `kind: "image"` is what branding, avatars,
// signatures, customer logos and evidence photos use; `kind: "file"` is the archived issued-PO PDF.
// Collapsing them would silently change four call sites — see UploadOptions.
describe("upload — kind selects the transport, nothing else does", () => {
  it('"image" forces the image resource type and overwrites in place', async () => {
    await provider().upload(PNG, "logo", { folder: "senthra/branding", kind: "image", immutable: false });

    expect(upload).toHaveBeenCalledWith(PNG, {
      folder: "senthra/branding",
      public_id: "logo",
      overwrite: true,
      invalidate: true,
      resource_type: "image",
    });
  });

  it('"file" derives the resource type from the MIME and does NOT overwrite', async () => {
    upload.mockResolvedValue({
      secure_url: "https://res.cloudinary.com/cloud/raw/upload/v1/senthra/purchase-orders/po.pdf",
      public_id: "senthra/purchase-orders/po.pdf",
      resource_type: "raw",
    });

    await provider().upload(PDF, "po", { folder: "senthra/purchase-orders", kind: "file", immutable: true });

    // `.pdf` baked into the public id, `raw` resource type, and no `overwrite`/`invalidate` keys —
    // exactly what uploadFileToCloudinary has always sent.
    expect(upload).toHaveBeenCalledWith(PDF, {
      folder: "senthra/purchase-orders",
      public_id: "po.pdf",
      resource_type: "raw",
    });
  });

  it("does NOT let `immutable` choose the transport", async () => {
    // A random-id avatar is `immutable: true` but has always gone through the IMAGE transport. If the
    // adapter ever inferred the transport from `immutable`, this call would lose `invalidate: true`
    // and take its resource type from the MIME instead of being forced.
    await provider().upload(PNG, "abc-uuid", { folder: "senthra/users", kind: "image", immutable: true });

    expect(upload).toHaveBeenCalledWith(
      PNG,
      expect.objectContaining({ resource_type: "image", overwrite: true, invalidate: true }),
    );
  });

  it("reports what Cloudinary stored, tagged with the provider that stored it", async () => {
    const asset = await provider().upload(PNG, "avatar", {
      folder: "senthra/users",
      kind: "image",
      immutable: true,
    });

    // The identity is passed through from the RESULT, never from what we asked for — and `provider`
    // is stamped on so a later delete can be routed without consulting the active setting.
    expect(asset).toEqual({
      url: "https://res.cloudinary.com/cloud/image/upload/v1/senthra/users/avatar",
      publicId: "senthra/users/avatar",
      resourceType: "image",
      provider: "cloudinary",
    });
  });
});

// ── destroy ────────────────────────────────────────────────────────────────────────────────────
describe("destroy — addressed by BOTH halves of the identity", () => {
  it("passes publicId and resourceType through to the transport", async () => {
    await provider().destroy({ provider: "cloudinary", publicId: "senthra/jobs/a.pdf", resourceType: "raw" });

    expect(destroy).toHaveBeenCalledWith("senthra/jobs/a.pdf", { resource_type: "raw", invalidate: true });
  });

  it("does not widen the transport's contract: an already-missing asset is still a success", async () => {
    destroy.mockResolvedValue({ result: "not found" });

    await expect(
      provider().destroy({ provider: "cloudinary", publicId: "gone", resourceType: "image" }),
    ).resolves.toBeUndefined();
  });
});

// ── signUpload ─────────────────────────────────────────────────────────────────────────────────
//
// The field NAMES are the contract with the browser. Cloudinary rebuilds its signature from what it
// receives, so a renamed or dropped field is a failed upload — see frontend/src/lib/upload.ts, which
// posts exactly these keys today.
describe("signUpload — the envelope carries the fields Cloudinary expects", () => {
  const spec = {
    folder: "senthra/jobs",
    publicId: "uuid/Report.pdf",
    resourceType: "raw",
    mediaType: "application/pdf",
    maxBytes: 10 * 1024 * 1024,
  };

  it("maps every signed value onto its Cloudinary field name", async () => {
    const signed = await provider().signUpload(spec);

    expect(signed.method).toBe("POST");
    expect(signed.url).toBe("https://api.cloudinary.com/v1_1/cloud/raw/upload");
    expect(signed.fields).toEqual({
      api_key: "key",
      timestamp: expect.stringMatching(/^\d+$/),
      signature: "signed-hex",
      folder: "senthra/jobs",
      public_id: "uuid/Report.pdf",
      overwrite: "false",
      upload_preset: "configured-raw",
    });
  });

  it("returns the FULL key, folder included — the form the pending-upload ledger is keyed by", async () => {
    expect((await provider().signUpload(spec)).publicId).toBe("senthra/jobs/uuid/Report.pdf");
  });

  it("reads the preset from config, one per resource type", async () => {
    expect((await provider().signUpload(spec)).fields.upload_preset).toBe("configured-raw");
    const image = await provider().signUpload({ ...spec, resourceType: "image" });
    expect(image.fields.upload_preset).toBe("configured-image");
  });

  // MOVED HERE from upload.service.test.ts along with preset resolution itself. Blank means "sign
  // without a preset", which is the pre-preset behaviour and the escape hatch for an account that
  // has none — losing it would make the presets mandatory by accident.
  it("signs without a preset when the configured name is blank", async () => {
    const mutable = env as { CLOUDINARY_UPLOAD_PRESET_RAW: string };
    const configured = mutable.CLOUDINARY_UPLOAD_PRESET_RAW;
    mutable.CLOUDINARY_UPLOAD_PRESET_RAW = "  ";
    try {
      const signed = await provider().signUpload(spec);
      expect(signed.fields.upload_preset).toBeUndefined();
      expect(apiSign).toHaveBeenCalledWith(expect.not.objectContaining({ upload_preset: expect.anything() }), "secret");
    } finally {
      mutable.CLOUDINARY_UPLOAD_PRESET_RAW = configured;
    }
  });

  it("signs the preset, so a client cannot swap it for a looser one", () => {
    provider().signUpload(spec);

    // The preset is INSIDE the payload handed to api_sign_request, not merely posted alongside it.
    expect(apiSign).toHaveBeenCalledWith(expect.objectContaining({ upload_preset: "configured-raw" }), "secret");
  });

  it("signs `overwrite: false`, which is what stops a replay replacing a validated asset", () => {
    provider().signUpload(spec);

    expect(apiSign).toHaveBeenCalledWith(expect.objectContaining({ overwrite: false }), "secret");
  });
});

// ── confirmUpload ──────────────────────────────────────────────────────────────────────────────
//
// `UploadEvidence` makes both fields optional because a provider with no signed response has nothing
// to put in them. Cloudinary HAS one, so the optionality must not become a bypass here.
describe("confirmUpload — the optional evidence is not optional for Cloudinary", () => {
  const ref = { provider: "cloudinary" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  it("accepts a response whose signature matches", async () => {
    apiSign.mockReturnValue("matching");

    await expect(provider().confirmUpload(ref, { version: 17, signature: "matching" })).resolves.toBeUndefined();
    expect(apiSign).toHaveBeenCalledWith({ public_id: ref.publicId, version: 17 }, "secret");
  });

  it("refuses a signature that does not match", async () => {
    apiSign.mockReturnValue("expected");

    await expect(provider().confirmUpload(ref, { version: 17, signature: "tampered" })).rejects.toThrow(
      "That upload could not be verified.",
    );
  });

  it("refuses a missing signature rather than skipping the check", async () => {
    await expect(provider().confirmUpload(ref, { version: 17 })).rejects.toThrow(
      "That upload could not be verified.",
    );
    expect(apiSign).not.toHaveBeenCalled();
  });

  it("refuses a missing version rather than skipping the check", async () => {
    await expect(provider().confirmUpload(ref, { signature: "whatever" })).rejects.toThrow(
      "That upload could not be verified.",
    );
    expect(apiSign).not.toHaveBeenCalled();
  });
});

// ── head ───────────────────────────────────────────────────────────────────────────────────────
//
// MOVED HERE from upload.service.test.ts along with `measure()` itself. The invariant is unchanged
// and is the reason this is not a one-line wrapper around `fetch`.
describe("head — the stored size, and the status checked before the header is believed", () => {
  const ref = { provider: "cloudinary" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };
  const respond = (bytes: number, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Map([["content-length", String(bytes)]]) as never,
      })),
    );

  it("reads the size from the delivery response", async () => {
    respond(2048);
    await expect(provider().head(ref)).resolves.toMatchObject({ sizeBytes: 2048 });
  });

  /**
   * A failed HEAD still carries a content-length — of its own error body. Believing it turns an
   * asset we could not read into a plausible small size, which then sails through the caller's size
   * ceiling. The status has to be tested before the header is used.
   */
  it("refuses a size read from a non-2xx delivery response", async () => {
    respond(71, 404);
    await expect(provider().head(ref)).rejects.toThrow(/could not verify the uploaded file \(http 404\)/i);
  });

  it("refuses when the probe fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    await expect(provider().head(ref)).rejects.toThrow(/could not verify/i);
  });

  it("refuses a missing or nonsensical content-length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Map() as never })));
    await expect(provider().head(ref)).rejects.toThrow(/could not verify the uploaded file/i);
  });
});

// ── deliveryUrl ────────────────────────────────────────────────────────────────────────────────
describe("deliveryUrl — signed, so an authenticated asset is readable back", () => {
  it("asks the transport for a signed URL addressed by both halves of the identity", () => {
    const url = provider().deliveryUrl({ provider: null, publicId: "senthra/jobs/a.pdf", resourceType: "raw" });

    expect(cloudUrl).toHaveBeenCalledWith("senthra/jobs/a.pdf", {
      resource_type: "raw",
      type: "upload",
      sign_url: true,
      secure: true,
    });
    expect(url).toBe("https://res.cloudinary.com/cloud/image/upload/s--x--/v1/a");
  });
});

// ── Ingest validation capability ──────────────────────────────────────────────────────────────
//
// The flag finalize reads to decide whether a magic-byte pass is needed. It is a statement about
// what the PROVIDER does, and getting it wrong in either direction is a real defect: `true` on a
// store that decodes nothing lets arbitrary bytes through as an image, and `false` on Cloudinary
// buys a pointless extra request on the highest-volume path in the app.
describe("validatesImagesOnIngest", () => {
  it("is TRUE — Cloudinary decodes an image on the way in and refuses what it cannot read", () => {
    expect(provider().validatesImagesOnIngest).toBe(true);
  });
});
