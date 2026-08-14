import { describe, expect, it } from "vitest";

import { uploadAttachmentSchema } from "./job-kit-request.validation.js";

// ── Attachment upload contract ──────────────────────────────────────────────────────────────────
//
// Fixtures carry REAL leading bytes rather than a placeholder under a chosen label. This schema judges
// the declared media type only, so a bare label would satisfy it — which is the weakness being closed.
const bytesOf = (signature: number[], pad = 40) =>
  Buffer.concat([Buffer.from(signature), Buffer.alloc(pad, 0x41)]).toString("base64");
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = bytesOf([0xff, 0xd8, 0xff, 0xe0]);
const GIF = bytesOf([...Buffer.from("GIF89a")]);
const PDF = bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d]);
const EXE = bytesOf([0x4d, 0x5a, 0x90, 0x00]); // a Windows executable
const ZIP = bytesOf([0x50, 0x4b, 0x03, 0x04]);
const uri = (mediaType: string, payload: string) => `data:${mediaType};base64,${payload}`;
const MAX_CHARS = 3 * 1024 * 1024;

// `application/octet-stream` is what a browser emits when it knows nothing about a file. Accepting it
// meant this endpoint accepted ANY payload under that one label — an executable, an archive — while
// the picker only ever offers `image/*`.
describe("uploadAttachmentSchema — kit-request evidence", () => {
  const parse = (v: string) => uploadAttachmentSchema.safeParse({ image: v });

  it("rejects application/octet-stream", () => {
    expect(parse(uri("application/octet-stream", PNG)).success).toBe(false);
  });

  it.each([
    ["an executable", EXE],
    ["a ZIP archive", ZIP],
  ])("rejects %s declared as octet-stream", (_l, payload) => {
    expect(parse(uri("application/octet-stream", payload)).success).toBe(false);
  });

  it.each([
    ["PNG", "image/png", PNG],
    ["JPEG", "image/jpeg", JPG],
    ["GIF", "image/gif", GIF],
    ["WEBP", "image/webp", GIF],
    ["SVG", "image/svg+xml", GIF],
    ["PDF", "application/pdf", PDF],
  ])("still accepts %s", (_l, mediaType, payload) => {
    expect(parse(uri(mediaType, payload)).success).toBe(true);
  });

  it("keeps the ~2 MB ceiling", () => {
    expect(parse(uri("image/png", "A".repeat(MAX_CHARS))).success).toBe(false);
  });

  it("still rejects a plain URL", () => {
    expect(parse("https://cdn.example.com/photo.png").success).toBe(false);
  });

  // Anchored to `;base64,`. A percent-encoded data URI is a different encoding, not a smaller one:
  // it used to pass this regex and fail later inside Cloudinary, surfacing an error from the wrong
  // layer with a message about nothing the caller did.
  it.each([
    ["a percent-encoded data URI", "data:image/png,hello-world"],
    ["a data URI with no encoding declared", "data:image/png,"],
    ["a charset instead of base64", "data:image/png;charset=utf-8,abc"],
  ])("rejects %s", (_l, v) => {
    expect(parse(v).success).toBe(false);
  });
});
