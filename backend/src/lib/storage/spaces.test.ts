import { beforeEach, describe, expect, it, vi } from "vitest";

// ── The Spaces adapter ────────────────────────────────────────────────────────────────────────
//
// The AWS SDK is mocked at the CLIENT boundary — `S3Client.send` and `createPresignedPost` — so
// these run with no network, no credentials and no bucket. What they pin is the set of decisions
// this adapter makes on the way past, and every one of them is a decision that fails silently when
// it is wrong:
//
//   • the object key must be EXACTLY the identity the database persists, or nothing can ever find
//     the file again;
//   • Content-Type must be explicit, or S3 stores `binary/octet-stream` and documents download as
//     blobs instead of opening;
//   • a deterministic key must NOT get a year-long cache, or a replaced logo is stuck at the edge;
//   • a ranged read must send a Range header, or a 10 MB probe downloads 10 MB.
const { send, presign } = vi.hoisted(() => ({ send: vi.fn(), presign: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  // Each command records its own input so a test can assert what the adapter asked for. Naming them
  // lets one assertion distinguish a HeadObject from a GetObject.
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = send;
    },
    PutObjectCommand: class extends Cmd {
      readonly name = "PutObject";
    },
    HeadObjectCommand: class extends Cmd {
      readonly name = "HeadObject";
    },
    GetObjectCommand: class extends Cmd {
      readonly name = "GetObject";
    },
    DeleteObjectCommand: class extends Cmd {
      readonly name = "DeleteObject";
    },
    CopyObjectCommand: class extends Cmd {
      readonly name = "CopyObject";
    },
  };
});
vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost: presign }));

import { createSpacesProvider, type SpacesConfig } from "./spaces.js";

const SECRET = "super-secret-do-not-leak";
const CONFIG: SpacesConfig = {
  endpoint: "https://ams3.digitaloceanspaces.com",
  region: "ams3",
  bucket: "senthra-prod",
  accessKeyId: "DO00EXAMPLE",
  secretAccessKey: SECRET,
  cdnUrl: null,
};

const provider = (over: Partial<SpacesConfig> = {}) => createSpacesProvider({ ...CONFIG, ...over });

const PNG = "data:image/png;base64,AAAA";
const PDF = "data:application/pdf;base64,AAAA";

/** The input of the single command that was sent. */
const sentInput = () => (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
const sentName = () => (send.mock.calls[0]![0] as { name: string }).name;

/** An SDK "not there" error, in the shape the SDK actually produces. */
const notFound = () => Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  presign.mockReset().mockResolvedValue({
    url: "https://senthra-prod.ams3.digitaloceanspaces.com",
    fields: { key: "k", policy: "p", "x-amz-signature": "s" },
  });
});

// ── Identity ──────────────────────────────────────────────────────────────────────────────────
describe("provider identity", () => {
  it('identifies itself as "spaces", which is what every stored row resolves against', () => {
    expect(provider().id).toBe("spaces");
  });
});

// ── upload ────────────────────────────────────────────────────────────────────────────────────
describe("upload — the object and the metadata written with it", () => {
  it("stores under exactly <folder>/<publicId>, unaltered", async () => {
    await provider().upload(PDF, "uuid/Report.pdf", {
      folder: "senthra/jobs",
      kind: "file",
      immutable: true,
    });
    expect(sentName()).toBe("PutObject");
    expect(sentInput()).toMatchObject({ Bucket: "senthra-prod", Key: "senthra/jobs/uuid/Report.pdf" });
  });

  // S3 stores `binary/octet-stream` when it is not told, and a PDF served under that type downloads
  // as an extensionless blob instead of opening in the viewer.
  it("sets Content-Type explicitly from the data URI, never by inference", async () => {
    await provider().upload(PDF, "po", { folder: "senthra/purchase-orders", kind: "file", immutable: true });
    expect(sentInput().ContentType).toBe("application/pdf");
  });

  it("sets Content-Disposition inline so a document opens rather than downloads", async () => {
    await provider().upload(PDF, "po", { folder: "senthra/purchase-orders", kind: "file", immutable: true });
    expect(sentInput().ContentDisposition).toBe("inline");
  });

  // Phase 1: the delivery URL every stored record holds must keep working without an authenticated
  // request.
  it("writes the object public-read", async () => {
    await provider().upload(PNG, "logo", { folder: "senthra/branding", kind: "image", immutable: false });
    expect(sentInput().ACL).toBe("public-read");
  });

  it("returns the stored identity, tagged with the provider that stored it", async () => {
    const asset = await provider().upload(PNG, "avatar-uuid", {
      folder: "senthra/users",
      kind: "image",
      immutable: true,
    });
    expect(asset).toEqual({
      url: "https://senthra-prod.ams3.digitaloceanspaces.com/senthra/users/avatar-uuid",
      publicId: "senthra/users/avatar-uuid",
      resourceType: "image",
      provider: "spaces",
    });
  });

  it("surfaces a configuration failure without naming the secret", async () => {
    send.mockRejectedValue(Object.assign(new Error("boom"), { name: "NoSuchBucket" }));
    await expect(
      provider().upload(PNG, "x", { folder: "f", kind: "image", immutable: true }),
    ).rejects.toThrow(/bucket does not exist/i);
  });
});

