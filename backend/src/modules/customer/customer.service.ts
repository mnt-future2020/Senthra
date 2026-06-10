import crypto from "node:crypto";

import type {
  Customer,
  CustomerCatalogueItem,
  CustomerProject,
  CustomerSite,
  Prisma,
} from "@prisma/client";

import * as customerRepo from "./customer.repository.js";
import type { CustomerWithChildren } from "./customer.repository.js";
import { assertEmailNamespaceFree } from "#modules/auth/email-namespace.js";
import { getCustomerStock, type CustomerStock } from "./customer.stock.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";

// Upload a company logo to Cloudinary (random public id, "senthra/customers"
// folder) and return its secure URL. Mirrors the staff avatar upload.
async function uploadLogo(image: string): Promise<string> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your credentials in Settings → Integrations to upload a logo.",
    );
  }
  return uploadToCloudinary(image, crypto.randomUUID(), creds, "senthra/customers");
}

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
  // Company
  registrationNumber: string | null;
  industry: string | null;
  website: string | null;
  logoUrl: string | null;
  notes: string | null;
  status: string;
  // Primary contact
  contactPerson: string | null;
  contactJobTitle: string | null;
  email: string;
  phone: string | null;
  altPhone: string | null;
  // Address (UK)
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
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
// exposes another customer, internal notes, or any auth field.
export interface CustomerSelfProfile {
  id: string;
  customerCode: string;
  name: string;
  logoUrl: string | null;
  website: string | null;
  contactPerson: string | null;
  contactJobTitle: string | null;
  email: string;
  phone: string | null;
}

function toSummary(c: Customer): PublicCustomerSummary {
  return {
    id: c.id,
    customerCode: c.customerCode,
    name: c.name,
    registrationNumber: c.registrationNumber,
    industry: c.industry,
    website: c.website,
    logoUrl: c.logoUrl,
    notes: c.notes,
    status: c.status,
    contactPerson: c.contactPerson,
    contactJobTitle: c.contactJobTitle,
    email: c.email,
    phone: c.phone,
    altPhone: c.altPhone,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    county: c.county,
    postcode: c.postcode,
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
  // Constrain the status filter to the known values; an unknown/typo value is
  // ignored (no filter) rather than silently matching zero rows.
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : undefined;
  const filters = { search: params.search, status };
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

// --- admin: create / update / delete customer --------------------------------

// Optional company / contact / address fields shared by create + update. The
// service trims each to null. `logo` is a data URI uploaded to Cloudinary.
export interface CustomerFieldsInput {
  registrationNumber?: string;
  industry?: string;
  website?: string;
  notes?: string;
  contactPerson?: string;
  contactJobTitle?: string;
  phone?: string;
  altPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  status?: string;
  logo?: string;
}

export interface CreateCustomerInput extends CustomerFieldsInput {
  name: string;
  email: string;
}

// The optional company/contact/address columns (everything except name/email/auth),
// trimmed to null. Shared by create + revive so the two stay in lockstep.
function customerColumns(input: CustomerFieldsInput, logoUrl: string | null) {
  return {
    registrationNumber: trimToNull(input.registrationNumber),
    industry: trimToNull(input.industry),
    website: trimToNull(input.website),
    notes: trimToNull(input.notes),
    logoUrl,
    contactPerson: trimToNull(input.contactPerson),
    contactJobTitle: trimToNull(input.contactJobTitle),
    phone: trimToNull(input.phone),
    altPhone: trimToNull(input.altPhone),
    addressLine1: trimToNull(input.addressLine1),
    addressLine2: trimToNull(input.addressLine2),
    city: trimToNull(input.city),
    county: trimToNull(input.county),
    postcode: trimToNull(input.postcode),
    status: normalizeStatus(input.status),
  };
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

  // Reject an email claimed by the admin or an active staff user (keeps the login
  // namespaces disjoint); the customer's own collection is checked below, with revive.
  await assertEmailNamespaceFree(email, { skip: { customer: true } });

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
  // bcrypt (CPU) and the optional logo upload (network) are independent — run them
  // together rather than serially.
  const [passwordHash, logoUrl] = await Promise.all([
    hashPassword(temporaryPassword),
    input.logo ? uploadLogo(input.logo) : Promise.resolve(null),
  ]);

  const fields = {
    name,
    nameLower,
    email,
    ...customerColumns(input, logoUrl),
    passwordHash,
    mustResetPassword: true,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
  };

  // The service pre-checks the email, but two concurrent creates for the same NEW
  // email both pass that check and race to the unique index — map that P2002 to a
  // friendly 409 instead of a raw 500. (A customerCode clash is retried inside
  // createWithCode.)
  let created: Customer;
  try {
    created = existing
      ? await customerRepo.revive(existing.id, { ...fields, deletedAt: null })
      : await customerRepo.createWithCode(fields);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict("A customer with that email already exists.");
    }
    throw e;
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

export interface UpdateCustomerInput extends CustomerFieldsInput {
  name?: string;
  email?: string;
  removeLogo?: boolean;
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
      await assertEmailNamespaceFree(email, { skip: { customer: true } });
      const clash = await customerRepo.findByEmailIncludingDeleted(email);
      if (clash && clash.id !== id) throw conflict("A customer with that email already exists.");
      data.email = email;
    }
  }

  // Each optional field is written only when the client actually sent it (so a
  // partial update never clears untouched columns); an empty string maps to null.
  if (typeof input.contactPerson === "string") data.contactPerson = trimToNull(input.contactPerson);
  if (typeof input.contactJobTitle === "string") data.contactJobTitle = trimToNull(input.contactJobTitle);
  if (typeof input.phone === "string") data.phone = trimToNull(input.phone);
  if (typeof input.altPhone === "string") data.altPhone = trimToNull(input.altPhone);
  if (typeof input.registrationNumber === "string") data.registrationNumber = trimToNull(input.registrationNumber);
  if (typeof input.industry === "string") data.industry = trimToNull(input.industry);
  if (typeof input.website === "string") data.website = trimToNull(input.website);
  if (typeof input.notes === "string") data.notes = trimToNull(input.notes);
  if (typeof input.addressLine1 === "string") data.addressLine1 = trimToNull(input.addressLine1);
  if (typeof input.addressLine2 === "string") data.addressLine2 = trimToNull(input.addressLine2);
  if (typeof input.city === "string") data.city = trimToNull(input.city);
  if (typeof input.county === "string") data.county = trimToNull(input.county);
  if (typeof input.postcode === "string") data.postcode = trimToNull(input.postcode);
  if (typeof input.status === "string") data.status = normalizeStatus(input.status);

  // Logo: a new upload replaces the current one; removeLogo clears it.
  if (input.logo) data.logoUrl = await uploadLogo(input.logo);
  else if (input.removeLogo) data.logoUrl = null;

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
  // undefined → field omitted (preserve on update); null / {} → explicit clear;
  // a non-empty object → replace.
  let attributes: Prisma.InputJsonValue | null | undefined;
  if (input.attributes === undefined) attributes = undefined;
  else if (input.attributes === null) attributes = null;
  else attributes = Object.keys(input.attributes).length > 0
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
    logoUrl: c.logoUrl,
    website: c.website,
    contactPerson: c.contactPerson,
    contactJobTitle: c.contactJobTitle,
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
