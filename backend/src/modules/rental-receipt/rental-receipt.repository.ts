import { Prisma } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";
import { conflict } from "../../utils/http-error.js";
import { DIRECTION_COUNTER_KEY, formatRentalReceiptCode, type ReceiptDirection } from "./rentalReceiptCode.js";

// Data-access layer for hire movement notes. The ONLY place Prisma is touched for rental receipts.
//
// A receipt is written together with its lines AND the running total it moves on each hire line, in
// one transaction: a receipt that landed while the hire line's `receivedQuantity` did not would leave
// the fast-query total disagreeing with the records it is supposed to summarise, and nothing would
// ever notice. Same rule for the reversal.

const withRelations = {
  lines: { orderBy: { sortOrder: "asc" } },
  attachments: { orderBy: { createdAt: "asc" } },
  warehouse: { select: { id: true, code: true, name: true } },
} satisfies Prisma.RentalReceiptInclude;

export type RentalReceiptWithRelations = Prisma.RentalReceiptGetPayload<{ include: typeof withRelations }>;

/**
 * What a hire line must become, and what it must still look like for that to be honest.
 *
 * `expect` is an OPTIMISTIC LOCK. The service reads the line, works out the new running total from
 * what it read, and hands both here — so the write only lands if nobody moved that total in between.
 * Without it two receivers posting at the same moment both read 0, both pass the outstanding check,
 * and both write an ABSOLUTE total: a 5-unit line ends up carrying two notes for 7 units and a stored
 * total of whichever transaction committed last. The cap is defeated and nothing ever notices, because
 * these totals are only recomputed on a reversal.
 *
 * Omitted on the writes that are not accumulations — a reversal's recompute is already derived from
 * the surviving notes inside the same transaction.
 */
export interface HireLineWrite {
  id: string;
  expect?: Prisma.PurchaseOrderRentalLineWhereInput;
  data: Prisma.PurchaseOrderRentalLineUncheckedUpdateInput;
}

/**
 * Apply one hire-line write, refusing if the line no longer looks the way the caller read it.
 *
 * Throws the HTTP error from the repository, exactly as inventory.repository.ts does for the same
 * class of problem ("Insufficient stock … Refresh and try again."): the check can only be made here,
 * inside the transaction, and whoever lost the race needs an instruction rather than a 500 they will
 * retry straight back into it.
 */
async function applyHireWrite(tx: Prisma.TransactionClient, u: HireLineWrite): Promise<void> {
  if (!u.expect) {
    await tx.purchaseOrderRentalLine.update({ where: { id: u.id }, data: u.data });
    return;
  }
  // updateMany, because `update` takes a UNIQUE where and cannot carry the guard columns.
  const res = await tx.purchaseOrderRentalLine.updateMany({ where: { id: u.id, ...u.expect }, data: u.data });
  if (res.count !== 1) {
    throw conflict(
      "Someone recorded another movement on this hire a moment ago. Reload and check what is outstanding before recording again.",
    );
  }
}

/**
 * The order's hire lines as they stand INSIDE a transaction — the reversal's other pre-read.
 *
 * The reversal compares its recomputed totals against the line's own `receivedQuantity`, `quantity`,
 * `hireStatus` and `shortClosedAt`: they decide `fullyReturned`, whether the line goes back on the
 * receiving queue, and whether the reversal is refused — because the kit has already gone back, or
 * because the outstanding units were recorded as never arriving. Read before the transaction opened,
 * all of them can have moved — a delivery landing mid-window makes `fullyReturned` true against a
 * total that is no longer the total, a concurrent return slips past the already-returned guard
 * entirely, and a short close landing there would have its shortfall silently unpicked.
 *
 * Reading them here rather than through the purchase-order repository is the same boundary this
 * module already sits on: it WRITES PurchaseOrderRentalLine (see applyHireWrite), because the hire's
 * running totals and the notes that produce them are one transaction or they are nothing.
 */
export function hireLinesForOrderTx(tx: Prisma.TransactionClient, purchaseOrderId: string) {
  return tx.purchaseOrderRentalLine.findMany({
    where: { purchaseOrderId },
    select: { id: true, itemName: true, quantity: true, receivedQuantity: true, hireStatus: true, shortClosedAt: true },
  });
}

