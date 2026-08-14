import { describe, expect, it } from "vitest";

import { CELL_ONE_LINE, colClass, colClassAt, tableMinWidth, type ColPriority } from "./tableLayout";

// Measured on a 1024×866 laptop: the Inventory list showed FOUR rows, and the bands above the table
// were not the cause. Nine columns shared a flat 760px minimum (~84px each) while "London Fulfillment
// Centre" needs ~180px, so the browser resolved the overflow by WRAPPING text and growing rows to
// ~72px instead of ~45px — the one direction that costs rows on a screen already short of them.
//
// Every list in the app had the same habit, all of them too small for their content:
//   Purchase Orders 9 @ 1000px = 111px · Jobs 8 @ 1000px = 125px · Warehouses 8 @ 860px = 107px
//   Customers — no minimum at all.

describe("tableMinWidth", () => {
  it("is the sum of each column's allowance plus its padding", () => {
    // normal 118 + 32 = 150
    expect(tableMinWidth(["normal"])).toBe(150);
    expect(tableMinWidth(["normal", "normal"])).toBe(300);
  });

  it("gives free-text columns more room than codes and quantities", () => {
    expect(tableMinWidth(["wide"])).toBeGreaterThan(tableMinWidth(["normal"]));
    expect(tableMinWidth(["normal"])).toBeGreaterThan(tableMinWidth(["narrow"]));
  });

  // The real check: the shapes that were wrapping must now ask for more than they used to.
  it("asks for more than the flat minimum every list used to declare", () => {
    // Purchase Orders: code, supplier, warehouse, status, priority, dates ×3, actions.
    const po: Parameters<typeof tableMinWidth>[0] = ["normal", "wide", "wide", "narrow", "narrow", "normal", "normal", "normal", "narrow"];
    expect(tableMinWidth(po)).toBeGreaterThan(1000);
    // Warehouses, the tightest of the lot at 860px across eight columns.
    const wh: Parameters<typeof tableMinWidth>[0] = ["normal", "wide", "normal", "normal", "normal", "narrow", "narrow", "narrow"];
    expect(tableMinWidth(wh)).toBeGreaterThan(860);
  });

  // A wide column must always clear the ~180px that was wrapping "London Fulfillment Centre".
  it("gives a wide column enough for the value that started all this", () => {
    expect(tableMinWidth(["wide"])).toBeGreaterThanOrEqual(180 + 32);
  });

  it("is zero for a table with no columns", () => {
    expect(tableMinWidth([])).toBe(0);
  });

  it("grows with every column added, so a wider lens scrolls rather than squeezing", () => {
    const base = tableMinWidth(["normal", "normal"]);
    expect(tableMinWidth(["normal", "normal", "narrow"])).toBeGreaterThan(base);
  });
});

describe("colClass", () => {
  // Anything rows are told apart by. Hiding one leaves a wall of near-identical lines.
  it("keeps an always-column visible at every width", () => {
    expect(colClass("always")).toBe("");
  });

  it("hides the follow-up columns below their breakpoint", () => {
    expect(colClass("lg")).toBe("hidden lg:table-cell");
    expect(colClass("xl")).toBe("hidden xl:table-cell");
  });

  // A `hidden` cell leaves the layout entirely, so a header and its body cell MUST carry the same
  // class — a mismatch shifts every following cell by one and the table misreports which value is
  // which. Both sides read this one function, which is what makes that impossible by construction.
  it("returns the same class for the same priority, wherever it is asked", () => {
    expect(colClass("lg")).toBe(colClass("lg"));
    expect(colClass("xl")).not.toBe(colClass("lg"));
  });
});

// The loading skeletons draw their body cells from an INDEX, so they could not call colClass per
// column the way a real row does — and didn't. Their headers hid the lg/xl columns while their
// placeholder bodies kept them, so below those breakpoints the skeleton was a different shape from
// the table that replaced it.
describe("colClassAt", () => {
  const COLS: ColPriority[] = ["always", "xl", "always", "lg"];

  it("gives each index the class its own column declared", () => {
    expect(colClassAt(COLS, 0)).toBe(colClass("always"));
    expect(colClassAt(COLS, 1)).toBe(colClass("xl"));
    expect(colClassAt(COLS, 3)).toBe(colClass("lg"));
  });

  // The trailing actions cell every list appends itself is not in the array and must never vanish.
  it("treats a column past the end as always-visible", () => {
    expect(colClassAt(COLS, COLS.length)).toBe("");
    expect(colClassAt([], 3)).toBe("");
  });

  // The whole point: a header mapping the array and a body mapping the same array cannot diverge.
  it("agrees with colClass for every entry, which is what keeps header and body aligned", () => {
    COLS.forEach((p, i) => expect(colClassAt(COLS, i)).toBe(colClass(p)));
  });
});

describe("CELL_ONE_LINE", () => {
  // This is what makes the sizing hold for data nobody has seen yet: however long a value gets, the
  // row height cannot grow.
  it("truncates rather than wrapping, and caps how wide one cell can get", () => {
    expect(CELL_ONE_LINE).toContain("truncate");
    expect(CELL_ONE_LINE).toMatch(/max-w-/);
  });
});
