import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cloudinary.js", () => ({ uploadFileToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getCompanyTimezone: vi.fn().mockResolvedValue("Europe/London"),
}));

import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { uploadAttachment } from "./job.service.js";
import { MAX_JOB_ATTACHMENT_BYTES, uploadAttachmentSchema } from "./job.validation.js";

// Payloads carry REAL leading bytes. `dataUriOf` used to emit `AAAA…` under whatever media type the
// test named, which passed because the schema read that label instead of the file. It now reads the
// file, so a fixture has to be one.
const SIG: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], // %PDF-1.4
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [0x50, 0x4b, 0x03, 0x04],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
};

/** A data URI of a given media type whose decoded payload is `bytes` long and really IS that type. */
const dataUriOf = (mediaType: string, bytes: number) => {
  const head = Buffer.from(SIG[mediaType] ?? [0x4d, 0x5a, 0x90, 0x00]); // unknown → an executable
  const buf = Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x41)]);
  return `data:${mediaType};base64,${buf.toString("base64")}`;
};

/** A payload of one type wearing another type's label — what the signature check exists to catch. */
const mislabelled = (claimedMediaType: string, actual: keyof typeof SIG | "exe") => {
  const head = Buffer.from(actual === "exe" ? [0x4d, 0x5a, 0x90, 0x00] : SIG[actual]!);
  const buf = Buffer.concat([head, Buffer.alloc(1024, 0x41)]);
  return `data:${claimedMediaType};base64,${buf.toString("base64")}`;
};

const CREDS = { cloudName: "test-cloud", apiKey: "key", apiSecret: "secret" };
const PNG_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_DATA = "data:application/pdf;base64,JVBERi0xLjQKJ...";

describe("job uploadAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-data URI inputs", async () => {
    await expect(uploadAttachment("https://example.com/file.png")).rejects.toThrow("Upload a valid file.");
    await expect(uploadAttachment("invalid-data")).rejects.toThrow("Upload a valid file.");
  });

  it("throws when Cloudinary is unconfigured", async () => {
    vi.mocked(getCloudinaryCreds).mockResolvedValue(null);
    await expect(uploadAttachment(PNG_DATA)).rejects.toThrow("Cloudinary isn't configured");
  });

  it("uploads data URI to Cloudinary senthra/jobs folder and returns secure URL", async () => {
    vi.mocked(getCloudinaryCreds).mockResolvedValue(CREDS);
    vi.mocked(uploadFileToCloudinary).mockResolvedValue({
      url: "https://res.cloudinary.com/test/raw/upload/senthra/jobs/job-attach-123.pdf",
      publicId: "senthra/jobs/job-attach-123.pdf",
      resourceType: "raw",
    });

    const result = await uploadAttachment(PDF_DATA);
    expect(result).toEqual({ url: "https://res.cloudinary.com/test/raw/upload/senthra/jobs/job-attach-123.pdf" });
    expect(uploadFileToCloudinary).toHaveBeenCalledTimes(1);
    expect(uploadFileToCloudinary).toHaveBeenCalledWith(PDF_DATA, expect.stringMatching(/^job-attach-[a-f0-9]{8}$/), CREDS, "senthra/jobs");
  });

  it("sanitizes and preserves original filename in public_id", async () => {
    vi.mocked(getCloudinaryCreds).mockResolvedValue(CREDS);
    vi.mocked(uploadFileToCloudinary).mockResolvedValue({
      url: "https://res.cloudinary.com/test/raw/upload/senthra/jobs/site-survey-rev-c-a1b2c3d4.pdf",
      publicId: "senthra/jobs/site-survey-rev-c-a1b2c3d4.pdf",
      resourceType: "raw",
    });

    const result = await uploadAttachment(PDF_DATA, "Site Survey Rev C.pdf");
    expect(result).toEqual({ url: "https://res.cloudinary.com/test/raw/upload/senthra/jobs/site-survey-rev-c-a1b2c3d4.pdf" });
    expect(uploadFileToCloudinary).toHaveBeenCalledWith(PDF_DATA, expect.stringMatching(/^site-survey-rev-c-[a-f0-9]{8}$/), CREDS, "senthra/jobs");
  });

  describe("uploadAttachmentSchema", () => {
    it("validates data URI strings with optional fileName", () => {
      expect(uploadAttachmentSchema.safeParse({ data: PNG_DATA, fileName: "test.png" }).success).toBe(true);
      expect(uploadAttachmentSchema.safeParse({ data: PDF_DATA }).success).toBe(true);
    });

    it("rejects non-data URI data strings", () => {
      expect(uploadAttachmentSchema.safeParse({ data: "http://example.com" }).success).toBe(false);
      expect(uploadAttachmentSchema.safeParse({ data: "" }).success).toBe(false);
      expect(uploadAttachmentSchema.safeParse({}).success).toBe(false);
    });

    // A `data:` prefix says nothing about what follows. Without this gate any payload at all reaches
    // Cloudinary and comes back as a link staff, engineers AND customers click.
    it("rejects a file outside the picker's list, however well-formed the URI", () => {
      for (const mediaType of ["application/x-msdownload", "image/svg+xml", "text/html", "application/zip"]) {
        const res = uploadAttachmentSchema.safeParse({ data: dataUriOf(mediaType, 1024) });
        expect(res.success, mediaType).toBe(false);
      }
    });

    // The label is no longer what decides. An executable announcing itself as a PDF is refused, and
    // — the case a browser actually produces — a real DOCX with no media type at all is accepted,
    // where checking the label alone rejected a perfectly good document.
    it("judges the payload, not the media type in front of it", () => {
      expect(uploadAttachmentSchema.safeParse({ data: mislabelled("application/pdf", "exe") }).success).toBe(false);
      expect(uploadAttachmentSchema.safeParse({ data: mislabelled("image/png", "exe") }).success).toBe(false);
      const docxNoMime = mislabelled(
        "application/octet-stream",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(uploadAttachmentSchema.safeParse({ data: docxNoMime }).success).toBe(true);
    });

    it("accepts every media type the picker offers", () => {
      for (const mediaType of [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png",
        "image/jpeg",
      ]) {
        expect(uploadAttachmentSchema.safeParse({ data: dataUriOf(mediaType, 1024) }).success, mediaType).toBe(true);
      }
    });

    // The client checks 10 MB for a fast message; this is the check that actually holds, since the
    // client is not the only thing that can call this endpoint.
    it("caps the decoded size at 10 MB", () => {
      expect(uploadAttachmentSchema.safeParse({ data: dataUriOf("image/png", MAX_JOB_ATTACHMENT_BYTES - 1024) }).success).toBe(true);
      expect(uploadAttachmentSchema.safeParse({ data: dataUriOf("image/png", MAX_JOB_ATTACHMENT_BYTES + 1024) }).success).toBe(false);
    });
  });
});
