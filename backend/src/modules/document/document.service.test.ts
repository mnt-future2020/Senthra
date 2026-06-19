import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The PDF is rendered for real (pdfkit); only the SoT readers, the signature lookup and the network
// are mocked, so the test stays deterministic and offline while exercising the whole pipeline.
vi.mock("#modules/settings/settings.service.js", () => ({
  getCompanyProfile: vi.fn(),
  getRegionalSettings: vi.fn(),
  getBranding: vi.fn(),
}));
vi.mock("#modules/user/user.service.js", () => ({ getSignatureForEmail: vi.fn() }));

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import { getBranding, getCompanyProfile, getRegionalSettings } from "#modules/settings/settings.service.js";
import { getSignatureForEmail } from "#modules/user/user.service.js";
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
    ...over,
  } as unknown as PurchaseOrderWithRelations;
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";
// Count page objects in the PDF. The page-tree root is `/Type /Pages` (excluded via the lookahead),
// so this counts only real pages — guards against the footer accidentally spawning trailing blanks.
const countPdfPages = (b: Buffer): number =>
  (b.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;

beforeEach(() => {
  vi.clearAllMocks();
  (getCompanyProfile as ReturnType<typeof vi.fn>).mockResolvedValue(company);
  (getRegionalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(regional);
  (getBranding as ReturnType<typeof vi.fn>).mockResolvedValue(branding);
  (getSignatureForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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
});
