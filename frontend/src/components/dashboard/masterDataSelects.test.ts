import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Every master-data Select must survive its record being deactivated ────────────────────────
//
// `withHistoricalOption` (lib/historicalOption.ts) is correct and well tested. This is about
// whether the forms actually CALL it, which is a different failure and the one that happened: the
// helper shipped wired to the supplier field, and the delivery-warehouse and job-supplier fields
// were left plain. Nothing errored, nothing failed a test, and the gap is invisible until a
// warehouse or supplier is deactivated — at which point a saved purchase request reopens showing
// "— Select a warehouse —" on a request that plainly has one.
//
// Checked from SOURCE, per-field, because the miss is a field someone forgot rather than a broken
// function. A unit test of the helper cannot see an unwired caller, and there is no jsdom here to
// render the forms.
//
// Deliberately limited to DB-BACKED MASTER DATA — records an administrator can retire while a
// document still references them. Fixed code enums (Priority, Delivery terms, Job type, Pricing
// basis, Line source…) are excluded on purpose: their values cannot be deactivated, so demanding
// the wrapper there would be noise that the next developer strips out.

const FORMS = join(process.cwd(), "src", "components", "dashboard");

const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

const read = (rel: string) => stripComments(readFileSync(join(FORMS, rel), "utf8"));

/** The one JSX line carrying this `ariaLabel`, so each field is asserted on its own. */
function selectLine(src: string, ariaLabel: string): string {
  const line = src.split("\n").find((l) => l.includes(`ariaLabel="${ariaLabel}"`));
  if (!line) throw new Error(`no Select found with ariaLabel="${ariaLabel}"`);
  return line;
}

// form file → the master-data fields on it that a document can outlive.
const GUARDED: Array<[string, string, string[]]> = [
  [
    "purchase-requests/PurchaseRequestForm.tsx",
    "purchase request",
    ["Supplier", "Delivery warehouse"],
  ],
  [
    "purchase-orders/PurchaseOrderForm.tsx",
    "purchase order",
    ["Supplier", "Delivery warehouse"],
  ],
  [
    "jobs/JobForm.tsx",
    "job",
    ["Customer", "Supplier"],
  ],
];

describe("master-data selects keep a saved value visible after it is deactivated", () => {
  for (const [file, doc, fields] of GUARDED) {
    describe(`${doc} form`, () => {
      const src = read(file);

      it.each(fields)("%s resolves its saved value by id", (field) => {
        expect(selectLine(src, field)).toContain("withHistoricalOption(");
      });

      // The wrapper is only reachable if the file imports it — a guard against a find/replace that
      // leaves the call but drops the import, which typecheck would catch but only while the file
      // still compiles as part of a full run.
      it("imports the shared helper rather than reimplementing it", () => {
        expect(src).toContain('from "@/lib/historicalOption"');
      });
    });
  }

  // The counterpart. Fixed enums must NOT be wrapped: their options come from code, cannot be
  // retired, and a saved value is always present — so wrapping them would add a permanently
  // unreachable branch and imply a lifecycle these values do not have.
  it.each([
    ["purchase-requests/PurchaseRequestForm.tsx", "Delivery terms"],
    ["purchase-orders/PurchaseOrderForm.tsx", "Priority"],
    ["jobs/JobForm.tsx", "Job type"],
  ])("%s leaves the fixed enum %s alone", (file, field) => {
    expect(selectLine(read(file), field)).not.toContain("withHistoricalOption(");
  });
});
