import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The PDF is rendered for real (pdfkit); only the SoT readers, the signature lookup and the network
// are mocked, so the test stays deterministic and offline while exercising the whole pipeline.
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyProfile: vi.fn(),
  getRegionalSettings: vi.fn(),
  getBranding: vi.fn(),
  getPurchaseOrderDocumentBranding: vi.fn(),
}));
vi.mock("#modules/user/user.service.js", () => ({
  getSignatureForEmail: vi.fn(),
  getDisplayNamesForEmails: vi.fn(),
}));

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import {
  getBranding,
  getCompanyProfile,
  getPurchaseOrderDocumentBranding,
  getRegionalSettings,
} from "#modules/settings/settings.service.js";
import { getDisplayNamesForEmails, getSignatureForEmail } from "#modules/user/user.service.js";
import { makePng, pdfContent, pdfImages, pdfPageCount, pdfText } from "./document.pdfText.testkit.js";
import { generatePurchaseOrderPdf } from "./document.service.js";

const company = {
  legalName: "Electra Networks Ltd",
  registrationNumber: "01234567",
  vatNumber: "GB1",
  addressLine1: "1 Way",
  addressLine2: null,
  city: "Bracknell",
  county: "Berkshire",
  postcode: "RG12 1NF",
  country: "United Kingdom",
  phone: "+44 1344",
  email: "po@electra.co",
  website: "",
  logoUrl: "",
};
const regional = { timezone: "Europe/London", dateFormat: "DD/MM/YYYY", timeFormat: "24h" };
const branding = {
  brandName: "Senthra",
  brandColor: "#7b6ef0",
  logoUrl: "",
  faviconUrl: "",
  footerText: "",
  loginHeadline: "",
  loginSubtext: "",
};

