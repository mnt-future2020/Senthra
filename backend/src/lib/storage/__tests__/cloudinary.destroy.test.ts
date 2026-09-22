import { beforeEach, describe, expect, it, vi } from "vitest";

// The transport half of attachment cleanup. Thin by design, but two of its behaviours carry real
// weight: which resource_type it addresses, and what it treats as success.
// `vi.hoisted` because vi.mock's factory is lifted above these declarations.
const { upload, destroy, config } = vi.hoisted(() => ({ upload: vi.fn(), destroy: vi.fn(), config: vi.fn() }));
vi.mock("cloudinary", () => ({ v2: { config, uploader: { upload, destroy } } }));

import { destroyFromCloudinary, uploadFileToCloudinary } from "../cloudinary.js";

const CREDS = { cloudName: "cloud", apiKey: "key", apiSecret: "secret" };
const PDF = "data:application/pdf;base64,AAAA";
const PNG = "data:image/png;base64,AAAA";

beforeEach(() => {
  upload.mockReset();
  destroy.mockReset().mockResolvedValue({ result: "ok" });
  config.mockReset();
});

describe("uploadFileToCloudinary — returns the identity, not just a URL", () => {
  it("reports what Cloudinary actually stored", async () => {
    upload.mockResolvedValue({
      secure_url: "https://res.cloudinary.com/cloud/raw/upload/v1/senthra/jobs/survey.pdf",
      public_id: "senthra/jobs/survey.pdf",
      resource_type: "raw",
    });
    const asset = await uploadFileToCloudinary(PDF, "survey", CREDS, "senthra/jobs");
    expect(asset).toEqual({
      url: "https://res.cloudinary.com/cloud/raw/upload/v1/senthra/jobs/survey.pdf",
      publicId: "senthra/jobs/survey.pdf",
      resourceType: "raw",
    });
  });

  // The RESULT's public_id, not the one we asked for. A raw upload has its extension appended and
  // Cloudinary is free to normalise; recording our input instead would store an id that addresses
  // nothing, which is indistinguishable from having stored no id at all.
  it("trusts the upload result over the requested id", async () => {
    upload.mockResolvedValue({
      secure_url: "https://cdn/x",
      public_id: "senthra/jobs/survey.pdf", // extension baked in by the helper
      resource_type: "raw",
    });
    const asset = await uploadFileToCloudinary(PDF, "survey", CREDS, "senthra/jobs");
    expect(asset.publicId).toBe("senthra/jobs/survey.pdf");
    expect(asset.publicId).not.toBe("survey");
  });

  it("carries an image's resource type through unchanged", async () => {
    upload.mockResolvedValue({ secure_url: "https://cdn/p.png", public_id: "senthra/jobs/p", resource_type: "image" });
    expect((await uploadFileToCloudinary(PNG, "p", CREDS, "senthra/jobs")).resourceType).toBe("image");
  });
});

describe("destroyFromCloudinary", () => {
  it("addresses the asset by publicId AND resource_type", async () => {
    await destroyFromCloudinary("senthra/jobs/survey.pdf", "raw", CREDS);
    expect(destroy).toHaveBeenCalledWith("senthra/jobs/survey.pdf", expect.objectContaining({ resource_type: "raw" }));
  });

  // Without this the origin file is gone while the CDN keeps serving it — for a customer document
  // that cached copy is the part that actually matters.
  it("invalidates the CDN copy, not just the origin", async () => {
    await destroyFromCloudinary("senthra/jobs/x.pdf", "raw", CREDS);
    expect(destroy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ invalidate: true }));
  });

  it("configures the client with the caller's credentials", async () => {
    await destroyFromCloudinary("x", "raw", CREDS);
    expect(config).toHaveBeenCalledWith(expect.objectContaining({ cloud_name: "cloud", api_key: "key" }));
  });

  // An id Cloudinary has no record of is the END STATE WE WANTED — whether a previous attempt
  // already deleted it or it never existed. Raising here would make a retry look broken and would
  // fill the logs with lines nobody can act on.
  it("treats an already-missing asset as a successful cleanup", async () => {
    destroy.mockResolvedValue({ result: "not found" });
    await expect(destroyFromCloudinary("gone", "raw", CREDS)).resolves.toBeUndefined();
  });

  it("is idempotent — deleting twice is not an error", async () => {
    destroy.mockResolvedValueOnce({ result: "ok" }).mockResolvedValueOnce({ result: "not found" });
    await expect(destroyFromCloudinary("x", "raw", CREDS)).resolves.toBeUndefined();
    await expect(destroyFromCloudinary("x", "raw", CREDS)).resolves.toBeUndefined();
  });

  // Anything else IS a real failure and must reach the caller's log rather than being read as done.
  it("throws on any other result, naming it", async () => {
    destroy.mockResolvedValue({ result: "error" });
    await expect(destroyFromCloudinary("x", "raw", CREDS)).rejects.toThrow(/"error"/);
  });

  it("lets a transport error propagate", async () => {
    destroy.mockRejectedValue(new Error("ECONNRESET"));
    await expect(destroyFromCloudinary("x", "raw", CREDS)).rejects.toThrow("ECONNRESET");
  });
});
