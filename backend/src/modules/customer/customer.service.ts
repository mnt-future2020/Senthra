import crypto from "node:crypto";

import type {
  Customer,
  CustomerProject,
  CustomerSite,
  CustomerStockRequest,
  CustomerUser,
  Prisma,
} from "@prisma/client";

import * as customerRepo from "./customer.repository.js";
import type { CustomerWithChildren } from "./customer.repository.js";
import { assertEmailNamespaceFree } from "#modules/auth/email-namespace.js";
import { issueResetEmail } from "#modules/auth/auth.service.js";
import * as sessionService from "#modules/auth/session.service.js";
import { getCustomerStock, type CustomerStock } from "./customer.stock.service.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import { geocodePostcode } from "../../lib/geocode.js";
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

// An ISO date string → Date, or null for empty/invalid. (Validation already rejects
// unparseable dates; this is the defensive last mile before the DB.)
function parseDate(v?: string | null): Date | null {
  if (!v || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A 24-char hex string is a Mongo ObjectId; anything else is treated as the human
// customer reference (e.g. "CUST-0001"). The two never overlap (codes contain "-").
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// --- DTOs (never include passwordHash or reset-token fields) -----------------

export interface PublicCustomerProject {
  id: string;
  code: string | null;
  name: string;
  type: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
  description: string | null;
  createdAt: string;
}

export interface PublicCustomerSite {
  id: string;
  code: string | null;
  name: string;
  addressLine: string | null;
  postcode: string | null;
  contactPerson: string | null;
  contactNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  createdAt: string;
}

export interface PublicCustomerUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  designation: string | null;
  status: string;
  // True until the user completes their first-login password set (the invite wall).
  mustResetPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

// A customer-submitted stock / replenishment request — shown to both the admin
// (review queue) and the portal user (their request history).
export interface PublicWarehouseAssignment {
  id: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  quantity: number;
  receivedQuantity: number;
  status: string;
  receivedBy: string | null;
  receivedAt: string | null;
  notes: string | null;
}

export interface PublicStockRequest {
  id: string;
  name: string;
  editedName: string | null;
  catalogueItemId: string | null;
  quantity: number | null;
  reason: string | null;
  notes: string | null;
  status: string;
  requestedByName: string | null;
  reviewedBy: string | null;
  adminResponse: string | null;
  reviewedAt: string | null;
  warehouseAssignments: PublicWarehouseAssignment[];
  createdAt: string;
}

export interface PublicCustomerSummary {
  id: string;
  customerCode: string;
  name: string;
  // Company
  legalName: string | null;
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
  country: string | null;
  // Audit
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCustomer extends PublicCustomerSummary {
  projects: PublicCustomerProject[];
  sites: PublicCustomerSite[];
  users: PublicCustomerUser[];
  stockRequests: PublicStockRequest[]; // PENDING only (the admin review queue)
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
    legalName: c.legalName,
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
    country: c.country,
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toProject(p: CustomerProject): PublicCustomerProject {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    type: p.type,
    startDate: p.startDate ? p.startDate.toISOString() : null,
    endDate: p.endDate ? p.endDate.toISOString() : null,
    status: p.status ?? "active",
    description: p.description,
    createdAt: p.createdAt.toISOString(),
  };
}

function toSite(s: CustomerSite): PublicCustomerSite {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    addressLine: s.addressLine,
    postcode: s.postcode,
    contactPerson: s.contactPerson,
    contactNumber: s.contactNumber,
    latitude: s.latitude,
    longitude: s.longitude,
    status: s.status ?? "active",
    createdAt: s.createdAt.toISOString(),
  };
}

function toCustomerUser(u: CustomerUser): PublicCustomerUser {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    designation: u.designation,
    status: u.status,
    mustResetPassword: u.mustResetPassword ?? true,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

function toWarehouseAssignment(a: { id: string; warehouseId: string; warehouse: { id: string; name: string; code: string }; quantity: number; receivedQuantity: number; status: string; receivedBy: string | null; receivedAt: Date | null; notes: string | null }): PublicWarehouseAssignment {
  return {
    id: a.id,
    warehouseId: a.warehouseId,
    warehouseName: a.warehouse.name,
    warehouseCode: a.warehouse.code,
    quantity: a.quantity,
    receivedQuantity: a.receivedQuantity,
    status: a.status,
    receivedBy: a.receivedBy,
    receivedAt: a.receivedAt ? a.receivedAt.toISOString() : null,
    notes: a.notes,
  };
}

type StockRequestRow = CustomerStockRequest & { warehouseAssignments?: Array<{ id: string; warehouseId: string; warehouse: { id: string; name: string; code: string }; quantity: number; receivedQuantity: number; status: string; receivedBy: string | null; receivedAt: Date | null; notes: string | null }> };

function toStockRequest(r: StockRequestRow): PublicStockRequest {
  return {
    id: r.id,
    name: r.name,
    editedName: r.editedName ?? null,
    catalogueItemId: r.catalogueItemId ?? null,
    quantity: r.quantity,
    reason: r.reason,
    notes: r.notes,
    status: r.status,
    requestedByName: r.requestedByName,
    reviewedBy: r.reviewedBy,
    adminResponse: r.adminResponse,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    warehouseAssignments: (r.warehouseAssignments ?? []).map(toWarehouseAssignment),
    createdAt: r.createdAt.toISOString(),
  };
}

function toPublic(
  c: CustomerWithChildren,
  opts: { includeStockRequests?: boolean } = {},
): PublicCustomer {
  return {
    ...toSummary(c),
    projects: c.projects.map(toProject),
    sites: c.sites.map(toSite),
    users: c.users.map(toCustomerUser),
    // The pending stock-request queue is its own capability (stock_requests.view) —
    // never expose it to a caller who only holds customers.view.
    stockRequests: opts.includeStockRequests ? c.stockRequests.map(toStockRequest) : [],
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
export async function getCustomer(
  idOrCode: string,
  opts: { includeStockRequests?: boolean } = {},
): Promise<PublicCustomer> {
  const c = OBJECT_ID_RE.test(idOrCode)
    ? await customerRepo.findByIdWithChildren(idOrCode)
    : await customerRepo.findByCustomerCodeWithChildren(idOrCode);
  if (!c) throw notFound("Customer not found.");
  return toPublic(c, opts);
}

// --- admin: create / update / delete customer --------------------------------

// Optional company / contact / address fields shared by create + update. The
// service trims each to null. `logo` is a data URI uploaded to Cloudinary.
export interface CustomerFieldsInput {
  legalName?: string;
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
  country?: string;
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
    legalName: trimToNull(input.legalName),
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
    country: trimToNull(input.country),
    status: normalizeStatus(input.status),
  };
}

// The temporary password is returned ONCE so the admin can relay it; it is never
// stored in plaintext or returned again.
export interface CreateCustomerResult {
  customer: PublicCustomerSummary;
  temporaryPassword: string;
}

// --- portal login provisioning (CustomerUser is the login identity) ----------

// Create a login user with a fresh temp password + email the invite. Returns the
// plaintext temp password ONCE (for the admin to relay); it's only ever stored hashed.
async function provisionLoginUser(
  customerId: string,
  data: {
    fullName: string;
    email: string;
    phone?: string | null;
    designation?: string | null;
    status?: string;
  },
  company: Customer,
): Promise<{ user: CustomerUser; temporaryPassword: string }> {
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await customerRepo.createCustomerUser(customerId, {
    fullName: data.fullName.trim(),
    email: data.email.trim(),
    phone: data.phone ?? null,
    designation: data.designation ?? null,
    status: normalizeStatus(data.status),
    passwordHash,
    mustResetPassword: true,
  });
  sendInvite(company, user, temporaryPassword);
  return { user, temporaryPassword };
}

// Regenerate a user's temp password (re-arming first-login) and return it. The
// caller emails it + ends the user's other sessions.
async function reissueLogin(userId: string): Promise<string> {
  const temporaryPassword = generateTempPassword();
  await customerRepo.updateLoginUser(userId, {
    passwordHash: await hashPassword(temporaryPassword),
    mustResetPassword: true,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
  });
  return temporaryPassword;
}

// Fire-and-forget the invite email (reuses the customer.created template). Forced
// so a disabled template never blocks a login invite.
function sendInvite(company: Customer, user: CustomerUser, temporaryPassword: string): void {
  void sendTemplatedEmail(
    "customer.created",
    user.email,
    {
      customerName: company.name,
      contactPerson: user.fullName,
      email: user.email,
      temporaryPassword,
    },
    { force: true },
  ).catch((e) =>
    console.error("customer invite email failed:", e instanceof Error ? e.message : e),
  );
}

// The company's primary login user — the one whose email matches the company
// contact email (the auto-created first user), else the earliest user.
async function findPrimaryUser(company: Customer): Promise<CustomerUser | null> {
  const byEmail = await customerRepo.findLoginByEmail(company.email.toLowerCase());
  if (byEmail && byEmail.customerId === company.id) return byEmail;
  const users = await customerRepo.findUsersByCustomer(company.id);
  return users[0] ?? null;
}

export async function createCustomer(
  input: CreateCustomerInput,
  actor?: AuditActor,
): Promise<CreateCustomerResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw badRequest("Customer name is required.");
  if (!email) throw badRequest("Email is required.");

  // The email becomes the FIRST portal user's login, so it must be free across the
  // admin / staff / customer-user namespaces. A soft-deleted company's user is allowed
  // (revive re-provisions it); the company-email revive case is handled just below.
  await assertEmailNamespaceFree(email);

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

  const logoUrl = input.logo ? await uploadLogo(input.logo) : null;
  const actorLabel = actor?.email ?? null;
  const fields = {
    name,
    nameLower,
    email,
    ...customerColumns(input, logoUrl),
    createdBy: actorLabel,
    updatedBy: actorLabel,
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

  // Provision the FIRST portal login user from the primary contact — this is the
  // login identity (the company itself has no password). If it fails (e.g. a racing
  // create grabbed the email), roll the company back so we never leave one without a
  // login, and surface a friendly conflict.
  let provisioned: { user: CustomerUser; temporaryPassword: string };
  try {
    provisioned = await provisionLoginUser(
      created.id,
      {
        fullName: trimToNull(input.contactPerson) ?? created.name,
        email: created.email,
        phone: trimToNull(input.phone),
        designation: trimToNull(input.contactJobTitle),
        status: "active",
      },
      created,
    );
  } catch (e) {
    await customerRepo.softDelete(created.id).catch(() => {});
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict("A customer with that email already exists.");
    }
    throw e;
  }

  auditNested(actor, "customer.user.created", created, provisioned.user.fullName);

  return { customer: toSummary(created), temporaryPassword: provisioned.temporaryPassword };
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
  if (typeof input.legalName === "string") data.legalName = trimToNull(input.legalName);
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
  if (typeof input.country === "string") data.country = trimToNull(input.country);
  if (typeof input.status === "string") data.status = normalizeStatus(input.status);

  // Logo: a new upload replaces the current one; removeLogo clears it.
  if (input.logo) data.logoUrl = await uploadLogo(input.logo);
  else if (input.removeLogo) data.logoUrl = null;

  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  // Stamp who last changed it (only once we know there IS a change).
  data.updatedBy = actor?.email ?? null;

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
  // End every portal user's sessions so a removed company can't keep browsing.
  const users = await customerRepo.findUsersByCustomer(id);
  await customerRepo.softDelete(id);
  await Promise.all(users.map((u) => sessionService.endAll(u.id, "customer")));
  audit.record({
    actor,
    action: "customer.deleted",
    targetType: "customer",
    targetId: id,
    targetLabel: customer.email,
  });
}

// Re-send the login invite for the company's PRIMARY portal user — a fresh temp
// password, re-arming first-login and ending their sessions. Used by the customer
// detail header's "Resend invite".
export async function resendInvite(
  id: string,
  actor?: AuditActor,
): Promise<{ temporaryPassword: string; email: string }> {
  const customer = await customerRepo.findById(id);
  if (!customer) throw notFound("Customer not found.");
  const user = await findPrimaryUser(customer);
  if (!user) throw badRequest("This customer has no portal user to invite. Add one first.");

  const temporaryPassword = await reissueLogin(user.id);
  await sessionService.endAll(user.id, "customer");
  audit.record({
    actor,
    action: "customer.invite_resent",
    targetType: "customer",
    targetId: id,
    targetLabel: user.email,
  });
  sendInvite(customer, user, temporaryPassword);
  return { temporaryPassword, email: user.email };
}

// --- admin: nested projects / sites -------------------------------------------
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

export interface ProjectInput {
  name: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  description?: string;
}

const PROJECT_STATUSES = ["active", "planned", "on_hold", "completed"] as const;
function normalizeProjectStatus(status?: string): string {
  return status && (PROJECT_STATUSES as readonly string[]).includes(status) ? status : "active";
}

function toProjectData(input: ProjectInput): customerRepo.ProjectData {
  const name = input.name.trim();
  if (!name) throw badRequest("Project name is required.");
  return {
    name,
    type: trimToNull(input.type),
    startDate: parseDate(input.startDate),
    endDate: parseDate(input.endDate),
    status: normalizeProjectStatus(input.status),
    description: trimToNull(input.description),
  };
}

export async function addProject(
  customerId: string,
  input: ProjectInput,
  actor?: AuditActor,
): Promise<PublicCustomerProject> {
  const customer = await requireCustomer(customerId);
  const data = toProjectData(input);
  if (await customerRepo.findProjectByName(customerId, data.name.toLowerCase())) {
    throw conflict(`A project named "${data.name}" already exists for this customer.`);
  }
  let created: CustomerProject;
  try {
    created = await customerRepo.createProject(customerId, data);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A project named "${data.name}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.project.created", customer, data.name);
  return toProject(created);
}

export async function updateProject(
  customerId: string,
  projectId: string,
  input: ProjectInput,
  actor?: AuditActor,
): Promise<PublicCustomerProject> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findProjectById(projectId);
  if (!existing || existing.customerId !== customerId) throw notFound("Project not found.");
  const data = toProjectData(input);
  const clash = await customerRepo.findProjectByName(customerId, data.name.toLowerCase());
  if (clash && clash.id !== projectId) {
    throw conflict(`A project named "${data.name}" already exists for this customer.`);
  }
  let updated: CustomerProject;
  try {
    updated = await customerRepo.updateProject(projectId, data);
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A project named "${data.name}" already exists for this customer.`);
    }
    throw e;
  }
  auditNested(actor, "customer.project.updated", customer, data.name);
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

export interface SiteInput {
  name: string;
  addressLine?: string;
  postcode?: string;
  contactPerson?: string;
  contactNumber?: string;
  status?: string;
}

function toSiteData(input: SiteInput): customerRepo.SiteData {
  const name = input.name.trim();
  if (!name) throw badRequest("Site name is required.");
  return {
    name,
    addressLine: trimToNull(input.addressLine),
    postcode: trimToNull(input.postcode),
    contactPerson: trimToNull(input.contactPerson),
    contactNumber: trimToNull(input.contactNumber),
    status: normalizeStatus(input.status),
  };
}

// Coordinates are derived from the postcode on the server (postcodes.io), never
// typed by the user. Best-effort: an unknown postcode / lookup failure leaves them
// null, and a cleared postcode clears the coordinates too.
async function geocodeSiteData(data: customerRepo.SiteData): Promise<customerRepo.SiteData> {
  const coords = await geocodePostcode(data.postcode);
  return { ...data, latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null };
}

export async function addSite(
  customerId: string,
  input: SiteInput,
  actor?: AuditActor,
): Promise<PublicCustomerSite> {
  const customer = await requireCustomer(customerId);
  const data = await geocodeSiteData(toSiteData(input));
  const created = await customerRepo.createSite(customerId, data);
  auditNested(actor, "customer.site.created", customer, data.name);
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
  const data = await geocodeSiteData(toSiteData(input));
  const updated = await customerRepo.updateSite(siteId, data);
  auditNested(actor, "customer.site.updated", customer, data.name);
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

// --- admin: nested customer users -------------------------------------------

export interface CustomerUserInput {
  fullName: string;
  email: string;
  phone?: string;
  designation?: string;
  status?: string;
}

// Every customer user is also a login account — creating one provisions a login
// (temp password + invite email) and returns the temp password ONCE.
export interface AddCustomerUserResult {
  user: PublicCustomerUser;
  temporaryPassword: string;
}

export async function addCustomerUser(
  customerId: string,
  input: CustomerUserInput,
  actor?: AuditActor,
): Promise<AddCustomerUserResult> {
  const customer = await requireCustomer(customerId);
  // One portal login per company (current scope). The first user is auto-created at
  // company creation, so adding another is blocked — edit / deactivate that one instead.
  if ((await customerRepo.findUsersByCustomer(customerId)).length >= 1) {
    throw conflict(
      "This customer already has a portal login. Edit or deactivate the existing user instead.",
    );
  }
  const fullName = input.fullName.trim();
  const email = input.email.trim();
  if (!fullName) throw badRequest("Full name is required.");
  if (!email) throw badRequest("Email is required.");
  // The email is a login, so it must be free across the admin / staff / customer-user
  // namespaces (emailLower is globally unique).
  await assertEmailNamespaceFree(email.toLowerCase());

  let provisioned: { user: CustomerUser; temporaryPassword: string };
  try {
    provisioned = await provisionLoginUser(
      customerId,
      {
        fullName,
        email,
        phone: trimToNull(input.phone),
        designation: trimToNull(input.designation),
        status: normalizeStatus(input.status),
      },
      customer,
    );
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A user with email "${email}" already exists.`);
    }
    throw e;
  }
  auditNested(actor, "customer.user.created", customer, fullName);
  return { user: toCustomerUser(provisioned.user), temporaryPassword: provisioned.temporaryPassword };
}

