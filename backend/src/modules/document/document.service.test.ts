import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The PDF is rendered for real (pdfkit); only the SoT readers, the signature lookup and the network
// are mocked, so the test stays deterministic and offline while exercising the whole pipeline.
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyProfile: vi.fn(),
  getRegionalSettings: vi.fn(),
  getBranding: vi.fn(),
}));
vi.mock("#modules/user/user.service.js", () => ({
  getSignatureForEmail: vi.fn(),
  getDisplayNamesForEmails: vi.fn(),
}));

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import { getBranding, getCompanyProfile, getRegionalSettings } from "#modules/settings/settings.service.js";
import { getDisplayNamesForEmails, getSignatureForEmail } from "#modules/user/user.service.js";
import { pdfPageCount, pdfText } from "./document.pdfText.testkit.js";
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
