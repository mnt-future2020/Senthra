// Document Platform — shared types. The builder produces a pure, render-agnostic payload; the
// renderer (pdfkit today) draws it. A future PDF/engine swap touches only the renderer.

import { DOCUMENT_TYPES } from "./document.constants.js";

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// Company letterhead identity (resolved from getCompanyProfile()). `logo` is the fetched image
// buffer (Branding.logoUrl) — null when unset or unfetchable; the renderer then omits it.
export interface DocumentCompany {
  legalName: string;
  registrationNumber: string;
  vatNumber: string;
  addressLines: string[];
  phone: string;
  email: string;
  website: string;
  logoUrl: string;
}

export interface DocumentRegional {
  timezone: string;
  dateFormat: string;
  timeFormat: string;
}

export interface DocumentBranding {
  brandName: string;
  brandColor: string;
}

// The signer (a PO's `sentBy`). `image` is the fetched signature graphic (null = name-only or
// none). Resolved by document.signature.ts; optional — generation never fails without it.
export interface DocumentSignatureBlock {
  signerName: string;
  jobTitle: string | null;
  image: Buffer | null;
  mimeType: string | null;
}

// Generic metadata carried by EVERY document (future types included).
export interface DocumentMeta {
  documentId: string;
  documentCode: string;
  documentType: DocumentType;
  generatedAt: Date;
  generatedBy: string | null;
}

// Everything resolved (I/O done) before the pure builder runs.
export interface DocumentContext {
  company: DocumentCompany;
  regional: DocumentRegional;
  branding: DocumentBranding;
  signature: DocumentSignatureBlock | null;
  logo: Buffer | null;
  meta: DocumentMeta;
}

// ── Purchase Order document payload (pure data the renderer draws) ──────────────────────────
export interface PoDocLine {
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

export interface PurchaseOrderDocumentData {
  meta: DocumentMeta;
  company: DocumentCompany;
  branding: DocumentBranding;
  logo: Buffer | null;
  signature: DocumentSignatureBlock | null;
  supplier: { name: string; contactPerson: string; addressLines: string[]; email: string; phone: string };
  delivery: { name: string; addressLines: string[] };
  order: {
    code: string;
    status: string;
    orderDate: string;
    expectedDeliveryDate: string;
    reference: string;
    currency: string;
    priority: string;
  };
  lines: PoDocLine[];
  totals: { subtotal: string; vat: string; grandTotal: string };
  notes: string;
}

export interface RenderedDocument {
  buffer: Buffer;
  filename: string;
  mimeType: "application/pdf";
}
