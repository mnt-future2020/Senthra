import { describe, expect, it } from "vitest";

import { pdfSafeImageUrl } from "./document.utils.js";

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
