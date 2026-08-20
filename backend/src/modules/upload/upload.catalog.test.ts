import { describe, expect, it } from "vitest";

import { UPLOAD_PURPOSES } from "./upload.catalog.js";

// The catalog is the ONLY place an upload's size limit lives, and a limit set too low fails in a way
// nobody reports: the picker refuses the file, the user assumes their photo is "wrong", and tries a
// different one. That is what happened to `damage_photo` before it was raised, and the same value
// was sitting in four more purposes. These pin the shape so it cannot drift back.

const MB = 1024 * 1024;

const EVIDENCE_PURPOSES = ["damage_photo", "vsr_attachment", "vsr_damage_photo", "transfer_attachment"] as const;

describe("evidence-photo purposes", () => {
  // Every one of these is captured on a phone, by an engineer in a van or a manager on the warehouse
  // floor, and a modern phone JPEG is routinely 4–15 MB. The browser downscales before uploading, so
  // a typical capture arrives far under this — the ceiling exists for the files compression cannot
  // help: a format the canvas will not decode, or a device too constrained to re-encode.
  it.each(EVIDENCE_PURPOSES)("%s accepts a full-size phone photo", (purpose) => {
    expect(UPLOAD_PURPOSES[purpose].maxBytes).toBe(10 * MB);
  });

  // Images only. These skip the magic-byte read that documents get, because Cloudinary's own decode
  // is the content check — it stores them as `image` and rejects anything it cannot decode. A
  // purpose that quietly gained a document type here would lose that guarantee.
  it.each(EVIDENCE_PURPOSES)("%s accepts images and nothing else", (purpose) => {
    for (const type of UPLOAD_PURPOSES[purpose].mediaTypes) {
      expect(type, `${purpose} allows ${type}`).toMatch(/^image\//);
    }
  });
});

describe("document purposes", () => {
  // Documents are the customer's own paperwork and are NOT downscaled — a canvas round trip would
  // destroy a PDF — so their ceilings have to hold the real file.
  it.each([
    ["job_attachment", 10],
    ["prf_attachment", 10],
    ["po_attachment", 10],
    ["grn_attachment", 5],
  ] as const)("%s caps at %i MB", (purpose, mb) => {
    expect(UPLOAD_PURPOSES[purpose].maxBytes).toBe(mb * MB);
  });
});

describe("every purpose", () => {
  it("declares a positive size cap", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.maxBytes, name).toBeGreaterThan(0);
    }
  });

  // A purpose with no accepted types would sign an upload of anything at all.
  it("declares at least one accepted media type", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.mediaTypes.length, name).toBeGreaterThan(0);
    }
  });

  // The permission list is what stops one module's picker minting a signature for another's folder.
  it("declares at least one permission", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.permissions.length, name).toBeGreaterThan(0);
    }
  });
});