/**
 * Units of each hire line recorded damaged, across EVERY live note that can record it.
 *
 * Its own function rather than `receivedTotalsByLine(po, "damage", ...)` because damage has two
 * sources, not one: a report filed while the kit is with us, and a collection note saying what went
 * back broken. The service caps both against this same total so one unit cannot be counted — or
 * charged — twice, which means the reversal has to rebuild it from both too. Filtered to reports
 * alone, withdrawing one claim would silently erase a live note's damage along with it.
 *
 * `{ in: [...] }` is safe here where `movementDatesByHireLine` had to avoid it: the rows it can miss
 * are the ones with no `direction` stored at all, and those are deliveries written before the field
 * existed. A delivery carries no damage of ours — damage that arrived with the kit is the supplier's.
 */
export async function damagedTotalsByLine(
  purchaseOrderId: string,
  // The reversal MUST pass one, for the same reason receivedTotalsByLine does: read outside the
  // transaction, the absolute figure derived from this is stale before it lands.
  tx?: Prisma.TransactionClient,
): Promise<Map<string, number>> {
  const rows = await (tx ?? prisma).rentalReceiptLine.findMany({
    where: { rentalReceipt: { is: { purchaseOrderId, direction: { in: ["damage", "out"] }, ...LIVE } } },
    select: { purchaseOrderRentalLineId: true, damagedQuantity: true },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.purchaseOrderRentalLineId, (totals.get(r.purchaseOrderRentalLineId) ?? 0) + r.damagedQuantity);
  }
  return totals;
}

/** A reversed note moved nothing — every total, list and count reads live rows only. */
const LIVE = { OR: [{ reversedAt: null }, { reversedAt: { isSet: false } }] } satisfies Prisma.RentalReceiptWhereInput;

export function findById(id: string): Promise<RentalReceiptWithRelations | null> {
  return prisma.rentalReceipt.findUnique({ where: { id }, include: withRelations });
}

export function findByCode(code: string): Promise<RentalReceiptWithRelations | null> {
  return prisma.rentalReceipt.findUnique({ where: { code }, include: withRelations });
}

/**
 * Every note against a purchase order — deliveries, returns and damage reports alike, newest first.
 *
 * REVERSED ones included, deliberately. A reversal keeps the record and marks it precisely so the
 * history stays readable: hiding it would leave a hire whose quantities changed with nothing on screen
 * saying why, which is the thing reversing-instead-of-deleting exists to prevent. Every TOTAL still
 * counts live rows only — that is `receivedTotalsByLine`'s job, and it keeps its filter.
 */
export function findByPurchaseOrder(purchaseOrderId: string): Promise<RentalReceiptWithRelations[]> {
  return prisma.rentalReceipt.findMany({
    where: { purchaseOrderId },
    include: withRelations,
    orderBy: { deliveryDate: "desc" },
  });
}

/**
 * Set or clear the damage charges on a note, after the fact.
 *
 * Written as one transaction so a note cannot end up carrying half a supplier's invoice. `undefined`
 * on the reference leaves it alone; `null` on a line's charge CLEARS it — a charge that turned out
 * not to be coming has to be removable, and leaving 0 there would read as "they charged us nothing".
 *
 * The service has already checked that this note can take a charge at all — the `in` leg cannot, and
 * a reversed note cannot.
 */
export async function updateDamageCharges(
  receiptId: string,
  damageChargeRef: string | undefined,
  lines: { purchaseOrderRentalLineId: string; damageChargePence: number | null }[],
): Promise<RentalReceiptWithRelations> {
  return withTransaction(async (tx) => {
    if (damageChargeRef !== undefined) {
      await tx.rentalReceipt.update({ where: { id: receiptId }, data: { damageChargeRef } });
    }
    for (const l of lines) {
      // updateMany on the note+line pair, which is the row's own @@unique: an id from the request
      // that does not belong to this note simply updates nothing, and the service has already
      // refused it by name so nobody is left guessing which line was ignored.
      await tx.rentalReceiptLine.updateMany({
        where: { rentalReceiptId: receiptId, purchaseOrderRentalLineId: l.purchaseOrderRentalLineId },
        data: { damageChargePence: l.damageChargePence },
      });
    }
    const full = await tx.rentalReceipt.findUnique({ where: { id: receiptId }, include: withRelations });
    if (!full) throw new Error("Rental receipt vanished inside its own transaction.");
    return full;
  });
}