export async function updateCustomerUser(
  customerId: string,
  userId: string,
  input: CustomerUserInput,
  actor?: AuditActor,
): Promise<PublicCustomerUser> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findCustomerUserById(userId);
  if (!existing || existing.customerId !== customerId) throw notFound("User not found.");
  const fullName = input.fullName.trim();
  const email = input.email.trim();
  if (!fullName) throw badRequest("Full name is required.");
  if (!email) throw badRequest("Email is required.");
  // Changing the login email must keep it globally unique + out of the admin/staff
  // namespaces.
  if (email.toLowerCase() !== existing.emailLower) {
    await assertEmailNamespaceFree(email.toLowerCase());
  }
  const status = normalizeStatus(input.status);
  let updated: CustomerUser;
  try {
    updated = await customerRepo.updateCustomerUser(userId, {
      fullName,
      email,
      phone: trimToNull(input.phone),
      designation: trimToNull(input.designation),
      status,
    });
  } catch (e) {
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict(`A user with email "${email}" already exists.`);
    }
    throw e;
  }
  // Deactivating a user revokes their portal access immediately.
  if (status === "inactive") await sessionService.endAll(userId, "customer");
  auditNested(actor, "customer.user.updated", customer, fullName);
  return toCustomerUser(updated);
}

// Re-issue a single user's login invite (fresh temp password + email), re-arming
// first-login and ending their existing sessions.
export async function resendCustomerUserInvite(
  customerId: string,
  userId: string,
  actor?: AuditActor,
): Promise<{ temporaryPassword: string; email: string }> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findCustomerUserById(userId);
  if (!existing || existing.customerId !== customerId) throw notFound("User not found.");
  const temporaryPassword = await reissueLogin(userId);
  await sessionService.endAll(userId, "customer");
  auditNested(actor, "customer.user.invite_resent", customer, existing.fullName);
  sendInvite(customer, existing, temporaryPassword);
  return { temporaryPassword, email: existing.email };
}

