import { describe, expect, it } from "vitest";

import { PERMISSION_KEYS } from "../role/permissions.js";
import { CATEGORY_LIST_READERS } from "./category.routes.js";

// Category is a REQUIRED field on a customer stock entry, so the read guard on GET /categories
// must admit everyone the /stock-entries write guards admit. When it didn't, the picker came
// back empty (403) and the form could not be saved at all — a silent, total block with no
// server-side signal that the two guards had drifted apart. These tests pin them together.

describe("GET /categories read guard", () => {
  it("names only real catalogue permissions", () => {
    const unknown = CATEGORY_LIST_READERS.filter((key) => !PERMISSION_KEYS.includes(key));
    expect(unknown).toEqual([]);
  });

  // Mirror of the write guards in customer.routes.ts. If a stock-entry route's permission
  // changes, this fails until the category read guard is updated to match.
  it.each([
    ["customer_stock.create", "POST /customers/:id/stock-entries"],
    ["customer_stock.edit", "PUT /stock-entries/:id"],
    ["stock_requests.complete", "warehouse receive, then fill in the entry"],
  ])("admits %s (%s)", (key) => {
    expect(CATEGORY_LIST_READERS).toContain(key);
  });

  it("still admits category managers and legacy coarse-key roles", () => {
    expect(CATEGORY_LIST_READERS).toContain("categories.view");
    expect(CATEGORY_LIST_READERS).toContain("customers.edit");
  });
});
