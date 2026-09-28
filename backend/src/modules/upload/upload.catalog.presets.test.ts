import { describe, expect, it } from "vitest";

import { UPLOAD_PURPOSES, formatsForMediaTypes, uploadPresetFormats } from "./upload.catalog.js";

// ── What each Cloudinary upload preset must allow ─────────────────────────────────────────────
//
// The presets are the account-side format allowlist for direct browser uploads, and they are
// created and repaired from THIS catalog (see `ensureUploadPresets`). Deriving them here rather than
// keeping a second list in the storage layer is what stops the two drifting apart: a media type
// added to a purpose reaches the preset on the next save, and a type nobody mapped to an extension
// fails loudly instead of being quietly left out of the allowlist.

describe("uploadPresetFormats", () => {
  it("lists every image format any purpose accepts, once, as Cloudinary extensions", () => {
    expect(uploadPresetFormats().image).toEqual(["gif", "jpeg", "jpg", "png", "webp"]);
  });

  it("lists every document and spreadsheet format any purpose accepts, once", () => {
    expect(uploadPresetFormats().raw).toEqual(["csv", "docx", "pdf", "xls", "xlsx"]);
  });

  it("is derived from the purposes — every media type of every purpose lands in one of the two lists", () => {
    const all = [...uploadPresetFormats().image, ...uploadPresetFormats().raw];
    for (const purpose of Object.values(UPLOAD_PURPOSES)) {
      for (const mediaType of purpose.mediaTypes) {
        for (const format of formatsForMediaTypes([mediaType])) expect(all).toContain(format);
      }
    }
  });
});

describe("formatsForMediaTypes", () => {
  it("maps a JPEG to both extensions Cloudinary distinguishes", () => {
    expect(formatsForMediaTypes(["image/jpeg"])).toEqual(["jpeg", "jpg"]);
  });

  it("refuses a media type nobody mapped to an extension, naming it", () => {
    expect(() => formatsForMediaTypes(["application/x-new-thing"])).toThrow(/application\/x-new-thing/);
  });
});
