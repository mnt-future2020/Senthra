import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { DERIVATIVE_SPECS, derivativeKey, generateDerivatives, renderDerivative } from "./derivatives.js";
import type { StorageProvider } from "./types.js";

// ── Image derivatives ─────────────────────────────────────────────────────────────────────────
//
// `sharp` runs for real here — no mock. The whole point of these tests is what the BYTES come out
// as, and a mocked encoder could only confirm that the code called the functions it was written to
// call. The PNG header is read directly for the same reason: "sharp returned successfully" is not
// the property that matters.
//
// THE PNG HEADER, for the assertions below:
//   bytes  0–7   the 8-byte PNG signature
//   bytes  8–15  chunk length + "IHDR"
//   bytes 16–19  width           20–23  height
//   byte     24  bit depth       25     colour type
//
// Colour types: 0 grey · 2 RGB · 3 PALETTE · 4 grey+alpha · 6 RGBA
const ihdr = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
  bitDepth: png[24],
  colourType: png[25],
});

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/**
 * A GENUINE two-colour palette PNG — the exact shape this whole mechanism exists for.
 *
 * A flat company logo encodes like this: colour type 3, one bit per pixel. pdfkit draws it as a
 * scrambled strip of blocks, which is the bug `fl_png32` was introduced to fix on Cloudinary and
 * that `ensureAlpha()` has to fix here. The fixture is built rather than checked in so the test
 * cannot silently start passing against a PNG that was never indexed in the first place.
 */
async function twoColourPalettePng(width = 200, height = 60): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png({ palette: true, colours: 2 })
    .toBuffer();
}

