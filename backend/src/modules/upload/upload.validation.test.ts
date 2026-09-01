import { describe, expect, it } from "vitest";

import { normalisePrfDocumentType } from "#modules/purchase-request/purchase-request.validation.js";

import { finalizeRequestSchema } from "./upload.validation.js";

// The document group crosses the wire from a browser, so the two upload areas on the purchase-request
// form are a UI arrangement and nothing more. This is the boundary that decides whether the value is
// a category or a rejection.

const VALID = {
  purpose: "prf_attachment",
  publicId: "senthra/purchase-orders/quote.pdf",
  version: 1,
  signature: "sig",
  fileName: "quote.pdf",
  mediaType: "application/pdf",
  targetId: "a".repeat(24),
};

describe("finalize — the purchase request's document group", () => {
  it.each(["quote", "other"])("accepts the group %s", (documentType) => {
    const parsed = finalizeRequestSchema.safeParse({ ...VALID, documentType });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.documentType).toBe(documentType);
  });

  // The whole point of validating it. A client that invents a group must not get one written.
  it.each(["invoice", "QUOTE", "", "quote ", "__proto__"])("refuses %o", (documentType) => {
    expect(finalizeRequestSchema.safeParse({ ...VALID, documentType }).success).toBe(false);
  });

  // Absent is legitimate: it is what every purpose without a group picker sends, and what the older
  // upload path has always sent. The module downstream is what decides it means `quote`.
  it("accepts an absent group", () => {
    const parsed = finalizeRequestSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.documentType).toBeUndefined();
  });
});

describe("normalisePrfDocumentType", () => {
  // BACKWARD COMPATIBILITY, in one function. Nothing was backfilled, so a row written before the
  // second group existed has no value — and it is a quote document, because the field it came out of
  // was labelled "Quote document(s)".
  it.each([[null], [undefined], [""], ["quote"], ["nonsense"]])("reads %o as a quote document", (stored) => {
    expect(normalisePrfDocumentType(stored as string | null | undefined)).toBe("quote");
  });

  it("reads a stored `other` as a supporting document", () => {
    expect(normalisePrfDocumentType("other")).toBe("other");
  });
});
