import { describe, expect, it } from "vitest";

import { hireList } from "./hireOutstanding";

const row = (itemName: string, qty: number) => ({ itemName, itemCode: null, qty });

// The sentence that replaced a green "Job reconciled" toast on a job that had not closed. Three
// screens build it, so it is worth pinning rather than re-typing at each call site.
describe("hireList", () => {
  it("names quantity first, the way every other hire surface phrases it", () => {
    expect(hireList([row("Fibre Tester", 2)])).toBe("2 × Fibre Tester");
  });

  it("lists several without swallowing any of them", () => {
    expect(hireList([row("Fibre Tester", 2), row("OTDR", 1)])).toBe("2 × Fibre Tester, 1 × OTDR");
  });

  it("caps a long list so the toast stays readable, and SAYS how many it dropped", () => {
    // "and 2 more", never a bare "+2": most of these get relayed down a warehouse phone, so the
    // sentence has to survive being read aloud.
    const rows = [row("A", 1), row("B", 1), row("C", 1), row("D", 1), row("E", 1)];
    expect(hireList(rows)).toBe("1 × A, 1 × B, 1 × C and 2 more");
  });

  it("returns nothing when nothing is outstanding, so a caller cannot build an empty sentence", () => {
    expect(hireList([])).toBe("");
  });
});