// ── Cache-Control ─────────────────────────────────────────────────────────────────────────────
//
// The one decision Cloudinary makes for itself and S3 cannot. Getting it backwards is invisible
// until someone replaces a logo and it does not change for a year.
describe("upload — cache policy follows mutability, not convenience", () => {
  it("gives a DETERMINISTIC key a short TTL so a replacement is not stuck at the edge", async () => {
    await provider().upload(PNG, "logo", { folder: "senthra/branding", kind: "image", immutable: false });
    expect(sentInput().CacheControl).toBe("public, max-age=300");
  });

  it("gives a UUID key the long immutable policy, because it can never be rewritten", async () => {
    await provider().upload(PNG, "avatar-uuid", { folder: "senthra/users", kind: "image", immutable: true });
    expect(sentInput().CacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("never gives a mutable key the immutable policy", async () => {
    await provider().upload(PNG, "signature-abc", { folder: "senthra/signatures", kind: "image", immutable: false });
    expect(String(sentInput().CacheControl)).not.toMatch(/immutable/);
  });
});

// ── signUpload ────────────────────────────────────────────────────────────────────────────────
describe("signUpload — a presigned POST in the neutral envelope", () => {
  const spec = {
    folder: "senthra/jobs",
    publicId: "uuid/Report.pdf",
    resourceType: "raw",
    mediaType: "application/pdf",
    maxBytes: 10 * 1024 * 1024,
  };

  // CHANGED, deliberately: the permit is now minted for a STAGING key, never the key this app
  // serves. An S3 POST policy authorises a destination for its whole lifetime rather than for one
  // use, so a permit issued against the real key let a client replace approved bytes after finalize
  // had validated them. See `promoteUpload`.
  it("presigns against the configured bucket and the STAGING key", async () => {
    await provider().signUpload(spec);
    expect(presign.mock.calls[0]![1]).toMatchObject({
      Bucket: "senthra-prod",
      Key: "senthra/jobs/uuid/Report.pdf.staged",
    });
  });

  it("returns a POST envelope carrying the presigned url and fields verbatim", async () => {
    const signed = await provider().signUpload(spec);
    expect(signed.method).toBe("POST");
    expect(signed.url).toBe("https://senthra-prod.ams3.digitaloceanspaces.com");
    expect(signed.fields).toEqual({ key: "k", policy: "p", "x-amz-signature": "s" });
  });

  // The identity the PENDING row, head, readRange and discard all use while the upload is being
  // checked. It becomes the final key at promotion, which is what the attachment row records.
  it("returns the staging key as publicId, which is where the bytes actually land", async () => {
    const signed = await provider().signUpload(spec);
    expect(signed.publicId).toBe("senthra/jobs/uuid/Report.pdf.staged");
  });

  it("pins the content type in the policy, not merely in the form", async () => {
    await provider().signUpload(spec);
    const args = presign.mock.calls[0]![1] as { Fields: Record<string, string>; Conditions: unknown[] };
    expect(args.Fields["Content-Type"]).toBe("application/pdf");
    expect(args.Conditions).toContainEqual(["eq", "$Content-Type", "application/pdf"]);
  });

  // This is what replaces Cloudinary's upload preset: the only cap enforced BEFORE the bytes are
  // spent. Losing it would move the ceiling to finalize, i.e. after a 10 MB upload completed.
  it("carries the purpose's byte ceiling as a policy condition", async () => {
    await provider().signUpload(spec);
    const args = presign.mock.calls[0]![1] as { Conditions: unknown[] };
    expect(args.Conditions).toContainEqual(["content-length-range", 1, 10 * 1024 * 1024]);
  });

  it("pins the key exactly, so a holder of the policy cannot write to another object", async () => {
    await provider().signUpload(spec);
    const args = presign.mock.calls[0]![1] as { Conditions: unknown[] };
    expect(args.Conditions).toContainEqual(["eq", "$key", "senthra/jobs/uuid/Report.pdf.staged"]);
  });

  // The point of the whole arrangement: whatever the permit allows, it does NOT allow writing to
  // the key the app serves.
  it("never authorises the key the app actually serves", async () => {
    await provider().signUpload(spec);
    const args = presign.mock.calls[0]![1] as { Key: string; Conditions: unknown[] };
    expect(args.Key).not.toBe("senthra/jobs/uuid/Report.pdf");
    expect(JSON.stringify(args.Conditions)).not.toContain('"senthra/jobs/uuid/Report.pdf"');
  });

  it("expires the policy quickly, matching the Cloudinary signature's window", async () => {
    await provider().signUpload(spec);
    expect(presign.mock.calls[0]![1]).toMatchObject({ Expires: 120 });
  });

  // The browser must not be able to tell which provider it is talking to.
  it("adds no Cloudinary concept to the envelope", async () => {
    const signed = (await provider().signUpload(spec)) as unknown as Record<string, unknown>;
    for (const leaked of ["cloudName", "apiKey", "timestamp", "signature", "uploadPreset", "uploadUrl"]) {
      expect(signed, leaked).not.toHaveProperty(leaked);
    }
  });

  it("echoes the resourceType it was given rather than inventing one", async () => {
    // Spaces has one flat namespace and ignores it; the SERVICE stamps its own value on the ledger,
    // so replacing it here would create two values for one asset.
    expect((await provider().signUpload(spec)).resourceType).toBe("raw");
    expect((await provider().signUpload({ ...spec, resourceType: "image" })).resourceType).toBe("image");
  });

  it("surfaces a presigning failure without naming the secret", async () => {
    presign.mockRejectedValue(Object.assign(new Error("nope"), { name: "InvalidAccessKeyId" }));
    await expect(provider().signUpload(spec)).rejects.toThrow(/credentials were refused/i);
  });
});

// ── confirmUpload ─────────────────────────────────────────────────────────────────────────────
describe("confirmUpload — the object exists, because S3 issues no receipt", () => {
  const ref = { provider: "spaces" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  it("accepts an object that is there", async () => {
    send.mockResolvedValue({ ContentLength: 10 });
    await expect(provider().confirmUpload(ref, {})).resolves.toBeUndefined();
    expect(sentName()).toBe("HeadObject");
  });

  it("refuses a missing object with the same message Cloudinary gives", async () => {
    send.mockRejectedValue(notFound());
    await expect(provider().confirmUpload(ref, {})).rejects.toThrow("That upload could not be verified.");
  });
});

// ── head ──────────────────────────────────────────────────────────────────────────────────────
describe("head — metadata only", () => {
  const ref = { provider: "spaces" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  it("returns the stored size and content type", async () => {
    send.mockResolvedValue({ ContentLength: 2048, ContentType: "application/pdf" });
    await expect(provider().head(ref)).resolves.toEqual({ sizeBytes: 2048, contentType: "application/pdf" });
  });

  it("uses HeadObject, never a full download", async () => {
    send.mockResolvedValue({ ContentLength: 1 });
    await provider().head(ref);
    expect(sentName()).toBe("HeadObject");
    expect(send).toHaveBeenCalledTimes(1);
  });

  // A zero-length object is a real, successful answer; a missing one is not. The caller's size
  // ceiling depends on telling them apart.
  it("reports a zero-length object as a size, not as an error", async () => {
    send.mockResolvedValue({ ContentLength: 0, ContentType: "text/csv" });
    await expect(provider().head(ref)).resolves.toEqual({ sizeBytes: 0, contentType: "text/csv" });
  });

  it("throws for a missing object rather than reporting zero", async () => {
    send.mockRejectedValue(notFound());
    await expect(provider().head(ref)).rejects.toThrow(/could not verify the uploaded file/i);
  });
});

// ── readRange ─────────────────────────────────────────────────────────────────────────────────
describe("readRange — a ranged read, not a download", () => {
  const ref = { provider: "spaces" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  /** A body in the shape the SDK returns, tracking whether its stream was drained. */
  const body = (bytes: number[]) => {
    const state = { released: false };
    return {
      state,
      Body: {
        transformToByteArray: async () => {
          state.released = true;
          return new Uint8Array(bytes);
        },
      },
    };
  };

  it("asks for exactly the first N bytes", async () => {
    send.mockResolvedValue(body([1, 2, 3, 4]));
    await provider().readRange(ref, 1024);
    expect(sentName()).toBe("GetObject");
    expect(sentInput().Range).toBe("bytes=0-1023");
  });

  it("returns the bytes it read", async () => {
    send.mockResolvedValue(body([0x25, 0x50, 0x44, 0x46]));
    await expect(provider().readRange(ref, 4)).resolves.toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  });

  it("never returns more than was asked for", async () => {
    send.mockResolvedValue(body([1, 2, 3, 4, 5, 6, 7, 8]));
    expect((await provider().readRange(ref, 4)).length).toBe(4);
  });

  // Abandoning the body half-read leaks a socket per call, and the symptom is a process that stops
  // being able to reach Spaces at all after a few hundred uploads.
  it("drains the response stream so the connection is released", async () => {
    const b = body([1, 2, 3]);
    send.mockResolvedValue(b);
    await provider().readRange(ref, 3);
    expect(b.state.released).toBe(true);
  });

  it("refuses a missing object rather than returning empty bytes", async () => {
    send.mockRejectedValue(notFound());
    await expect(provider().readRange(ref, 16)).rejects.toThrow(/could not read the uploaded file/i);
  });
});

// ── destroy ───────────────────────────────────────────────────────────────────────────────────
describe("destroy — idempotent, like the Cloudinary adapter", () => {
  const ref = { provider: "spaces" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  it("deletes the exact bucket and key", async () => {
    await provider().destroy(ref);
    expect(sentName()).toBe("DeleteObject");
    expect(sentInput()).toMatchObject({ Bucket: "senthra-prod", Key: "senthra/jobs/a.pdf" });
  });

  // Matching Cloudinary exactly: an already-gone asset means the intended end state holds, and
  // treating it as an error would make a retry look broken.
  it("treats an already-missing object as success", async () => {
    send.mockRejectedValue(notFound());
    await expect(provider().destroy(ref)).resolves.toBeUndefined();
  });

  it("still reports a real failure", async () => {
    send.mockRejectedValue(Object.assign(new Error("service down"), { name: "ServiceUnavailable" }));
    await expect(provider().destroy(ref)).rejects.toThrow("service down");
  });
});

// ── deliveryUrl ───────────────────────────────────────────────────────────────────────────────
describe("deliveryUrl — public in Phase 1", () => {
  const ref = { provider: "spaces" as const, publicId: "senthra/jobs/a.pdf", resourceType: "raw" };

  it("builds from the bucket host when no CDN is configured", () => {
    expect(provider().deliveryUrl(ref)).toBe(
      "https://senthra-prod.ams3.digitaloceanspaces.com/senthra/jobs/a.pdf",
    );
  });

  it("uses the CDN origin when one is configured", () => {
    const url = provider({ cdnUrl: "https://cdn.senthra.co.uk" }).deliveryUrl(ref);
    expect(url).toBe("https://cdn.senthra.co.uk/senthra/jobs/a.pdf");
  });

  it("normalises the separator to exactly one slash", () => {
    expect(provider({ cdnUrl: "https://cdn.senthra.co.uk/" }).deliveryUrl(ref)).toBe(
      "https://cdn.senthra.co.uk/senthra/jobs/a.pdf",
    );
  });

  it("does not rewrite the persisted key", () => {
    const odd = { ...ref, publicId: "senthra/jobs/uuid/My_Report.final.v2.pdf" };
    expect(provider().deliveryUrl(odd)).toContain("/senthra/jobs/uuid/My_Report.final.v2.pdf");
  });

  // A signed URL would expire, and every stored record already holds a URL of this shape.
  it("returns a plain URL, never a signed one", () => {
    expect(provider().deliveryUrl(ref)).not.toMatch(/X-Amz-Signature|x-amz-signature/i);
  });
});

// ── Secrets ───────────────────────────────────────────────────────────────────────────────────
//
// The secret key reaches this adapter and must never leave it — not in a URL, not in an envelope,
// not in an error a user reads.
describe("the secret key never escapes", () => {
  it("is absent from a delivery URL", () => {
    const ref = { provider: "spaces" as const, publicId: "a", resourceType: "raw" };
    expect(provider().deliveryUrl(ref)).not.toContain(SECRET);
  });

  it("is absent from the upload envelope", async () => {
    const signed = await provider().signUpload({
      folder: "f",
      publicId: "p",
      resourceType: "raw",
      mediaType: "application/pdf",
      maxBytes: 1024,
    });
    expect(JSON.stringify(signed)).not.toContain(SECRET);
  });

  it("is absent from every configuration error message", async () => {
    for (const name of ["NoSuchBucket", "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "Whatever"]) {
      send.mockRejectedValue(Object.assign(new Error(`failed using ${SECRET}`), { name }));
      const err = await provider()
        .upload(PNG, "x", { folder: "f", kind: "image", immutable: true })
        .catch((e: Error) => e);
      expect((err as Error).message, name).not.toContain(SECRET);
      expect((err as Error).message, name).not.toContain("DO00EXAMPLE");
    }
  });
});

// ── Ingest validation capability ──────────────────────────────────────────────────────────────
//
// FALSE, and this is the single most consequential line in the adapter. Spaces stores whatever bytes
// arrive without looking at them, so a file of arbitrary content uploaded as `image/png` is stored
// exactly as happily as a photograph. Declaring `true` here would tell finalize the check had
// already happened and silently disable image validation for every evidence photo in the app.
describe("validatesImagesOnIngest", () => {
  it("is FALSE — Spaces stores opaque bytes and decodes nothing", () => {
    expect(provider().validatesImagesOnIngest).toBe(false);
  });

  it("differs from Cloudinary, which is the whole reason finalize asks", () => {
    // Stated as a contrast so a future provider added by copy-paste has to make the choice rather
    // than inherit one.
    expect(provider().validatesImagesOnIngest).not.toBe(true);
  });
});

// ── Promotion ─────────────────────────────────────────────────────────────────────────────────
//
// The step that takes the approved bytes out of the permit's reach.
describe("promoteUpload", () => {
  const staged = { provider: "spaces" as const, publicId: "senthra/jobs/uuid/Report.pdf.staged", resourceType: "raw" as const };

  it("copies the staged object to the real key and returns it", async () => {
    const result = await provider().promoteUpload(staged);

    expect(result.publicId).toBe("senthra/jobs/uuid/Report.pdf");
    const copy = send.mock.calls.map((c) => c[0] as { name: string; input: Record<string, unknown> })
      .find((c) => c.name === "CopyObject")!;
    expect(copy.input).toMatchObject({
      Bucket: "senthra-prod",
      CopySource: "/senthra-prod/senthra/jobs/uuid/Report.pdf.staged",
      Key: "senthra/jobs/uuid/Report.pdf",
      MetadataDirective: "COPY",
    });
  });

  // A copy does NOT inherit the source's ACL. Omit it and every promoted file is private — which,
  // on a provider whose delivery URLs are plain and unauthenticated, means every attachment 403s.
  it("re-states the public-read ACL, which a copy does not inherit", async () => {
    await provider().promoteUpload(staged);
    const copy = send.mock.calls.map((c) => c[0] as { name: string; input: Record<string, unknown> })
      .find((c) => c.name === "CopyObject")!;
    expect(copy.input.ACL).toBe("public-read");
  });

  it("removes the staged copy once the real one exists", async () => {
    await provider().promoteUpload(staged);
    const names = send.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual(["CopyObject", "DeleteObject"]);
    const del = send.mock.calls[1]![0] as { input: { Key: string } };
    expect(del.input.Key).toBe("senthra/jobs/uuid/Report.pdf.staged");
  });

  // The bytes are safely at the real key by then. Rejecting here would fail an upload that worked,
  // and the pending row (keyed by the staging key) means the reaper still collects the leftover.
  it("still succeeds when the staged copy cannot be deleted", async () => {
    send.mockImplementation(async (cmd: { name: string }) => {
      if (cmd.name === "DeleteObject") throw new Error("denied");
      return {};
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(provider().promoteUpload(staged)).resolves.toMatchObject({
      publicId: "senthra/jobs/uuid/Report.pdf",
    });
  });

  it("fails loudly when the copy itself fails — nothing may be recorded", async () => {
    send.mockRejectedValue(Object.assign(new Error("no"), { name: "AccessDenied" }));
    await expect(provider().promoteUpload(staged)).rejects.toThrow();
  });

  // Defensive: an already-final ref (a legacy row, or Cloudinary's shape) must pass straight through
  // rather than have a suffix stripped off something that never had one.
  it("leaves an already-final ref completely alone", async () => {
    const final = { ...staged, publicId: "senthra/jobs/uuid/Report.pdf" };
    await expect(provider().promoteUpload(final)).resolves.toBe(final);
    expect(send).not.toHaveBeenCalled();
  });
});
