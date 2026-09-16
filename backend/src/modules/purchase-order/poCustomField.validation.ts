import { z } from "zod";

import { PO_CUSTOM_FIELD_LABEL_MAX, PO_CUSTOM_FIELD_VALUE_MAX } from "./poCustomField.values.js";

// PO custom fields — request bodies. DEFINITIONS are managed from Settings → Purchase Orders
// (settings.manage). VALUES ride on the ordinary PO create / draft-edit bodies — see
// `customFieldValuesField`, spread into purchase-order.validation's shared header.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const labelField = z
  .string({ error: "Enter a field name." })
  .trim()
  .min(1, "Enter a field name.")
  .max(PO_CUSTOM_FIELD_LABEL_MAX, `Keep the field name to ${PO_CUSTOM_FIELD_LABEL_MAX} characters or fewer.`);

export const createPoCustomFieldSchema = z.object({
  label: labelField,
  printOnPdf: z.boolean().optional(),
});
export type CreatePoCustomFieldInput = z.infer<typeof createPoCustomFieldSchema>;

export const updatePoCustomFieldSchema = z
  .object({
    label: labelField.optional(),
    active: z.boolean().optional(),
    printOnPdf: z.boolean().optional(),
  })
  .refine((b) => b.label !== undefined || b.active !== undefined || b.printOnPdf !== undefined, "Nothing to update.");
export type UpdatePoCustomFieldInput = z.infer<typeof updatePoCustomFieldSchema>;

// The COMPLETE list of definition ids in their new order — a reorder is one decision about the whole
// list, so a partial list (a field added in another tab since) is refused by the service.
export const reorderPoCustomFieldsSchema = z.object({
  ids: z
    .array(z.string().regex(OBJECT_ID_RE, "Unknown field."))
    .min(1, "Nothing to reorder.")
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Each field can appear only once."),
});
export type ReorderPoCustomFieldsInput = z.infer<typeof reorderPoCustomFieldsSchema>;

// Keys in one body — far past any real configuration, low enough to refuse a flood.
const MAX_VALUE_KEYS = 50;

/**
 * The additional-information values on a PO create / draft-edit body: `{ [definitionId]: text }`.
 *
 * OPTIONAL everywhere, and no individual field can be made required: a required custom field would put
 * a new gate on create, PRF conversion and submit, which this feature must never do. The ids are checked
 * against real definitions in the service — this enforces only the shape.
 */
export const customFieldValuesField = z
  .record(
    z.string().regex(OBJECT_ID_RE, "Unknown additional-information field."),
    z
      .string({ error: "Additional-information values must be text." })
      .max(PO_CUSTOM_FIELD_VALUE_MAX, `Keep each additional-information value to ${PO_CUSTOM_FIELD_VALUE_MAX} characters or fewer.`),
  )
  .refine((o) => Object.keys(o).length <= MAX_VALUE_KEYS, "Too many additional-information values.");
