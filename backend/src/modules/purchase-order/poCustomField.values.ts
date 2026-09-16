// PO custom fields — the VALUES half, pure (no I/O). Shared by the PO service (writing values, shaping
// the DTO) and the document builder (the PDF), so the order screen and the supplier's copy can never
// disagree about which values exist or which of them print.
//
// A value is stored on the order as a SNAPSHOT: the definition's id, its label and its print flag as
// they were when the draft was last saved, plus the text. The label is what keeps an old order readable
// after its definition is renamed or switched off; the id is what lets the next draft save refresh it.
//
// INFORMATIONAL ONLY. None of this is money, and nothing downstream — totals, VAT, approval, the PRF
// fast-path comparison, receiving, status, reporting — reads these values.

import { badRequest } from "../../utils/http-error.js";

/** Field-name limit. The PDF prints it in the same narrow label column as the terms block. */
export const PO_CUSTOM_FIELD_LABEL_MAX = 60;
/** Per-value limit, so the PDF's additional-information block stays the small section it is meant to be. */
export const PO_CUSTOM_FIELD_VALUE_MAX = 500;
/** Active definitions at one time — the form section and the PDF block both grow with this. */
export const PO_CUSTOM_FIELD_MAX_ACTIVE = 20;

/**
 * One value as stored in `PurchaseOrder.customFields`. A type alias rather than an interface so the
 * array is assignable to Prisma's Json input type as-is.
 */
export type StoredPoCustomField = {
  fieldId: string;
  label: string;
  value: string;
  printOnPdf: boolean;
};

/** The definition facts a value write needs. */
export type PoCustomFieldDefinitionFacts = {
  id: string;
  label: string;
  active: boolean;
  printOnPdf: boolean;
  sortOrder: number;
};

// What an entry whose label is missing or unreadable is shown as — a value with no name is still a fact
// recorded on the order, and dropping it would lose it.
const UNLABELLED = "Additional information";

/**
 * The stored values of an order, read defensively.
 *
 * `customFields` is a Json column and Mongo enforces no shape on it, so anything that is not a
 * well-formed entry is DROPPED rather than allowed to crash the order screen or the PDF: a non-array,
 * a non-object entry, a missing or repeated id, a non-string or blank value. A missing print flag reads
 * as NOT printed — an entry nobody can vouch for stays off the supplier's copy.
 */
export function readStoredCustomFields(raw: unknown): StoredPoCustomField[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPoCustomField[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.fieldId !== "string" || !e.fieldId || seen.has(e.fieldId)) continue;
    if (typeof e.value !== "string" || !e.value.trim()) continue;
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : UNLABELLED;
    out.push({ fieldId: e.fieldId, label, value: e.value.trim(), printOnPdf: e.printOnPdf === true });
    seen.add(e.fieldId);
  }
  return out;
}

/**
 * Apply a create / draft-edit body's values to what the order already holds.
 *
 * MERGE, not replace: a key that is present sets that field (or clears it, when blank); a key that is
 * absent leaves the stored value exactly as it is. That is what keeps a value for a since-deactivated
 * field on the order when the form no longer offers that field.
 *
 * - An id with no definition is refused: it never existed, or the form is out of date.
 * - An INACTIVE definition's value may be kept (sent unchanged) or cleared, never given a new value.
 * - Every surviving value's label and print flag are refreshed from its definition. Only a draft is
 *   ever written through here, so a submitted order keeps the snapshot it left draft with.
 * - The result follows the definitions' order; a value whose definition is gone keeps its place last.
 */
export function mergeCustomFieldValues(
  stored: StoredPoCustomField[],
  input: Record<string, string>,
  definitions: PoCustomFieldDefinitionFacts[],
): StoredPoCustomField[] {
  const defs = new Map(definitions.map((d) => [d.id, d]));
  const values = new Map(stored.map((s) => [s.fieldId, s]));

  for (const [fieldId, raw] of Object.entries(input)) {
    const def = defs.get(fieldId);
    if (!def) {
      throw badRequest("One of the additional-information fields no longer exists. Refresh the page and try again.");
    }
    const value = raw.trim();
    const current = values.get(fieldId);
    if (!def.active && value && value !== current?.value) {
      throw badRequest(`"${def.label}" is no longer in use — its value can be kept or cleared, but not changed.`);
    }
    if (value) values.set(fieldId, { fieldId, label: def.label, value, printOnPdf: def.printOnPdf });
    else values.delete(fieldId);
  }

  const rank = (fieldId: string) => defs.get(fieldId)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return [...values.values()]
    .map((v) => {
      const def = defs.get(v.fieldId);
      return def ? { ...v, label: def.label, printOnPdf: def.printOnPdf } : v;
    })
    .sort((a, b) => rank(a.fieldId) - rank(b.fieldId));
}

/** The values that belong on the supplier's document: set to print, non-empty, in stored order. */
export function printableCustomFields(raw: unknown): { label: string; value: string }[] {
  return readStoredCustomFields(raw)
    .filter((f) => f.printOnPdf)
    .map(({ label, value }) => ({ label, value }));
}
