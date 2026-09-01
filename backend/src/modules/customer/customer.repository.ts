import {
  Prisma,
  type Customer,
  type CustomerProject,
  type CustomerSite,
  type CustomerStockRequest,
  type CustomerUser,
} from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";
import { isEmptyWindow, type DayWindow } from "../../utils/filter-date.js";

// Repo functions in the customer-receive path accept an optional transaction client so the
// caller can run the assignment update, request-status update and stock-entry write atomically
// (see receiveStockAssignment). Defaults to the shared client for all non-transactional callers.
type Db = Prisma.TransactionClient | typeof prisma;

// Data-access layer for the Customer aggregate (Customer + projects + sites +
// users). The ONLY place Prisma is touched for customers. Soft-deleted customers
// (deletedAt set) are excluded from normal reads.
//
// ISOLATION INVARIANT: every nested read/write is scoped by `customerId`. Callers
// pass the customerId resolved from the route (admin) or from req.principal
// (customer portal) — a customer can only ever address its own rows.

// NOTE: sites/projects are deliberately NOT included here — sites can be bulk-imported in the
// thousands, so the detail read must never carry the full child sets. The detail page's Sites /
// Projects tabs read them through the PAGED queries below instead.
export type CustomerWithChildren = Customer & {
  users: CustomerUser[];
  // Carries the preferred warehouse alongside each submission — the admin detail is the screen the
  // reviewer works from, so the preference has to arrive with the row, not via a second lookup.
  stockRequests: (CustomerStockRequest & { preferredWarehouse?: { id: string; name: string; code: string; status: string; deletedAt: Date | null } | null })[];
};

// Every read of a submission carries the preferred warehouse's name so the reviewer can see WHICH
// warehouse the customer asked for without a second round trip. Selected (not the whole row) —
// a customer must never receive a warehouse's address, contact or notes through their own request.
// `deletedAt` is selected alongside `status` because they are INDEPENDENT: warehouseRepo.softDelete
// stamps deletedAt and leaves status "active". Deriving usability from status alone reported a
// deleted warehouse as fine, so the reviewer saw no warning while the assign modal silently refused
// to pre-fill it. Both flags, one answer — see toStockRequest.
const preferredWarehouseInclude = {
  preferredWarehouse: { select: { id: true, name: true, code: true, status: true, deletedAt: true } },
} as const;

const childInclude = {
  users: { orderBy: { fullName: "asc" } },
  // EVERY submission rides along on the admin detail — the Stock Submissions tab defaults its own
  // filter to the open ones, so the queue still opens on work-to-do.
  //
  // This used to exclude `completed`/`rejected`. That was fine while a short delivery could never
  // finish, but closing one short now completes its request, which made the submission (and the
  // closure reason someone was required to type) vanish from the only screen that shows it. A record
  // you can only reach through the audit log is not a record the reviewer can use.
  //
  // Unbounded per customer, like the open set already was. If submission volume ever grows the way
  // sites did, this belongs on its own paged endpoint (see listCustomerSites) rather than the detail
  // payload — the tab is already paginated client-side, so only this include would change.
  stockRequests: {
    // Assignments keep CREATION order — that's a stable reading order for the warehouses under one
    // submission, and it shouldn't reshuffle just because one of them was received.
    include: { ...preferredWarehouseInclude, warehouseAssignments: { include: { warehouse: { select: { id: true, name: true, code: true } } }, orderBy: { createdAt: "asc" } } },
    // LAST TOUCHED first, not last created. Sorting on createdAt meant acting on an older submission
    // (receiving it, approving it, closing it short) left it sitting wherever it was first raised —
    // so the thing you just did was the thing you then had to scroll to find, while the Audit Log
    // showed it at the top.
    //
    // This only holds because every one of those actions WRITES the request row. `@updatedAt` covers
    // the ones that change its status; the assignment-level actions that legitimately don't (a leg
    // closed short having received nothing, with another warehouse still outstanding) go through
    // `touchStockRequest` so they move the row anyway. Any new path that mutates an assignment must
    // do the same, or its submission silently stops surfacing here.
    orderBy: { updatedAt: "desc" },
  },
} satisfies Prisma.CustomerInclude;

export interface CustomerListFilters {
  search?: string;
  status?: string;
}

function buildWhere(filters: CustomerListFilters): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { customerCode: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { contactPerson: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

// Unknown/absent sort → newest first (default). Mirrors the user list ordering.
function customerOrderBy(
  sort?: string,
): Prisma.CustomerOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "name":
      return { name: "asc" };
    default:
      return { createdAt: "desc" };
  }
}

// One page of matching customers (no children — the grid only needs the profile).
export function findMany(
  filters: CustomerListFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<Customer[]> {
  return prisma.customer.findMany({
    where: buildWhere(filters),
    orderBy: customerOrderBy(sort),
    skip,
    take,
  });
}

export function count(filters: CustomerListFilters = {}): Promise<number> {
  return prisma.customer.count({ where: buildWhere(filters) });
}

// --- single-customer lookups (all exclude soft-deleted) ---------------------

export function findById(id: string): Promise<Customer | null> {
  // Guard a nullish id (Prisma drops an `undefined` filter key, which would
  // otherwise match the first non-deleted customer instead of returning null).
  if (!id) return Promise.resolve(null);
  return prisma.customer.findFirst({ where: { id, deletedAt: null } });
}

export function findByIdWithChildren(id: string): Promise<CustomerWithChildren | null> {
  return prisma.customer.findFirst({
    where: { id, deletedAt: null },
    include: childInclude,
  });
}

export function findByCustomerCodeWithChildren(
  customerCode: string,
): Promise<CustomerWithChildren | null> {
  return prisma.customer.findFirst({
    where: { customerCode, deletedAt: null },
    include: childInclude,
  });
}

// Login / forgot-password lookup: a non-deleted customer by email, with auth
// fields. Does NOT filter by status — the caller checks it (so an inactive account
// can be messaged clearly on login, or silently skipped on a reset email).
export function findByEmail(email: string): Promise<Customer | null> {
  return prisma.customer.findFirst({ where: { email, deletedAt: null } });
}

// Unique-email guard: matches even soft-deleted rows, since the email still
// occupies the unique index. The service revives a soft-deleted match.
export function findByEmailIncludingDeleted(email: string): Promise<Customer | null> {
  return prisma.customer.findUnique({ where: { email } });
}

// Case-insensitive company-name lookup among ACTIVE customers — the friendly
// uniqueness pre-check (there is no hard DB unique on nameLower, deliberately, so
// soft-deleted names can be re-used).
export function findActiveByNameLower(nameLower: string): Promise<Customer | null> {
  return prisma.customer.findFirst({ where: { nameLower, deletedAt: null } });
}

export function findByResetTokenHash(resetTokenHash: string): Promise<Customer | null> {
  return prisma.customer.findFirst({ where: { resetTokenHash, deletedAt: null } });
}

export function update(id: string, data: Prisma.CustomerUpdateInput): Promise<Customer> {
  return prisma.customer.update({ where: { id }, data });
}

export function softDelete(id: string): Promise<Customer> {
  return prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
}

// --- customerCode allocation (atomic Counter, prefix "CUST") -----------------
//
// Same mechanism as the staff employeeId: a single $inc on one Counter row hands
// out gap-free, collision-free running numbers (CUST-0001, CUST-0002, …). The
// customerCode @unique index is defence-in-depth; on the (otherwise impossible)
// out-of-band collision we fast-forward the counter past the real max and retry,
// never falling back to a random code. See user.repository for the full rationale.

const CUSTOMER_CODE_PREFIX = "CUST";

function isCustomerCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return false;
  }
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("customerCode");
}

