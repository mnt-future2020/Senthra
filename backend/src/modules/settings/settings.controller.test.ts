import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings.service.js", () => ({ setupCloudinaryPresets: vi.fn() }));

import * as settingsService from "./settings.service.js";
import { setupCloudinaryPresets } from "./settings.controller.js";

const mockSetup = settingsService.setupCloudinaryPresets as ReturnType<typeof vi.fn>;

// Drive a controller through asyncHandler and resolve once its async body has settled.
async function run(req: Partial<Request>) {
  const json = vi.fn();
  const res = { json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  setupCloudinaryPresets(req as Request, res, next);
  await new Promise((r) => setImmediate(r));
  return { json, next };
}

// POST /settings/storage/cloudinary/presets — the explicit "prepare the account" action. The
// controller has two jobs and no opinions: name WHO did it (the audit log records what was created
// in the client's account) and hand the result back exactly as the service worded it.
describe("setupCloudinaryPresets controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetup.mockResolvedValue({ ok: true, message: 'Cloudinary (cloud "demo"): senthra_image created.' });
  });

  it("attributes the action to the acting principal", async () => {
    await run({ body: {}, principal: { id: "a1", email: "admin@x.co", type: "admin", permissions: [] } } as unknown as Request);

    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockSetup.mock.calls[0]![0]).toEqual({ id: "a1", email: "admin@x.co", type: "admin" });
  });

  it("returns the service result verbatim — ok and message, nothing else", async () => {
    const { json, next } = await run({ body: {}, principal: { id: "a1", email: "admin@x.co", type: "admin" } } as unknown as Request);

    expect(json).toHaveBeenCalledWith({ ok: true, message: 'Cloudinary (cloud "demo"): senthra_image created.' });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns a refusal as a normal answer, not as an error", async () => {
    mockSetup.mockResolvedValue({ ok: false, message: "Cloudinary rejected the API key or secret." });

    const { json, next } = await run({ body: {}, principal: { id: "a1", type: "admin" } } as unknown as Request);

    expect(json).toHaveBeenCalledWith({ ok: false, message: "Cloudinary rejected the API key or secret." });
    expect(next).not.toHaveBeenCalled();
  });
});