// Admin-INITIATED password reset for a customer's portal login. The admin never sees
// or sets the password: this issues a secure single-use reset token (1-hour expiry,
// only its hash stored) and emails the customer a link to the public /reset-password
// page, where they choose their own password (handled by auth.resetPassword, which
// also clears the forced-first-login flag + ends every session). Blocked for inactive
// users / companies — a disabled login shouldn't be re-armed. Returns only the email
// (there is no password to relay).
export async function sendUserResetLink(
  customerId: string,
  userId: string,
  actor?: AuditActor,
): Promise<{ email: string }> {
  const customer = await requireCustomer(customerId);
  const existing = await customerRepo.findCustomerUserById(userId);
  if (!existing || existing.customerId !== customerId) throw notFound("User not found.");
  if (existing.status !== "active" || customer.status !== "active" || customer.deletedAt) {
    throw badRequest("This login is inactive. Reactivate it before sending a reset link.");
  }
  const firstName = existing.fullName.trim().split(/\s+/)[0] || existing.fullName;
  await issueResetEmail(existing.email, firstName, (d) =>
    customerRepo.updateLoginUser(userId, d),
  );
  auditNested(actor, "customer.user.reset_link_sent", customer, existing.fullName);
  return { email: existing.email };
}

// --- customer stock requests (portal submit → internal review) --------------

