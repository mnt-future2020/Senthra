import {
  Prisma,
  type Customer,
  type CustomerCatalogueItem,
  type CustomerProject,
  type CustomerSite,
  type CustomerStockRequest,
  type CustomerUser,
} from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// Data-access layer for the Customer aggregate (Customer + projects + catalogue +
// sites + users). The ONLY place Prisma is touched for customers. Soft-deleted
// customers (deletedAt set) are excluded from normal reads.
//
// ISOLATION INVARIANT: every nested read/write is scoped by `customerId`. Callers
// pass the customerId resolved from the route (admin) or from req.principal
// (customer portal) — a customer can only ever address its own rows.

export type CustomerWithChildren = Customer & {
  projects: CustomerProject[];
  catalogue: CustomerCatalogueItem[];
  sites: CustomerSite[];
  users: CustomerUser[];
  stockRequests: CustomerStockRequest[];
};

const childInclude = {
  projects: { orderBy: { name: "asc" } },
  catalogue: { include: { category: true }, orderBy: { name: "asc" } },
  sites: { orderBy: { name: "asc" } },
  users: { orderBy: { fullName: "asc" } },
  // Only PENDING requests ride along on the admin detail (the review queue).
  stockRequests: { where: { status: "pending" }, orderBy: { createdAt: "desc" } },
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
// CRITICAL: the prior occupant's nested data (projects / catalogue / sites / users)
// is scrubbed in the SAME transaction. The Customer row is reused (so the email +
// code stay reserved), so without this the revived customer — a different company
// reusing the email — would inherit the previous company's catalogue/projects/
// sites/users (a cross-tenant data leak via GET /customer/catalogue + the detail).
export function revive(
  id: string,
  data: Omit<Prisma.CustomerUpdateInput, "customerCode">,
): Promise<Customer> {
  return withTransaction(async (tx) => {
    await tx.customerProject.deleteMany({ where: { customerId: id } });
    await tx.customerCatalogueItem.deleteMany({ where: { customerId: id } });
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

// --- nested: catalogue items ------------------------------------------------

export function findCatalogueItemById(id: string) {
  return prisma.customerCatalogueItem.findUnique({ where: { id }, include: { category: true } });
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
  categoryId: string;
  description?: string | null;
  uom?: string | null;
  serialized?: boolean;
  barcodeRequired?: boolean;
  highValue?: boolean;
  thresholdQty?: number | null;
  status?: string | null;
  // undefined = leave attributes unchanged (omitted from a PUT); null = clear them;
  // an object = replace them.
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
      categoryId: data.categoryId,
      description: data.description ?? null,
      uom: data.uom ?? null,
      serialized: data.serialized ?? false,
      barcodeRequired: data.barcodeRequired ?? false,
      highValue: data.highValue ?? false,
      thresholdQty: data.thresholdQty ?? null,
      status: data.status ?? "active",
      attributes: data.attributes ?? null,
    },
    include: { category: true },
  });
}

export function updateCatalogueItem(
  id: string,
  data: CatalogueItemData,
): Promise<CustomerCatalogueItem> {
  const update: Prisma.CustomerCatalogueItemUncheckedUpdateInput = {
    name: data.name,
    sku: data.sku,
    skuLower: data.sku.toLowerCase(),
    categoryId: data.categoryId,
    description: data.description ?? null,
    uom: data.uom ?? null,
    serialized: data.serialized ?? false,
    barcodeRequired: data.barcodeRequired ?? false,
    highValue: data.highValue ?? false,
    thresholdQty: data.thresholdQty ?? null,
    status: data.status ?? "active",
  };
  // Only touch attributes when the caller actually sent the field — an omitted
  // `attributes` (undefined) preserves the stored value rather than wiping it.
  if (data.attributes !== undefined) update.attributes = data.attributes ?? null;
  return prisma.customerCatalogueItem.update({ where: { id }, data: update, include: { category: true } });
}

export function deleteCatalogueItem(id: string): Promise<CustomerCatalogueItem> {
  return prisma.customerCatalogueItem.delete({ where: { id } });
}

// --- nested: sites ----------------------------------------------------------

export interface SiteData {
  name: string;
  addressLine?: string | null;
  postcode?: string | null;
  contactPerson?: string | null;
  contactNumber?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status?: string | null;
}

export function findSiteById(id: string): Promise<CustomerSite | null> {
  return prisma.customerSite.findUnique({ where: { id } });
}

export async function createSite(customerId: string, data: SiteData): Promise<CustomerSite> {
  const code = await allocateNestedCode("STE", customerId, () =>
    prisma.customerSite
      .findMany({ where: { customerId }, select: { code: true } })
      .then((rows) => rows.map((s) => s.code)),
  );
  return prisma.customerSite.create({
    data: {
      customerId,
      code,
      name: data.name,
      addressLine: data.addressLine ?? null,
      postcode: data.postcode ?? null,
      contactPerson: data.contactPerson ?? null,
      contactNumber: data.contactNumber ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      status: data.status ?? "active",
    },
  });
}

export function updateSite(id: string, data: SiteData): Promise<CustomerSite> {
  return prisma.customerSite.update({
    where: { id },
    data: {
      name: data.name,
      addressLine: data.addressLine ?? null,
      postcode: data.postcode ?? null,
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
}

export function createStockRequest(
  customerId: string,
  requestedByUserId: string | null,
  requestedByName: string | null,
  data: StockRequestData,
): Promise<CustomerStockRequest> {
  return prisma.customerStockRequest.create({
    data: {
      customerId,
      requestedByUserId,
      requestedByName,
      name: data.name,
      quantity: data.quantity ?? null,
      reason: data.reason ?? null,
      notes: data.notes ?? null,
      status: "pending",
    },
  });
}

export function findStockRequestsByCustomer(
  customerId: string,
  status?: string,
): Promise<CustomerStockRequest[]> {
  return prisma.customerStockRequest.findMany({
    where: { customerId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export function findStockRequestById(id: string): Promise<CustomerStockRequest | null> {
  return prisma.customerStockRequest.findUnique({ where: { id } });
}

// The reviewer's verdict on a request: a status move (approved | rejected) plus an
// optional admin response note shown to the customer. Approval is status-only — it
// never writes a catalogue item or inventory record (that's a later, deliberate
// internal step).
export interface StockReviewData {
  status: string;
  reviewedBy: string | null;
  adminResponse?: string | null;
  reviewedAt: Date;
}

export function reviewStockRequest(id: string, data: StockReviewData): Promise<CustomerStockRequest> {
  return prisma.customerStockRequest.update({
    where: { id },
    data: {
      status: data.status,
      reviewedBy: data.reviewedBy,
      adminResponse: data.adminResponse ?? null,
      reviewedAt: data.reviewedAt,
    },
  });
}

// True when a nested write hit a per-customer unique index (P2002) — duplicate
// project name, catalogue SKU, or customer-user email within the same customer.
// The service turns this into a friendly 409.
export function isUniqueConflictError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
