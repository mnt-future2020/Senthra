/**
 * The values a CALLER may pre-fill into the IRM item form, resolved in one place.
 *
 * `IrmItemForm` reads this twice — once for its initial state, once for the dirty BASELINE it
 * compares against. That is the whole reason it exists as a function rather than two literals: if
 * the two ever disagreed, the form would open already reporting unsaved changes, so Cancel would
 * challenge a user who had typed nothing and the tab-close warning would fire on an untouched form.
 *
 * Seeds apply to CREATE only. An edit form is describing a row that already exists, and letting a
 * caller pre-fill it would silently rewrite that item's name or supplier link the moment it opened.
 */

export type SeededSupplierRow = {
  supplierId: string;
  isPrimary: boolean;
  priority: string;
  supplierSku: string;
  leadTimeDays: string;
};

export interface IrmFormSeeds {
  name: string;
  supplierRows: SeededSupplierRow[];
}

export function irmItemFormSeeds(
  mode: "create" | "edit",
  initialName?: string,
  initialSupplierId?: string,
): IrmFormSeeds {
  if (mode !== "create") return { name: "", supplierRows: [] };
  return {
    name: initialName?.trim() ?? "",
    // Primary, because it is the only link: an item bought from exactly one supplier has no other
    // candidate, and `primarySupplier` is what the rest of the app reads.
    supplierRows: initialSupplierId
      ? [{ supplierId: initialSupplierId, isPrimary: true, priority: "1", supplierSku: "", leadTimeDays: "" }]
      : [],
  };
}
