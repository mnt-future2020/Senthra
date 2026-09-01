import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { supplierDetailNotice } from "./supplierPanel";

/**
 * `/suppliers/options` is deliberately wider than `suppliers.view` — a purchaser who may raise a
 * request has to be able to pick a supplier. `GET /suppliers/:id`, which fills the read-only panel
 * and pre-fills payment terms, is NOT wider. So the widening created a role that can choose a
 * supplier and then gets a 403 on the very next call.
 *
 * That rejection used to be swallowed into `setSupplierDetail(null)`, which renders exactly like
 * "no supplier chosen": no panel, no payment-terms prefill, and nothing to tell the user that
 * something was refused rather than simply absent. These are the words shown instead.
 */
describe("supplierDetailNotice", () => {
  it("names the permission wall, and says the form still works without it", () => {
    const notice = supplierDetailNotice(new ApiError("You don't have permission to do that.", 403));
    expect(notice).toContain("permission");
    // The actionable half: the request can still be raised, the terms just have to be typed.
    expect(notice.toLowerCase()).toContain("payment terms");
  });

  it("does not blame permissions for an ordinary failure", () => {
    const notice = supplierDetailNotice(new ApiError("Service unavailable.", 503));
    expect(notice).not.toContain("permission");
    expect(notice.toLowerCase()).toContain("payment terms");
  });

  it("handles a failure that is not an ApiError at all", () => {
    expect(supplierDetailNotice(new TypeError("Network request failed"))).toBeTruthy();
    expect(supplierDetailNotice(undefined)).toBeTruthy();
  });
});
