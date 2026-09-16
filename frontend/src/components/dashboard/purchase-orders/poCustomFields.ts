// Pure helpers for a purchase order's ADDITIONAL INFORMATION (PO custom fields, configured in Settings →
// Purchase Orders). Shared by the PO form and the detail page; kept free of React so they unit-test alone.

import type { PoCustomFieldDefinition, PoCustomFieldValue, PurchaseOrder } from "@/types/purchase-order";

// Mirrors PO_CUSTOM_FIELD_VALUE_MAX in backend/src/modules/purchase-order/poCustomField.values.ts.
export const PO_CUSTOM_FIELD_VALUE_MAX = 500;

/** The fields the form offers for entry: active definitions, in their configured order. */
export function activeCustomFieldDefinitions(defs: PoCustomFieldDefinition[]): PoCustomFieldDefinition[] {
  return defs.filter((d) => d.active).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** An order's stored values as form state, keyed by definition id ({} for a new order). */
export function initialCustomFieldValues(order: PurchaseOrder | null | undefined): Record<string, string> {
  return Object.fromEntries((order?.customFields ?? []).map((v) => [v.fieldId, v.value]));
}

/**
 * Stored values the form can no longer offer for editing — their field has been deactivated since.
 * Shown read-only. The server keeps them untouched because the payload below never names them.
 */
export function retainedCustomFieldValues(
  order: PurchaseOrder | null | undefined,
  defs: PoCustomFieldDefinition[],
): PoCustomFieldValue[] {
  const active = new Set(defs.filter((d) => d.active).map((d) => d.id));
  return (order?.customFields ?? []).filter((v) => !active.has(v.fieldId) && v.value.trim());
}

/**
 * The `customFields` payload: every ACTIVE field's current text, blank included (blank clears it).
 * Inactive fields are never named, which is what leaves their stored values exactly as they are.
 */
export function customFieldsPayload(
  activeDefs: PoCustomFieldDefinition[],
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(activeDefs.map((d) => [d.id, (values[d.id] ?? "").trim()]));
}

/** The values the detail page shows: every non-empty one, as stored (label snapshot included). */
export function visibleCustomFieldValues(po: Pick<PurchaseOrder, "customFields">): PoCustomFieldValue[] {
  return (po.customFields ?? []).filter((v) => v.value.trim());
}
