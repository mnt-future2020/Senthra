/**
 * One-off maintenance: give back the real date to custody records a migration dated to its own run.
 *
 * ── What went wrong ────────────────────────────────────────────────────────────────────────────
 *
 * `HireCustodyExit.declaredAt` had no way in — the column took `now()` and no caller could say
 * otherwise. `backfill-hire-custody-exits.ts` therefore stamped every row it created with the moment
 * it ran, and `recomputeCountersTx` copied that same instant onto each hire line's
 * `fieldDamageReportedAt`, overwriting the real date that field had held.
 *
 * That date is not decoration. The hire's Damage & loss panel prints it against every record, next to
 * the note and the charge, and it is the date somebody argues from when a provider disputes a claim.
 * A hire whose damage was found on the 23rd was reading "24 Aug" — the afternoon of the migration.
 *
 * ── Where the real dates come from ─────────────────────────────────────────────────────────────
 *
 *   • FIELD damage — the job return that reported it: the earliest damaged return line on that hire,
 *     at or before the migrated date. Later returns are ignored; they opened records of their own.
 *   • NOTE damage — the note the record was lifted from, which carries the day it reports.
 *   • SPLITS — whatever their parent is corrected to. A slice and the record it was cut from are one
 *     fault and must not end up with two dates.
 *
 * Nothing else moves. A return scan and a loss declaration ARE the declaration, so their `now()` is
 * the fact. A row with no evidence behind it is listed as unexplained and left alone — an honestly
 * unknown date beats an invented one. The rules are in `custody-declared-at.plan.ts`, tested there.
 *
 * DRY RUN BY DEFAULT — it only reports what it would move. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/repair-custody-declared-at.ts
 *   npx tsx --conditions=development src/scripts/repair-custody-declared-at.ts --apply
 *
 * Safe to re-run: a row already carrying the date this computes is not planned again.
 */

import { prisma } from "../lib/prisma.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import { planDeclaredAtRepairs } from "./custody-declared-at.plan.js";
import type { ExitRow } from "./custody-declared-at.plan.js";

const APPLY = process.argv.includes("--apply");

const stamp = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 16);

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING custody declaration-date repair.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  // Every row, because a split is dated from a parent that may be anywhere in the table. These are one
  // row per damage or loss event across all hires — a table counted in hundreds, not millions.
  const rows: ExitRow[] = await prisma.hireCustodyExit.findMany({
    select: { id: true, purchaseOrderRentalLineId: true, poCode: true, itemName: true, sourceType: true, sourceId: true, declaredAt: true },
    orderBy: { declaredAt: "asc" },
  });

  // The evidence: damaged units coming back off a job, on the hires that carry a migrated row. POSTED
  // movements only — a draft has not happened yet and never opened a record.
  const sightings = await prisma.jobStockMovementLine.findMany({
    where: {
      condition: "damaged",
      purchaseOrderRentalLineId: { in: [...new Set(rows.map((r) => r.purchaseOrderRentalLineId))] },
      movement: { is: { direction: "return", status: "posted" } },
    },
    select: { purchaseOrderRentalLineId: true, createdAt: true },
  });

  const notes = await prisma.rentalReceipt.findMany({
    where: { id: { in: [...new Set(rows.filter((r) => r.sourceType === "warehouse_damage_note").map((r) => r.sourceId))] } },
    select: { id: true, deliveryDate: true, createdAt: true },
  });

  const { repairs, unexplained } = planDeclaredAtRepairs(
    rows,
    sightings.flatMap((s) => (s.purchaseOrderRentalLineId ? [{ purchaseOrderRentalLineId: s.purchaseOrderRentalLineId, createdAt: s.createdAt }] : [])),
    notes,
  );

  for (const u of unexplained) {
    console.log(`  ? ${u.poCode ?? "(no order)"} · ${u.itemName} — dated ${stamp(u.declaredAt)}, nothing to date it from. Left alone.`);
  }

  if (repairs.length === 0) {
    console.log(unexplained.length === 0 ? "  Nothing to repair — every record's date is its own." : "\nNothing repairable.");
    return;
  }

  for (const r of repairs) {
    console.log(`  ${stamp(r.from)} → ${stamp(r.to)}  ${r.row.poCode ?? "(no order)"} · ${r.row.itemName} — ${r.reason}`);
  }

  if (!APPLY) {
    console.log(`\n${repairs.length} record${repairs.length === 1 ? "" : "s"} would be re-dated. Re-run with --apply.`);
    return;
  }

  // One transaction per hire, and the recompute inside it: `fieldDamageReportedAt` is derived from
  // these rows, so a repaired date that never reached the line would leave the line still quoting the
  // migration — which is half the bug, in the place it is read from most.
  const byLine = new Map<string, typeof repairs>();
  for (const r of repairs) byLine.set(r.row.purchaseOrderRentalLineId, [...(byLine.get(r.row.purchaseOrderRentalLineId) ?? []), r]);

  for (const [lineId, lineRepairs] of byLine) {
    await prisma.$transaction(async (tx) => {
      for (const r of lineRepairs) await tx.hireCustodyExit.update({ where: { id: r.id }, data: { declaredAt: r.to } });
      await custodyExitRepo.recomputeCountersTx(tx, lineId);
    });
  }

  console.log(`\nDone — ${repairs.length} record${repairs.length === 1 ? "" : "s"} re-dated across ${byLine.size} hire${byLine.size === 1 ? "" : "s"}.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