// ── The register — every movement, across every order ─────────────────────────────────────────
//
// `findByPurchaseOrder` above answers "what happened on THIS order", which is the question the order
// page asks. It was also the ONLY read this module had, and that made a finished hire unreachable
// without already knowing its order: nothing could ask "every collection in July", which is what an
// invoice arriving from a supplier actually needs answering. The GRN register has had this shape
// since it existed; hire movements are the same kind of record and get the same one.

export interface RentalReceiptListFilters {
  /** Code, order code, supplier, the supplier's own note number, or the carrier. */
  search?: string;
  /** in | out | damage — one leg of the loop. */
  direction?: string;
  warehouseId?: string;
  /**
   * Warehouse-access scope. `undefined` = unrestricted; an array constrains to those warehouses (an
   * empty array correctly matches nothing). Applied ALONGSIDE `warehouseId` — a chosen warehouse
   * narrows the permitted set, it can never widen it.
   */
  warehouseIds?: string[];
  supplierId?: string;
  purchaseOrderId?: string;
  /** Inclusive calendar-day bounds on the date the equipment MOVED — a reporting period. */
  dateFrom?: Date;
  dateTo?: Date;
  /**
   * Reversed notes are IN the register by default, exactly as they are on the order page: a movement
   * that was corrected is a fact about the period, and hiding it is how a reconciliation quietly
   * stops matching. `false` excludes them — the setting a finance export wants, because a reversed
   * note moved nothing and must not be summed.
   */
  includeReversed?: boolean;
}

/**
 * The forms of one asset tag worth looking for — as typed, and in each case.
 *
 * NOT regex-escaped, unlike the `contains` arms beside it: these are compared as whole values by
 * Mongo, never injected into a pattern, so a bracket in a tag is a bracket.
 */
function tagVariants(raw: string): string[] {
  const tag = raw.trim();
  return [...new Set([tag, tag.toUpperCase(), tag.toLowerCase()])];
}

function buildListWhere(f: RentalReceiptListFilters): Prisma.RentalReceiptWhereInput {
  const where: Prisma.RentalReceiptWhereInput = {};
  if (f.direction) where.direction = f.direction;
  if (f.warehouseId) where.warehouseId = f.warehouseId;
  if (f.warehouseIds !== undefined) {
    where.warehouseId = { ...(typeof where.warehouseId === "string" ? { equals: where.warehouseId } : {}), in: f.warehouseIds };
  }
  if (f.supplierId) where.supplierId = f.supplierId;
  if (f.purchaseOrderId) where.purchaseOrderId = f.purchaseOrderId;
  if (f.dateFrom || f.dateTo) {
    where.deliveryDate = { ...(f.dateFrom ? { gte: f.dateFrom } : {}), ...(f.dateTo ? { lte: f.dateTo } : {}) };
  }
  // BOTH of the clauses below want a top-level `OR`, and only one of them can have it: assigning
  // `where.OR` twice means the second silently wins.
  //
  // It did. `includeReversed: false` set the live filter as `OR`, the search then overwrote it, and
  // typing anything into the box quietly put reversed notes back in the list — and in the export —
  // while the Filters trigger still counted the filter as on. That is the worst shape a filter bug
  // takes: the screen says it is narrowed and it is not.
  //
  // AND'd instead, exactly as the purchase-order register does for its derived statuses, whose own
  // comment names this trap: "AND'd ... so they compose with (and can't be clobbered by) the search
  // OR further down".
  const and: Prisma.RentalReceiptWhereInput[] = [];
  if (f.includeReversed === false) and.push(LIVE);
  if (f.search) {
    // escapeRegex, always: Prisma injects `contains` into a Mongo $regex unescaped, so a bare "(" in
    // a search box is a 500 rather than no results.
    const q = escapeRegex(f.search);
    and.push({ OR: [
      { code: { contains: q, mode: "insensitive" } },
      { poCode: { contains: q, mode: "insensitive" } },
      { supplierName: { contains: q, mode: "insensitive" } },
      { deliveryNoteRef: { contains: q, mode: "insensitive" } },
      { carrier: { contains: q, mode: "insensitive" } },
      // THE SUPPLIER'S OWN ASSET TAG, and the one identifier here that names a physical unit.
      //
      // Everything else on this record describes a movement; `FT-9` describes the tester. It is the
      // string somebody reaches for when a supplier says a unit came back broken — "when did FT-9
      // arrive, and what condition was it in" — and without this arm the only way to answer that was
      // to download the lines CSV and search the file, which is not a register.
      //
      // WHOLE TAG, not a substring, and that is a limit of the storage rather than a choice: tags are
      // a Mongo scalar LIST, whose filters (`has` / `hasSome`) compare whole elements. There is no
      // `contains` for a list member, and giving one would mean mirroring every tag into a normalised
      // field — a schema change and a backfill for a search nobody has asked to be fuzzy.
      //
      // The case variants are what make it usable anyway: tags are typed as they are printed, and
      // `has` is case-SENSITIVE, so "ft-9" would silently find nothing on a sheet reading "FT-9".
      { lines: { some: { assetTags: { hasSome: tagVariants(f.search) } } } },
    ] });
  }
  if (and.length) where.AND = and;
  return where;
}

