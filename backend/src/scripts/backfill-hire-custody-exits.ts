/**
 * One-off maintenance: give every damage a hire already carries a custody-exit ROW.
 *
 * ── Why this is not optional ───────────────────────────────────────────────────────────────────
 *
 * `fieldDamageQty` used to be an independent increment. It is now a CACHED COUNT of open damage exits,
 * recomputed as an absolute from those rows by every writer that touches one. On a hire that carries a
 * pre-existing count with no rows behind it, the first such recompute — any damage, any loss, any
 * reversal on that hire — would rebuild the counter from an empty set and silently drop the quarantine,
 * putting a broken tester back into the issuable pool.
 *
 * So this runs BEFORE anything else writes to those hires. It is the migration half of the change.
 *
 * ── What it creates ────────────────────────────────────────────────────────────────────────────
 *
 *   • FIELD damage (`fieldDamageQty > 0`) — reported from a job return scan and never settled. Opened
 *     UNSETTLED, which is correct and is what puts it on the office's worklist: that damage has never
 *     been put to the provider, which is the gap the whole change exists to close.
 *
 *   • NOTE damage (live `damage`-direction note lines) — already on a supplier document, so the exit is
 *     born SETTLED and linked to it. Without these rows a warehouse-raised damage report would leave
 *     its units issuable, since issuability now reads the rows rather than `damagedQuantity`.
 *
 * A `damage` note's units are still ON OUR SHELF, so they quarantine. Damage recorded on a COLLECTION
 * note (`out`) is deliberately skipped: those units left the building on that same note, so there is
 * nothing left to quarantine and a `held_damaged` row would understate the hire for ever.
 *
 * DRY RUN BY DEFAULT — it only reports what it would create. Pass --apply to write.
 *
 *   npx tsx --conditions=development src/scripts/backfill-hire-custody-exits.ts
 *   npx tsx --conditions=development src/scripts/backfill-hire-custody-exits.ts --apply
 *
 * Safe to re-run: every row it writes carries the same `(sourceType, sourceId, hireLine, kind)` key,
 * which is uniquely indexed, so a second pass finds the rows already there and creates nothing.
 */

import { prisma } from "../lib/prisma.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import { instantForDay } from "../utils/calendar-day.js";

const APPLY = process.argv.includes("--apply");

interface Planned {
  hireLineId: string;
  label: string;
  qty: number;
  settled: boolean;
  create: () => Promise<void>;
}

async function planFieldDamage(): Promise<Planned[]> {
  const rows = await prisma.purchaseOrderRentalLine.findMany({
    where: { fieldDamageQty: { gt: 0 } },
    select: {
      id: true,
      itemName: true,
      fieldDamageQty: true,
      fieldDamageReportedAt: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { code: true, warehouseId: true } },
    },
  });

  return rows.map((r) => ({
    hireLineId: r.id,
    label: `${r.purchaseOrder.code} · ${r.itemName}`,
    qty: r.fieldDamageQty,
    settled: false,
    create: async () => {
      await prisma.$transaction(async (tx) => {
        await custodyExitRepo.createExitTx(tx, {
          purchaseOrderRentalLineId: r.id,
          purchaseOrderId: r.purchaseOrderId,
          poCode: r.purchaseOrder.code,
          warehouseId: r.purchaseOrder.warehouseId,
          kind: "damage",
          qty: r.fieldDamageQty,
          itemName: r.itemName,
          custodyState: custodyExitRepo.CUSTODY_HELD_DAMAGED,
          // Honest about what is and is not known. The per-event reason and photograph live on the
          // return movement lines that reported them, and matching a lump counter back to individual
          // lines would be a guess — so this says where to look instead of inventing a reason.
          reason: "Reported damaged on a job return (recorded before per-event damage records existed)",
          notes: "Backfilled from the hire's fieldDamageQty. The reason and photograph for each report are on the job's return movement lines.",
          declaredBy: null,
          // THE DATE THE HIRE ALREADY CLAIMED, not the afternoon this runs. Without it every row this
          // creates is dated to the migration, and `recomputeCountersTx` then writes that same date
          // back onto the line — overwriting the only copy of the real one. The damage panel prints
          // this, so a hire whose kit broke in June would read as broken the day it was migrated.
          declaredAt: r.fieldDamageReportedAt ?? undefined,
          // Keyed on the hire itself: there is exactly one pre-existing counter per hire to migrate, so
          // one row per hire, and a re-run resolves to the same key.
          sourceType: "backfill_field_damage",
          sourceId: r.id,
        });
      });
    },
  }));
}

