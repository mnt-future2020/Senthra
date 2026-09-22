import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the settings row is mocked. The header HTML is built for real, because the bug this file
// exists for lives in the WIRING — `emailImageUrl` has always handled a stored derivative correctly
// (see email-html.test.ts); what was missing was anyone handing it one.
vi.mock("#modules/settings/settings.repository.js", () => ({
  getOrCreate: vi.fn(),
  findFirst: vi.fn(),
}));

import * as settingsRepo from "#modules/settings/settings.repository.js";

import { resolveBrandVars } from "./email.service.js";

const CLOUDINARY_LOGO = "https://res.cloudinary.com/demo/image/upload/v1/senthra/branding/logo.png";
const SPACES_LOGO = "https://files.example.com/senthra/branding/logo.svg";
const SPACES_EMAIL_LOGO = "https://files.example.com/senthra/branding/logo__email.png";

const mockRow = settingsRepo.getOrCreate as ReturnType<typeof vi.fn>;

/** A settings row carrying only what `resolveBrandVars` reads. */
function row(over: Record<string, unknown> = {}) {
  return {
    brandName: "Senthra",
    brandColor: "#7b6ef0",
    logoUrl: "",
    logoEmailUrl: null,
    smtpFromEmail: "no-reply@senthra.co",
    ...over,
  };
}

/** The `src` of the header's `<img>`, or null when the header rendered the name as text instead. */
function headerImgSrc(headerRow: string): string | null {
  return /<img src="([^"]+)"/.exec(headerRow)?.[1] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveBrandVars — the email header consumes the stored logo derivative", () => {
  // THE REGRESSION. A mail client renders no SVG, so a vector wordmark on a provider that cannot
  // transform at delivery has a PNG generated at upload time and stored in `logoEmailUrl`. If that
  // column stops reaching `buildEmailHeaderRow`, this asserts the raw SVG again — which is a header
  // that silently degrades to bare alt text in Gmail and Outlook.
  it("uses the stored email derivative as the header image", async () => {
    mockRow.mockResolvedValue(row({ logoUrl: SPACES_LOGO, logoEmailUrl: SPACES_EMAIL_LOGO }));
    const vars = await resolveBrandVars();
    expect(headerImgSrc(String(vars.emailHeaderRow))).toBe(SPACES_EMAIL_LOGO);
  });

  // The paired half of the same guarantee: the unrenderable source must not survive anywhere in the
  // header once a derivative exists.
  it("does not fall back to the source logo when a derivative is stored", async () => {
    mockRow.mockResolvedValue(row({ logoUrl: SPACES_LOGO, logoEmailUrl: SPACES_EMAIL_LOGO }));
    const vars = await resolveBrandVars();
    expect(String(vars.emailHeaderRow)).not.toContain(SPACES_LOGO);
  });

  // Cloudinary rasterises on delivery, so it stores no derivative and must keep getting the
  // transform it always has.
  it("keeps the Cloudinary delivery transform when no derivative is stored", async () => {
    mockRow.mockResolvedValue(row({ logoUrl: CLOUDINARY_LOGO, logoEmailUrl: null }));
    const vars = await resolveBrandVars();
    expect(headerImgSrc(String(vars.emailHeaderRow))).toBe(
      "https://res.cloudinary.com/demo/image/upload/f_png,h_80,c_limit/v1/senthra/branding/logo.png",
    );
  });

  // A row written before derivatives existed: no derivative, no transform to apply, so the source
  // is used exactly as stored — today's behaviour, unchanged.
  it("falls back to the source logo when no derivative exists", async () => {
    mockRow.mockResolvedValue(row({ logoUrl: SPACES_LOGO, logoEmailUrl: null }));
    const vars = await resolveBrandVars();
    expect(headerImgSrc(String(vars.emailHeaderRow))).toBe(SPACES_LOGO);
  });

  // No logo at all still renders the brand name as text, and a stray derivative cannot resurrect a
  // logo that is not set — the header keys off `logoUrl`, and must keep doing so.
  it("renders the brand name as text when no logo is set, derivative or not", async () => {
    mockRow.mockResolvedValue(row({ logoUrl: "", logoEmailUrl: SPACES_EMAIL_LOGO }));
    const vars = await resolveBrandVars();
    expect(headerImgSrc(String(vars.emailHeaderRow))).toBeNull();
    expect(String(vars.emailHeaderRow)).toContain("Senthra");
  });
});