export function findMany(filters: RentalReceiptListFilters, skip = 0, take = 20): Promise<RentalReceiptWithRelations[]> {
  return prisma.rentalReceipt.findMany({
    where: buildListWhere(filters),
    include: withRelations,
    // The date the equipment MOVED, not when the row was written — the register is read as a period,
    // and a note entered late belongs where it happened. `@@index([warehouseId, deliveryDate])` and
    // `@@index([reversedAt, deliveryDate])` both end on this key.
    orderBy: [{ deliveryDate: "desc" }, { code: "desc" }],
    skip,
    take,
  });
}

export function count(filters: RentalReceiptListFilters): Promise<number> {
  return prisma.rentalReceipt.count({ where: buildListWhere(filters) });
}

export interface NewReceiptHeader {
  direction: ReceiptDirection;
  purchaseOrderId: string;
  poCode: string | null;
  supplierId: string | null;
  supplierName: string | null;
  warehouseId: string;
  deliveryDate: Date;
  carrier: string | null;
  deliveryNoteRef: string | null;
  notes: string | null;
  condition: string;
  conditionNotes: string | null;
  receivedBy: string | null;
  /** The supplier's quote or invoice number for damage. Only ever set on the `out`/`damage` legs. */
  damageChargeRef: string | null;
  createdBy: string | null;
}

export interface NewReceiptLine {
  purchaseOrderRentalLineId: string;
  itemName: string;
  baseUnit: string | null;
  orderedQuantity: number;
  previouslyReceived: number;
  receivedQuantity: number;
  damagedQuantity: number;
  assetTags: string[];
  notes: string | null;
  sortOrder: number;
  /**
   * What the supplier is charging for the damage on this line, in pence. `null` is "nothing recorded"
   * and 0 is "they are not charging" — see the field's note in schema.prisma.
   */
  damageChargePence: number | null;
}

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return target == null || String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

