import { v2 as cloudinary } from "cloudinary";
import { describe, expect, it } from "vitest";

import { signUploadParams } from "./cloudinary.js";

// The signature is the only thing standing between a browser and an upload on our terms. Cloudinary
// rebuilds it from the fields the browser posts, so a field is enforced ONLY if it is signed — an
// unsigned one can be edited or dropped in flight and the upload still succeeds. These tests are about
// which fields are inside that boundary; the rest of the flow is covered in the upload module.

const CREDS = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };
const BASE = { folder: "senthra/purchase-orders", publicId: "quote.pdf", resourceType: "raw" as const };

/** What Cloudinary itself would compute for these fields — the check its API performs on arrival. */
const expected = (fields: Record<string, string | number | boolean>) =>
  cloudinary.utils.api_sign_request(fields, CREDS.apiSecret);

describe("signUploadParams", () => {
  it("signs the preset, so a client cannot swap it for a looser one", () => {
    const signed = signUploadParams({ ...BASE, uploadPreset: "senthra_raw" }, CREDS);

    expect(signed.signature).toBe(
      expected({
        folder: BASE.folder,
        public_id: BASE.publicId,
        overwrite: false,
        timestamp: signed.timestamp,
        upload_preset: "senthra_raw",
      }),
    );
  });

  // The whole point of the previous test, stated as the attack it prevents: posting a different preset
  // (or none) makes Cloudinary compute a different string, and the upload is refused.
  it("produces a different signature for a different preset, and for none", () => {
    const raw = signUploadParams({ ...BASE, uploadPreset: "senthra_raw" }, CREDS);
    const permissive = expected({
      folder: BASE.folder,
      public_id: BASE.publicId,
      overwrite: false,
      timestamp: raw.timestamp,
      upload_preset: "anything_goes",
    });
    const none = expected({
      folder: BASE.folder,
      public_id: BASE.publicId,
      overwrite: false,
      timestamp: raw.timestamp,
    });

    expect(raw.signature).not.toBe(permissive);
    expect(raw.signature).not.toBe(none);
  });

  it("hands the preset back so the browser can post the value that was signed", () => {
    expect(signUploadParams({ ...BASE, uploadPreset: "senthra_raw" }, CREDS).uploadPreset).toBe("senthra_raw");
  });

  it("signs without a preset when none is given, unchanged from before presets existed", () => {
    const signed = signUploadParams(BASE, CREDS);

    expect(signed.uploadPreset).toBeUndefined();
    expect(signed.signature).toBe(
      expected({ folder: BASE.folder, public_id: BASE.publicId, overwrite: false, timestamp: signed.timestamp }),
    );
  });

  it("still signs the folder and public id, which is what pins the asset's identity", () => {
    const moved = signUploadParams({ ...BASE, folder: "senthra/elsewhere", uploadPreset: "senthra_raw" }, CREDS);

    expect(moved.signature).not.toBe(
      expected({
        folder: BASE.folder,
        public_id: BASE.publicId,
        overwrite: false,
        timestamp: moved.timestamp,
        upload_preset: "senthra_raw",
      }),
    );
  });
});
