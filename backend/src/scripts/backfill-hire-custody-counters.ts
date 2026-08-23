/**
 * One-off maintenance: give every pre-existing hire line its custody counters.
 *
 * `PurchaseOrderRentalLine.issuedQuantity`, `fieldDamageQty` and `fieldDamageReportedAt` were added
 * when hired kit became issuable to engineers on a job. All three carry `@default(...)`, and on
 * MongoDB that is a CLIENT-SIDE default applied at create time — not a stored value. `prisma db push`
 * creates collections and indexes; it never writes a field into rows that already exist. So every
 * hire raised before that change has no such field at all.
 *
 * ABSENT IS NOT ZERO, and that is what made this urgent rather than cosmetic. The issue guard
 * (`adjustHireIssuedQtyTx`) is a conditional update whose `where` bounds `issuedQuantity` — and in
 * MongoDB a range comparison does not match a document that lacks the field. Every issue of a
 * pre-existing hire matched zero rows and was refused with "those units are no longer available on
 * this hire — stock changed", on hires with everything still on the shelf.
 *
 * That hole is now closed in the query itself (the `isSet: false` arm in `adjustHireIssuedQtyTx`), so
 * this script is no longer what makes the feature work. It is still worth running: a stored 0 is an
 * honest row, it keeps `received − returned − issued` readable straight out of the database, and it
 * means the next person reading these documents does not have to know about the trap to understand
 * what they are looking at.
 *
 * DRY RUN BY DEFAULT — it only reports what it would change. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/backfill-hire-custody-counters.ts
 *   npx tsx --conditions=development src/scripts/backfill-hire-custody-counters.ts --apply
 *
 * Safe to re-run: it only touches rows where the field is MISSING, so a second pass finds nothing.
 * It never overwrites a stored value — including a stored 0 — so it cannot undo real custody.
 *
 * `fieldDamageReportedAt` is deliberately NOT backfilled: it is nullable, its absence and a null read
 * identically through Prisma, and writing a null would claim a damage report that never happened.
 *
 * This script deliberately talks to Prisma directly rather than through a repository: it is one-off
 * maintenance, not part of the layered request path.
 */

import { prisma } from "../lib/prisma.js";

const APPLY = process.argv.includes("--apply");

/** The counters that must exist as real numbers, and the value a missing one stands for. */
const COUNTERS = [
  { field: "issuedQuantity", value: 0 },
  { field: "fieldDamageQty", value: 0 },
] as const;

async function countMissing(field: string): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    count: "PurchaseOrderRentalLine",
    query: { [field]: { $exists: false } },
  })) as { n?: number };
  return res.n ?? 0;
}

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING hire custody-counter backfill.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  let touched = 0;
  for (const { field, value } of COUNTERS) {
    const missing = await countMissing(field);
    if (missing === 0) {
      console.log(`  ${field}: nothing to do — every hire line already stores it.`);
      continue;
    }
    touched += missing;
    if (!APPLY) {
      console.log(`  ${field}: ${missing} hire line${missing === 1 ? "" : "s"} would be set to ${value}.`);
      continue;
    }
    // $exists:false in the filter is what makes this non-destructive: a row that already stores a
    // value — including a real, hard-won 0 — is not selected, so re-running can never reset custody.
    const res = (await prisma.$runCommandRaw({
      update: "PurchaseOrderRentalLine",
      updates: [{ q: { [field]: { $exists: false } }, u: { $set: { [field]: value } }, multi: true }],
    })) as { nModified?: number };
    console.log(`  ${field}: set to ${value} on ${res.nModified ?? 0} hire line${res.nModified === 1 ? "" : "s"}.`);
  }

  if (touched === 0) console.log("\nNothing to backfill.");
  else if (!APPLY) console.log(`\n${touched} field value${touched === 1 ? "" : "s"} would be written. Re-run with --apply.`);
  else console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
