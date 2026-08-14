/**
 * One-off maintenance: carry retired `reorderQuantity` values over to `maximumStock`.
 *
 * The reorder engine used to derive its top-up target two ways:
 *
 *     target = maximumStock ?? (reorderLevel + reorderQuantity)
 *
 * `reorderQuantity` is now retired (inventory/reorder.ts, schema.prisma) and the target is
 * `maximumStock ?? reorderLevel`. For an item that only ever had `reorderQuantity` set, that is a
 * SILENT change to how much gets ordered: the target collapses to the reorder level, so a
 * suggestion restores stock to exactly the line that triggers reordering and the row fires again
 * immediately. Nobody edits the item, nobody is told, the quantities just get smaller.
 *
 * This writes the number those items were already behaving as: maximumStock = reorderLevel +
 * reorderQuantity. Run it BEFORE the retired-field code reaches production.
 *
 * DRY RUN BY DEFAULT — it only reports what it would change. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/backfill-reorder-target.ts
 *   npx tsx --conditions=development src/scripts/backfill-reorder-target.ts --apply
 *
 * Safe to re-run: an item that already has a maximumStock is never touched, so a second pass finds
 * nothing. `reorderQuantity` is deliberately left in place — it is the evidence of what the old
 * target was, and no code reads it any more.
 *
 * It also REPORTS (never rewrites) rows that violate the newly-enforced ordering
 * critical ≤ reorder ≤ maximum. Those predate the rule; the service now lets you edit such an item's
 * other fields freely, but its reorder suggestions stay incoherent until a human picks the right
 * numbers — which is a judgement call, not something a script should guess.
 *
 * This script deliberately talks to Prisma directly rather than through a repository: it is
 * one-off maintenance, not part of the layered request path.
 */

import { prisma } from "../lib/prisma.js";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING reorder-target backfill.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  // Soft-deleted items are included on purpose: restoring one later must not resurrect it with a
  // quietly-shrunken order quantity.
  const items = await prisma.irmItem.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      reorderLevel: true,
      reorderQuantity: true,
      maximumStock: true,
      criticalLevel: true,
      deletedAt: true,
    },
    orderBy: { code: "asc" },
  });

  const changes: { id: string; code: string; name: string; to: number; from: string }[] = [];
  const incoherent: { code: string; name: string; why: string }[] = [];

  for (const i of items) {
    // Only items that relied on the old fallback: a target expressed ONLY as reorderQuantity.
    // A stored maximumStock always won before and still does, so those rows are unaffected.
    // `> 0`, not merely "is a number": a reorderQuantity of 0 contributed nothing to the old target
    // (reorderLevel + 0 === reorderLevel), so there is no drift to repair — but writing it would set
    // an explicit maximumStock equal to the reorder level, silencing the item form's
    // degenerate-config warning for an item still in exactly that state.
    if (i.maximumStock == null && typeof i.reorderQuantity === "number" && i.reorderQuantity > 0) {
      const base = i.reorderLevel ?? 0;
      changes.push({
        id: i.id,
        code: i.code,
        name: i.name,
        to: base + i.reorderQuantity,
        from: `reorderLevel ${i.reorderLevel ?? "—"} + reorderQuantity ${i.reorderQuantity}`,
      });
      continue;
    }

    // Pre-existing violations of critical ≤ reorder ≤ maximum. Report only.
    if (typeof i.reorderLevel === "number" && typeof i.maximumStock === "number" && i.maximumStock < i.reorderLevel) {
      incoherent.push({ code: i.code, name: i.name, why: `maximum ${i.maximumStock} < reorder ${i.reorderLevel}` });
    }
    if (typeof i.reorderLevel === "number" && typeof i.criticalLevel === "number" && i.criticalLevel > i.reorderLevel) {
      incoherent.push({ code: i.code, name: i.name, why: `critical ${i.criticalLevel} > reorder ${i.reorderLevel}` });
    }
  }

  console.log(`IrmItem: ${items.length} rows, ${changes.length} to backfill, ${incoherent.length} incoherent threshold(s)\n`);

  for (const c of changes) {
    console.log(`  ${c.code}  ${c.name}`);
    console.log(`      maximumStock: null → ${c.to}   (${c.from})`);
  }

  if (incoherent.length) {
    console.log(`\n  Thresholds that don't stack — left untouched, they need a human:`);
    for (const x of incoherent) console.log(`  ${x.code}  ${x.name}  ← ${x.why}`);
  }

  if (APPLY) {
    for (const c of changes) {
      await prisma.irmItem.update({ where: { id: c.id }, data: { maximumStock: c.to } });
    }
  }

  console.log(
    `\n${APPLY ? "Backfilled" : "Would backfill"} ${changes.length} item(s). ` +
      `${incoherent.length} threshold problem(s) reported and left as-is.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
