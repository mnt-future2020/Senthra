import { z } from "zod";

import { UOM_OPTIONS } from "../../utils/uom.js";

// Rental item master-data validation.
//
// This master defines WHAT can be hired, never what a hire COSTS. Price, VAT and currency are
// properties of the individual request — negotiated per period and per supplier — and live on the
// PRF rental line. A reference rate here would be a second, staler answer to a question the line
// already answers, so there is deliberately no pricing field to validate.
//
// REQUIRED on create: name, rentalCategoryId, baseUnit. A hire is always quantified in something,
// so the unit is not optional — and it is chosen from the shared vocabulary, never typed.

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export const RENTAL_ITEM_STATUSES = ["active", "inactive"] as const;

// `.strip()` drops anything the client invents — notably `code`, which is server-allocated from
// the atomic Counter. Accepting one would let a caller collide with a live item, and `code` is
// uniquely indexed, so the create would just fail.
export const createRentalItemSchema = z
  .object({
    name: z.string({ error: "Item name is required." }).trim().min(1, "Item name is required.").max(200),
    description: z.string().trim().max(2000).optional(),
    rentalCategoryId: z
      .string({ error: "Select a rental category." })
      .regex(OBJECT_ID_RE, "Select a rental category."),
    status: z.enum(RENTAL_ITEM_STATUSES).optional(),
    // The SAME closed list IRM items and customer stock entries use (utils/uom.ts). Free text here
    // would let "Each", "each" and "EA" become three different units on one report — and the unit is
    // snapshotted onto the PRF line, the PO line and the PDF the supplier reads, so a typo becomes
    // permanent on a document.
    baseUnit: z.enum(UOM_OPTIONS, { error: "Select a unit." }),
    notes: z.string().trim().max(2000).optional(),
  })
  .strip();
export type CreateRentalItemInput = z.infer<typeof createRentalItemSchema>;

export const updateRentalItemSchema = createRentalItemSchema.partial();
export type UpdateRentalItemInput = z.infer<typeof updateRentalItemSchema>;
