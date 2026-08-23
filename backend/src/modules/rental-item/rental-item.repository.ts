import { Prisma, type RentalItem } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";
import { RENTAL_COUNTER_KEY, formatRentalCode } from "./rentalCode.js";

// Data-access layer for the RentalItem model. The ONLY place Prisma is touched for rentals.

export type RentalItemWithCategory = Prisma.RentalItemGetPayload<{ include: { rentalCategory: true } }>;

const withCategory = { rentalCategory: true } as const;

// A soft-deleted item is invisible to every listing. Both arms are required: on MongoDB a row
// whose create omitted `deletedAt` does not match `{ deletedAt: null }`.
const LIVE = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } satisfies Prisma.RentalItemWhereInput;

export interface ListFilters {
  status?: string;
  categoryId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export async function findMany(filters: ListFilters): Promise<{ items: RentalItemWithCategory[]; total: number }> {
  const where: Prisma.RentalItemWhereInput = { ...LIVE };
  if (filters.status) where.status = filters.status;
  if (filters.categoryId) where.rentalCategoryId = filters.categoryId;
  if (filters.search) {
    // `contains` injects the term into a raw $regex, so an unescaped "(" or "[" would crash the
    // query (P2010 → 500) and "." or "*" would silently match the wrong rows.
    const term = escapeRegex(filters.search.trim());
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { code: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } },
    ];
  }
  const [items, total] = await Promise.all([
    prisma.rentalItem.findMany({
      where,
      include: withCategory,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.rentalItem.count({ where }),
  ]);
  return { items, total };
}

export function findById(id: string): Promise<RentalItemWithCategory | null> {
  return prisma.rentalItem.findFirst({ where: { id, ...LIVE }, include: withCategory });
}

export function findByCode(code: string): Promise<RentalItemWithCategory | null> {
  return prisma.rentalItem.findFirst({ where: { code, ...LIVE }, include: withCategory });
}

/**
 * Resolve a SCANNED label to a live, active catalogue item.
 *
 * `code` is the only thing a rental label can carry: the printed barcode is `Code128(code)`, rendered
 * on read from the item's own RNT-#### (see `renderBarcode`), and this master has no free-text
 * barcode column and no SKU by design. So there is exactly one field to match, and it is already
 * `@unique` — no ambiguity to resolve, unlike the IRM scan's three-way `OR`.
 *
 * Case-insensitive because a scanner or a hand-typed entry can arrive lowercased, and `code` is
 * allocated uppercase. `findByCode` above stays exact — it backs `getRentalItem`'s id-or-code route
 * param, where a loose match would let two different URLs address one record.
 *
 * ACTIVE-only, matching the IRM scan: a retired item may still be out on live hires and stays
 * readable everywhere, but it must not be issuable onto new work.
 */
export function findActiveByCode(code: string): Promise<RentalItemWithCategory | null> {
  return prisma.rentalItem.findFirst({
    where: { code: { equals: code, mode: "insensitive" }, status: "active", ...LIVE },
    include: withCategory,
  });
}

/** Live, ACTIVE items among the given ids — the conversion guard's lookup. */
export function findActiveByIds(ids: string[]): Promise<RentalItem[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.rentalItem.findMany({ where: { id: { in: ids }, status: "active", ...LIVE } });
}

export function update(id: string, data: Prisma.RentalItemUpdateInput): Promise<RentalItemWithCategory> {
  return prisma.rentalItem.update({ where: { id }, data, include: withCategory });
}

/** Soft delete — the row stays so historic PRF/PO lines keep resolving their item. */
export function softDelete(id: string, actorEmail: string | null): Promise<RentalItem> {
  return prisma.rentalItem.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: actorEmail } });
}

// --- dependency counters (the delete guard) ---------------------------------

export function countByPrfLines(rentalItemId: string): Promise<number> {
  return prisma.purchaseRequestRentalLine.count({ where: { rentalItemId } });
}

/**
 * Live job kit lines planning this rental item — a delete guard, like the PRF/PO counts beside it.
 *
 * Missing until now, and the gap was not cosmetic: a rental item could be retired while a job's kit
 * list still named it, leaving a line pointing at a catalogue entry no picker would ever show again.
 * The engineer would arrive to collect something the system could no longer describe.
 *
 * Soft-deleted jobs are excluded — their kit lines are history, not a commitment anyone will act on.
 */
export function countByJobKitLines(rentalItemId: string): Promise<number> {
  return prisma.jobKitLine.count({ where: { rentalItemId, job: { is: { deletedAt: null } } } });
}

export function countByPoLines(rentalItemId: string): Promise<number> {
  return prisma.purchaseOrderRentalLine.count({ where: { rentalItemId } });
}

// --- code allocation (atomic Counter) ---------------------------------------
// Mirrors the IRM allocator: take the next sequence, and on a code collision fast-forward the
// counter past whatever is already stored and retry. Codes are never reused.

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("code");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Highest number across ALL rental codes, so recovery stays correct if the counter is lost.
 *
 * Deliberately prefix-BLIND: the prefix is configurable, so a table can hold RNT-0007 beside
 * EQP-0011, and they share ONE sequence. Filtering by the current prefix here would restart from the
 * highest EQP number and hand out codes that already exist under another prefix.
 */
async function highestRentalNumber(): Promise<number> {
  const rows = await prisma.rentalItem.findMany({ select: { code: true } });
  let max = 0;
  for (const { code } of rows) {
    const m = /-(\d+)$/.exec(code);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({
      where: { key: RENTAL_COUNTER_KEY },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestRentalNumber();
  try {
    await prisma.counter.create({ data: { key: RENTAL_COUNTER_KEY, seq: start } });
  } catch (e) {
    // Another request created it in the gap — fine, the update below still moves it forward.
    if (!isUniqueConflict(e)) throw e;
  }
  const c = await prisma.counter.update({
    where: { key: RENTAL_COUNTER_KEY },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestRentalNumber();
  await prisma.counter.upsert({
    where: { key: RENTAL_COUNTER_KEY },
    create: { key: RENTAL_COUNTER_KEY, seq: max },
    update: { seq: max },
  });
}

/** Create an item with a freshly-allocated, collision-safe code. */
// `prefix` is the configured display prefix (e.g. "RNT"); the number comes from the fixed counter.
export async function createWithCode(
  data: Omit<Prisma.RentalItemCreateInput, "code">,
  prefix: string,
): Promise<RentalItemWithCategory> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    try {
      return await prisma.rentalItem.create({
        data: { deletedAt: null, ...data, code: formatRentalCode(prefix, seq) },
        include: withCategory,
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique rental code.");
}