export interface StockRequestInput {
  name: string;
  quantity: number;
  reason: string;
  notes?: string;
}

function toStockRequestData(input: StockRequestInput): customerRepo.StockRequestData {
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!name) throw badRequest("Item name is required.");
  if (!Number.isFinite(input.quantity) || input.quantity < 1) {
    throw badRequest("Quantity must be at least 1.");
  }
  if (!reason) throw badRequest("A business reason is required.");
  return {
    name,
    quantity: Math.trunc(input.quantity),
    reason,
    notes: trimToNull(input.notes),
  };
}

// PORTAL: a customer user submits a stock / replenishment request. Scoped to the
// authenticated customer; the requesting user is recorded. This is the ONE place a
// portal user can write into the customer module — and even then it only queues a
// request for admin review, never the stock or inventory itself.
export async function submitStockRequest(
  customerId: string,
  requestedBy: { userId: string; name: string; email: string },
  input: StockRequestInput,
): Promise<PublicStockRequest> {
  const customer = await requireCustomer(customerId);
  const data = toStockRequestData(input);
  const created = await customerRepo.createStockRequest(
    customerId,
    requestedBy.userId,
    requestedBy.name,
    data,
  );
  audit.record({
    actor: { id: requestedBy.userId, type: "customer", email: requestedBy.email },
    action: "customer.stock_request.submitted",
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — ${data.name} ×${data.quantity}`,
  });
  return toStockRequest(created);
}

// PORTAL: the authenticated customer's own requests (all statuses).
export async function getOwnStockRequests(customerId: string): Promise<PublicStockRequest[]> {
  const requests = await customerRepo.findStockRequestsByCustomer(customerId);
  return requests.map(toStockRequest);
}

// ADMIN: a customer's stock requests (optionally filtered by status).
export async function listStockRequests(
  customerId: string,
  status?: string,
): Promise<PublicStockRequest[]> {
  await requireCustomer(customerId);
  const requests = await customerRepo.findStockRequestsByCustomer(customerId, status);
  return requests.map(toStockRequest);
}

// ADMIN: approve a pending request. This is a STATUS MOVE ONLY — it records the
// reviewer + an optional admin response note for the customer, and deliberately
// never creates an inventory record. Turning an approved request into real stock
// is a separate internal step (the inventory module, later).
export async function approveStockRequest(
  customerId: string,
  requestId: string,
  note: string | undefined,
  actor?: AuditActor,
): Promise<{ request: PublicStockRequest }> {
  const customer = await requireCustomer(customerId);
  const request = await customerRepo.findStockRequestById(requestId);
  if (!request || request.customerId !== customerId) throw notFound("Request not found.");
  if (request.status !== "pending") throw badRequest("This request has already been reviewed.");
  const reviewed = await customerRepo.reviewStockRequest(requestId, {
    status: "approved",
    reviewedBy: actor?.email ?? null,
    adminResponse: trimToNull(note),
    reviewedAt: new Date(),
  });
  auditNested(actor, "customer.stock_request.approved", customer, request.name);
  return { request: toStockRequest(reviewed) };
}

// ADMIN: reject a pending request, with an optional reason.
export async function rejectStockRequest(
  customerId: string,
  requestId: string,
  note: string | undefined,
  actor?: AuditActor,
): Promise<PublicStockRequest> {
  const customer = await requireCustomer(customerId);
  const request = await customerRepo.findStockRequestById(requestId);
  if (!request || request.customerId !== customerId) throw notFound("Request not found.");
  if (request.status !== "pending") throw badRequest("This request has already been reviewed.");
  const reviewed = await customerRepo.reviewStockRequest(requestId, {
    status: "rejected",
    reviewedBy: actor?.email ?? null,
    adminResponse: trimToNull(note),
    reviewedAt: new Date(),
  });
  auditNested(actor, "customer.stock_request.rejected", customer, request.name);
  return toStockRequest(reviewed);
}

// --- stock request: PM edit + approve in one step ----------------------------

export interface EditStockRequestInput {
  editedName: string;
  catalogueItemId?: string;
  note?: string;
}

export async function editAndApproveStockRequest(
  customerId: string,
  requestId: string,
  input: EditStockRequestInput,
  actor?: AuditActor,
): Promise<{ request: PublicStockRequest }> {
  const customer = await requireCustomer(customerId);
  const request = await customerRepo.findStockRequestById(requestId);
  if (!request || request.customerId !== customerId) throw notFound("Request not found.");
  if (request.status !== "pending") throw badRequest("Only pending requests can be edited.");
  const reviewed = await customerRepo.editAndApproveStockRequest(requestId, {
    editedName: input.editedName.trim(),
    catalogueItemId: trimToNull(input.catalogueItemId) ?? null,
    adminResponse: trimToNull(input.note),
    status: "approved",
    reviewedBy: actor?.email ?? null,
    reviewedAt: new Date(),
  });
  auditNested(actor, "customer.stock_request.edited_approved", customer, `${request.name} → ${input.editedName}`);
  return { request: toStockRequest(reviewed) };
}

// --- stock request: assign warehouses ----------------------------------------

export interface AssignWarehousesInput {
  assignments: Array<{ warehouseId: string; quantity: number }>;
}

export async function assignStockRequestWarehouses(
  customerId: string,
  requestId: string,
  input: AssignWarehousesInput,
  actor?: AuditActor,
): Promise<{ request: PublicStockRequest }> {
  const customer = await requireCustomer(customerId);
  const request = await customerRepo.findStockRequestById(requestId);
  if (!request || request.customerId !== customerId) throw notFound("Request not found.");
  if (request.status !== "approved") throw badRequest("Only approved requests can be assigned to warehouses.");

  const totalAssigned = input.assignments.reduce((s, a) => s + a.quantity, 0);
  if (request.quantity && totalAssigned !== request.quantity) {
    throw badRequest(`Total assigned (${totalAssigned}) must equal request quantity (${request.quantity}).`);
  }

  const warehouseIds = new Set(input.assignments.map((a) => a.warehouseId));
  if (warehouseIds.size !== input.assignments.length) {
    throw badRequest("Each warehouse can only appear once.");
  }

  await customerRepo.createWarehouseAssignments(
    input.assignments.map((a) => ({
      customerStockRequestId: requestId,
      warehouseId: a.warehouseId,
      quantity: a.quantity,
    })),
  );
  await customerRepo.updateStockRequestStatus(requestId, "assigned");

  const updated = await customerRepo.findStockRequestWithAssignments(requestId);
  auditNested(actor, "customer.stock_request.assigned", customer, `${request.editedName ?? request.name} → ${input.assignments.length} warehouse(s)`);
  return { request: toStockRequest(updated as StockRequestRow) };
}

// --- stock assignment: warehouse manager receives stock ----------------------

export interface ReceiveStockInput {
  receivedQuantity: number;
  notes?: string;
}

export async function receiveStockAssignment(
  assignmentId: string,
  input: ReceiveStockInput,
  actor?: AuditActor,
): Promise<{ assignment: PublicWarehouseAssignment; stockEntryId: string }> {
  const assignment = await customerRepo.findAssignmentById(assignmentId);
  if (!assignment) throw notFound("Assignment not found.");
  if (assignment.status === "received") throw badRequest("This assignment is already fully received.");

  const remaining = assignment.quantity - assignment.receivedQuantity;
  if (input.receivedQuantity > remaining) {
    throw badRequest(`Only ${remaining} remaining to receive. You entered ${input.receivedQuantity}.`);
  }

  const updated = await customerRepo.updateAssignmentReceived(
    assignmentId,
    input.receivedQuantity,
    assignment.receivedQuantity,
    assignment.quantity,
    actor?.email ?? null,
    trimToNull(input.notes),
  );

  const allAssignments = await customerRepo.findAssignmentsByRequest(assignment.customerStockRequestId);
  const allReceived = allAssignments.every((a) => a.status === "received");
  const someReceived = allAssignments.some((a) => a.status === "received" || a.status === "partially_received");

  if (allReceived) {
    await customerRepo.updateStockRequestStatus(assignment.customerStockRequestId, "completed");
  } else if (someReceived) {
    await customerRepo.updateStockRequestStatus(assignment.customerStockRequestId, "partially_received");
  }

  const stockEntry = await customerRepo.createStockEntry({
    customerId: assignment.stockRequest.customerId,
    warehouseId: assignment.warehouseId,
    assignmentId,
    itemName: assignment.stockRequest.editedName ?? assignment.stockRequest.name,
    quantity: input.receivedQuantity,
    receivedBy: actor?.email ?? null,
    receivedAt: new Date(),
  });

  audit.record({
    actor,
    action: "customer.stock_request.received",
    targetType: "customer_stock_assignment",
    targetId: assignmentId,
    targetLabel: `${assignment.stockRequest.editedName ?? assignment.stockRequest.name} ×${input.receivedQuantity} at ${assignment.warehouse.name}`,
  });

  return {
    assignment: toWarehouseAssignment({
      ...updated,
      warehouse: assignment.warehouse,
    }),
    stockEntryId: stockEntry.id,
  };
}

// --- stock request: get assignments for a request ----------------------------

export async function getStockRequestAssignments(
  customerId: string,
  requestId: string,
): Promise<PublicWarehouseAssignment[]> {
  await requireCustomer(customerId);
  const request = await customerRepo.findStockRequestById(requestId);
  if (!request || request.customerId !== customerId) throw notFound("Request not found.");
  const assignments = await customerRepo.findAssignmentsByRequest(requestId);
  return assignments.map(toWarehouseAssignment);
}

// --- warehouse pending stock view --------------------------------------------

export interface PendingStockItem {
  assignmentId: string;
  requestId: string;
  customerName: string;
  customerCode: string;
  itemName: string;
  quantity: number;
  receivedQuantity: number;
  status: string;
  warehouseName: string;
  warehouseCode: string | null;
  createdAt: string;
}

export async function getPendingStockForWarehouse(warehouseId: string): Promise<PendingStockItem[]> {
  const assignments = await customerRepo.findPendingAssignmentsByWarehouse(warehouseId);
  return assignments.map((a) => ({
    assignmentId: a.id,
    requestId: a.stockRequest.id,
    customerName: a.stockRequest.customer.name,
    customerCode: a.stockRequest.customer.customerCode,
    itemName: a.stockRequest.editedName ?? a.stockRequest.name,
    quantity: a.quantity,
    receivedQuantity: a.receivedQuantity,
    status: a.status,
    warehouseName: a.warehouse.name,
    warehouseCode: a.warehouse.code,
    createdAt: a.createdAt.toISOString(),
  }));
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

export function getOwnStock(customerId: string): Promise<CustomerStock> {
  return getCustomerStock(customerId);
}

// PORTAL: the customer's own projects (read-only).
export async function getOwnProjects(customerId: string): Promise<PublicCustomerProject[]> {
  const c = await customerRepo.findByIdWithChildren(customerId);
  if (!c) throw notFound("Customer not found.");
  return c.projects.map(toProject);
}

// PORTAL: the customer's own sites (read-only).
export async function getOwnSites(customerId: string): Promise<PublicCustomerSite[]> {
  const c = await customerRepo.findByIdWithChildren(customerId);
  if (!c) throw notFound("Customer not found.");
  return c.sites.map(toSite);
}

// PORTAL dashboard summary: company header + live counts + a few recent requests.
// Everything here is derivable today; richer cards (stock movements, allocations)
// arrive with the inventory module and are surfaced as "coming soon" on the client.
export interface CustomerOverview {
  customer: {
    id: string;
    customerCode: string;
    name: string;
    logoUrl: string | null;
    status: string;
  };
  counts: {
    activeProjects: number;
    totalProjects: number;
    totalSites: number;
    pendingRequests: number;
  };
  recentRequests: PublicStockRequest[];
}

export async function getOwnOverview(customerId: string): Promise<CustomerOverview> {
  const c = await customerRepo.findByIdWithChildren(customerId);
  if (!c) throw notFound("Customer not found.");
  // All requests (any status), newest first — for the "recent activity" card and an
  // accurate pending count (the included children are pre-filtered to pending only).
  const allRequests = await customerRepo.findStockRequestsByCustomer(customerId);
  return {
    customer: {
      id: c.id,
      customerCode: c.customerCode,
      name: c.name,
      logoUrl: c.logoUrl,
      status: c.status,
    },
    counts: {
      activeProjects: c.projects.filter((p) => p.status === "active").length,
      totalProjects: c.projects.length,
      totalSites: c.sites.length,
      pendingRequests: allRequests.filter((r) => r.status === "pending").length,
    },
    recentRequests: allRequests.slice(0, 5).map(toStockRequest),
  };
}

// ============================================================================
// Customer stock entries — physical stock received at warehouses
// ============================================================================

export interface PublicStockEntry {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  assignmentId: string;
  itemName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  description: string | null;
  uom: string | null;
  quantity: number;
  serialized: boolean;
  serialNumber: string | null;
  highValue: boolean;
  thresholdQty: number | null;
  attributes: Record<string, string> | null;
  barcode: string | null;
  barcodeDataUri: string | null;
  status: string;
  receivedBy: string | null;
  receivedAt: string | null;
  createdAt: string;
}

type StockEntryRow = NonNullable<Awaited<ReturnType<typeof customerRepo.findStockEntryById>>>;

function toStockEntry(e: StockEntryRow): PublicStockEntry {
  return {
    id: e.id,
    customerId: e.customerId,
    customerName: e.customer.name,
    customerCode: e.customer.customerCode,
    warehouseId: e.warehouseId,
    warehouseName: e.warehouse.name,
    warehouseCode: e.warehouse.code,
    assignmentId: e.assignmentId,
    itemName: e.itemName,
    sku: e.sku,
    categoryId: e.categoryId,
    categoryName: e.category?.name ?? null,
    description: e.description,
    uom: e.uom,
    quantity: e.quantity,
    serialized: e.serialized,
    serialNumber: e.serialNumber,
    highValue: e.highValue,
    thresholdQty: e.thresholdQty ?? null,
    attributes: e.attributes as Record<string, string> | null,
    barcode: e.barcode,
    barcodeDataUri: e.barcodeDataUri,
    status: e.status,
    receivedBy: e.receivedBy,
    receivedAt: e.receivedAt ? e.receivedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
}

export async function getStockEntry(entryId: string): Promise<PublicStockEntry> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");
  return toStockEntry(entry);
}

export interface UpdateStockEntryInput {
  itemName: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  uom?: string;
  serialized?: boolean;
  serialNumber?: string;
  highValue?: boolean;
  attributes?: Record<string, string>;
}

export async function updateStockEntry(
  entryId: string,
  input: UpdateStockEntryInput,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");

  const updated = await customerRepo.updateStockEntry(entryId, {
    itemName: input.itemName.trim(),
    sku: trimToNull(input.sku),
    categoryId: trimToNull(input.categoryId),
    description: trimToNull(input.description),
    uom: trimToNull(input.uom),
    serialized: input.serialized ?? false,
    serialNumber: trimToNull(input.serialNumber),
    highValue: input.highValue ?? false,
    attributes: input.attributes ?? null,
    status: "active",
  });

  audit.record({
    actor,
    action: "customer.stock_entry.updated",
    targetType: "customer_stock_entry",
    targetId: entryId,
    targetLabel: `${updated.itemName} at ${updated.warehouse.name}`,
  });

  return toStockEntry(updated);
}

export async function generateStockEntryBarcode(
  entryId: string,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");

  const count = await customerRepo.countStockEntries();
  const barcodeValue = `CSE-${String(count).padStart(5, "0")}`;

  const bwipjs = await import("bwip-js");
  const pngBuffer = await bwipjs.default.toBuffer({
    bcid: "code128",
    text: barcodeValue,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
  const dataUri = `data:image/png;base64,${pngBuffer.toString("base64")}`;

  const updated = await customerRepo.updateStockEntryBarcode(entryId, barcodeValue, dataUri);

  audit.record({
    actor,
    action: "customer.stock_entry.barcode_generated",
    targetType: "customer_stock_entry",
    targetId: entryId,
    targetLabel: `${entry.itemName} → ${barcodeValue}`,
  });

  return toStockEntry(updated);
}

export interface DirectStockEntryInput {
  warehouseId: string;
  itemName: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  uom?: string;
  quantity: number;
  serialized?: boolean;
  serialNumber?: string;
  highValue?: boolean;
}

export async function createDirectStockEntry(
  customerId: string,
  input: DirectStockEntryInput,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  await requireCustomer(customerId);

  const entry = await customerRepo.createDirectStockEntry({
    customerId,
    warehouseId: input.warehouseId,
    itemName: input.itemName,
    sku: input.sku || null,
    categoryId: input.categoryId || null,
    description: input.description || null,
    uom: input.uom || null,
    quantity: input.quantity,
    serialized: input.serialized ?? false,
    serialNumber: input.serialNumber || null,
    highValue: input.highValue ?? false,
    thresholdQty: input.thresholdQty ?? null,
    attributes: input.attributes ?? null,
    status: "active",
    receivedBy: actor?.email ?? null,
    receivedAt: new Date(),
  });

  await audit.log({
    action: "customer_stock_entry.created",
    actor: actor ?? null,
    targetType: "customer_stock_entry",
    targetId: entry.id,
    details: { itemName: input.itemName, quantity: input.quantity, warehouseId: input.warehouseId, direct: true },
  });

  return toStockEntry(entry as StockEntryRow);
}

export async function listCustomerStockEntries(
  customerId: string,
  status?: string,
): Promise<PublicStockEntry[]> {
  const entries = await customerRepo.findStockEntriesByCustomer(customerId, status);
  return entries.map((e) => toStockEntry(e as StockEntryRow));
}

export async function listWarehouseStockEntries(
  warehouseId: string,
  status?: string,
): Promise<PublicStockEntry[]> {
  const entries = await customerRepo.findStockEntriesByWarehouse(warehouseId, status);
  return entries.map((e) => toStockEntry(e as StockEntryRow));
}