function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Highest numeric suffix currently used for the prefix (scanning ALL rows incl.
// soft-deleted — their codes still hold a slot in the unique index). Used only to
// SEED / re-sync the counter, not on every allocation.
async function highestCustomerNumber(): Promise<number> {
  const head = `${CUSTOMER_CODE_PREFIX}-`;
  const rows = await prisma.customer.findMany({
    where: { customerCode: { startsWith: head } },
    select: { customerCode: true },
  });
  let max = 0;
  for (const { customerCode } of rows) {
    const suffix = customerCode.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(): Promise<number> {
  try {
    const c = await prisma.counter.update({
      where: { key: CUSTOMER_CODE_PREFIX },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestCustomerNumber();
  try {
    await prisma.counter.create({ data: { key: CUSTOMER_CODE_PREFIX, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
  const c = await prisma.counter.update({
    where: { key: CUSTOMER_CODE_PREFIX },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return c.seq;
}

async function fastForwardCounter(): Promise<void> {
  const max = await highestCustomerNumber();
  await prisma.counter.upsert({
    where: { key: CUSTOMER_CODE_PREFIX },
    create: { key: CUSTOMER_CODE_PREFIX, seq: max },
    update: { seq: max },
  });
}

// Create a new customer with a freshly-allocated, collision-safe customerCode.
// `data` carries everything except the customerCode (allocated here).
export async function createWithCode(
  data: Omit<Prisma.CustomerCreateInput, "customerCode">,
): Promise<Customer> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence();
    const customerCode = `${CUSTOMER_CODE_PREFIX}-${String(seq).padStart(4, "0")}`;
    try {
      return await prisma.customer.create({
        data: { deletedAt: null, ...data, customerCode },
      });
    } catch (e) {
      if (!isCustomerCodeConflict(e)) throw e;
      await fastForwardCounter();
    }
  }
  throw new Error("Could not allocate a unique customer code.");
}

// Revive a soft-deleted customer (re-add under the same email). Keeps the existing
// customerCode — it's already unique and a stable reference — and overwrites the
// profile + auth with the new details.
//
// CRITICAL: the prior occupant's nested data (projects / sites / users) is scrubbed
// in the SAME transaction. The Customer row is reused (so the email + code stay
// reserved), so without this the revived customer — a different company reusing the
// email — would inherit the previous company's projects/sites/users (a cross-tenant
// data leak via the detail endpoint).
export function revive(
  id: string,
  data: Omit<Prisma.CustomerUpdateInput, "customerCode">,
): Promise<Customer> {
  return withTransaction(async (tx) => {
    await tx.customerProject.deleteMany({ where: { customerId: id } });
    await tx.customerSite.deleteMany({ where: { customerId: id } });
    await tx.customerUser.deleteMany({ where: { customerId: id } });
    return tx.customer.update({ where: { id }, data });
  });
}

// Highest numeric suffix among a customer's existing nested codes — used only to
// SEED the per-customer counter (covers any rows created before counters existed).
function highestNestedSuffix(prefix: string, codes: (string | null)[]): number {
  const head = `${prefix}-`;
  let max = 0;
  for (const code of codes) {
    if (!code || !code.startsWith(head)) continue;
    const n = Number(code.slice(head.length));
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

// Atomically allocate the next per-customer reference code (e.g. PRJ-0001) via a
// per-customer Counter row keyed `${prefix}:${customerId}`. A single $inc hands out
// gap-free, collision-free running numbers (same mechanism as customerCode), so
// concurrent adds can never duplicate a code. `listExistingCodes` seeds the counter
// the first time, from the highest existing suffix.
async function allocateNestedCode(
  prefix: string,
  customerId: string,
  listExistingCodes: () => Promise<(string | null)[]>,
): Promise<string> {
  const key = `${prefix}:${customerId}`;
  const fmt = (seq: number) => `${prefix}-${String(seq).padStart(4, "0")}`;
  try {
    const c = await prisma.counter.update({
      where: { key },
      data: { seq: { increment: 1 } },
      select: { seq: true },
    });
    return fmt(c.seq);
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = highestNestedSuffix(prefix, await listExistingCodes());
  try {
    await prisma.counter.create({ data: { key, seq: start } });
  } catch (e) {
    if (!isUniqueConflict(e)) throw e; // a concurrent request seeded it first — fine
  }
  const c = await prisma.counter.update({
    where: { key },
    data: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return fmt(c.seq);
}

// Reset a per-customer nested counter to the highest suffix currently in use — the
// recovery step after a code collision (the counter drifted behind out-of-band inserts).
async function fastForwardNestedCounter(
  prefix: string,
  customerId: string,
  listExistingCodes: () => Promise<(string | null)[]>,
): Promise<void> {
  const max = highestNestedSuffix(prefix, await listExistingCodes());
  const key = `${prefix}:${customerId}`;
  await prisma.counter.upsert({ where: { key }, create: { key, seq: max }, update: { seq: max } });
}

// Atomically reserve a contiguous block of N codes; returns the FIRST sequence number.
// Standalone $inc (NEVER inside a transaction — a $inc in a Mongo tx can hit un-retried
// write-conflict aborts), with the same cold-start seed as allocateNestedCode, so
// single-add and bulk-add share one gap-free sequence.
async function reserveNestedCodeBlock(
  prefix: string,
  customerId: string,
  listExistingCodes: () => Promise<(string | null)[]>,
  n: number,
): Promise<number> {
  const key = `${prefix}:${customerId}`;
  try {
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: n } }, select: { seq: true } });
    return c.seq - n + 1;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
    const start = highestNestedSuffix(prefix, await listExistingCodes());
    try {
      await prisma.counter.create({ data: { key, seq: start } });
    } catch (e2) {
      if (!isUniqueConflict(e2)) throw e2; // concurrent seed — fine
    }
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: n } }, select: { seq: true } });
    return c.seq - n + 1;
  }
}

// --- nested: projects -------------------------------------------------------

export interface ProjectData {
  name: string;
  type?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  status?: string | null;
  description?: string | null;
}

export function findProjectById(id: string): Promise<CustomerProject | null> {
  return prisma.customerProject.findUnique({ where: { id } });
}

export function findProjectByName(
  customerId: string,
  nameLower: string,
): Promise<CustomerProject | null> {
  return prisma.customerProject.findFirst({ where: { customerId, nameLower } });
}

export async function createProject(
  customerId: string,
  data: ProjectData,
): Promise<CustomerProject> {
  const code = await allocateNestedCode("PRJ", customerId, () =>
    prisma.customerProject
      .findMany({ where: { customerId }, select: { code: true } })
      .then((rows) => rows.map((p) => p.code)),
  );
  return prisma.customerProject.create({
    data: {
      customerId,
      code,
      name: data.name,
      nameLower: data.name.toLowerCase(),
      type: data.type ?? null,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      status: data.status ?? "active",
      description: data.description ?? null,
    },
  });
}

// The detail modal always submits the full form, so an update is a full replace:
// an omitted optional field maps to null (cleared). The code is immutable.
export function updateProject(id: string, data: ProjectData): Promise<CustomerProject> {
  return prisma.customerProject.update({
    where: { id },
    data: {
      name: data.name,
      nameLower: data.name.toLowerCase(),
      type: data.type ?? null,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      status: data.status ?? "active",
      description: data.description ?? null,
    },
  });
}

export function deleteProject(id: string): Promise<CustomerProject> {
  return prisma.customerProject.delete({ where: { id } });
}

// --- nested: sites ----------------------------------------------------------

export interface SiteData {
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
  contactPerson?: string | null;
  contactNumber?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status?: string | null;
}

export function findSiteById(id: string): Promise<CustomerSite | null> {
  return prisma.customerSite.findUnique({ where: { id } });
}

// Field mapping shared by single + bulk create so the two never drift.
function siteRow(customerId: string, code: string, d: SiteData) {
  return {
    customerId,
    code,
    name: d.name,
    addressLine1: d.addressLine1 ?? null,
    addressLine2: d.addressLine2 ?? null,
    city: d.city ?? null,
    county: d.county ?? null,
    postcode: d.postcode ?? null,
    country: d.country ?? null,
    contactPerson: d.contactPerson ?? null,
    contactNumber: d.contactNumber ?? null,
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    status: d.status ?? "active",
  };
}

// A customer's current site codes — the seed source for counter bootstrap / fast-forward.
const siteCodes = (customerId: string) => () =>
  prisma.customerSite
    .findMany({ where: { customerId }, select: { code: true } })
    .then((rows) => rows.map((s) => s.code));

// Numeric suffix of a nested code (e.g. "STE-0007" → 7). Sorting on this is order-correct
// past the 4-digit padding boundary, where lexicographic "STE-10000" < "STE-9999" breaks.
const nestedSuffixOf = (code: string): number => Number(code.slice(code.indexOf("-") + 1)) || 0;

export async function createSite(customerId: string, data: SiteData): Promise<CustomerSite> {
  // Retry on a code collision: fast-forward the counter to the true max and re-allocate.
  // The @@unique([customerId, code]) index makes a drifted counter fail loudly here rather
  // than silently duplicate; this recovers instead of 500ing (mirrors createWithCode).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await allocateNestedCode("STE", customerId, siteCodes(customerId));
    try {
      return await prisma.customerSite.create({ data: siteRow(customerId, code, data) });
    } catch (e) {
      if (!isUniqueConflict(e)) throw e;
      await fastForwardNestedCounter("STE", customerId, siteCodes(customerId));
    }
  }
  throw new Error("Could not allocate a unique site code.");
}

export function updateSite(id: string, data: SiteData): Promise<CustomerSite> {
  return prisma.customerSite.update({
    where: { id },
    data: {
      name: data.name,
      addressLine1: data.addressLine1 ?? null,
      addressLine2: data.addressLine2 ?? null,
      city: data.city ?? null,
      county: data.county ?? null,
      postcode: data.postcode ?? null,
      country: data.country ?? null,
      contactPerson: data.contactPerson ?? null,
      contactNumber: data.contactNumber ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      status: data.status ?? "active",
    },
  });
}

export function deleteSite(id: string): Promise<CustomerSite> {
  return prisma.customerSite.delete({ where: { id } });
}

// Dedupe-key source: the customer's existing sites, name + postcode only (avoids
// pulling the whole customer graph just to build the skip set).
export function findSitesByCustomer(
  customerId: string,
): Promise<{ name: string; postcode: string | null }[]> {
  return prisma.customerSite.findMany({
    where: { customerId },
    select: { name: true, postcode: true },
  });
}

// --- portal paged children reads --------------------------------------------------------------
// Sites can be BULK-IMPORTED (thousands per customer), so the portal lists page at the DB — they
// must never load the full child set the way the admin detail's findByIdWithChildren does.
export interface PortalChildFilters {
  search?: string;
  status?: string;
}
function siteListWhere(customerId: string, f: PortalChildFilters): Prisma.CustomerSiteWhereInput {
  const q = f.search ? escapeRegex(f.search) : undefined;
  return {
    customerId,
    ...(f.status && { status: f.status }),
    ...(q && {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { postcode: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } },
      ],
    }),
  };
}
export function findSitesByCustomerPaged(customerId: string, f: PortalChildFilters, skip: number, take: number, sort?: string) {
  return prisma.customerSite.findMany({
    where: siteListWhere(customerId, f),
    orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
    skip,
    take,
  });
}
export function countSitesByCustomer(customerId: string, f: PortalChildFilters = {}): Promise<number> {
  return prisma.customerSite.count({ where: siteListWhere(customerId, f) });
}

/**
 * Type-ahead search across sites, for the Jobs list's SITE filter.
 *
 * A SEARCH rather than a listing, and that is the whole point: sites are bulk-imported in the
 * thousands, so the picker that filters by one cannot be fed a flat dropdown — it would truncate
 * silently, and a filter that quietly omits the site you wanted is worse than no filter.
 *
 * `customerId` narrows to one company when the caller has one. On the PORTAL that argument is not
 * optional in practice: it comes from the session, and passing it is what keeps a customer inside
 * their own tenant. Staff pass it only when they have already picked a customer.
 *
 * Ordered by name so the options read alphabetically rather than by import order, and capped —
 * a type-ahead shows a shortlist, it does not page.
 */
export function searchSites(
  term: string | undefined,
  customerId: string | undefined,
  take: number,
): Promise<{ id: string; name: string; code: string | null; postcode: string | null; customerName: string | null }[]> {
  const q = term?.trim() ? escapeRegex(term.trim()) : undefined;
  return prisma.customerSite.findMany({
    where: {
      ...(customerId && { customerId }),
      ...(q && {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { code: { contains: q, mode: "insensitive" } },
          { postcode: { contains: q, mode: "insensitive" } },
          { city: { contains: q, mode: "insensitive" } },
        ],
      }),
    },
    select: { id: true, name: true, code: true, postcode: true, customer: { select: { name: true } } },
    orderBy: { name: "asc" },
    take,
  }).then((rows) => rows.map((r) => ({ id: r.id, name: r.name, code: r.code, postcode: r.postcode, customerName: r.customer?.name ?? null })));
}
function projectListWhere(customerId: string, f: PortalChildFilters): Prisma.CustomerProjectWhereInput {
  const q = f.search ? escapeRegex(f.search) : undefined;
  return {
    customerId,
    ...(f.status && { status: f.status }),
    ...(q && {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
      ],
    }),
  };
}
export function findProjectsByCustomerPaged(customerId: string, f: PortalChildFilters, skip: number, take: number, sort?: string) {
  return prisma.customerProject.findMany({
    where: projectListWhere(customerId, f),
    orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
    skip,
    take,
  });
}
export function countProjectsByCustomer(customerId: string, f: PortalChildFilters = {}): Promise<number> {
  return prisma.customerProject.count({ where: projectListWhere(customerId, f) });
}

// Bulk-create sites with a RACE-SAFE contiguous STE-#### block.
// Allocation mirrors allocateNestedCode: reserve the whole block with ONE atomic $inc (by
// N) on the per-customer counter — NEVER inside a transaction (a $inc in a Mongo tx can hit
// un-retried write-conflict aborts). The insert itself runs in a transaction so a mid-batch
// unique conflict rolls the WHOLE batch back (no partial insert), making the fast-forward +
// retry safe. On the rare drifted-counter collision we recover instead of 500ing.
export async function createSitesBulk(
  customerId: string,
  data: SiteData[],
): Promise<CustomerSite[]> {
  if (data.length === 0) return [];
  const N = data.length;
  const fmt = (seq: number) => `STE-${String(seq).padStart(4, "0")}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const startSeq = await reserveNestedCodeBlock("STE", customerId, siteCodes(customerId), N);
    const rows = data.map((d, i) => siteRow(customerId, fmt(startSeq + i), d));
    try {
      await withTransaction((tx) => tx.customerSite.createMany({ data: rows }));
      const created = await prisma.customerSite.findMany({
        where: { customerId, code: { in: rows.map((r) => r.code) } },
      });
      // Numeric-suffix order — lexicographic ("STE-10000" < "STE-9999") breaks past 9999.
      return created.sort((a, b) => nestedSuffixOf(a.code) - nestedSuffixOf(b.code));
    } catch (e) {
      if (!isUniqueConflict(e)) throw e;
      await fastForwardNestedCounter("STE", customerId, siteCodes(customerId));
    }
  }
  throw new Error("Could not allocate unique site codes for the bulk import.");
}

// --- nested: customer users (also the customer LOGIN accounts) --------------

export interface CustomerUserData {
  fullName: string;
  email: string;
  phone?: string | null;
  designation?: string | null;
  status?: string | null;
  // Auth — set only when provisioning / re-issuing a login.
  passwordHash?: string | null;
  mustResetPassword?: boolean;
}

// A login user joined to its company — the shape auth needs (to check the company
// is active + not soft-deleted, and to build the principal).
const loginInclude = { customer: true } satisfies Prisma.CustomerUserInclude;
export type CustomerLoginUser = CustomerUser & { customer: Customer };

export function findCustomerUserById(id: string): Promise<CustomerUser | null> {
  return prisma.customerUser.findUnique({ where: { id } });
}

export function findCustomerUserByEmail(
  customerId: string,
  emailLower: string,
): Promise<CustomerUser | null> {
  return prisma.customerUser.findFirst({ where: { customerId, emailLower } });
}

export function findUsersByCustomer(customerId: string): Promise<CustomerUser[]> {
  return prisma.customerUser.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });
}

// --- login lookups (CustomerUser is the login identity) ---

export function findLoginByEmail(emailLower: string): Promise<CustomerLoginUser | null> {
  if (!emailLower) return Promise.resolve(null);
  return prisma.customerUser.findFirst({ where: { emailLower }, include: loginInclude });
}

export function findLoginById(id: string): Promise<CustomerLoginUser | null> {
  if (!id) return Promise.resolve(null);
  return prisma.customerUser.findFirst({ where: { id }, include: loginInclude });
}

export function findLoginByResetTokenHash(hash: string): Promise<CustomerLoginUser | null> {
  return prisma.customerUser.findFirst({ where: { resetTokenHash: hash }, include: loginInclude });
}

// Auth-column write (password set/clear, reset token, mustResetPassword) — returns
// the user joined to its company so the caller can rebuild the principal.
export function updateLoginUser(
  id: string,
  data: Prisma.CustomerUserUpdateInput,
): Promise<CustomerLoginUser> {
  return prisma.customerUser.update({ where: { id }, data, include: loginInclude });
}

export function createCustomerUser(
  customerId: string,
  data: CustomerUserData,
): Promise<CustomerUser> {
  return prisma.customerUser.create({
    data: {
      customerId,
      fullName: data.fullName,
      email: data.email,
      emailLower: data.email.toLowerCase(),
      phone: data.phone ?? null,
      designation: data.designation ?? null,
      status: data.status ?? "active",
      passwordHash: data.passwordHash ?? null,
      mustResetPassword: data.mustResetPassword ?? true,
      resetTokenHash: null,
      resetTokenExpiresAt: null,
    },
  });
}

// Profile update only — never touches the auth columns (those go through the
// dedicated invite / password flows).
export function updateCustomerUser(id: string, data: CustomerUserData): Promise<CustomerUser> {
  return prisma.customerUser.update({
    where: { id },
    data: {
      fullName: data.fullName,
      email: data.email,
      emailLower: data.email.toLowerCase(),
      phone: data.phone ?? null,
      designation: data.designation ?? null,
      status: data.status ?? "active",
    },
  });
}


// --- customer stock requests (portal-submitted order / replenishment asks) ---

export interface StockRequestData {
  name: string;
  quantity: number | null;
  reason: string | null;
  notes?: string | null;
  // Existing stock line this submission tops up (resolved + validated in the service).
  linkedStockEntryId?: string | null;
  // The customer's PREFERRED receiving warehouse — eligibility-checked in the service.
  // Advisory only: it pre-fills the reviewer's assign step and is read nowhere else.
  preferredWarehouseId?: string | null;
}


export function createStockRequest(
  customerId: string,
  requestedByUserId: string | null,
  requestedByName: string | null,
  data: StockRequestData,
) {
  return prisma.customerStockRequest.create({
    data: {
      customerId,
      requestedByUserId,
      requestedByName,
      name: data.name,
      quantity: data.quantity ?? null,
      reason: data.reason ?? null,
      notes: data.notes ?? null,
      linkedStockEntryId: data.linkedStockEntryId ?? null,
      preferredWarehouseId: data.preferredWarehouseId ?? null,
      status: "pending",
    },
    include: preferredWarehouseInclude,
  });
}

// `status` accepts a single status OR the pseudo-status "open", which stands for the whole set that
// still needs something to happen. Resolved HERE so the portal filter, the dashboard's "Open
// submissions" count and the admin tab's "Open" option are all reading one definition — three places
// each maintaining their own list of what counts as open is how they end up disagreeing.
//
// Search covers BOTH names: `editedName` is what the account team renamed it to and what the row
// shows, `name` is what the customer typed and still remembers. Matching only one means searching for
// your own wording finds nothing.
// Submissions still needing something to happen. THE definition — the portal's `open` filter, the
// dashboard's "Open submissions" count and the admin tab's "Open" option all resolve through here.
export const OPEN_REQUEST_STATUSES: string[] = ["pending", "approved", "assigned", "partially_received"];

export interface StockRequestFilters {
  status?: string;
  search?: string;
  /** Half-open window on `createdAt` — an INSTANT, resolved in the company timezone by the service. */
  raisedWindow?: DayWindow;
}

function stockRequestListWhere(customerId: string, filters: StockRequestFilters = {}): Prisma.CustomerStockRequestWhereInput {
  const { status, search, raisedWindow } = filters;
  const q = search ? escapeRegex(search) : undefined;
  return {
    customerId,
    ...(raisedWindow && !isEmptyWindow(raisedWindow) && { createdAt: raisedWindow }),
    ...(status === "open"
      ? { status: { in: OPEN_REQUEST_STATUSES } }
      : status
        ? { status }
        : {}),
    ...(q && {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { editedName: { contains: q, mode: "insensitive" } },
      ],
    }),
  };
}

// Filters as an OBJECT for the same reason as the stock-entry reads: this was
// `(customerId, status, skip, take)` and search would have been a fifth positional behind two
// numbers, which is how a search term ends up silently passed as a page offset.
export function findStockRequestsByCustomer(
  customerId: string,
  filters: StockRequestFilters = {},
  page?: { skip: number; take: number },
) {
  const { skip, take } = page ?? {};
  return prisma.customerStockRequest.findMany({
    where: stockRequestListWhere(customerId, filters),
    include: {
      ...preferredWarehouseInclude,
      warehouseAssignments: {
        include: { warehouse: { select: { id: true, name: true, code: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    // Optional paging — the portal list pages; existing unpaged callers pass nothing and are unchanged.
    ...(skip !== undefined ? { skip } : {}),
    ...(take !== undefined ? { take } : {}),
  });
}
// MUST take the same filters as the find above — counting a different set than you page through gives
// a paginator that walks off the end of the list.
/**
 * Per-status totals for the SAME filtered set the list pages through, in one grouped query.
 *
 * The tab's status menu used to be derived from the whole submission collection, which is why the
 * customer detail payload had to carry every submission an account had ever made. This is that
 * metadata as metadata — bounded by the number of statuses, not by the account's history.
 *
 * Callers pass the filters WITHOUT a status — the menu must say what the other statuses hold, or
 * picking one would empty the menu that offers the rest. Stated at the call site rather than
 * stripped here, so the rule is visible where the decision is made.
 */
export async function countStockRequestsByStatus(
  customerId: string,
  filters: StockRequestFilters = {},
): Promise<Record<string, number>> {
  const rows = await prisma.customerStockRequest.groupBy({
    by: ["status"],
    where: stockRequestListWhere(customerId, filters),
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}

export function countStockRequestsByCustomer(customerId: string, filters: StockRequestFilters = {}): Promise<number> {
  return prisma.customerStockRequest.count({ where: stockRequestListWhere(customerId, filters) });
}

export function findStockRequestById(id: string): Promise<CustomerStockRequest | null> {
  return prisma.customerStockRequest.findUnique({ where: { id } });
}

// The reviewer's verdict on a request: a status move (approved | rejected) plus an
// optional admin response note shown to the customer. Approval is status-only — it
// never writes a stock entry or inventory record (that's a later, deliberate
// internal step).
export interface StockReviewData {
  status: string;
  reviewedBy: string | null;
  adminResponse?: string | null;
  reviewedAt: Date;
}

export function reviewStockRequest(id: string, data: StockReviewData) {
  return prisma.customerStockRequest.update({
    where: { id },
    data: {
      status: data.status,
      reviewedBy: data.reviewedBy,
      adminResponse: data.adminResponse ?? null,
      reviewedAt: data.reviewedAt,
    },
    include: preferredWarehouseInclude,
  });
}

// --- customer stock request editing + warehouse assignment ---

export interface StockRequestEditData {
  editedName: string;
  catalogueItemId?: string | null;
  adminResponse?: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date;
}

export function editAndApproveStockRequest(id: string, data: StockRequestEditData) {
  return prisma.customerStockRequest.update({
    where: { id },
    data: {
      editedName: data.editedName,
      catalogueItemId: data.catalogueItemId ?? null,
      adminResponse: data.adminResponse ?? null,
      status: data.status,
      reviewedBy: data.reviewedBy,
      reviewedAt: data.reviewedAt,
    },
    include: preferredWarehouseInclude,
  });
}

export function updateStockRequestStatus(id: string, status: string, client: Db = prisma): Promise<CustomerStockRequest> {
  return client.customerStockRequest.update({
    where: { id },
    data: { status },
  });
}

// Write the request WITHOUT changing it, purely to move `updatedAt`. Two jobs, both load-bearing:
//
//  1. ORDERING. The admin's Stock Submissions list sorts on `updatedAt` (see `childInclude`), so an
//     action that legitimately leaves the status alone — closing one warehouse short having received
//     nothing while another is still outstanding — would otherwise leave the row buried exactly where
//     it was first raised, which is the problem that sort was introduced to fix.
//  2. SERIALISATION. Every assignment-level write recomputes its parent through the one function that
//     calls this, so the parent document becomes the single row all of a request's in-flight
//     transactions touch. Mongo then aborts the loser with a write-conflict — retried a level up —
//     instead of letting two transactions each derive a status from a snapshot that cannot see the
//     other's uncommitted assignment write.
//
// `updatedAt` is set explicitly rather than left to `@updatedAt`: Prisma has nothing else to write
// here, and an update with an empty `data` is not a contract worth resting either job on.
export function touchStockRequest(id: string, client: Db = prisma): Promise<CustomerStockRequest> {
  return client.customerStockRequest.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
}

export interface WarehouseAssignmentData {
  customerStockRequestId: string;
  warehouseId: string;
  quantity: number;
}

export function createWarehouseAssignments(data: WarehouseAssignmentData[]) {
  return prisma.$transaction(
    data.map((d) =>
      prisma.customerStockWarehouseAssignment.create({ data: d }),
    ),
  );
}

export function findAssignmentsByRequest(requestId: string, client: Db = prisma) {
  return client.customerStockWarehouseAssignment.findMany({
    where: { customerStockRequestId: requestId },
    include: { warehouse: { select: { id: true, name: true, code: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export function findAssignmentById(id: string) {
  return prisma.customerStockWarehouseAssignment.findUnique({
    where: { id },
    include: {
      warehouse: { select: { id: true, name: true, code: true } },
      stockRequest: { select: { id: true, customerId: true, name: true, editedName: true, quantity: true, status: true, linkedStockEntryId: true } },
    },
  });
}

export function findPendingAssignmentsByWarehouse(warehouseId: string) {
  return prisma.customerStockWarehouseAssignment.findMany({
    where: { warehouseId, status: { in: ["pending", "partially_received"] } },
    include: {
      stockRequest: {
        select: { id: true, customerId: true, name: true, editedName: true, quantity: true, status: true, customer: { select: { id: true, name: true, customerCode: true } } },
      },
      warehouse: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

// Atomic, race-safe receive. The update only applies if receivedQuantity is STILL the
// value the caller read (optimistic guard `receivedQuantity: totalReceivedSoFar`), so two
// concurrent/double-clicked receives can't both succeed and double-count — the loser gets
// count===0 and we return null (caller turns it into a 409). This also prevents the
// duplicate-stock-entry race, since only the winning receive proceeds to create the entry.
export async function updateAssignmentReceived(id: string, receivedQuantity: number, totalReceivedSoFar: number, assignedQty: number, receivedBy: string | null, notes: string | null, client: Db = prisma) {
  const newTotal = totalReceivedSoFar + receivedQuantity;
  const status = newTotal >= assignedQty ? "received" : "partially_received";
  const res = await client.customerStockWarehouseAssignment.updateMany({
    // The status guard rides ALONGSIDE the receivedQuantity guard: the quantity alone can't catch a
    // concurrent short-closure (that leaves receivedQuantity untouched), which would otherwise let a
    // receipt land on an assignment someone had just closed and silently reopen it.
    where: { id, receivedQuantity: totalReceivedSoFar, status: { in: OPEN_ASSIGNMENT_STATUSES } },
    data: { receivedQuantity: newTotal, status, receivedBy, receivedAt: new Date(), notes },
  });
  if (res.count === 0) return null;
  return client.customerStockWarehouseAssignment.findUnique({
    where: { id },
    include: { warehouse: { select: { id: true, name: true, code: true } } },
  });
}

// The two states an assignment can still be acted on from. Terminal states (`received`,
// `closed_short`) are excluded, so both the receive and the short-close paths reject a stale write
// at the DATABASE rather than trusting the status they read a moment earlier.
// Not `as const` — Prisma's generated `in:` filter takes a mutable string[], and spreading a
// readonly tuple at every call site to satisfy it is noise for no safety gained here.
export const OPEN_ASSIGNMENT_STATUSES: string[] = ["pending", "partially_received"];

// Short-close: the outstanding balance is never arriving. Only ever moves an OPEN assignment to the
// terminal `closed_short`; `receivedQuantity` is deliberately left alone, because what did arrive is
// already booked into stock and the rest was never stock to begin with (so there is nothing to write
// off — unlike goods-management's reconcile). Returns null when the row was no longer open, which
// the caller surfaces as a conflict.
export async function closeAssignmentShort(id: string, reason: string, closedBy: string | null, client: Db = prisma) {
  const res = await client.customerStockWarehouseAssignment.updateMany({
    where: { id, status: { in: OPEN_ASSIGNMENT_STATUSES } },
    data: { status: "closed_short", closureReason: reason, closedBy, closedAt: new Date() },
  });
  if (res.count === 0) return null;
  return client.customerStockWarehouseAssignment.findUnique({
    where: { id },
    include: { warehouse: { select: { id: true, name: true, code: true } } },
  });
}

export function findStockRequestWithAssignments(id: string) {
  return prisma.customerStockRequest.findUnique({
    where: { id },
    include: {
      ...preferredWarehouseInclude,
      warehouseAssignments: {
        include: { warehouse: { select: { id: true, name: true, code: true } } },
      },
    },
  });
}

// --- customer stock entries (physical stock received at warehouses) -----------

export interface CreateStockEntryData {
  customerId: string;
  warehouseId: string;
  assignmentId: string;
  itemName: string;
  quantity: number;
  receivedBy: string | null;
  receivedAt: Date;
  // Optional product details — copied from a linked existing line when a top-up
  // submission lands in a warehouse that doesn't yet hold that product, so the new
  // line stays consistent with its sibling instead of starting blank.
  sku?: string | null;
  categoryId?: string | null;
  description?: string | null;
  uom?: string | null;
  serialized?: boolean;
  highValue?: boolean;
  thresholdQty?: number | null;
}

const stockEntryRelations = {
  customer: { select: { id: true, name: true, customerCode: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  category: { select: { id: true, name: true } },
} as const;

export function createStockEntry(data: CreateStockEntryData, client: Db = prisma) {
  return client.customerStockEntry.create({ data, include: stockEntryRelations });
}

// Find an existing stock line for this customer in this warehouse that represents the
// SAME product as `itemName` (+ optional sku) — the target a top-up submission should
// accumulate into instead of creating a duplicate row. Matching is case-insensitive on
// the name and exact on sku (when the linked line carries one); the per-customer,
// per-warehouse candidate set is small, so the match is done in-process to avoid the
// Mongo connector's collation quirks.
export async function findStockEntryForTopUp(
  customerId: string,
  warehouseId: string,
  itemName: string,
  sku: string | null,
  client: Db = prisma,
): Promise<{ id: string } | null> {
  const candidates = await client.customerStockEntry.findMany({
    where: { customerId, warehouseId },
    select: { id: true, itemName: true, sku: true },
    orderBy: { createdAt: "asc" },
  });
  const norm = (s: string) => s.trim().toLowerCase();
  // Match on name AND an EXACT sku equality (null matches only null). A null-sku source must never
  // collapse onto a different same-named product that does carry a sku, and vice-versa.
  const target = candidates.find(
    (e) => norm(e.itemName) === norm(itemName) && e.sku === sku,
  );
  return target ? { id: target.id } : null;
}

// Find an existing ACTIVE-or-draft entry that a Direct Add would DUPLICATE: same customer +
// warehouse + name (case/space-insensitive) + EXACT sku (null matches only null). Same matching
// predicate as findStockEntryForTopUp, but returns the entry's `code` too so the caller can point
// the user at it. A different warehouse or a different sku is NOT a duplicate (legitimately distinct
// stock), so this returns null for those.
export async function findDuplicateStockEntry(
  customerId: string,
  warehouseId: string,
  itemName: string,
  sku: string | null,
  client: Db = prisma,
): Promise<{ id: string; code: string | null } | null> {
  const candidates = await client.customerStockEntry.findMany({
    where: { customerId, warehouseId },
    select: { id: true, itemName: true, sku: true, barcode: true },
    orderBy: { createdAt: "asc" },
  });
  const norm = (s: string) => s.trim().toLowerCase();
  const target = candidates.find((e) => norm(e.itemName) === norm(itemName) && e.sku === sku);
  return target ? { id: target.id, code: target.barcode ?? null } : null;
}

// Add newly-received units onto the assignment's existing stock entry (partial
// receives accumulate into one entry instead of spawning a new row each time).
export function addStockEntryQuantity(id: string, addQuantity: number, receivedBy: string | null, receivedAt: Date, client: Db = prisma) {
  return client.customerStockEntry.update({
    where: { id },
    data: { quantity: { increment: addQuantity }, receivedBy, receivedAt },
    include: stockEntryRelations,
  });
}

export interface CreateDirectStockEntryData {
  customerId: string;
  warehouseId: string;
  itemName: string;
  sku?: string | null;
  categoryId?: string | null;
  description?: string | null;
  uom?: string | null;
  quantity: number;
  serialized?: boolean;
  serialNumber?: string | null;
  highValue?: boolean;
  thresholdQty?: number | null;
  attributes?: Record<string, string> | null;
  status: string;
  receivedBy: string | null;
  receivedAt: Date;
}

export function createDirectStockEntry(data: CreateDirectStockEntryData) {
  return prisma.customerStockEntry.create({
    data,
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
  });
}

/**
 * On-hand quantity for MANY stock entries in one query.
 *
 * For availability checks only — the job form's "can't plan more than exists" backstop was calling
 * `findStockEntryById` once per kit line, so a 20-line job cost 20 sequential round trips (plus the
 * customer/warehouse joins that read never used) before the save could even be validated.
 *
 * Deliberately NO status filter, matching `findStockEntryById` below: a line already pointing at a
 * non-active entry must keep reporting that entry's quantity, or re-saving an untouched job would
 * suddenly fail on a line nobody edited.
 */
export function findStockEntryQuantitiesByIds(ids: string[]): Promise<{ id: string; quantity: number }[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.customerStockEntry.findMany({ where: { id: { in: ids } }, select: { id: true, quantity: true } });
}

export function findStockEntryById(id: string, client: Db = prisma) {
  return client.customerStockEntry.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
  });
}

// Shared where for a customer's stock-entry list — optional status + free-text search over the
// fields the picker/list shows (item name, SKU, serial, barcode). `search` is escaped (the Mongo
// `contains` gotcha) before it feeds any $regex.
function stockEntryListWhere(customerId: string, f: StockEntryFilters = {}): Prisma.CustomerStockEntryWhereInput {
  const { status, search, warehouseId, receivedWindow } = f;
  const q = search ? escapeRegex(search) : undefined;
  return {
    customerId,
    ...(status ? { status } : {}),
    // `receivedAt` is an INSTANT and NULLABLE — an entry not yet physically received has none, so it
    // cannot fall inside any window and is excluded rather than passed through. Same rule the goods
    // queue applies to a job with no activity.
    ...(receivedWindow && !isEmptyWindow(receivedWindow) ? { receivedAt: receivedWindow } : {}),
    // Filtered by ID, not by warehouse NAME: a name is editable and non-unique, so a link built on one
    // silently stops matching the day someone renames a site. The id is what the entry actually holds.
    ...(warehouseId ? { warehouseId } : {}),
    ...(q && {
      OR: [
        { itemName: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
        { serialNumber: { contains: q, mode: "insensitive" } },
        { barcode: { contains: q, mode: "insensitive" } },
      ],
    }),
  };
}

// Filters as an OBJECT, not more positionals. This had grown to `(customerId, status, skip, take,
// search)` — five parameters, four optional, three of them strings — and adding a warehouse to that
// signature is how someone eventually passes a search term into the warehouse slot and gets an empty
// list with no error. Named fields also let a caller set only what it cares about.
export interface StockEntryFilters {
  status?: string;
  search?: string;
  warehouseId?: string;
  /** Half-open window on `receivedAt` — an INSTANT, resolved in the company timezone by the service. */
  receivedWindow?: DayWindow;
}

/**
 * A customer's stock as PICKER OPTIONS — five scalar columns and the warehouse name, nothing else.
 *
 * Deliberately UNPAGED, and that is a correctness requirement rather than a shortcut. The job form
 * groups these into item → warehouse and SUMS the on-hand per warehouse; a partial set therefore
 * produces wrong QUANTITIES, not merely missing options — and the quantity is what the form's
 * per-line cap is enforced against. Paging this would be silently incorrect unless the grouping
 * moved with it.
 *
 * It is still far cheaper than the read it replaced, which returned whole entry rows (base64 barcode
 * image and three joined relations included) for the same purpose.
 */
export function findStockOptionsByCustomer(customerId: string): Promise<
  { id: string; itemName: string; sku: string | null; quantity: number; warehouseId: string; warehouseName: string }[]
> {
  return prisma.customerStockEntry
    .findMany({
      // `warehouseId` is REQUIRED on this model, so there is no "unplaced entry" case to exclude —
      // every active entry is pickable. Only `active` is filtered: a draft has not been received yet.
      where: { customerId, status: "active" },
      select: {
        id: true,
        itemName: true,
        sku: true,
        quantity: true,
        warehouseId: true,
        warehouse: { select: { name: true } },
      },
      orderBy: { itemName: "asc" },
    })
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        itemName: r.itemName,
        sku: r.sku,
        quantity: r.quantity,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouse.name,
      })),
    );
}