function po(over: Record<string, unknown> = {}): PurchaseOrderWithRelations {
  return {
    id: "po1",
    code: "PO-0001",
    currency: "GBP",
    status: "sent",
    priority: "normal",
    sentBy: "buyer@x.co",
    supplierName: "Acme",
    referenceNumber: null,
    orderDate: new Date("2026-06-01T00:00:00Z"),
    expectedDeliveryDate: new Date("2026-06-10T00:00:00Z"),
    deliveryAddress: null,
    subtotalPence: 7000,
    vatPence: 1400,
    grandTotalPence: 8400,
    supplierNotes: null,
    supplier: {
      name: "Acme Ltd",
      contactPerson: "Dana",
      contactEmail: "sales@acme.co",
      contactPhone: "0800",
      addressLine1: "5 Trade",
      addressLine2: null,
      city: "Leeds",
      county: null,
      postcode: "LS1",
      country: "UK",
    },
    warehouse: { name: "Leeds DC", addressLine1: "1 Depot", addressLine2: null, city: "Leeds", county: null, postcode: "LS2", country: "UK" },
    items: [{ itemName: "CAT6", sku: "C6", baseUnit: "Each", notes: null, quantity: 10, unitPricePence: 500, lineTotalPence: 5000 }],
    // Always supplied by the repository's include; hire rendering is covered in the builder tests.
    rentalItems: [],
    ...over,
  } as unknown as PurchaseOrderWithRelations;
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";
// Counts only real pages (the page-tree root `/Type /Pages` is excluded) — guards against a block
// accidentally spawning trailing blanks.
const countPdfPages = pdfPageCount;

beforeEach(() => {
  vi.clearAllMocks();
  (getCompanyProfile as ReturnType<typeof vi.fn>).mockResolvedValue(company);
  (getRegionalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(regional);
  (getBranding as ReturnType<typeof vi.fn>).mockResolvedValue(branding);
  // Nothing PO-specific configured: the reader hands back the app branding (see settings.poDocument.test).
  (getPurchaseOrderDocumentBranding as ReturnType<typeof vi.fn>).mockResolvedValue({ logoUrl: "", accentColor: branding.brandColor });
  (getSignatureForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (getDisplayNamesForEmails as ReturnType<typeof vi.fn>).mockResolvedValue({});
  // No network in tests — any image fetch fails fast and degrades to null.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});
afterEach(() => vi.unstubAllGlobals());

describe("generatePurchaseOrderPdf", () => {
  it("produces a real PDF buffer + canonical filename, signing from sentBy", async () => {
    const out = await generatePurchaseOrderPdf(po(), "viewer@x.co");
    expect(isPdf(out.buffer)).toBe(true);
    expect(countPdfPages(out.buffer)).toBe(1); // single-page PO — no trailing blank pages
    expect(out.buffer.length).toBeGreaterThan(800);
    expect(out.filename).toBe("PO-0001.pdf");
    expect(out.mimeType).toBe("application/pdf");
    // Signature is resolved from the PO's issuer, NOT the generatedBy actor.
    expect(getSignatureForEmail).toHaveBeenCalledWith("buyer@x.co");
  });

  it("does not throw when the signer's signature image can't be fetched", async () => {
    (getSignatureForEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      signerName: "Ava Stone",
      jobTitle: "Buyer",
      url: "https://cdn/sig.png",
      mimeType: "image/png",
    });
    const out = await generatePurchaseOrderPdf(po(), null);
    expect(isPdf(out.buffer)).toBe(true);
  });

  it("still generates a single-page PDF for an order with no items", async () => {
    const out = await generatePurchaseOrderPdf(po({ items: [] }));
    expect(isPdf(out.buffer)).toBe(true);
    expect(countPdfPages(out.buffer)).toBe(1);
  });

  // Renders end-to-end through pdfkit WITH the Terms & Authorisation section populated (project,
  // delivery/payment terms, prepared-by, approved-by) — proves drawTerms doesn't throw at runtime.
  it("renders a valid PDF with the terms & authorisation section populated", async () => {
    const out = await generatePurchaseOrderPdf(
      po({
        deliveryInstructions: "Call ahead; forklift required.",
        createdBy: "finance@x.co",
        approvedBy: "director@x.co",
        projectRef: "PROJ-77",
        job: null,
        supplier: { ...po().supplier, paymentTerms: "30 Days", customPaymentTerms: null },
      }),
      "viewer@x.co",
    );
    expect(isPdf(out.buffer)).toBe(true);
    expect(countPdfPages(out.buffer)).toBe(1);
  });

  // The signature block used to be dropped WHOLESALE when the issuer had no signature graphic on
  // file — taking the signer's name with it. An official PO then left the building naming nobody
  // who issued it. Most users never upload a signature, so this was the normal case, not the edge.
  it("still names the issuer when they have no signature image on file", async () => {
    (getSignatureForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getDisplayNamesForEmails as ReturnType<typeof vi.fn>).mockResolvedValue({ "buyer@x.co": { name: "Ava Stone", jobTitle: "Buyer" } });
    const out = await generatePurchaseOrderPdf(po(), null);
    expect(isPdf(out.buffer)).toBe(true);
    expect(pdfText(out.buffer)).toContain("Ava Stone");
    // ...and their designation, exactly as it appears when they DO have a signature image.
    expect(pdfText(out.buffer)).toContain("Buyer");
  });

  it("omits the signature block entirely for an unknown issuer", async () => {
    (getSignatureForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getDisplayNamesForEmails as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const out = await generatePurchaseOrderPdf(po(), null);
    expect(pdfText(out.buffer)).not.toContain("AUTHORISED BY");
  });

  // One lookup covers the signer AND the Prepared/Approved By names — the PDF is generated on every
  // send, every download and every archive, so a per-name round trip would be three queries a hit.
  it("resolves every person on the document in a single lookup", async () => {
    await generatePurchaseOrderPdf(po({ createdBy: "raiser@x.co", approvedBy: "boss@x.co" }), null);
    expect(getDisplayNamesForEmails).toHaveBeenCalledTimes(1);
    expect((getDisplayNamesForEmails as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
      expect.arrayContaining(["raiser@x.co", "boss@x.co", "buyer@x.co"]),
    );
  });
});

// ── PO document branding (Settings → Purchase Orders) ─────────────────────────────────────────
// A 1×1 PNG — enough for pdfkit to embed a real image XObject.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const pngResponse = () => new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
// pdfkit's fill operator for a #rrggbb colour: each channel over 255, then `scn`.
const fillOp = (hex: string) => `${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).join(" ")} scn`;
const mockPoBranding = getPurchaseOrderDocumentBranding as ReturnType<typeof vi.fn>;
const fetchedUrls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe("generatePurchaseOrderPdf — PO document branding", () => {
  it("prints with the app branding when nothing PO-specific is configured (unchanged behaviour)", async () => {
    mockPoBranding.mockResolvedValue({ logoUrl: "https://cdn/app-logo.png", accentColor: "#7b6ef0" });
    const out = await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual(["https://cdn/app-logo.png"]);
    expect(pdfContent(out.buffer)).toContain(fillOp("#7b6ef0"));
    // The offline fetch fails, so the letterhead falls back to the company name — exactly as before.
    expect(pdfText(out.buffer)).toContain("Electra Networks Ltd");
  });

  it("uses the PO-specific logo — and only that one", async () => {
    mockPoBranding.mockResolvedValue({ logoUrl: "https://cdn/po-logo.png", accentColor: "#7b6ef0" });
    (getCompanyProfile as ReturnType<typeof vi.fn>).mockResolvedValue({ ...company, logoUrl: "https://cdn/app-logo.png" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => pngResponse()));
    const out = await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual(["https://cdn/po-logo.png"]);
    expect(out.buffer.toString("latin1")).toMatch(/\/Subtype \/Image/);
  });

  it("paints the header band and headings in the PO-specific accent", async () => {
    mockPoBranding.mockResolvedValue({ logoUrl: "", accentColor: "#112233" });
    const content = pdfContent((await generatePurchaseOrderPdf(po(), null)).buffer);
    expect(content).toContain(fillOp("#112233"));
    expect(content).not.toContain(fillOp("#7b6ef0"));
  });

  it("expands a 3-digit accent the same way the settings screen does", async () => {
    mockPoBranding.mockResolvedValue({ logoUrl: "", accentColor: "#0a0" });
    const content = pdfContent((await generatePurchaseOrderPdf(po(), null)).buffer);
    expect(content).toContain(fillOp("#00aa00"));
  });

  // ── The stored pdfkit-safe derivative ────────────────────────────────────────────────────────
  //
  // A provider that cannot transform at delivery has the raster generated at UPLOAD time and stored
  // beside the original, so the document must embed THAT object. These four fail the moment
  // `logoPdfUrl` stops reaching the letterhead: the PDF silently falls back to the untransformed
  // original, which on a flat two-colour logo is the scrambled-strip bug the derivative exists for.
  it("embeds the stored PDF derivative instead of the original when one exists", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://files.example.com/senthra/branding/logo.svg",
      logoPdfUrl: "https://files.example.com/senthra/branding/logo__pdf.png",
      accentColor: "#7b6ef0",
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => pngResponse()));
    await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual(["https://files.example.com/senthra/branding/logo__pdf.png"]);
  });

  // The derivative is already the finished raster, so it must arrive at pdfkit byte-for-byte as
  // stored. This pairs the derivative with a Cloudinary-shaped original precisely because that is
  // the one original a delivery transform WOULD rewrite — if the fallback ever won, the assertion
  // sees the `fl_png32` URL rather than the stored one.
  it("does not rewrite a stored derivative, and never falls back to transforming the original", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://res.cloudinary.com/demo/image/upload/v1/senthra/branding/logo.png",
      logoPdfUrl: "https://files.example.com/senthra/branding/logo__pdf.png",
      accentColor: "#7b6ef0",
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => pngResponse()));
    await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual(["https://files.example.com/senthra/branding/logo__pdf.png"]);
    expect(fetchedUrls().join()).not.toContain("fl_png32");
  });

  // Cloudinary stores no derivative — it rasterises on delivery instead — so a null here must keep
  // producing exactly the transformed URL it always has.
  it("keeps the Cloudinary delivery transform when no derivative is stored", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://res.cloudinary.com/demo/image/upload/v1/senthra/branding/logo.png",
      logoPdfUrl: null,
      accentColor: "#7b6ef0",
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => pngResponse()));
    await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual([
      "https://res.cloudinary.com/demo/image/upload/f_png,fl_png32,h_400,c_limit/v1/senthra/branding/logo.png",
    ]);
  });

  // Override semantics: the PO logo and ITS derivative travel together. Pairing the app logo's
  // derivative with the PO's original would rasterise an image that is not the one being printed.
  it("uses the PO logo's own derivative, never the app logo's", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://files.example.com/senthra/branding/po-logo.svg",
      logoPdfUrl: "https://files.example.com/senthra/branding/po-logo__pdf.png",
      accentColor: "#0f766e",
    });
    (getCompanyProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...company,
      logoUrl: "https://files.example.com/senthra/branding/logo.svg",
      logoPdfUrl: "https://files.example.com/senthra/branding/logo__pdf.png",
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => pngResponse()));
    await generatePurchaseOrderPdf(po(), null);
    expect(fetchedUrls()).toEqual(["https://files.example.com/senthra/branding/po-logo__pdf.png"]);
  });
});

