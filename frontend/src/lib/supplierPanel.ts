import { isPermissionError } from "./api";

/**
 * What to say when a form could not load the SELECTED supplier's full record.
 *
 * Lives here, said once, because two forms show this panel — the purchase request and the purchase
 * order — and a second copy of the wording is how one screen ends up explaining the situation in
 * terms the other doesn't.
 *
 * WHY THERE IS ANYTHING TO SAY
 * `/suppliers/options` is deliberately wider than `suppliers.view`: a purchaser who may raise a
 * request has to be able to pick a supplier, whether or not they administer the supplier directory.
 * `GET /suppliers/:id` — which fills this panel and pre-fills payment terms — was NOT widened, and
 * should not be: it carries contact details, addresses and notes that the pick itself does not.
 *
 * So the widening created a role that can choose a supplier and is then refused the follow-up call.
 * That rejection was swallowed into `setSupplierDetail(null)`, which renders identically to "no
 * supplier chosen": no panel, no prefill, and no hint that anything was refused rather than simply
 * absent. The user is left believing the supplier has no payment terms on file.
 *
 * Both messages end on what the user can still DO, because in both cases the form remains usable —
 * the terms just have to be typed rather than arriving pre-filled.
 */
export function supplierDetailNotice(err: unknown): string {
  return isPermissionError(err)
    ? "Supplier details aren't shown because you don't have permission to view supplier records. You can still choose a supplier and enter payment terms yourself."
    : "Couldn't load this supplier's details. You can still choose a supplier and enter payment terms yourself.";
}
