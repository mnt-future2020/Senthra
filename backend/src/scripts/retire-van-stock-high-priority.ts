/**
 * One-off maintenance: rewrite retired Field Stock (VSR) priority `high` → `urgent`.
 *
 * Field Stock now runs a two-level scale — Normal or Urgent (client request, 2026-08-20). The schema
 * in van-stock-request.validation.ts rewrites an incoming "high" to urgent, so nothing STORES it any
 * more; but `priority` is a plain String in Mongo, so every request raised before the change still
 * holds it. Nothing breaks if this is not run: readPriority() maps a stored "high" to urgent on the
 * way out, and the queue's Urgent filter matches both values. This is the tidy-up that makes those
 * two allowances unnecessary — after it, what is stored is what the UI shows.
 *
 * DRY RUN BY DEFAULT — it only reports what it would change. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/retire-van-stock-high-priority.ts
 *   npx tsx --conditions=development src/scripts/retire-van-stock-high-priority.ts --apply
 *
 * Safe to re-run: a second pass finds nothing, because it matches on the retired value itself.
 *
 * Soft-deleted and closed requests are included on purpose. The value is historical record on those,
 * and leaving one behind means a restored or reopened request comes back wearing a level the app no
 * longer renders. "Urgent" is what a "high" request always meant to the reviewer — the worklist has
 * banded the two together since the feature shipped — so this loses no meaning.
 *
 * This script deliberately talks to Prisma directly rather than through a repository: it is one-off
 * maintenance, not part of the layered request path.
 */

import { prisma } from "../lib/prisma.js";

const APPLY = process.argv.includes("--apply");
const RETIRED = "high";
const REPLACEMENT = "urgent";

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING the high→urgent priority retirement.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  const rows = await prisma.vanStockRequest.findMany({
    where: { priority: RETIRED },
    select: { id: true, code: true, status: true, createdAt: true, deletedAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`VanStockRequest: ${rows.length} row(s) still on "${RETIRED}".\n`);
  for (const r of rows) {
    console.log(`  ${r.code}  ${r.status}${r.deletedAt ? " (deleted)" : ""}  ${r.createdAt.toISOString().slice(0, 10)}  →  ${REPLACEMENT}`);
  }

  if (APPLY && rows.length) {
    const { count } = await prisma.vanStockRequest.updateMany({ where: { priority: RETIRED }, data: { priority: REPLACEMENT } });
    console.log(`\nRewrote ${count} row(s).`);
    return;
  }

  console.log(`\n${rows.length ? `Would rewrite ${rows.length} row(s).` : "Nothing to do."}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
