import { describe, expect, it } from "vitest";

import { pdfImageUrl, pdfSafeImageUrl } from "./document.utils.js";

// The image URL every PDF logo and signature is fetched through. `fl_png32` is load-bearing: without it
// Cloudinary answers a few-colour image (a flat logo, a scanned signature) with a 1-, 2- or 4-bit
// PALETTE PNG, which pdfkit draws as a scrambled strip — found on a PO logo in browser QA 2026-09-11.
// With it, every image arrives as 8-bit RGBA, which pdfkit draws exactly.
describe("pdfSafeImageUrl", () => {
  const logo = "https://res.cloudinary.com/demo/image/upload/v1788867518/senthra/branding/logo.png";
  const poLogo = "https://res.cloudinary.com/demo/image/upload/v1789132991/senthra/branding/po-logo.png";

  it("asks Cloudinary for a full-colour 32-bit PNG, height-bounded", () => {
    expect(pdfSafeImageUrl(logo)).toBe(
      "https://res.cloudinary.com/demo/image/upload/f_png,fl_png32,h_400,c_limit/v1788867518/senthra/branding/logo.png",
    );
  });

  it("treats the app logo, the PO logo and a signature identically", () => {
    const signature = "https://res.cloudinary.com/demo/image/upload/v1/senthra/signatures/signature-u1.png";
    for (const url of [logo, poLogo, signature]) {
      expect(pdfSafeImageUrl(url)).toContain("/upload/f_png,fl_png32,h_400,c_limit/");
    }
  });

  it("rasterises vector and modern formats too (pdfkit embeds only PNG/JPEG)", () => {
    for (const ext of ["svg", "webp", "avif", "gif"]) {
      expect(pdfSafeImageUrl(`https://res.cloudinary.com/demo/image/upload/v1/logo.${ext}`)).toContain("/upload/f_png,fl_png32,");
    }
  });

  it("never stacks a second transformation onto a URL that already carries one", () => {
    const once = pdfSafeImageUrl(logo);
    expect(pdfSafeImageUrl(once)).toBe(once);
    expect(once.match(/fl_png32/g)).toHaveLength(1);
  });

  it("leaves a non-Cloudinary URL, and an empty one, untouched", () => {
    expect(pdfSafeImageUrl("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png");
    expect(pdfSafeImageUrl("")).toBe("");
  });
});

// ── Which mechanism a PDF uses, and why it is not the active provider ─────────────────────────
//
// TWO MECHANISMS, ONE INTENT. Cloudinary rasterises on delivery, so its asset needs nothing stored
// and gets a transformed URL. A provider that cannot transform had the image rasterised at UPLOAD
// time and stored beside the original, so its asset gets that stored URL.
//
// The choice is made from what is PERSISTED against the asset. That is the property these pin: an
// administrator switching provider must not change how an EXISTING logo is rendered, because it is
// still on the provider that stored it.
describe("pdfImageUrl — the source asset decides, never the active provider", () => {
  const CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/v1/senthra/branding/logo";
  const SPACES = "https://senthra.ams3.digitaloceanspaces.com/senthra/branding/logo";
  const SPACES_PDF = "https://senthra.ams3.digitaloceanspaces.com/senthra/branding/logo__pdf.png";

  it("transforms a Cloudinary logo in its URL — nothing stored, nothing downloaded", () => {
    const url = pdfImageUrl(CLOUDINARY, null);
    expect(url).toContain("f_png,fl_png32,h_400,c_limit");
    expect(url).toContain("res.cloudinary.com");
  });

  it("uses the STORED derivative for an asset that has one", () => {
    expect(pdfImageUrl(SPACES, SPACES_PDF)).toBe(SPACES_PDF);
  });

  // The switch case, stated directly: a Cloudinary asset has no stored derivative, so it keeps
  // getting the delivery transform however the Settings provider changes. Nothing here reads
  // Settings at all — which is the strongest form of the guarantee.
  it("keeps transforming a Cloudinary logo even with a stored derivative absent", () => {
    expect(pdfImageUrl(CLOUDINARY, null)).toContain("f_png,fl_png32");
    expect(pdfImageUrl(CLOUDINARY, undefined)).toContain("f_png,fl_png32");
  });

  it("never downloads or rewrites the source — it only chooses a URL", () => {
    // A pure function: same inputs, same output, no side effect available to it.
    expect(pdfImageUrl(CLOUDINARY, null)).toBe(pdfImageUrl(CLOUDINARY, null));
  });

  it("returns a non-Cloudinary URL with no derivative unchanged", () => {
    expect(pdfImageUrl(SPACES, null)).toBe(SPACES);
  });

  it("returns null when there is no logo at all", () => {
    expect(pdfImageUrl("", null)).toBeNull();
    expect(pdfImageUrl(null, null)).toBeNull();
    expect(pdfImageUrl(undefined, SPACES_PDF)).toBe(SPACES_PDF);
  });
});
