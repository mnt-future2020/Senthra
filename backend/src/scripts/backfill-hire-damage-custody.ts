/**
 * One-off maintenance: move damage records for equipment the provider has ALREADY COLLECTED.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────────────────────────
 *
 * A hire's damaged units have exactly one way out of our custody: they go back to the provider on the
 * collection note, damage and all — a hire stays theirs, and the charge is argued afterwards. The
 * state for that, `returned_to_supplier`, was declared and displayed and never once written.
 *
 * So a record went on reading "Damaged, still here" after the driver had taken it away, and the order
 * line went on printing "N damaged here" against a fully returned hire. Most screens clamp these
 * numbers against what is actually on the shelf, so the drift was invisible on all but one of them —
 * a clamp HIDES this, which is why it survived.
 *
 * ── What this does ─────────────────────────────────────────────────────────────────────────────
 *
 * Runs `reconcileDamageCustodyTx` over every hire line that carries a damage record. That is the same
 * function the collection path and the reversal path now call, not a second implementation of it: the
 * partition is derived from the shelf, so a backfill is simply the first run on rows that never had
 * one. It splits a record when only part of it can have gone, and it moves nothing on a hire whose
 * kit is all still here.
 *
 * SAFE TO RE-RUN. The reconciliation partitions rather than decrements, so a second pass over the same
 * data is a no-op — it re-derives the same answer from the same shelf.
 *
 * The MONEY is deliberately untouched. A record already settled stays settled — the charge was agreed
 * for those units and their going back does not refund it — and an unsettled one stays on the office's
 * worklist, because the provider's invoice lands after they have the equipment. Custody and settlement
 * are two columns for exactly this.
 *
 * Run with:  npx tsx src/scripts/backfill-hire-damage-custody.ts
 */

import { prisma } from "../lib/prisma.js";
import { reconcileDamageCustodyTx } from "../modules/purchase-order/hireCustodyExit.repository.js";

async function main(): Promise<void> {
  const rows = await prisma.hireCustodyExit.findMany({
    where: { kind: "damage" },
    select: { purchaseOrderRentalLineId: true },
    distinct: ["purchaseOrderRentalLineId"],
  });
  console.log(`Hire lines carrying damage records: ${rows.length}`);

  let moved = 0;
  for (const { purchaseOrderRentalLineId: lineId } of rows) {
    const before = await prisma.purchaseOrderRentalLine.findUnique({
      where: { id: lineId },
      select: { itemName: true, fieldDamageQty: true },
    });
    // One line per transaction rather than one for the lot: a single hire that fails — a row edited by
    // hand, a counter that will not reconcile — must not roll back every line before it, and the
    // re-run is a no-op on the ones that already went through.
    await prisma.$transaction(async (tx) => {
      await reconcileDamageCustodyTx(tx, lineId);
    });
    const after = await prisma.purchaseOrderRentalLine.findUnique({
      where: { id: lineId },
      select: { fieldDamageQty: true },
    });
    if (before && after && before.fieldDamageQty !== after.fieldDamageQty) {
      moved += 1;
      console.log(`  ${before.itemName}: damaged-and-here ${before.fieldDamageQty} → ${after.fieldDamageQty}`);
    }
  }

  console.log(moved === 0 ? "Nothing to move — every record already agreed with its shelf." : `Corrected ${moved} hire line(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