// ── Logo rendering — what the PDF actually paints ─────────────────────────────────────────────
// Every logo is fetched through pdfSafeImageUrl, which asks Cloudinary for `fl_png32` so the image
// arrives as 8-bit RGBA. These feed the renderer exactly that and read the embedded pixels back: a
// scrambled logo still embeds an image of the right size, so only the pixels prove it drew correctly.
describe("generatePurchaseOrderPdf — logos render pixel-accurately", () => {
  const W = 240;
  const H = 80;
  const ORANGE: [number, number, number, number] = [234, 88, 12, 255];
  const WHITE: [number, number, number, number] = [255, 255, 255, 255];
  const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
  // The QA logo that exposed the bug: THREE colours (orange, white, transparent). Cloudinary's plain
  // `f_png` turned it into a 2-bit palette PNG, which pdfkit drew as a strip of black blocks.
  const fewColour = makePng(W, H, (x, y) =>
    x >= 10 && x < 70 && y >= 10 && y < 70 ? ORANGE : x >= 85 && x < 230 && y >= 28 && y < 52 ? WHITE : CLEAR,
  );
  // A normal many-colour logo — a gradient, so hundreds of distinct colours.
  const gradient = makePng(W, H, (x, y) => [x, y * 3, 128, 255]);

  const rgbAt = (img: { data: Buffer; width: number }, x: number, y: number) =>
    [...img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3)];
  const alphaAt = (mask: { data: Buffer; width: number }, x: number, y: number) => mask.data[y * mask.width + x];
  const logoOf = (buf: Buffer) => {
    const images = pdfImages(buf);
    const logo = images.find((i) => i.width === W && i.height === H && i.colorSpace === "DeviceRGB");
    return { logo, mask: images.find((i) => i.id === logo?.smask) };
  };
  const serve = (png: Buffer) => vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(png, { headers: { "content-type": "image/png" } })));

  it("fetches the existing app logo as a 32-bit PNG and paints a normal many-colour logo exactly", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://res.cloudinary.com/demo/image/upload/v1788867518/senthra/branding/logo.png",
      accentColor: "#7b6ef0",
    });
    serve(gradient);
    const { logo, mask } = logoOf((await generatePurchaseOrderPdf(po(), null)).buffer);

    expect(fetchedUrls()).toEqual([
      "https://res.cloudinary.com/demo/image/upload/f_png,fl_png32,h_400,c_limit/v1788867518/senthra/branding/logo.png",
    ]);
    expect(logo).toMatchObject({ bitsPerComponent: 8 });
    expect(logo!.data.length).toBe(W * H * 3);
    for (const [x, y] of [[0, 0], [120, 40], [239, 79]]) expect(rgbAt(logo!, x, y)).toEqual([x, y * 3, 128]);
    expect(alphaAt(mask!, 120, 40)).toBe(255);
  });

  it("fetches the PO-specific logo the same way and paints it exactly", async () => {
    mockPoBranding.mockResolvedValue({
      logoUrl: "https://res.cloudinary.com/demo/image/upload/v1789132991/senthra/branding/po-logo.png",
      accentColor: "#0f766e",
    });
    serve(fewColour);
    const { logo } = logoOf((await generatePurchaseOrderPdf(po(), null)).buffer);

    expect(fetchedUrls()).toEqual([
      "https://res.cloudinary.com/demo/image/upload/f_png,fl_png32,h_400,c_limit/v1789132991/senthra/branding/po-logo.png",
    ]);
    expect(logo).toBeDefined();
  });

  it("paints a few-colour logo as the image it is — not a scrambled strip", async () => {
    mockPoBranding.mockResolvedValue({ logoUrl: "https://res.cloudinary.com/demo/image/upload/v1/po-logo.png", accentColor: "#0f766e" });
    serve(fewColour);
    const { logo, mask } = logoOf((await generatePurchaseOrderPdf(po(), null)).buffer);

    expect(logo!.data.length).toBe(W * H * 3);
    expect(rgbAt(logo!, 40, 40)).toEqual([234, 88, 12]); // inside the orange square
    expect(rgbAt(logo!, 150, 40)).toEqual([255, 255, 255]); // inside the white bar
    expect(alphaAt(mask!, 40, 40)).toBe(255);
    expect(alphaAt(mask!, 150, 40)).toBe(255);
    expect(alphaAt(mask!, 2, 2)).toBe(0); // the background stays see-through on the accent band
    expect(alphaAt(mask!, 150, 10)).toBe(0);
  });
});

