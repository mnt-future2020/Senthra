import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A class-level guard, not a unit test. Deleting from Cloudinary is the one operation in this app
// that destroys data an audit trail cannot reconstruct, and its safety lives entirely in ONE
// function — releaseAsset, which refuses while any row still references the asset. That guarantee is
// only worth anything if there is no second way to reach `destroy`.
//
// So: the transport may be imported by exactly one module. A service that imports it directly gets
// a delete with no reference count behind it, which is precisely how a converted PRF's quotation
// would vanish from a PO removal.

const SRC = join(import.meta.dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ path, rel: path.slice(SRC.length + 1).replace(/\\/g, "/"), src: readFileSync(path, "utf8") }));

// The only places allowed to name the destroy transport: the transport itself, the one service that
// wraps it in the reference check, and their tests.
const DESTROY_ALLOWLIST = [
  "lib/cloudinary.ts",
  "lib/__tests__/cloudinary.destroy.test.ts",
  "modules/attachment/attachment.service.ts",
  "modules/attachment/attachment.service.test.ts",
  "modules/attachment/attachment.boundary.test.ts",
];

describe("Cloudinary deletion has exactly one entrance", () => {
  it("is reached only through releaseAsset", () => {
    const offenders = files.filter((f) => f.src.includes("destroyFromCloudinary") && !DESTROY_ALLOWLIST.includes(f.rel));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  // `uploader.destroy` / `api.delete_resources` bypass our helper entirely and would carry no
  // reference check at all.
  it("nothing calls the Cloudinary SDK's delete APIs directly", () => {
    // This file is excluded because it contains the pattern it searches for.
    const offenders = files.filter(
      (f) =>
        /uploader\.destroy|delete_resources|api\.delete/.test(f.src) &&
        f.rel !== "lib/cloudinary.ts" &&
        f.rel !== "modules/attachment/attachment.boundary.test.ts",
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});

// The image helper is used for assets that must NOT be deleted on replacement: branding logo and
// favicon, and a user's signature, all upload with a DETERMINISTIC public_id and `overwrite: true`.
// Replacing one overwrites the file in place — there is nothing to clean up, and destroying the id
// would delete the live asset. Damage photos and acknowledgement signatures are audit evidence and
// are likewise never removed.
//
// The protection is structural: no cleanup path exists for any of them. This test states that as an
// intended property, so wiring one up has to be a decision rather than a copy-paste.
describe("deterministic and evidence assets have no deletion path", () => {
  // `user` and `customer` are deliberately ABSENT. They upload two kinds of image: a deterministic one
  // that overwrites in place (`signature-${userId}`), and a randomUUID one — the avatar and the company
  // logo — where a replacement uploads a NEW asset and the old file simply stops being referenced. Those
  // two DO release, because changing your picture is an ordinary success path and leaked a file every
  // time. The sites listed here have no random-id upload at all, so a cleanup path would have nothing
  // to clean and would only put a delete next to an asset that must survive.
  const IMAGE_UPLOAD_SITES = [
    "modules/settings/settings.service.ts", // logo / favicon — publicId is the literal type
    "modules/goods-management/goods-management.service.ts", // damage photos — audit evidence
    "modules/engineer-transfer/engineer-transfer.service.ts", // acknowledgement signature
    "modules/job-kit-request/job-kit-request.service.ts",
    "modules/van-stock-request/van-stock-request.service.ts",
  ];

  it.each(IMAGE_UPLOAD_SITES)("%s uploads but never releases", (rel) => {
    const file = files.find((f) => f.rel === rel);
    expect(file, `${rel} not found — was it moved?`).toBeDefined();
    expect(file!.src).toContain("uploadToCloudinary");
    expect(file!.src).not.toContain("releaseAsset");
    expect(file!.src).not.toContain("destroyFromCloudinary");
  });
});

// Job attachments are a bare `String[]` edited by replacing the whole array, so there is no
// "this one was removed" event to hang cleanup on and no row to hold an identity in. Deferred
// lifecycle debt, recorded here so it reads as a known gap rather than an oversight.
describe("job attachments remain deferred", () => {
  it("stores only URLs and never deletes", () => {
    const job = files.find((f) => f.rel === "modules/job/job.service.ts")!;
    expect(job.src).toContain("uploadFileToCloudinary");
    expect(job.src).not.toContain("releaseAsset");
  });
});

// `uploadToCloudinary` passes `overwrite: true`, which BRANDING and a user's signature depend on —
// replacing one must land on the same asset. The cost is that any publicId two concurrent uploads can
// agree on makes the second silently destroy the first, with nothing logged and nothing to notice.
//
// A timestamp is exactly such an id: `attach-${Date.now()}`, `sig-${id}-${Date.now()}` and
// `vsr-${kind}-${Date.now()}` collided on a shared millisecond, and damage photos — which back
// supplier and insurance claims — used a timestamp plus six Math.random characters, which can repeat.
describe("upload ids cannot collide", () => {
  it("no publicId is derived from a clock or Math.random", () => {
    const offenders = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .flatMap((f) =>
        f.src
          .split("\n")
          .map((line, i) => ({ rel: f.rel, line: i + 1, text: line }))
          // Comments discuss these ids — including the comments explaining why a clock is wrong — so
          // only real code is scanned.
          .filter(({ text }) => !/^\s*(\/\/|\*)/.test(text))
          .filter(({ text }) => /publicId|uploadToCloudinary|uploadFileToCloudinary/.test(text))
          .filter(({ text }) => /Date\.now\(\)|Math\.random\(\)/.test(text)),
      );
    expect(offenders.map((o) => `${o.rel}:${o.line}`)).toEqual([]);
  });

  // Every non-deterministic upload site names its asset with randomUUID. The deterministic ones
  // (branding `type`, `signature-${userId}`) are absent on purpose — they REPLACE, and a fresh id
  // each time would leak the old asset instead of overwriting it.
  it("the sites that must not collide all use randomUUID", () => {
    const rel = [
      "modules/engineer-transfer/engineer-transfer.service.ts",
      "modules/van-stock-request/van-stock-request.service.ts",
      "modules/goods-management/goods-management.service.ts",
      "modules/job/job.service.ts",
      "modules/job-kit-request/job-kit-request.service.ts",
    ];
    for (const r of rel) {
      const f = files.find((x) => x.rel === r);
      expect(f, `${r} not found — was it moved?`).toBeDefined();
      expect(f!.src, r).toMatch(/randomUUID/);
    }
  });
});

// The two random-id image uploads. A replacement does not overwrite them, so the file it replaces has
// to be released explicitly — and it goes through releaseAsset like everything else, never a direct
// destroy, so the single-entrance guarantee above still holds.
describe("avatar and company logo release the file they replace", () => {
  it.each([
    "modules/user/user.service.ts",
    "modules/customer/customer.service.ts",
  ])("%s releases through releaseAsset, not a direct destroy", (rel) => {
    const f = files.find((x) => x.rel === rel);
    expect(f, `${rel} not found — was it moved?`).toBeDefined();
    expect(f!.src).toContain("releaseAsset");
    expect(f!.src).not.toContain("destroyFromCloudinary");
  });

  // Identity has to be STORED for the release to have anything to address.
  it("stores the identity it will later need", () => {
    const user = files.find((x) => x.rel === "modules/user/user.service.ts")!;
    const customer = files.find((x) => x.rel === "modules/customer/customer.service.ts")!;
    expect(user.src).toMatch(/profileImagePublicId/);
    expect(customer.src).toMatch(/logoPublicId/);
  });
});
