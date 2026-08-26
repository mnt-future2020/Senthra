/**
 * One-off maintenance: give the backfilled damage records the words somebody actually wrote.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────────────────────────
 *
 * `backfill-hire-custody-exits.ts` created a custody record for every damage a hire already carried,
 * and it had to invent a `reason` — the exits did not exist yet, so there was nothing on the row to
 * copy. It wrote "Damage recorded on HDM-0001": true, and useless to the person deciding whether to
 * argue the charge.
 *
 * The real description was never lost. It is on the note, in `conditionNotes` — "left side scratch" —
 * and it is exactly what a report written TODAY puts on the record (see the damage path's
 * `reason: input.conditionNotes?.trim() || …`). So the backfilled rows are the only ones that read
 * like a filing reference instead of an account of what happened.
 *
 * ── Why a data fix and not a display one ───────────────────────────────────────────────────────
 *
 * The alternative was to have the panel prefer the note's words whenever the reason looks like the
 * placeholder. That is a branch in the read path, forever, keyed on a string pattern — and it would
 * quietly rewrite a genuine reason that happened to be phrased the same way. The rows are wrong; the
 * rows get corrected.
 *
 * SAFE TO RE-RUN. It only touches rows whose reason still matches the generated shape AND whose note
 * has something better to offer, so a second pass finds nothing.
 *
 * Run with:  npx tsx src/scripts/backfill-hire-damage-reason.ts
 */

import { prisma } from "../lib/prisma.js";

/** Exactly what the exits backfill wrote, anchored — never a reason somebody typed. */
const PLACEHOLDER = /^Damage recorded on [A-Z]{3}-\d{4}$/;

async function main(): Promise<void> {
  const rows = await prisma.hireCustodyExit.findMany({
    where: { kind: "damage" },
    select: { id: true, reason: true, sourceType: true, sourceId: true, settledByReceiptId: true, itemName: true },
  });
  const stale = rows.filter((r) => PLACEHOLDER.test(r.reason));
  console.log(`Damage records: ${rows.length} · carrying the generated reason: ${stale.length}`);

  let fixed = 0;
  for (const r of stale) {
    // The note this record belongs to, whichever way it is attached. A warehouse report is its own
    // source AND its own settlement; a job report is settled by a note it did not come from.
    const noteId = r.sourceType === "warehouse_damage_note" ? r.sourceId : r.settledByReceiptId;
    if (!noteId) continue;
    const note = await prisma.rentalReceipt.findUnique({
      where: { id: noteId },
      select: { code: true, conditionNotes: true, notes: true },
    });
    // Nothing better to say: leave the reference alone rather than replacing it with an empty string,
    // which would take away the only thing the record currently tells anybody.
    const better = note?.conditionNotes?.trim() || note?.notes?.trim();
    if (!better) continue;
    await prisma.hireCustodyExit.update({ where: { id: r.id }, data: { reason: better } });
    fixed += 1;
    console.log(`  ${r.itemName} (${note?.code}): "${r.reason}" → "${better}"`);
  }

  console.log(fixed === 0 ? "Nothing to correct." : `Corrected ${fixed} record(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
