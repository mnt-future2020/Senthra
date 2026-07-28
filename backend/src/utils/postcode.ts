import { z } from "zod";

// UK postcode validation + normalisation, defined ONCE for every module that stores an
// address (customer, customer site, warehouse, supplier, user, job site, company profile).
//
// Why normalise on the server rather than in the input box: the postcode reaches the DB
// from several paths — the master-data forms, the customer site CSV import, and any direct
// API call. A UI-only uppercase leaves the other paths writing raw text, so the same
// physical postcode ends up stored as "ls14dy", "LS14DY" and "LS1 4DY". That breaks
// postcode search (which matches case-insensitively but NOT space-insensitively) and shows
// whatever was typed on PDFs, labels and the customer portal.

// Canonical UK postcode shape, e.g. "EC1A 1BB", "M1 1AE", "DN55 1PT". The internal space is
// optional here so a user typing "ls14dy" is accepted and then normalised — validation and
// normalisation are deliberately separate steps. "GIR 0AA" (Girobank) is the one real
// postcode that doesn't fit the general pattern, so it's an explicit alternative.
//
// The `i` flag is load-bearing for that GIR branch only (the general branch already spells out
// [A-Za-z]): this regex is exported and applied to RAW, un-uppercased input by the site-import
// preview and the frontend form validators, so without it "gir0aa" would be rejected in exactly
// the places where "ls14dy" is accepted.
export const UK_POSTCODE_RE = /^(GIR\s*0AA|[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2})$/i;

// The inward code (the part after the space) is ALWAYS exactly 3 characters, which is what
// makes canonical formatting a pure string operation: strip every space, then re-insert one
// before the last 3.
const INWARD_LEN = 3;

// "ls14dy" → "LS1 4DY" — the form that gets STORED and displayed. Distinct from
// `canonicalPostcode` in lib/geocode.ts, which strips the space entirely to build a comparison
// key for lookup de-duping; don't reach for that one when persisting a value.
//
// Anything that isn't a recognisable UK postcode is returned trimmed,
// uppercased and whitespace-collapsed but NOT split — the field may be mid-typing or simply
// invalid, and inventing a space in the wrong place would be worse than leaving it alone.
// The schema below is what rejects invalid values; this function never throws.
export function formatUkPostcode(value: string): string {
  const collapsed = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!UK_POSTCODE_RE.test(collapsed)) return collapsed;
  const compact = collapsed.replace(/\s+/g, "");
  return `${compact.slice(0, compact.length - INWARD_LEN)} ${compact.slice(-INWARD_LEN)}`;
}

const FORMAT_MESSAGE = "Enter a valid UK postcode (e.g. EC1A 1BB).";
// Canonical form is at most 8 chars ("DN55 1PT"); the cap applies to the raw input, which
// may carry extra spaces, so it stays a little looser than that.
const MAX_RAW_LENGTH = 12;

interface PostcodeFieldOptions {
  // Required fields (warehouse, supplier) reject an empty string; optional ones (customer,
  // user, job site) accept it as "cleared" and hand back "" for the service to null out.
  required?: boolean;
  requiredMessage?: string;
}

// A zod field that VALIDATES the shape and TRANSFORMS the value to canonical form, so every
// schema using it stores "LS1 4DY" no matter how it was typed. Use `.optional()` on the
// result where the key itself may be absent from the payload.
export function postcodeField(opts: PostcodeFieldOptions = {}) {
  const { required = false, requiredMessage = "Postcode is required." } = opts;
  return z
    // A required postcode names itself when the key is MISSING (not just empty): the create
    // forms send `postcode.trim() || undefined`, so a blank arrives as undefined, and
    // validate.middleware puts issues[0].message straight in the 400 body. Without this the
    // client would show zod's raw "expected string, received undefined".
    .string(required ? { error: requiredMessage } : undefined)
    .trim()
    .max(MAX_RAW_LENGTH, FORMAT_MESSAGE)
    .transform(formatUkPostcode)
    .refine((v) => (v === "" ? !required : UK_POSTCODE_RE.test(v)), {
      error: (iss) => (iss.input === "" ? requiredMessage : FORMAT_MESSAGE),
    });
}