/** Highest number in ONE direction's series, so recovery stays correct if its counter row is lost. */
async function highestNumber(direction: ReceiptDirection): Promise<number> {
  const head = `${DIRECTION_COUNTER_KEY[direction]}-`;
  const rows = await prisma.rentalReceipt.findMany({ where: { code: { startsWith: head } }, select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const suffix = code.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(direction: ReceiptDirection): Promise<number> {
  const key = DIRECTION_COUNTER_KEY[direction];
  try {
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestNumber(direction);
  try {
    await prisma.counter.create({ data: { key, seq: start } });
  } catch (e) {
    // Another request created it in the gap — the update below still moves it forward.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

async function fastForwardCounter(direction: ReceiptDirection): Promise<void> {
  const key = DIRECTION_COUNTER_KEY[direction];
  const max = await highestNumber(direction);
  await prisma.counter.upsert({ where: { key }, create: { key, seq: max }, update: { seq: max } });
}

/**
 * Write the receipt, its lines, and the running total on every hire line it delivered — atomically.
 *
 * The hire STATUS moves here too: any quantity arriving starts the hire, because the deadline applies
 * to the units that are actually here. The caller decides which lines qualify; this writes what it is
 * told, inside one transaction, so a half-applied delivery cannot exist.
 */
export async function createWithCode(
  header: NewReceiptHeader,
  lines: NewReceiptLine[],
  /**
   * What each hire line becomes. Written in the SAME transaction as the note, so a running total can
   * never disagree with the records it summarises — the reason these are stored at all.
   */
  hireUpdates: HireLineWrite[],
): Promise<RentalReceiptWithRelations> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence(header.direction);
    const code = formatRentalReceiptCode(header.direction, seq);
    try {
      return await withTransaction(async (tx) => {
        const receipt = await tx.rentalReceipt.create({ data: { ...header, code } });
        for (const line of lines) {
          await tx.rentalReceiptLine.create({ data: { ...line, rentalReceiptId: receipt.id } });
        }
        for (const u of hireUpdates) {
          await applyHireWrite(tx, u);
        }
        const full = await tx.rentalReceipt.findUnique({ where: { id: receipt.id }, include: withRelations });
        if (!full) throw new Error("Rental receipt vanished inside its own transaction.");
        return full;
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter(header.direction);
    }
  }
  throw new Error("Could not allocate a unique hire note code.");
}

/**
 * Reverse a note and take its quantities back off the hire lines — atomically.
 *
 * `hireUpdates` carries the recomputed totals rather than a decrement, so the result is always the sum
 * of the notes that remain rather than the outcome of arithmetic on a number that may already have
 * drifted. A hire whose total falls back to zero returns to awaiting delivery: it never arrived.
 */
export async function reverseReceipt(
  id: string,
  stamp: { reversedAt: Date; reversedBy: string | null; reversalReason: string | null },
  /**
   * The recompute itself, NOT its result — run here, against this transaction's client.
   *
   * It used to be a prebuilt array, and that was the bug the sentence above claimed it wasn't. The
   * caller worked out ABSOLUTE totals ("this line now has 3") from the notes it read moments earlier,
   * and the transaction wrote them unconditionally. A delivery note committed in that window — with
   * its own optimistic guard, so entirely correct on its side — was then erased by the reversal's
   * pre-read figure, with nothing left to re-trigger the calculation. The two writes never overlap in
   * time, so Mongo raises no write conflict; `fullyReceived` and the receiving queue simply follow
   * the wrong number from then on.
   *
   * Passing the work instead of its result is what makes "derived from the surviving notes inside the
   * same transaction" literally true.
   */
  buildHireUpdates: (tx: Prisma.TransactionClient) => Promise<HireLineWrite[]>,
): Promise<RentalReceiptWithRelations> {
  return withTransaction(async (tx) => {
    // BEFORE the reversal is stamped, deliberately: the totals read counts LIVE notes only, and this
    // note is still one of them. The arithmetic subtracts it explicitly ("what the set says, minus
    // this one"), so stamping first would take it out twice and give back double.
    const hireUpdates = await buildHireUpdates(tx);
    await tx.rentalReceipt.update({ where: { id }, data: stamp });
    for (const u of hireUpdates) {
      await applyHireWrite(tx, u);
    }
    const full = await tx.rentalReceipt.findUnique({ where: { id }, include: withRelations });
    if (!full) throw new Error("Rental receipt vanished inside its own transaction.");
    return full;
  });
}

/**
 * Live totals per hire line, in ONE direction — the truth the running totals on the line summarise.
 *
 * Recomputed from the notes rather than decremented, so a reversal always leaves the line agreeing with
 * the set of records that still stand.
 */
export async function receivedTotalsByLine(
  purchaseOrderId: string,
  direction: ReceiptDirection = "in",
  // Which number to total. `damage` reports are counted on their damaged column — it is the same
  // figure either way (see the service), but reading the one the caller means keeps it honest.
  column: "receivedQuantity" | "damagedQuantity" = "receivedQuantity",
  // The reversal path MUST pass one. Read on the ambient client, this total is a snapshot from
  // before the transaction opened, and the absolute figure derived from it can be stale by the time
  // it lands — see reverseReceipt. Through `tx` the read and the write it feeds are one commit.
  tx?: Prisma.TransactionClient,
): Promise<Map<string, number>> {
  const rows = await (tx ?? prisma).rentalReceiptLine.findMany({
    where: { rentalReceipt: { is: { purchaseOrderId, direction, ...LIVE } } },
    select: { purchaseOrderRentalLineId: true, receivedQuantity: true, damagedQuantity: true },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.purchaseOrderRentalLineId, (totals.get(r.purchaseOrderRentalLineId) ?? 0) + r[column]);
  }
  return totals;
}

export function addAttachment(
  data: {
    rentalReceiptId: string;
    label: string | null;
    fileName: string;
    fileType: string;
    fileSizeBytes: number;
    url: string;
    publicId: string | null;
    resourceType: string | null;
    uploadedBy: string | null;
  },
  // Passed by the direct-upload finalize, which commits this row and its pending-upload ledger
  // removal together — so a photo row cannot outlive the ledger entry that would have reaped it.
  tx?: Prisma.TransactionClient,
) {
  return (tx ?? prisma).rentalReceiptAttachment.create({ data });
}

export function findAttachment(id: string) {
  return prisma.rentalReceiptAttachment.findUnique({ where: { id } });
}

export function deleteAttachment(id: string) {
  return prisma.rentalReceiptAttachment.delete({ where: { id } });
}

/**
 * When a hire physically STARTED and ENDED, per hire line — read off its own movement notes.
 *
 * Both OPTIONAL rather than nullable: a leg that has not happened has no date, and absent says that
 * more plainly than a null does. It also keeps a bare `x: null` out of a repository, where the
 * null-vs-absent scanner reads one as a Mongo filter (see lib/__tests__/null-vs-absent.test.ts).
 */
export interface HireMovementDates {
  /** The earliest live delivery against the line. Absent while nothing has arrived. */
  deliveredOn?: Date;
  /** The latest live return. Absent until something has gone back. */
  collectedOn?: Date;
  /**
   * Everything the supplier is charging us for damage to this hire, in pence, across its live damage
   * reports and returns. Absent when no charge has been recorded — which is NOT the same as zero, and
   * the screens say so: a hire with damage and no figure yet is waiting on a quote.
   */
  damageChargePence?: number;
}

/**
 * The physical window of each hire, batched for a page of hire lines.
 *
 * Read from the NOTES rather than from the hire line's `receivedAt` / `returnedAt`, because those two
 * are stamped `new Date()` when the record is written and the note carries the date the equipment
 * actually moved. Paperwork lags reality — that is the whole reason `deliveryDate` is a field the
 * user fills in rather than a timestamp — and a hire billed from when somebody got round to typing it
 * in is a number no supplier invoice will ever agree with.
 *
 * ONE query for the whole page, keyed on `@@index([purchaseOrderRentalLineId])`. Empty in, empty out:
 * `{ in: [] }` is a valid Prisma filter that matches nothing, but the round trip is still a round trip.
 *
 * Every LIVE note is read, in all three directions — a reversed one moved nothing and charges
 * nothing. Which fact each contributes differs, and the reduction is explicit about it rather than
 * relying on the query to exclude a leg: a note with no `direction` stored at all is a delivery
 * written before that field existed, and in MongoDB such a row matches `$ne` but not `$in`, so the
 * classification has to survive the value being absent.
 */
export async function movementDatesByHireLine(lineIds: string[]): Promise<Map<string, HireMovementDates>> {
  const out = new Map<string, HireMovementDates>();
  if (lineIds.length === 0) return out;
  const rows = await prisma.rentalReceiptLine.findMany({
    where: { purchaseOrderRentalLineId: { in: lineIds }, rentalReceipt: { is: LIVE } },
    select: {
      purchaseOrderRentalLineId: true,
      damageChargePence: true,
      rentalReceipt: { select: { direction: true, deliveryDate: true } },
    },
  });
  for (const r of rows) {
    const at = r.rentalReceipt.deliveryDate;
    const direction = r.rentalReceipt.direction ?? "in";
    const cur: HireMovementDates = out.get(r.purchaseOrderRentalLineId) ?? {};
    if (direction === "out") {
      // LAST collection: a hire goes back in parts, and the one that ends it is the final one.
      if (!cur.collectedOn || at.getTime() > cur.collectedOn.getTime()) cur.collectedOn = at;
    } else if (direction !== "damage" && (!cur.deliveredOn || at.getTime() < cur.deliveredOn.getTime())) {
      // FIRST delivery: the clock starts on the first unit to arrive, not the last. A damage report
      // moves nothing and never starts it.
      cur.deliveredOn = at;
    }
    // Only OUR damage carries a charge. The service refuses to set one on an arrival — damage that
    // came with the kit is the supplier's own fault — but the sum asks anyway rather than trusting a
    // write path to have been the only one that ever ran.
    if (direction !== "in" && r.damageChargePence != null) {
      cur.damageChargePence = (cur.damageChargePence ?? 0) + r.damageChargePence;
    }
    out.set(r.purchaseOrderRentalLineId, cur);
  }
  return out;
}
