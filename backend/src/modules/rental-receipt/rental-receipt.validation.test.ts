import { describe, expect, it } from "vitest";

import {
  createRentalReceiptSchema,
  createRentalReturnSchema,
  reportHireDamageSchema,
} from "./rental-receipt.validation.js";

const PO = "a".repeat(24);
const LINE = "b".repeat(24);

// `toCalendarDay` THROWS on an unparseable value — deliberately, so a silently-invalid hire period
// cannot read as "never due". Inside a `z.preprocess` that throw is not converted into a validation
// issue: zod lets a non-Zod error propagate out of `safeParse` itself. `validateBody` only handles
// `!result.success`, so the raw Error escapes the middleware, Express hands it to the error handler,
// and a typo in a date field is answered with a logged 500 and a generic message instead of the
// field-level 400 every other bad input in this app produces.
//
// The purchase-request schema's own `calendarDayField` already try/catches for exactly this reason;
// these three note endpoints were the outlier.
describe("a malformed date is a validation failure, not a crash", () => {
  const cases = [
    ["delivery note", createRentalReceiptSchema, { deliveryDate: "banana" }],
    ["return note", createRentalReturnSchema, { returnDate: "banana" }],
    ["damage note", reportHireDamageSchema, { reportedDate: "banana" }],
  ] as const;

  for (const [label, schema, dateField] of cases) {
    it(`reports a bad date on a ${label} as a field error`, () => {
      const body = {
        purchaseOrderId: PO,
        ...dateField,
        lines: [{ purchaseOrderRentalLineId: LINE, quantity: 1 }],
      };
      const result = schema.safeParse(body);
      expect(result.success).toBe(false);
      if (!result.success) {
        const field = Object.keys(dateField)[0]!;
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    });
  }
});
