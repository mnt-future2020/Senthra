import type {
  Customer,
  CustomerCatalogueItem,
  CustomerProject,
  CustomerSite,
  Prisma,
} from "@prisma/client";

import * as customerRepo from "./customer.repository.js";
import type { CustomerWithChildren } from "./customer.repository.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { getCustomerStock, type CustomerStock } from "./customer.stock.service.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";

const STATUSES = ["active", "inactive"] as const;
export type CustomerStatus = (typeof STATUSES)[number];

function normalizeStatus(status?: string): CustomerStatus {
  return status && (STATUSES as readonly string[]).includes(status)
    ? (status as CustomerStatus)
    : "active";
}

function trimToNull(v?: string | null): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length ? t : null;
}

// A 24-char hex string is a Mongo ObjectId; anything else is treated as the human
// customer reference (e.g. "CUST-0001"). The two never overlap (codes contain "-").
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// --- DTOs (never include passwordHash or reset-token fields) -----------------

export interface PublicCustomerProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface PublicCatalogueItem {
  id: string;
  name: string;
  sku: string;
  category: string;
  attributes: unknown;
  createdAt: string;
}

export interface PublicCustomerSite {
  id: string;
  name: string;
  postcode: string | null;
  createdAt: string;
}

export interface PublicCustomerSummary {
  id: string;
  customerCode: string;
  name: string;
  contactPerson: string | null;
  email: string;
  phone: string | null;
  status: string;
  mustResetPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCustomer extends PublicCustomerSummary {
  projects: PublicCustomerProject[];
  catalogue: PublicCatalogueItem[];
  sites: PublicCustomerSite[];
}

// What a logged-in customer sees about THEMSELVES (their own profile). Never
// exposes another customer or any auth/internal field.
export interface CustomerSelfProfile {
  id: string;
  customerCode: string;
  name: string;
  contactPerson: string | null;
  email: string;
  phone: string | null;
}

function toSummary(c: Customer): PublicCustomerSummary {
  return {
    id: c.id,
    customerCode: c.customerCode,
    name: c.name,
    contactPerson: c.contactPerson,
    email: c.email,
    phone: c.phone,
    status: c.status,
    mustResetPassword: c.mustResetPassword,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toProject(p: CustomerProject): PublicCustomerProject {
  return { id: p.id, name: p.name, createdAt: p.createdAt.toISOString() };
}

function toCatalogueItem(i: CustomerCatalogueItem): PublicCatalogueItem {
  return {
    id: i.id,
    name: i.name,
    sku: i.sku,
    category: i.category,
    attributes: i.attributes ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

function toSite(s: CustomerSite): PublicCustomerSite {
  return { id: s.id, name: s.name, postcode: s.postcode, createdAt: s.createdAt.toISOString() };
}

function toPublic(c: CustomerWithChildren): PublicCustomer {
  return {
    ...toSummary(c),
    projects: c.projects.map(toProject),
    catalogue: c.catalogue.map(toCatalogueItem),
    sites: c.sites.map(toSite),
  };
}

// --- admin: list + detail ----------------------------------------------------

export interface ListCustomersParams {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedCustomers {
  customers: PublicCustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listCustomers(params: ListCustomersParams = {}): Promise<PagedCustomers> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = { search: params.search, status: params.status };
  const total = await customerRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const customers = await customerRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { customers: customers.map(toSummary), total, page, pageSize, totalPages };
}

// Resolve a customer by either its database id OR its customerCode (so pages can
// route by the friendly reference). Includes children for the detail view.
export async function getCustomer(idOrCode: string): Promise<PublicCustomer> {
  const c = OBJECT_ID_RE.test(idOrCode)
    ? await customerRepo.findByIdWithChildren(idOrCode)
    : await customerRepo.findByCustomerCodeWithChildren(idOrCode);
  if (!c) throw notFound("Customer not found.");
  return toPublic(c);
}

// Reject an email that belongs to the admin or an active staff user — login
// resolves admin → user → customer, so a shared address would shadow the customer.
async function assertEmailFree(email: string): Promise<void> {
  const [adminWithEmail, userWithEmail] = await Promise.all([
    adminRepo.findByEmail(email),
    userRepo.findByEmailWithRole(email),
  ]);
  if (adminWithEmail) {
    throw conflict("That email belongs to the administrator account. Use a different one.");
  }
  if (userWithEmail) {
    throw conflict("That email belongs to a staff user. Use a different one.");
  }
}

// --- admin: create / update / delete customer --------------------------------

export interface CreateCustomerInput {
  name: string;
  email: string;
  contactPerson?: string;
  phone?: string;
  status?: string;
}

// The temporary password is returned ONCE so the admin can relay it; it is never
// stored in plaintext or returned again.
export interface CreateCustomerResult {
  customer: PublicCustomerSummary;
  temporaryPassword: string;
}

export async function createCustomer(
  input: CreateCustomerInput,
  actor?: AuditActor,
): Promise<CreateCustomerResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw badRequest("Customer name is required.");
  if (!email) throw badRequest("Email is required.");

  await assertEmailFree(email);

  // A SOFT-DELETED customer with this email is revived (re-adding a removed customer
  // reuses the record + a new password); an ACTIVE one is a real conflict.
  const existing = await customerRepo.findByEmailIncludingDeleted(email);
  if (existing && !existing.deletedAt) {
    throw conflict("A customer with that email already exists.");
  }

  // Friendly company-name uniqueness pre-check among active customers.
  const nameLower = name.toLowerCase();
  const nameClash = await customerRepo.findActiveByNameLower(nameLower);
  if (nameClash && nameClash.id !== existing?.id) {
    throw conflict(`A customer named "${name}" already exists.`);
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const fields = {
    name,
    nameLower,
    email,
    contactPerson: trimToNull(input.contactPerson),
    phone: trimToNull(input.phone),
    status: normalizeStatus(input.status),
    passwordHash,
    mustResetPassword: true,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
  };

  let created: Customer;
  if (existing) {
    created = await customerRepo.revive(existing.id, { ...fields, deletedAt: null });
  } else {
    created = await customerRepo.createWithCode(fields);
  }

  audit.record({
    actor,
    action: "customer.created",
    targetType: "customer",
    targetId: created.id,
    targetLabel: created.email,
    metadata: { customerCode: created.customerCode, revived: Boolean(existing) },
  });

  void sendTemplatedEmail(
    "customer.created",
    created.email,
    {
      customerName: created.name,
      contactPerson: created.contactPerson ?? created.name,
      email: created.email,
      temporaryPassword,
    },
    { force: true },
  ).catch((e) =>
    console.error("customer.created email failed:", e instanceof Error ? e.message : e),
  );

  return { customer: toSummary(created), temporaryPassword };
}

export interface UpdateCustomerInput {
  name?: string;
  email?: string;
  contactPerson?: string;
  phone?: string;
  status?: string;
}

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  actor?: AuditActor,
): Promise<PublicCustomerSummary> {
  const customer = await customerRepo.findById(id);
  if (!customer) throw notFound("Customer not found.");

  const data: Prisma.CustomerUpdateInput = {};

  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const nameLower = name.toLowerCase();
    if (nameLower !== customer.nameLower) {
      const clash = await customerRepo.findActiveByNameLower(nameLower);
      if (clash && clash.id !== id) throw conflict(`A customer named "${name}" already exists.`);
    }
    data.name = name;
    data.nameLower = nameLower;
  }

  if (typeof input.email === "string" && input.email.trim()) {
    const email = input.email.trim().toLowerCase();
    if (email !== customer.email) {
      await assertEmailFree(email);
      const clash = await customerRepo.findByEmailIncludingDeleted(email);
      if (clash && clash.id !== id) throw conflict("A customer with that email already exists.");
      data.email = email;
    }
  }

  if (typeof input.contactPerson === "string") data.contactPerson = trimToNull(input.contactPerson);
  if (typeof input.phone === "string") data.phone = trimToNull(input.phone);
  if (typeof input.status === "string") data.status = normalizeStatus(input.status);

  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  const updated = await customerRepo.update(id, data);
  audit.record({
    actor,
    action: "customer.updated",
    targetType: "customer",
    targetId: id,
    targetLabel: updated.email,
  });
  return toSummary(updated);
}

export async function deleteCustomer(id: string, actor?: AuditActor): Promise<void> {
  const customer = await customerRepo.findById(id);
  if (!customer) throw notFound("Customer not found.");
  await customerRepo.softDelete(id);
  audit.record({
    actor,
    action: "customer.deleted",
    targetType: "customer",
    targetId: id,
    targetLabel: customer.email,
  });
}

// Regenerate the temporary password and re-send the login email — used when the
// invite is lost or the temp password needs resetting.
export async function resendInvite(
  id: string,
  actor?: AuditActor,
): Promise<{ temporaryPassword: string }> {
  const customer = await customerRepo.findById(id);
  if (!customer) throw notFound("Customer not found.");

  const temporaryPassword = generateTempPassword();
  await customerRepo.update(id, {
    passwordHash: await hashPassword(temporaryPassword),
    mustResetPassword: true,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
  });
  audit.record({
    actor,
    action: "customer.invite_resent",
    targetType: "customer",
    targetId: id,
    targetLabel: customer.email,
  });

  void sendTemplatedEmail(
    "customer.created",
    customer.email,
    {
      customerName: customer.name,
      contactPerson: customer.contactPerson ?? customer.name,
      email: customer.email,
      temporaryPassword,
    },
    { force: true },
  ).catch((e) =>
    console.error("customer invite resend email failed:", e instanceof Error ? e.message : e),
  );

  return { temporaryPassword };
}

// --- admin: nested projects / catalogue / sites ------------------------------
//
// Each write first loads the parent customer (404 if missing) and, on update/delete,
// verifies the child belongs to that customer — so a mismatched customerId/childId
// pair can never edit another customer's row.

async function requireCustomer(customerId: string): Promise<Customer> {
  const c = await customerRepo.findById(customerId);
  if (!c) throw notFound("Customer not found.");
  return c;
}

function auditNested(
  actor: AuditActor | undefined,
  action: string,
  customer: Customer,
  label: string,
): void {
  audit.record({
    actor,
    action,
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — ${label}`,
  });
}

export async function addProject(
  customerId: string,
  name: string,
  actor?: AuditActor,
): Promise<PublicCustomerProject> {
  const customer = await requireCustomer(customerId);
  const trimmed = name.trim();
  if (!trimmed) throw badRequest("Project name is required.");
  if (await customerRepo.findProjectByName(customerId, trimmed.toLowerCase())) {
    throw conflict(`A project named "${trimmed}" already exists for this customer.`);
  }
  let created: CustomerProject;
  try {
    created = await customerRepo.createProject(customerId, trimmed);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A project named "${trimmed}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.project.created", customer, trimmed);
  return toProject(created);
}

export async function updateProject(
  customerId: string,
  projectId: string,
  name: string,
  actor?: AuditActor,
): Promise<PublicCustomerProject> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findProjectById(projectId);
  if (!existing || existing.customerId !== customerId) throw notFound("Project not found.");
  const trimmed = name.trim();
  if (!trimmed) throw badRequest("Project name is required.");
  const clash = await customerRepo.findProjectByName(customerId, trimmed.toLowerCase());
  if (clash && clash.id !== projectId) {
    throw conflict(`A project named "${trimmed}" already exists for this customer.`);
  }
  let updated: CustomerProject;
  try {
    updated = await customerRepo.updateProject(projectId, trimmed);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A project named "${trimmed}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.project.updated", customer, trimmed);
  return toProject(updated);
}

export async function removeProject(
  customerId: string,
  projectId: string,
  actor?: AuditActor,
): Promise<void> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findProjectById(projectId);
  if (!existing || existing.customerId !== customerId) throw notFound("Project not found.");
  await customerRepo.deleteProject(projectId);
  auditNested(actor, "customer.project.deleted", customer, existing.name);
}

export interface CatalogueItemInput {
  name: string;
  sku: string;
  category: string;
  attributes?: Record<string, unknown> | null;
}

function normalizeCatalogueInput(input: CatalogueItemInput): customerRepo.CatalogueItemData {
  const name = input.name.trim();
  const sku = input.sku.trim();
  const category = input.category.trim();
  if (!name) throw badRequest("Item name is required.");
  if (!sku) throw badRequest("SKU is required.");
  if (!category) throw badRequest("Category is required.");
  const attributes =
    input.attributes && Object.keys(input.attributes).length > 0
      ? (input.attributes as Prisma.InputJsonValue)
      : null;
  return { name, sku, category, attributes };
}

export async function addCatalogueItem(
  customerId: string,
  input: CatalogueItemInput,
  actor?: AuditActor,
): Promise<PublicCatalogueItem> {
  const customer = await requireCustomer(customerId);
  const data = normalizeCatalogueInput(input);
  if (await customerRepo.findCatalogueItemBySku(customerId, data.sku.toLowerCase())) {
    throw conflict(`An item with SKU "${data.sku}" already exists for this customer.`);
  }
  let created: CustomerCatalogueItem;
  try {
    created = await customerRepo.createCatalogueItem(customerId, data);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`An item with SKU "${data.sku}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.catalogue.created", customer, data.sku);
  return toCatalogueItem(created);
}

export async function updateCatalogueItem(
  customerId: string,
  itemId: string,
  input: CatalogueItemInput,
  actor?: AuditActor,
): Promise<PublicCatalogueItem> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findCatalogueItemById(itemId);
  if (!existing || existing.customerId !== customerId) throw notFound("Catalogue item not found.");
  const data = normalizeCatalogueInput(input);
  const clash = await customerRepo.findCatalogueItemBySku(customerId, data.sku.toLowerCase());
  if (clash && clash.id !== itemId) {
    throw conflict(`An item with SKU "${data.sku}" already exists for this customer.`);
  }
  let updated: CustomerCatalogueItem;
  try {
    updated = await customerRepo.updateCatalogueItem(itemId, data);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`An item with SKU "${data.sku}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.catalogue.updated", customer, data.sku);
  return toCatalogueItem(updated);
}

export async function removeCatalogueItem(
  customerId: string,
  itemId: string,
  actor?: AuditActor,
): Promise<void> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findCatalogueItemById(itemId);
  if (!existing || existing.customerId !== customerId) throw notFound("Catalogue item not found.");
  await customerRepo.deleteCatalogueItem(itemId);
  auditNested(actor, "customer.catalogue.deleted", customer, existing.sku);
}

export interface SiteInput {
  name: string;
  postcode?: string;
}

export async function addSite(
  customerId: string,
  input: SiteInput,
  actor?: AuditActor,
): Promise<PublicCustomerSite> {
  const customer = await requireCustomer(customerId);
  const name = input.name.trim();
  if (!name) throw badRequest("Site name is required.");
  const created = await customerRepo.createSite(customerId, {
    name,
    postcode: trimToNull(input.postcode),
  });
  auditNested(actor, "customer.site.created", customer, name);
  return toSite(created);
}

export async function updateSite(
  customerId: string,
  siteId: string,
  input: SiteInput,
  actor?: AuditActor,
): Promise<PublicCustomerSite> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findSiteById(siteId);
  if (!existing || existing.customerId !== customerId) throw notFound("Site not found.");
  const name = input.name.trim();
  if (!name) throw badRequest("Site name is required.");
  const updated = await customerRepo.updateSite(siteId, {
    name,
    postcode: trimToNull(input.postcode),
  });
  auditNested(actor, "customer.site.updated", customer, name);
  return toSite(updated);
}

export async function removeSite(
  customerId: string,
  siteId: string,
  actor?: AuditActor,
): Promise<void> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findSiteById(siteId);
  if (!existing || existing.customerId !== customerId) throw notFound("Site not found.");
  await customerRepo.deleteSite(siteId);
  auditNested(actor, "customer.site.deleted", customer, existing.name);
}

// --- customer-facing reads (scoped strictly by the authenticated customerId) --

export async function getOwnProfile(customerId: string): Promise<CustomerSelfProfile> {
  const c = await customerRepo.findById(customerId);
  if (!c) throw notFound("Customer not found.");
  return {
    id: c.id,
    customerCode: c.customerCode,
    name: c.name,
    contactPerson: c.contactPerson,
    email: c.email,
    phone: c.phone,
  };
}

export async function getOwnCatalogue(customerId: string): Promise<PublicCatalogueItem[]> {
  const c = await customerRepo.findByIdWithChildren(customerId);
  if (!c) throw notFound("Customer not found.");
  return c.catalogue.map(toCatalogueItem);
}

export function getOwnStock(customerId: string): Promise<CustomerStock> {
  return getCustomerStock(customerId);
}