/** A tall RGB source, for the height-cap assertions. */
async function tallPng(width = 100, height = 1000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

// ── The 2-colour requirement ──────────────────────────────────────────────────────────────────
describe("renderDerivative — a palette PNG becomes 8-bit RGBA", () => {
  it("starts from a genuinely indexed source (the fixture is what it claims)", async () => {
    const src = ihdr(await twoColourPalettePng());
    expect(src.colourType, "fixture must be PALETTE (3) or the test proves nothing").toBe(3);
    expect(src.bitDepth).toBeLessThan(8);
  });

  it.each(["pdf", "email"] as const)("converts it to bit depth 8, colour type 6 for %s", async (intent) => {
    const out = await renderDerivative(dataUri(await twoColourPalettePng()), intent);
    const got = ihdr(out);

    // THE assertion. pdfkit draws colour type 6 correctly and a low-bit-depth palette as garbage.
    expect(got.bitDepth).toBe(8);
    expect(got.colourType).toBe(6);
  });

  it("is not grey, grey+alpha, RGB-without-alpha, or palette", async () => {
    const got = ihdr(await renderDerivative(dataUri(await twoColourPalettePng()), "pdf"));
    expect([0, 2, 3, 4]).not.toContain(got.colourType);
  });

  it("keeps an ordinary RGB source at 8-bit RGBA too", async () => {
    const got = ihdr(await renderDerivative(dataUri(await tallPng(50, 50)), "pdf"));
    expect(got).toMatchObject({ bitDepth: 8, colourType: 6 });
  });
});

// ── The transform mapping ─────────────────────────────────────────────────────────────────────
//
// h_400 / h_80 + c_limit, expressed as sharp. The two heights must stay apart: 400 is sized for
// print, 80 is retina for a 34px logo in a mail client.
describe("renderDerivative — height cap and no upscaling", () => {
  it("caps a tall image at the pdf height", async () => {
    const got = ihdr(await renderDerivative(dataUri(await tallPng(100, 1000)), "pdf"));
    expect(got.height).toBe(DERIVATIVE_SPECS.pdf.maxHeight);
    expect(got.height).toBe(400);
  });

  it("caps it much lower for email", async () => {
    const got = ihdr(await renderDerivative(dataUri(await tallPng(100, 1000)), "email"));
    expect(got.height).toBe(DERIVATIVE_SPECS.email.maxHeight);
    expect(got.height).toBe(80);
  });

  it("preserves the aspect ratio while capping", async () => {
    const got = ihdr(await renderDerivative(dataUri(await tallPng(100, 1000)), "pdf"));
    // 100×1000 scaled to height 400 → width 40.
    expect(got.width).toBe(40);
  });

  // `c_limit` scales DOWN to fit and never up. A 60px signature blown up to 400 would go soft.
  it("does NOT enlarge a source shorter than the cap", async () => {
    const got = ihdr(await renderDerivative(dataUri(await tallPng(200, 60)), "pdf"));
    expect(got.height).toBe(60);
    expect(got.width).toBe(200);
  });

  it("refuses a source that is not a data URI rather than returning something unusable", async () => {
    await expect(renderDerivative("https://cdn/logo.png", "pdf")).rejects.toThrow(/data uri/i);
  });

  it("refuses bytes it cannot decode", async () => {
    await expect(renderDerivative("data:image/png;base64,AAAA", "pdf")).rejects.toThrow();
  });
});

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────
describe("derivativeKey", () => {
  it("derives from the SOURCE key, so the two stay associated", () => {
    expect(derivativeKey("logo", "pdf")).toBe("logo__pdf.png");
    expect(derivativeKey("logo", "email")).toBe("logo__email.png");
    expect(derivativeKey("signature-abc123", "pdf")).toBe("signature-abc123__pdf.png");
  });
});

// ── Storage interaction ───────────────────────────────────────────────────────────────────────
describe("generateDerivatives — what it stores, and what it cleans up", () => {
  let upload: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let storage: StorageProvider;
  let source: string;

  beforeEach(async () => {
    upload = vi.fn(async (_src: string, publicId: string) => ({
      url: `https://cdn.example/senthra/branding/${publicId}`,
      publicId: `senthra/branding/${publicId}`,
      resourceType: "image",
      provider: "spaces" as const,
    }));
    destroy = vi.fn(async () => undefined);
    storage = { id: "spaces", upload, destroy } as unknown as StorageProvider;
    source = dataUri(await twoColourPalettePng());
  });

  it("stores one object per intent, under the derived key", async () => {
    await generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]![1]).toBe("logo__pdf.png");
    expect(upload.mock.calls[1]![1]).toBe("logo__email.png");
  });

  it("returns the stored URL per intent", async () => {
    const urls = await generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage);
    expect(urls).toEqual({
      pdf: "https://cdn.example/senthra/branding/logo__pdf.png",
      email: "https://cdn.example/senthra/branding/logo__email.png",
    });
  });

  // A derivative key is derived from the SOURCE key, so a deterministic source produces a
  // deterministic derivative that is overwritten in place. A long cache there would keep serving the
  // old logo after it had been replaced — which is the bug the short TTL exists to prevent.
  it("stores every derivative as MUTABLE, because its key is overwritten in place", async () => {
    await generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage);
    for (const call of upload.mock.calls) {
      expect(call[2]).toMatchObject({ folder: "senthra/branding", kind: "image", immutable: false });
    }
  });

  it("uploads a PNG data URI, whatever the source format was", async () => {
    await generateDerivatives(source, "logo", "senthra/branding", ["pdf"], storage);
    expect(upload.mock.calls[0]![0]).toMatch(/^data:image\/png;base64,/);
  });

  it("does nothing when no intent is requested", async () => {
    await expect(generateDerivatives(source, "favicon", "senthra/branding", [], storage)).resolves.toEqual({});
    expect(upload).not.toHaveBeenCalled();
  });

  // ALL OR NOTHING: a set where the PDF variant exists and the email one does not would leave the
  // document correct and the email wrong, with nothing recording which.
  it("removes an already-stored derivative when a later one fails", async () => {
    upload.mockImplementationOnce(async (_s: string, publicId: string) => ({
      url: `https://cdn.example/${publicId}`,
      publicId: `senthra/branding/${publicId}`,
      resourceType: "image",
      provider: "spaces" as const,
    })).mockImplementationOnce(async () => {
      throw new Error("bucket unavailable");
    });

    await expect(
      generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage),
    ).rejects.toThrow("bucket unavailable");

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith({
      provider: "spaces",
      publicId: "senthra/branding/logo__pdf.png",
      resourceType: "image",
    });
  });

  // Cleanup goes through the SAME provider instance that stored the object — never a freshly
  // resolved one, which could by then be a different backend entirely.
  it("cleans up through the provider that stored it", async () => {
    upload.mockImplementationOnce(async (_s: string, publicId: string) => ({
      url: "u",
      publicId: `senthra/branding/${publicId}`,
      resourceType: "image",
      provider: "spaces" as const,
    })).mockImplementationOnce(async () => {
      throw new Error("nope");
    });

    await expect(
      generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage),
    ).rejects.toThrow();
    expect(destroy.mock.calls[0]![0]).toMatchObject({ provider: "spaces" });
  });

  it("surfaces the failure rather than returning a partial set", async () => {
    upload.mockRejectedValue(new Error("storage down"));
    await expect(
      generateDerivatives(source, "logo", "senthra/branding", ["pdf"], storage),
    ).rejects.toThrow("storage down");
  });

  // A cleanup that itself fails must not replace the real error with its own — the caller needs to
  // know why generation failed, not why the tidying up did.
  it("still reports the original failure when cleanup also fails", async () => {
    upload.mockImplementationOnce(async (_s: string, publicId: string) => ({
      url: "u",
      publicId: `senthra/branding/${publicId}`,
      resourceType: "image",
      provider: "spaces" as const,
    })).mockImplementationOnce(async () => {
      throw new Error("the real failure");
    });
    destroy.mockRejectedValue(new Error("cleanup failed too"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      generateDerivatives(source, "logo", "senthra/branding", ["pdf", "email"], storage),
    ).rejects.toThrow("the real failure");
    spy.mockRestore();
  });
});