async function planNoteDamage(): Promise<Planned[]> {
  const lines = await prisma.rentalReceiptLine.findMany({
    where: {
      damagedQuantity: { gt: 0 },
      rentalReceipt: {
        is: {
          direction: "damage",
          OR: [{ reversedAt: null }, { reversedAt: { isSet: false } }],
        },
      },
    },
    select: {
      damagedQuantity: true,
      itemName: true,
      purchaseOrderRentalLineId: true,
      rentalReceipt: { select: { id: true, code: true, purchaseOrderId: true, warehouseId: true, poCode: true, deliveryDate: true, createdAt: true, createdBy: true } },
    },
  });

  return lines.map((l) => ({
    hireLineId: l.purchaseOrderRentalLineId,
    label: `${l.rentalReceipt.code} · ${l.itemName}`,
    qty: l.damagedQuantity,
    settled: true,
    create: async () => {
      await prisma.$transaction(async (tx) => {
        const exit = await custodyExitRepo.createExitTx(tx, {
          purchaseOrderRentalLineId: l.purchaseOrderRentalLineId,
          purchaseOrderId: l.rentalReceipt.purchaseOrderId,
          poCode: l.rentalReceipt.poCode,
          warehouseId: l.rentalReceipt.warehouseId,
          kind: "damage",
          qty: l.damagedQuantity,
          itemName: l.itemName,
          custodyState: custodyExitRepo.CUSTODY_HELD_DAMAGED,
          reason: `Damage recorded on ${l.rentalReceipt.code}`,
          declaredBy: l.rentalReceipt.createdBy,
          // The instant the live path would have written for this note: its own moment when it reports
          // the day it was raised on, and midday of the reported day when it was written up later.
          declaredAt: instantForDay(l.rentalReceipt.deliveryDate, l.rentalReceipt.createdAt),
          sourceType: "warehouse_damage_note",
          sourceId: l.rentalReceipt.id,
        });
        // The note IS the settlement document, so the row is born settled and linked to it — and a
        // later reversal of that note reopens it through the ordinary path rather than needing to know
        // it was backfilled.
        await custodyExitRepo.moveSettlementStateTx(tx, exit.id, custodyExitRepo.SETTLE_UNSETTLED, custodyExitRepo.SETTLE_SETTLED, {
          settledByReceiptId: l.rentalReceipt.id,
          settledAt: l.rentalReceipt.deliveryDate,
        });
      });
    },
  }));
}

/**
 * Give every pre-existing exit the item name it was created without.
 *
 * `itemName` arrived after the first rows did, and on MongoDB a required scalar that a document simply
 * lacks is a READ CRASH through Prisma, not a null — so this is not cosmetic and it has to run before
 * anything reads those rows. Written with a raw update for the same reason: the typed client cannot
 * express "the field is missing", and a findMany over the rows would be the very read that fails.
 *
 * Sourced from the hire line, which is where the name would have been snapshotted from at the time.
 */
async function backfillItemNames(): Promise<number> {
  const found = (await prisma.$runCommandRaw({
    find: "HireCustodyExit",
    filter: { itemName: { $exists: false } },
    projection: { purchaseOrderRentalLineId: 1 },
  })) as { cursor?: { firstBatch?: { _id: unknown; purchaseOrderRentalLineId: unknown }[] } };

  const docs = found.cursor?.firstBatch ?? [];
  if (docs.length === 0) return 0;

  const oid = (v: unknown): string => String((v as { $oid?: string })?.$oid ?? v);
  const lineIds = [...new Set(docs.map((d) => oid(d.purchaseOrderRentalLineId)))];
  const lines = await prisma.purchaseOrderRentalLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, itemName: true } });
  const nameOf = new Map(lines.map((l) => [l.id, l.itemName]));

  if (!APPLY) return docs.length;
  for (const d of docs) {
    await prisma.$runCommandRaw({
      update: "HireCustodyExit",
      updates: [
        {
          q: { _id: d._id as object },
          // A hire line that has since been deleted leaves the row unnamed rather than unreadable —
          // the name is context, and losing it must not cost the evidence.
          u: { $set: { itemName: nameOf.get(oid(d.purchaseOrderRentalLineId)) ?? "Hired equipment" } },
        },
      ],
    });
  }
  return docs.length;
}

async function main(): Promise<void> {
  console.log(APPLY ? "APPLYING hire custody-exit backfill.\n" : "DRY RUN — no writes. Re-run with --apply to write.\n");

  // Names first: everything below reads these rows through the typed client, and a row missing a
  // required scalar makes that read throw rather than return.
  const named = await backfillItemNames();
  if (named > 0) {
    console.log(APPLY ? `  itemName: filled in on ${named} existing exit${named === 1 ? "" : "s"}.` : `  itemName: ${named} existing exit${named === 1 ? "" : "s"} would be named from their hire line.`);
  }

  const planned = [...(await planFieldDamage()), ...(await planNoteDamage())];
  if (planned.length === 0) {
    if (named === 0) console.log("  Nothing to migrate — no hire carries damage without a custody-exit row.");
    return;
  }

  for (const p of planned) {
    console.log(`  ${p.settled ? "settled " : "OPEN    "} ${p.qty} × ${p.label}`);
    if (APPLY) await p.create();
  }

  const units = planned.reduce((n, p) => n + p.qty, 0);
  console.log(
    APPLY
      ? `\nDone — ${planned.length} exit row${planned.length === 1 ? "" : "s"} covering ${units} unit${units === 1 ? "" : "s"}.`
      : `\n${planned.length} exit row${planned.length === 1 ? "" : "s"} covering ${units} unit${units === 1 ? "" : "s"} would be created. Re-run with --apply.`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
