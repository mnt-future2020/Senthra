import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ── The trap that has now shipped three times ──────────────────────────────────────────────────
//
// In this Prisma + MongoDB setup, `{ field: null }` in a WHERE matches only rows where the field is
// explicitly null. A field the create path never writes is ABSENT, and absent is not null — verified
// against the real database when the portal-invite count was stuck at zero.
//
// Every occurrence so far was invisible until someone happened to compare two numbers:
//
//   lastLoginAt            portal-invite count sat at 0 forever
//   confirmedDeliveryDate  "Deliveries overdue 8" opened six rows, hiding the un-acknowledged POs
//   acknowledgedAt         the engineer's awaiting-signature count was 0, always
//
// Three times, three different people-hours to find, and each one a SILENT wrong answer — the worst
// failure shape there is, because a count that reads zero looks like an empty desk rather than a bug.
// Reviewing for it clearly does not work, so this test does it instead.
//
// The rule: any `field: null` written as a FILTER must be a field the create path always writes, or
// it must be paired with `isSet: false`. New occurrences fail here until someone states which.

const MODULES = join(import.meta.dirname, "..", "..", "modules");

/** Fields that may be compared to bare `null`, and why that is safe. */
const REVIEWED: Record<string, string> = {
  // Written on EVERY create in this codebase (`data: { deletedAt: null, ... }`), so it is never
  // absent. The soft-delete filters were checked against the database when this trap first surfaced.
  deletedAt: "always written at create",
  // Not a filter — these appear only in `data:` payloads, clearing a token after use.
  resetTokenHash: "write-only (clears the token)",
  resetTokenExpiresAt: "write-only (clears the token)",
  // Cleared on write when a transfer line is reset; never used as a filter.
  customerStockEntryId: "write-only",
  customerName: "write-only",
  irmItemId: "write-only",
  // Written on every movement line, alongside irmItemId/customerStockEntryId above: a line names at
  // most one source pool, so the other pools' ids are explicitly null rather than absent. Never a
  // filter — "which hire did this move" is asked by id, not by null.
  rentalItemId: "write-only",
  purchaseOrderRentalLineId: "write-only",
  code: "write-only",
  sku: "write-only",
  uom: "write-only",
  notes: "write-only",
  scannedCode: "write-only",
  damagePhotoUrl: "write-only",
  damageReason: "write-only",
  warehouseId: "write-only (clears the snapshot on a misc line)",
  warehouseName: "write-only",
  warehouseCode: "write-only",
  roleId: "write-only (unassigns a role)",
  reopenReason: "write-only",
  dueDate: "not Prisma — a DTO field on the dashboard worklist",
  priority: "not Prisma — a DTO field on the dashboard worklist",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.includes(".test.") ? [full] : [];
  });
}

describe("no unreviewed `field: null` comparisons", () => {
  it("every bare null comparison is a field the create path always writes", () => {
    const offenders: string[] = [];

    // Repositories only: they are the sole place Prisma is touched, so a filter cannot live anywhere
    // else. That also keeps DTO shapes and service-level `x: null` defaults out of the scan.
    for (const file of sourceFiles(MODULES).filter((f) => f.endsWith(".repository.ts"))) {
      // Comments are stripped first, and deliberately: several of them QUOTE the broken pattern while
      // explaining the fix beside it. Scanning prose would report the warning as the offence.
      // Replaced with spaces rather than removed so byte offsets — and the line numbers derived from
      // them — still point at the real source.
      const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) =>
        c.replace(/[^\n]/g, " "),
      );
      for (const m of src.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*): null\b/g)) {
        const field = m[1];
        // `{ not: null }` is $ne, which excludes null AND missing — the safe direction. It selects
        // rows that HAVE a value, so an absent field correctly fails to match.
        if (field === "not" || REVIEWED[field]) continue;
        // The safe idiom: `OR: [{ f: null }, { f: { isSet: false } }]`. If the same field is paired
        // with isSet anywhere in the file, this occurrence is part of that pair.
        if (new RegExp(`${field}: \\{ isSet: false \\}`).test(src)) continue;
        // Filter or payload? Look back for whichever of `where`/`data:` is nearer. A `data:` block is
        // a write — `{ notes: null }` there clears a column and is not subject to the trap at all.
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        if (before.lastIndexOf("data:") > before.lastIndexOf("where")) continue;
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file.slice(file.indexOf("modules"))}:${line} — ${field}`);
      }
    }

    expect(
      offenders,
      "`field: null` matches only an EXPLICIT null in Mongo; a field the create path never writes is " +
        "ABSENT and will not match, which fails SILENTLY as a zero. Either pair it with " +
        "`{ isSet: false }`, or add it to REVIEWED with the reason it is safe.",
    ).toEqual([]);
  });

  // The guard is only worth having if it would have caught the three that shipped. Each of them is
  // now written as the safe pair, so the assertion below proves the pattern it looks for is the one
  // those fixes use — not a shape nothing in the codebase actually has.
  it("recognises the fix applied to all three known occurrences", () => {
    const fixed = [
      // Every approval failed with "just handled by someone else" — the claim matched 0 rows.
      ["van-stock-request/van-stock-request.repository.ts", "approvedQty"],
      // The portal-invite count sat at 0 forever.
      ["customer/customer.repository.ts", "lastLoginAt"],
      // "Deliveries overdue 8" opened six rows, hiding every un-acknowledged PO.
      ["purchase-order/purchase-order.repository.ts", "confirmedDeliveryDate"],
      // The engineer's awaiting-signature count was 0, always.
      ["engineer-transfer/engineer-transfer.repository.ts", "acknowledgedAt"],
      // A backfill that skipped the rows it existed to find, and reported success.
      ["warehouse/warehouse.repository.ts", "typeId"],
    ] as const;
    for (const [rel, field] of fixed) {
      const src = readFileSync(join(MODULES, rel), "utf8");
      expect(src, `${rel} should pair ${field} with isSet`).toContain(`${field}: { isSet: false }`);
    }
  });
});