export function findStockEntriesByCustomer(
  customerId: string,
  filters: StockEntryFilters = {},
  page?: { skip: number; take: number },
) {
  const { skip, take } = page ?? {};
  return prisma.customerStockEntry.findMany({
    where: stockEntryListWhere(customerId, filters),
    // Drop the heavy base64 barcode image from list reads — list views only show the
    // short `barcode` string; the full image is fetched only on the single-entry detail.
    omit: { barcodeDataUri: true },
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    // Optional paging — the portal list pages; existing unpaged callers pass nothing and are unchanged.
    ...(skip !== undefined ? { skip } : {}),
    ...(take !== undefined ? { take } : {}),
  });
}

// Count a customer's stock entries under the same filters — used for the portal dashboard "Stock
// entries" stat and for paging the list without loading the (heavy, barcode-image-bearing) rows.
// MUST take the identical filters as the find above, or the paginator counts a different set than it
// pages and the last page comes back empty.
export function countStockEntriesByCustomer(customerId: string, filters: StockEntryFilters = {}): Promise<number> {
  return prisma.customerStockEntry.count({
    where: stockEntryListWhere(customerId, filters),
  });
}

// The warehouses actually holding this customer's stock — the option list for the portal's warehouse
// filter. Derived from the stock itself rather than "every warehouse we operate", so the customer is
// never offered a filter that can only return nothing.
export async function findStockWarehousesByCustomer(
  customerId: string,
): Promise<{ id: string; name: string; code: string }[]> {
  const groups = await prisma.customerStockEntry.groupBy({
    by: ["warehouseId"],
    where: { customerId },
  });
  const warehouses = await prisma.warehouse.findMany({
    where: { id: { in: groups.map((g) => g.warehouseId) } },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
  return warehouses;
}

// --- portal dashboard aggregations -------------------------------------------
// Default to COUNT/SUM/GROUP BY rather than "load the rows and add them up in JS": a customer's
// consignment history grows without bound (that's why every portal list is server-paged), and an
// overview that pulls it all into memory to produce four numbers gets slower every week it runs.
//
// Three of the four do exactly that. `sumNotReceivedUnitsByCustomer` is the documented exception —
// its figure is a per-row subtraction no SUM can express, over a set that is small by nature; see the
// note on the function itself.

// Units the customer actually has with us, across every entry.
//
// DRAFT COUNTS. A draft entry is stock that has physically arrived and been booked in — it is only
// "draft" because the warehouse manager hasn't finished its product details yet (see the note on
// stockEntryStatus in the receive flow). Excluding it would under-report a customer's holding for
// exactly as long as the paperwork lags the pallet, and it would disagree with My Stock, which lists
// every entry regardless of status.
export async function sumStockUnitsByCustomer(customerId: string): Promise<number> {
  const agg = await prisma.customerStockEntry.aggregate({
    where: { customerId },
    _sum: { quantity: true },
  });
  // `_sum` is null when no rows matched — a customer with no stock has 0 units, not null.
  return agg._sum.quantity ?? 0;
}

export interface WarehouseUnits {
  warehouseId: string;
  units: number;
  entries: number;
}

// Where that stock is sitting. Returned unnamed — the caller joins warehouse names, because grouping
// can't include a relation and the set here is at most the number of warehouses we operate.
export async function groupStockUnitsByWarehouse(customerId: string): Promise<WarehouseUnits[]> {
  const rows = await prisma.customerStockEntry.groupBy({
    by: ["warehouseId"],
    where: { customerId },
    _sum: { quantity: true },
    _count: { _all: true },
  });
  return rows.map((r) => ({
    warehouseId: r.warehouseId,
    units: r._sum.quantity ?? 0,
    entries: r._count._all,
  }));
}

// Counts the same set the `open` filter selects, through the same where-builder — so the dashboard's
// number and the list it links to can never disagree about what "open" means.
export function countOpenStockRequestsByCustomer(customerId: string): Promise<number> {
  return countStockRequestsByCustomer(customerId, { status: "open" });
}

// Units the customer declared that are never coming — the total across every short-closed leg.
//
// Selects the two numbers and subtracts in JS rather than aggregating: the shortfall is
// `quantity - receivedQuantity`, which no SUM can express, and `closed_short` legs are the exception
// rather than the rule so the row set is small. Filtered through the parent request's customerId,
// since an assignment belongs to a warehouse and only reaches the customer through its request.
export async function sumNotReceivedUnitsByCustomer(customerId: string): Promise<number> {
  const legs = await prisma.customerStockWarehouseAssignment.findMany({
    where: { status: "closed_short", stockRequest: { customerId } },
    select: { quantity: true, receivedQuantity: true },
  });
  // Clamped per leg: an over-received leg must not subtract from a genuine shortfall elsewhere.
  return legs.reduce((sum, l) => sum + Math.max(0, l.quantity - l.receivedQuantity), 0);
}

export function findStockEntriesByWarehouse(warehouseId: string, status?: string) {
  return prisma.customerStockEntry.findMany({
    where: { warehouseId, ...(status ? { status } : {}) },
    omit: { barcodeDataUri: true },
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export function findStockEntriesByAssignment(assignmentId: string, client: Db = prisma) {
  return client.customerStockEntry.findMany({
    where: { assignmentId },
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export interface UpdateStockEntryData {
  itemName: string;
  sku?: string | null;
  categoryId?: string | null;
  description?: string | null;
  uom?: string | null;
  serialized?: boolean;
  serialNumber?: string | null;
  highValue?: boolean;
  attributes?: Record<string, string> | null;
  status: string;
}

export function updateStockEntry(id: string, data: UpdateStockEntryData) {
  return prisma.customerStockEntry.update({
    where: { id },
    data,
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
  });
}

// --- delete-dependency counts (see STOCK_ENTRY_DELETE_CHECKERS in customer.service) ------------
// A CustomerStockEntry is HARD-deleted (this model has no archive state, by design), and MongoDB has
// no foreign keys, so anything still pointing at the row simply ends up referencing an id that no
// longer exists. These counts are what stop that happening.

/** Units of this consignment entry still out with an engineer. */
export function countEngineerHoldingsByStockEntry(entryId: string): Promise<number> {
  return prisma.engineerCustomerStockHolding.count({ where: { customerStockEntryId: entryId, quantityOnHand: { gt: 0 } } });
}

/** Job kit lines planned against this entry — deleting it would leave them naming a missing item. */
export function countKitLinesByStockEntry(entryId: string): Promise<number> {
  return prisma.jobKitLine.count({ where: { customerStockEntryId: entryId } });
}

/** Posted goods movements that touched this entry: its history, which a hard delete would orphan. */
export function countMovementLinesByStockEntry(entryId: string): Promise<number> {
  return prisma.jobStockMovementLine.count({ where: { customerStockEntryId: entryId } });
}

/** Units of this entry sitting in the damaged pool. */
export function countDamagedByStockEntry(entryId: string): Promise<number> {
  return prisma.damagedStockBalance.count({ where: { customerStockEntryId: entryId, quantity: { gt: 0 } } });
}

/**
 * Consignment entries that still HOLD stock at a warehouse — blocks deleting a warehouse storing a
 * customer's goods. Only `quantity > 0`: an emptied entry is a historic record, and counting those too
 * would make any warehouse that ever held consignment undeletable for ever.
 */
export function countStockEntriesWithStockByWarehouse(warehouseId: string): Promise<number> {
  return prisma.customerStockEntry.count({ where: { warehouseId, quantity: { gt: 0 } } });
}

/**
 * Warehouse allocations still awaiting stock — blocks deleting the warehouse a customer's incoming
 * delivery is addressed to. Shares OPEN_ASSIGNMENT_STATUSES with the receive and short-close paths,
 * so "still expecting a delivery" means one thing here and there.
 *
 * The sibling of countStockEntriesWithStockByWarehouse, and the half it can't see: an assignment
 * that hasn't been received yet has produced NO CustomerStockEntry, so a warehouse whose only tie to
 * a customer is an inbound delivery reads as completely empty. Deleting it takes the row out of
 * every warehouse read, and the assignment is left addressed to somewhere the manager can no longer
 * open to receive against — the Incoming queue simply loses the delivery.
 */
// Attention counts — customer-domain states where a human still owes an action.
//  • stockRequestsPending: a customer submitted a request; office must approve/reject. NOT
//    warehouse-scoped — no warehouse has been assigned yet, so it is company-wide by nature.
//  • assignmentsOpen / stockEntryDrafts: warehouse-floor work (receive the delivery, then catalogue
//    the received entry), both scoped to the actor's warehouses.
//  • portalInvitesPending: an invited portal user who has never signed in. There is no "invited"
//    status — the signal is mustResetPassword && lastLoginAt === null.
export async function countAttention(warehouseIds?: string[]): Promise<{
  stockRequestsPending: number;
  stockRequestsAwaitingAssignment: number;
  assignmentsOpen: number;
  stockEntryDrafts: number;
  portalInvitesPending: number;
}> {
  const whScope = warehouseIds ? { warehouseId: { in: warehouseIds } } : {};
  const [
    stockRequestsPending,
    stockRequestsAwaitingAssignment,
    assignmentsOpen,
    stockEntryDrafts,
    portalInvitesPending,
  ] = await Promise.all([
    prisma.customerStockRequest.count({ where: { status: "pending" } }),
    // Approved, but the warehouses it will be received at have not been chosen yet.
    //
    // This is a REAL queue with a button on screen ("Assign warehouses") and it was counted by
    // nothing: `stockRequestsPending` stops at `pending`, and `assignmentsOpen` below can only see
    // assignments that ALREADY exist — which is precisely what this step creates. Approving therefore
    // moved a request out of every badge in the product while leaving the work undone, so a queue of
    // approved-but-unassigned requests read as an empty desk.
    prisma.customerStockRequest.count({ where: { status: "approved" } }),
    prisma.customerStockWarehouseAssignment.count({ where: { status: { in: OPEN_ASSIGNMENT_STATUSES }, ...whScope } }),
    prisma.customerStockEntry.count({ where: { status: "draft", ...whScope } }),
    prisma.customerUser.count({
      where: {
        status: "active",
        mustResetPassword: true,
        // MONGO TRAP (same one as van-stock-request.repository): `lastLoginAt: null` matches only
        // rows where the field is explicitly null. Nothing ever WRITES lastLoginAt on create, so on
        // a never-signed-in user the field is ABSENT — and absent is not null. Alone, that clause
        // matched nothing and this count sat at 0 forever: a silent false negative, which is worse
        // than the crash above it, because an attention badge that never appears looks like "no
        // work outstanding" rather than like a bug.
        OR: [{ lastLoginAt: null }, { lastLoginAt: { isSet: false } }],
        // The soft-delete lives on the CUSTOMER, not on its portal users — CustomerUser has no
        // deletedAt at all (which is what Prisma was rejecting here). Scoped through the relation
        // instead, so a deleted company stops generating "chase this invite" work.
        customer: { deletedAt: null },
      },
    }),
  ]);
  return { stockRequestsPending, stockRequestsAwaitingAssignment, assignmentsOpen, stockEntryDrafts, portalInvitesPending };
}

/**
 * The two WAREHOUSE-attributable halves of countAttention, split per warehouse.
 *
 * Both models carry a real `warehouseId` column (and a `[warehouseId, status]` index), so this is two
 * grouped counts rather than a scan. Warehouses with nothing outstanding are absent from the maps —
 * missing means zero.
 */
export async function countIntakeByWarehouse(warehouseIds?: string[]): Promise<{
  assignmentsOpen: Record<string, number>;
  stockEntryDrafts: Record<string, number>;
}> {
  const whScope = warehouseIds ? { warehouseId: { in: warehouseIds } } : {};
  const [assignments, drafts] = await Promise.all([
    prisma.customerStockWarehouseAssignment.groupBy({
      by: ["warehouseId"],
      where: { status: { in: OPEN_ASSIGNMENT_STATUSES }, ...whScope },
      _count: { _all: true },
    }),
    prisma.customerStockEntry.groupBy({
      by: ["warehouseId"],
      where: { status: "draft", ...whScope },
      _count: { _all: true },
    }),
  ]);
  return {
    assignmentsOpen: Object.fromEntries(assignments.map((r) => [r.warehouseId, r._count._all])),
    stockEntryDrafts: Object.fromEntries(drafts.map((r) => [r.warehouseId, r._count._all])),
  };
}

/**
 * The two CUSTOMER-facing attention counts, split per customer — what the Customers list shows on each
 * row. Neither queue has a cross-customer screen (both are worked on a customer's own detail page), so
 * this per-row split IS the navigation for them; there is nothing for the flat count to link to.
 *
 * Predicates are kept identical to countAttention's, including the Mongo null-vs-absent trap on
 * `lastLoginAt`: nothing writes that field on create, so `null` alone matches no never-signed-in user
 * and the count would sit at zero forever. A row and a badge disagreeing is exactly the failure this
 * whole rework exists to remove, so the two must stay written the same way.
 */
export async function countAttentionByCustomer(): Promise<{
  stockRequestsPending: Record<string, number>;
  stockRequestsAwaitingAssignment: Record<string, number>;
  portalInvitesPending: Record<string, number>;
}> {
  const [requests, awaitingAssignment, invites] = await Promise.all([
    prisma.customerStockRequest.groupBy({ by: ["customerId"], where: { status: "pending" }, _count: { _all: true } }),
    prisma.customerStockRequest.groupBy({ by: ["customerId"], where: { status: "approved" }, _count: { _all: true } }),
    prisma.customerUser.groupBy({
      by: ["customerId"],
      where: {
        status: "active",
        mustResetPassword: true,
        OR: [{ lastLoginAt: null }, { lastLoginAt: { isSet: false } }],
        customer: { deletedAt: null },
      },
      _count: { _all: true },
    }),
  ]);
  return {
    stockRequestsPending: Object.fromEntries(requests.map((r) => [r.customerId, r._count._all])),
    stockRequestsAwaitingAssignment: Object.fromEntries(awaitingAssignment.map((r) => [r.customerId, r._count._all])),
    portalInvitesPending: Object.fromEntries(invites.map((r) => [r.customerId, r._count._all])),
  };
}

export function countOpenAssignmentsByWarehouse(warehouseId: string): Promise<number> {
  return prisma.customerStockWarehouseAssignment.count({
    where: { warehouseId, status: { in: OPEN_ASSIGNMENT_STATUSES } },
  });
}

/**
 * A customer's entries that still hold stock. Same reasoning: entries are never archived (this model
 * has no archive state), so counting all of them would permanently block deleting any customer who
 * ever received consignment — and an emptied entry with movement history can't be deleted either,
 * leaving no way out at all.
 */
export function countStockEntriesWithStockByCustomer(customerId: string): Promise<number> {
  return prisma.customerStockEntry.count({ where: { customerId, quantity: { gt: 0 } } });
}

/**
 * A customer's consignment stock that is out in an ENGINEER's van, not on a shelf.
 *
 * The entry count above is deliberately shelf-only, and issuing to an engineer DECREMENTS that
 * shelf quantity (upsertCustomerHoldingTx moves it onto the holding row). So stock in the field is
 * invisible to it: a company whose whole consignment is out reads zero entries with stock. This is
 * the other half of "is any of their stock still with us".
 *
 * Scoped by the holding's own `customerId` snapshot — the field the model carries and indexes for
 * exactly this, and the same way customer-owned damage is scoped (findDamagedByCustomer). The
 * snapshot is taken from the entry, whose `customerId` is required, so it is always set.
 */
export function countEngineerHoldingsByCustomer(customerId: string): Promise<number> {
  return prisma.engineerCustomerStockHolding.count({ where: { customerId, quantityOnHand: { gt: 0 } } });
}

/**
 * A customer's units sitting in the damaged pool. Counted separately from the entry because a
 * damaged balance outlives the entry it came from and carries its own `customerId`: a company can
 * hold nothing on any shelf and nothing in any van, and still have stock of theirs in our hands.
 */
export function countDamagedByCustomer(customerId: string): Promise<number> {
  return prisma.damagedStockBalance.count({ where: { customerId, quantity: { gt: 0 } } });
}

export function deleteStockEntry(id: string) {
  return prisma.customerStockEntry.delete({ where: { id } });
}

export function updateStockEntryBarcode(id: string, barcode: string, barcodeDataUri: string) {
  return prisma.customerStockEntry.update({
    where: { id },
    data: { barcode, barcodeDataUri },
    include: {
      customer: { select: { id: true, name: true, customerCode: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
    },
  });
}

const STOCK_BARCODE_KEY = "CSE";

// Highest barcode number across ALL stock entries, regardless of prefix (every generated barcode is
// "<PREFIX>-<NNNNN>"). Prefix-agnostic so recovery stays correct after the configured prefix changes.
// Mirrors highestIrmNumber() in irm.repository — the same recovery problem, solved the same way.
async function highestStockEntryBarcodeNumber(): Promise<number> {
  const rows = await prisma.customerStockEntry.findMany({ where: { barcode: { not: null } }, select: { barcode: true } });
  let max = 0;
  for (const { barcode } of rows) {
    const m = /-(\d+)$/.exec(barcode ?? "");
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

// Atomic barcode sequence — mirrors the GRN/GDN code counters. Using an atomic Counter
// (not a row count) means concurrent barcode generation can't collide, and deleting an
// entry never recycles a previously-issued number.
//
// The cold-start seed MUST come from the highest number ever issued, NOT a row count:
// deleteStockEntry is a HARD delete, so a count under-seeds by exactly the number of deleted
// entries and re-issues barcodes that are still live on other rows. The partial unique index
// (ensureStockEntryBarcodeUniqueIndex) is the backstop if this is ever wrong again.
export async function nextStockEntryBarcodeSeq(): Promise<number> {
  try {
    const c = await prisma.counter.update({ where: { key: STOCK_BARCODE_KEY }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2025") throw e;
  }
  // Counter row doesn't exist yet — seed it past any already-issued barcode.
  const start = await highestStockEntryBarcodeNumber();
  try {
    await prisma.counter.create({ data: { key: STOCK_BARCODE_KEY, seq: start } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
  }
  const c = await prisma.counter.update({ where: { key: STOCK_BARCODE_KEY }, data: { seq: { increment: 1 } }, select: { seq: true } });
  return c.seq;
}

// Push the counter past the highest issued barcode after a P2002 — recovers a counter that has
// drifted behind the data (the only way a generated value can collide).
export async function fastForwardStockEntryBarcodeCounter(): Promise<void> {
  const max = await highestStockEntryBarcodeNumber();
  await prisma.counter.upsert({ where: { key: STOCK_BARCODE_KEY }, create: { key: STOCK_BARCODE_KEY, seq: max }, update: { seq: max } });
}

// True for a unique-constraint violation (P2002) on the barcode partial index. `meta.target` is
// matched leniently (index name or field path); a missing target is treated as the barcode clash,
// since barcode is the only unique index on this collection.
export function isStockEntryBarcodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).toLowerCase().includes("barcode");
}

// Enforce barcode uniqueness at the DATABASE with a PARTIAL unique index. A customer-stock barcode
// is a scannable physical identity — a duplicate makes findCustomerStockEntryByBarcode resolve the
// WRONG customer's stock, silently. Prisma can't express partial/sparse indexes for MongoDB (a plain
// `@unique` on an optional field builds a NON-sparse index that rejects a second null, and draft
// entries have no barcode yet — prisma/prisma#23870), so we create it directly. Only documents whose
// `barcode` is a string are indexed: unlimited nulls allowed, real barcodes unique across every row.
// This also gives the barcode scan lookup an index instead of a collection scan.
// Idempotent: createIndexes is a no-op once an identical index exists — safe on every boot.
export async function ensureStockEntryBarcodeUniqueIndex(): Promise<void> {
  await prisma.$runCommandRaw({
    createIndexes: "CustomerStockEntry",
    indexes: [
      {
        key: { barcode: 1 },
        name: "CustomerStockEntry_barcode_unique",
        unique: true,
        partialFilterExpression: { barcode: { $type: "string" } },
      },
    ],
  });
}

// True when a nested write hit a per-customer unique index (P2002) — duplicate
// project name or customer-user email within the same customer. The service
// turns this into a friendly 409.
export function isUniqueConflictError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// --- Inventory Hub: customer stock transfer (warehouse → warehouse) -------------------

// Atomically move `quantity` units from source entry to the destination warehouse.
// Match rule: find an active entry for the same customerId + itemName (normalised) + sku
// at toWarehouseId; if found increment it, otherwise create a new entry copying all item
// metadata from the source. Returns the destination entry (updated or created).
export async function transferCustomerStockTx(
  sourceId: string,
  toWarehouseId: string,
  quantity: number,
  actorEmail: string | null,
): Promise<{ source: Awaited<ReturnType<typeof findStockEntryById>>; destination: Awaited<ReturnType<typeof findStockEntryById>> }> {
  return withTransaction(async (tx) => {
    // Re-read source inside tx for concurrency safety.
    const source = await tx.customerStockEntry.findUnique({
      where: { id: sourceId },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        warehouse: { select: { id: true, name: true, code: true } },
        category: { select: { id: true, name: true } },
      },
    });
    if (!source || source.status !== "active") {
      throw new Error("Source entry not found or inactive.");
    }
    if (source.quantity < quantity) {
      throw new Error(`Only ${source.quantity} available — transfer quantity exceeds source.`);
    }

    // Decrement source.
    await tx.customerStockEntry.update({
      where: { id: sourceId },
      data: { quantity: { decrement: quantity } },
    });

    // Find an existing active destination entry matching same customer + itemName + sku.
    const norm = (s: string) => s.trim().toLowerCase();
    const candidates = await tx.customerStockEntry.findMany({
      where: { customerId: source.customerId, warehouseId: toWarehouseId, status: "active" },
      select: { id: true, itemName: true, sku: true },
    });
    const match = candidates.find(
      (e) => norm(e.itemName) === norm(source.itemName) && e.sku === (source.sku ?? null),
    );

    let destId: string;
    if (match) {
      // Increment existing destination entry.
      await tx.customerStockEntry.update({
        where: { id: match.id },
        data: { quantity: { increment: quantity }, receivedBy: actorEmail, receivedAt: new Date() },
      });
      destId = match.id;
    } else {
      // Create new destination entry copying item fields.
      const newEntry = await tx.customerStockEntry.create({
        data: {
          customerId: source.customerId,
          warehouseId: toWarehouseId,
          itemName: source.itemName,
          sku: source.sku ?? null,
          categoryId: source.categoryId ?? null,
          description: source.description ?? null,
          uom: source.uom ?? null,
          serialized: source.serialized ?? false,
          serialNumber: source.serialNumber ?? null,
          highValue: source.highValue ?? false,
          thresholdQty: source.thresholdQty ?? null,
          attributes: (source.attributes as Record<string, string> | null) ?? null,
          quantity,
          status: "active",
          receivedBy: actorEmail,
          receivedAt: new Date(),
        },
      });
      destId = newEntry.id;
    }

    // Re-read both with relations for the return value.
    const [updatedSource, updatedDest] = await Promise.all([
      tx.customerStockEntry.findUnique({
        where: { id: sourceId },
        include: {
          customer: { select: { id: true, name: true, customerCode: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          category: { select: { id: true, name: true } },
        },
      }),
      tx.customerStockEntry.findUnique({
        where: { id: destId },
        include: {
          customer: { select: { id: true, name: true, customerCode: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          category: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { source: updatedSource, destination: updatedDest };
  });
}

// --- Inventory Hub aggregation reads --------------------------------------------------
export function findActiveStockEntries(filters: { warehouseId?: string; customerId?: string } = {}) {
  return prisma.customerStockEntry.findMany({
    where: {
      status: "active",
      quantity: { gt: 0 },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
    },
    include: {
      customer: { select: { name: true } },
      warehouse: { select: { name: true, code: true } },
      category: { select: { name: true } },
    },
  });
}

/**
 * Lean, complete, active-only options for pickers. Ordered by name — how people scan a dropdown.
 *
 * The column is `customerCode`, NOT `code` (unlike Supplier and Warehouse). It is mapped to `code`
 * in the service so every picker consumes one option shape.
 */
export function findOptions(): Promise<{ id: string; customerCode: string; name: string }[]> {
  return prisma.customer.findMany({
    where: { deletedAt: null, status: "active" },
    select: { id: true, customerCode: true, name: true },
    orderBy: { name: "asc" },
  });
}
