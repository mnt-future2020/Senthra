import {
  Prisma,
  type Customer,
  type CustomerCatalogueItem,
  type CustomerProject,
  type CustomerSite,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Customer aggregate (Customer + projects + catalogue +
// sites). The ONLY place Prisma is touched for customers. Soft-deleted customers
// (deletedAt set) are excluded from normal reads.
//
// ISOLATION INVARIANT: every nested read/write is scoped by `customerId`. Callers
// pass the customerId resolved from the route (admin) or from req.principal
// (customer portal) — a customer can only ever address its own rows.

export type CustomerWithChildren = Customer & {
  projects: CustomerProject[];
  catalogue: CustomerCatalogueItem[];
  sites: CustomerSite[];
};

const childInclude = {
  projects: { orderBy: { name: "asc" } },
  catalogue: { orderBy: { name: "asc" } },
  sites: { orderBy: { name: "asc" } },
} satisfies Prisma.CustomerInclude;

export interface CustomerListFilters {
  search?: string;
  status?: string;
}

function buildWhere(filters: CustomerListFilters): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    const q = filters.search;
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
export function revive(
  id: string,
  data: Omit<Prisma.CustomerUpdateInput, "customerCode">,
): Promise<Customer> {
  return prisma.customer.update({ where: { id }, data });
}

// --- nested: projects -------------------------------------------------------

export function findProjectById(id: string): Promise<CustomerProject | null> {
  return prisma.customerProject.findUnique({ where: { id } });
}

export function findProjectByName(
  customerId: string,
  nameLower: string,
): Promise<CustomerProject | null> {
  return prisma.customerProject.findFirst({ where: { customerId, nameLower } });
}

export function createProject(customerId: string, name: string): Promise<CustomerProject> {
  return prisma.customerProject.create({
    data: { customerId, name, nameLower: name.toLowerCase() },
  });
}

export function updateProject(id: string, name: string): Promise<CustomerProject> {
  return prisma.customerProject.update({
    where: { id },
    data: { name, nameLower: name.toLowerCase() },
  });
}

export function deleteProject(id: string): Promise<CustomerProject> {
  return prisma.customerProject.delete({ where: { id } });
}

// --- nested: catalogue items ------------------------------------------------

export function findCatalogueItemById(id: string): Promise<CustomerCatalogueItem | null> {
  return prisma.customerCatalogueItem.findUnique({ where: { id } });
}

export function findCatalogueItemBySku(
  customerId: string,
  skuLower: string,
): Promise<CustomerCatalogueItem | null> {
  return prisma.customerCatalogueItem.findFirst({ where: { customerId, skuLower } });
}

export interface CatalogueItemData {
  name: string;
  sku: string;
  category: string;
  attributes?: Prisma.InputJsonValue | null;
}

export function createCatalogueItem(
  customerId: string,
  data: CatalogueItemData,
): Promise<CustomerCatalogueItem> {
  return prisma.customerCatalogueItem.create({
    data: {
      customerId,
      name: data.name,
      sku: data.sku,
      skuLower: data.sku.toLowerCase(),
      category: data.category,
      attributes: data.attributes ?? null,
    },
  });
}

export function updateCatalogueItem(
  id: string,
  data: CatalogueItemData,
): Promise<CustomerCatalogueItem> {
  return prisma.customerCatalogueItem.update({
    where: { id },
    data: {
      name: data.name,
      sku: data.sku,
      skuLower: data.sku.toLowerCase(),
      category: data.category,
      attributes: data.attributes ?? null,
    },
  });
}

export function deleteCatalogueItem(id: string): Promise<CustomerCatalogueItem> {
  return prisma.customerCatalogueItem.delete({ where: { id } });
}

// --- nested: sites ----------------------------------------------------------

export function findSiteById(id: string): Promise<CustomerSite | null> {
  return prisma.customerSite.findUnique({ where: { id } });
}

export interface SiteData {
  name: string;
  postcode?: string | null;
}

export function createSite(customerId: string, data: SiteData): Promise<CustomerSite> {
  return prisma.customerSite.create({
    data: { customerId, name: data.name, postcode: data.postcode ?? null },
  });
}

export function updateSite(id: string, data: SiteData): Promise<CustomerSite> {
  return prisma.customerSite.update({
    where: { id },
    data: { name: data.name, postcode: data.postcode ?? null },
  });
}

export function deleteSite(id: string): Promise<CustomerSite> {
  return prisma.customerSite.delete({ where: { id } });
}

// True when a nested write hit a per-customer unique index (P2002) — duplicate
// project name or catalogue SKU within the same customer. The service turns this
// into a friendly 409.
export function isUniqueConflictError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
