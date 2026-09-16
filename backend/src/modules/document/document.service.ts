// Document Platform — service entry point. The ONE function PO email + the download endpoint call.
// Resolves the shared single-source-of-truth readers (company profile / regional / branding / logo)
// + the issuer's signature, builds the pure payload, and renders the PDF. Future document types add
// a sibling generate*Pdf here reusing resolveLetterhead() + the builder/renderer primitives.

import type { PurchaseOrderWithRelations } from "#modules/purchase-order/purchase-order.repository.js";
import {
  getBranding,
  getCompanyProfile,
  getPurchaseOrderDocumentBranding,
  getRegionalSettings,
} from "#modules/settings/settings.service.js";
import { getDisplayNamesForEmails } from "#modules/user/user.service.js";
import { buildPurchaseOrderDocument } from "./document.builder.js";
import { renderPurchaseOrderPdf } from "./document.renderer.js";
import { resolveSignatureBlock } from "./document.signature.js";
import { fetchImageBuffer, getDocumentFileName, joinAddressLines, pdfSafeImageUrl } from "./document.utils.js";
import type { DocumentContext, DocumentMeta, RenderedDocument } from "./document.types.js";

// A document type's own letterhead branding, where it has one. Absent = the app branding.
interface LetterheadOverrides {
  logoUrl?: string;
  brandColor?: string;
}

// Resolve the shared letterhead (company identity + regional + branding + fetched logo) from the
// single-source-of-truth readers. Reused by every document type — never read the raw Settings row.
// `overrides` lets ONE document type print its own logo/colour without every other type inheriting
// it: the purchase order passes its Settings → Purchase Orders values; nothing else passes any.
async function resolveLetterhead(
  overrides: LetterheadOverrides = {},
): Promise<Omit<DocumentContext, "signature" | "meta" | "people">> {
  const [company, regional, branding] = await Promise.all([
    getCompanyProfile(),
    getRegionalSettings(),
    getBranding(),
  ]);
  const logoUrl = overrides.logoUrl ?? company.logoUrl;
  const logo = await fetchImageBuffer(pdfSafeImageUrl(logoUrl));
  return {
    company: {
      legalName: company.legalName,
      registrationNumber: company.registrationNumber,
      vatNumber: company.vatNumber,
      addressLines: joinAddressLines([
        company.addressLine1,
        company.addressLine2,
        company.city,
        company.county,
        company.postcode,
        company.country,
      ]),
      phone: company.phone,
      email: company.email,
      website: company.website,
      logoUrl,
    },
    regional: {
      timezone: regional.timezone,
      dateFormat: regional.dateFormat,
      timeFormat: regional.timeFormat,
    },
    branding: { brandName: branding.brandName, brandColor: overrides.brandColor ?? branding.brandColor },
    logo,
  };
}

// Generate the Purchase Order PDF. The SIGNATURE is the PO's issuer (`sentBy`) — deterministic, so
// the emailed copy and any later download are byte-for-byte the same document. `generatedBy` is the
// actor producing this copy (sender for the email, viewer for a download) and is metadata only.
export async function generatePurchaseOrderPdf(
  po: PurchaseOrderWithRelations,
  generatedBy?: string | null,
): Promise<RenderedDocument> {
  // The PO document's own logo + accent (Settings → Purchase Orders), which fall back to the app
  // branding when unset. Resolved here, at the PO layer — every PO render goes through this function
  // (download, supplier email, issued archive), and no other document type sees the override.
  const poBranding = await getPurchaseOrderDocumentBranding();
  const base = await resolveLetterhead({ logoUrl: poBranding.logoUrl, brandColor: poBranding.accentColor });
  // ONE lookup for every person this document names — its raiser, its approver and its signer.
  const people = await getDisplayNamesForEmails([po.createdBy, po.approvedBy, po.sentBy]);
  const signature = await resolveSignatureBlock(po.sentBy, people);
  const meta: DocumentMeta = {
    documentId: po.id,
    documentCode: po.code,
    documentType: "purchase_order",
    generatedAt: new Date(),
    generatedBy: generatedBy ?? null,
  };
  const ctx: DocumentContext = { ...base, people, signature, meta };
  const data = buildPurchaseOrderDocument(po, ctx);
  const buffer = await renderPurchaseOrderPdf(data, base.regional);
  return { buffer, filename: getDocumentFileName("purchase_order", po.code), mimeType: "application/pdf" };
}