// ── Additional information (PO custom fields) ─────────────────────────────────────────────────
describe("generatePurchaseOrderPdf — additional information", () => {
  const printed = { fieldId: "1".repeat(24), label: "Cost centre", value: "CC-42", printOnPdf: true };
  const internal = { fieldId: "2".repeat(24), label: "Internal ref", value: "SECRET-9", printOnPdf: false };

  it("prints the custom fields set to print, and never the others", async () => {
    const text = pdfText((await generatePurchaseOrderPdf(po({ customFields: [printed, internal] }), null)).buffer);
    expect(text).toContain("ADDITIONAL INFORMATION");
    expect(text).toContain("COST CENTRE");
    expect(text).toContain("CC-42");
    expect(text).not.toContain("SECRET-9");
    expect(text).not.toContain("INTERNAL REF");
  });

  it("draws no section — the identical document — when nothing is set to print", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T10:00:00Z"));
    try {
      const without = pdfText((await generatePurchaseOrderPdf(po(), null)).buffer);
      const onlyInternal = pdfText((await generatePurchaseOrderPdf(po({ customFields: [internal] }), null)).buffer);
      expect(onlyInternal).toBe(without);
      expect(without).not.toContain("ADDITIONAL INFORMATION");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still renders when the stored value is malformed", async () => {
    const out = await generatePurchaseOrderPdf(po({ customFields: "not-an-array" }), null);
    expect(isPdf(out.buffer)).toBe(true);
    expect(pdfText(out.buffer)).not.toContain("ADDITIONAL INFORMATION");
  });
});
