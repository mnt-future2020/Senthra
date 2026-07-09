// Shared payment-terms options — the standard terms offered across procurement (supplier default,
// purchase request, purchase order). Mirrors the supplier form's list so the whole app stays
// consistent. "Custom" reveals a free-text field for a bespoke term.
//
// NOTE ON STORAGE: a Supplier stores paymentTerms + a separate customPaymentTerms. A PurchaseOrder
// / PurchaseRequest instead stores ONE resolved `paymentTerms` string (the standard label, or the
// custom text). The helpers below convert between that single string and the (select, customText)
// pair the PaymentTermsField UI needs.

export const STANDARD_PAYMENT_TERMS = [
  "Prepaid",
  "7 Days",
  "14 Days",
  "30 Days",
  "45 Days",
  "60 Days",
  "90 Days",
] as const;

export const CUSTOM_PAYMENT_TERM = "Custom";

// The dropdown options: the standard terms plus the "Custom" escape hatch.
export const PAYMENT_TERMS_SELECT_OPTIONS = [
  ...STANDARD_PAYMENT_TERMS.map((t) => ({ value: t, label: t })),
  { value: CUSTOM_PAYMENT_TERM, label: "Custom…" },
];

// Split a stored resolved paymentTerms string into the UI's (selectValue, customText) pair.
// - "" / null              → ("", "")            → nothing selected
// - a known standard term  → (term, "")          → that option selected
// - anything else          → ("Custom", theText) → Custom selected + its free text
export function splitPaymentTerms(value: string | null | undefined): { select: string; custom: string } {
  const v = (value ?? "").trim();
  if (!v) return { select: "", custom: "" };
  if ((STANDARD_PAYMENT_TERMS as readonly string[]).includes(v)) return { select: v, custom: "" };
  return { select: CUSTOM_PAYMENT_TERM, custom: v };
}

// Resolve a Supplier's default payment terms to the single string a PO/PRF stores. A supplier
// keeps paymentTerms + a SEPARATE customPaymentTerms, and paymentTerms is the literal "Custom"
// when bespoke — so "Custom" must resolve to the free-text customPaymentTerms, never the word
// "Custom" itself. Returns "" when the supplier has no default.
export function resolveSupplierPaymentTerms(
  supplier: { paymentTerms: string | null; customPaymentTerms?: string | null } | null | undefined,
): string {
  if (!supplier?.paymentTerms) return "";
  if (supplier.paymentTerms === CUSTOM_PAYMENT_TERM) return supplier.customPaymentTerms?.trim() ?? "";
  return supplier.paymentTerms;
}
