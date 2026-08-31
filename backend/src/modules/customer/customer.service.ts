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
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import { withTransactionRetry } from "../../lib/prisma.js";
import { uploadToCloudinary } from "../../lib/cloudinary.js";
import type { CloudinaryImageAsset } from "../../lib/cloudinary.js";
import { geocodePostcode, geocodePostcodesBulk, canonicalPostcode } from "../../lib/geocode.js";
import { siteSchema } from "./customer.validation.js";
import { getCloudinaryCreds, getRegionalSettings, getStockCodePrefix } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { assertWarehouseAccess } from "../../lib/warehouse-access.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { resolveInstantWindow } from "../../utils/filter-date.js";
import * as settingsService from "#modules/settings/settings.service.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { emitAttentionChanged } from "../../lib/realtime.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";

// The customer module has no realtime surface, but four attention queues live here (stock requests
// awaiting review, open warehouse assignments, stock-entry drafts, portal invites never signed in).
// Those move across ~10 mutations written in two different audit shapes, with more to come — so the
// signal is derived from the audit line every one of them already writes, instead of an emit call
// each site has to remember. Fired unconditionally rather than filtered by action prefix: every
// action here is a rare admin/portal mutation (creating a customer, importing sites), the receiving
// clients debounce, and the counts are indexed `count()`s — so the cost of over-signalling is far
// below the cost of a queue that silently stops updating when someone adds action #15.
// Known lag: a portal invite is cleared by the customer's FIRST LOGIN, which happens in the auth
// module and writes no customer audit — that one count settles on the next signal or safety refresh.
function recordCustomerAudit(entry: Parameters<typeof audit.record>[0]): void {
  audit.record(entry);
  emitAttentionChanged("customers");
}
import { sendTemplatedEmail } from "#modules/email/email.service.js";

// Upload a company logo to Cloudinary (random public id, "senthra/customers"
// folder) and return its secure URL. Mirrors the staff avatar upload.
async function uploadLogo(image: string): Promise<CloudinaryImageAsset> {
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
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
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
  // Present only on a `closed_short` assignment — the shortfall's explanation, surfaced so the
  // warehouse and the customer can both see WHY a delivery was closed rather than just that it
  // stopped. (Closed, not "written off": nothing leaves a ledger — the shortfall was never stock.
  // "Write off" belongs to goods-management's job_lost drain, which really does move balances.)
  closureReason: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export interface PublicStockRequest {
  id: string;
  name: string;
  editedName: string | null;
  catalogueItemId: string | null;
  // Set when this submission tops up an existing received stock line.
  linkedStockEntryId: string | null;
  quantity: number | null;
  reason: string | null;
  notes: string | null;
  status: string;
  requestedByName: string | null;
  reviewedBy: string | null;
  adminResponse: string | null;
  reviewedAt: string | null;
  // What the CUSTOMER asked for — never the destination. The destination is
  // `warehouseAssignments` below, which the reviewer sets and may split across warehouses.
  preferredWarehouseId: string | null;
  preferredWarehouseName: string | null;
  // False once the preferred warehouse has been deactivated OR soft-deleted since submission, so
  // the UI can show the preference without offering to act on a warehouse that is no longer usable.
  preferredWarehouseActive: boolean;
  warehouseAssignments: PublicWarehouseAssignment[];
  createdAt: string;
}

// ── Portal (customer-facing) view of a submission ────────────────────────────────────────────
// The portal is served the SAME rows as the admin dashboard, so every field left on the type
// travelling to it is readable by the customer whether or not a component renders it. The admin
// shapes above carry things that are ours and not theirs: the staff emails that acted on the line
// (`receivedBy`, `closedBy`, `reviewedBy`) and the warehouse's internal `notes`. All of them were
// already being sent to the portal, which renders none of them — a narrower type is what keeps
// that accidental privacy from depending on nobody ever writing the component that shows them.
export interface PortalWarehouseAssignment {
  warehouseName: string;
  quantity: number;
  receivedQuantity: number;
  status: string;
  // Why a leg was closed with a balance still outstanding. This is the ONE part of a short-closure
  // the customer genuinely needs: their submission reads "completed" while some of what they
  // declared never arrived, and without this there is nothing anywhere that says so.
  closureReason: string | null;
  closedAt: string | null;
}

export interface PortalStockRequest {
  id: string;
  name: string;
  editedName: string | null;
  linkedStockEntryId: string | null;
  quantity: number | null;
  reason: string | null;
  status: string;
  adminResponse: string | null;
  // Echoed back so the customer can see the preference they expressed. Name only — the id is
  // internal, and `warehouseAssignments` remains what actually happened to their stock.
  preferredWarehouseName: string | null;
  warehouseAssignments: PortalWarehouseAssignment[];
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

// NOTE: sites/projects are deliberately NOT part of the detail payload — they can number in the
// thousands (bulk import), so the detail tabs read them through the paged list endpoints instead.
export interface PublicCustomer extends PublicCustomerSummary {
  users: PublicCustomerUser[];
  // EVERY submission, not just open ones — the Stock Submissions tab filters to open by default and
  // needs the finished ones reachable (a short-closed delivery completes its request).
  stockRequests: PublicStockRequest[];
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
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    county: s.county,
    postcode: s.postcode,
    country: s.country,
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

function toWarehouseAssignment(a: { id: string; warehouseId: string; warehouse: { id: string; name: string; code: string }; quantity: number; receivedQuantity: number; status: string; receivedBy: string | null; receivedAt: Date | null; notes: string | null; closureReason?: string | null; closedAt?: Date | null; closedBy?: string | null }): PublicWarehouseAssignment {
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
    // Optional on the input so a caller mapping a partially-selected row still compiles; a row that
    // was never closed simply reports null.
    closureReason: a.closureReason ?? null,
    closedAt: a.closedAt ? a.closedAt.toISOString() : null,
    closedBy: a.closedBy ?? null,
  };
}

type StockRequestRow = CustomerStockRequest & {
  warehouseAssignments?: Array<{ id: string; warehouseId: string; warehouse: { id: string; name: string; code: string }; quantity: number; receivedQuantity: number; status: string; receivedBy: string | null; receivedAt: Date | null; notes: string | null }>;
  // Optional on the type: a row read through a path that doesn't include the relation still maps,
  // reporting a null preference rather than crashing.
  preferredWarehouse?: { id: string; name: string; code: string; status: string; deletedAt?: Date | null } | null;
};

function toStockRequest(r: StockRequestRow): PublicStockRequest {
  return {
    id: r.id,
    name: r.name,
    editedName: r.editedName ?? null,
    catalogueItemId: r.catalogueItemId ?? null,
    linkedStockEntryId: r.linkedStockEntryId ?? null,
    quantity: r.quantity,
    reason: r.reason,
    notes: r.notes,
    status: r.status,
    requestedByName: r.requestedByName,
    reviewedBy: r.reviewedBy,
    adminResponse: r.adminResponse,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    preferredWarehouseId: r.preferredWarehouseId ?? null,
    preferredWarehouseName: r.preferredWarehouse?.name ?? null,
    // BOTH flags, matching what every warehouse query actually filters on (status + deletedAt).
    // Checking status alone made a soft-deleted warehouse — which keeps status "active" — read as
    // usable, so the reviewer got no "(no longer available)" hint while the assign modal refused to
    // pre-fill it: two contradictory signals about the same warehouse.
    preferredWarehouseActive: r.preferredWarehouse
      ? r.preferredWarehouse.status === "active" && !r.preferredWarehouse.deletedAt
      : false,
    warehouseAssignments: (r.warehouseAssignments ?? []).map(toWarehouseAssignment),
    createdAt: r.createdAt.toISOString(),
  };
}

// The customer's own view of their submission. Built by NAMING the safe fields rather than deleting
// the unsafe ones from the admin shape: a field added to PublicWarehouseAssignment later then has to
// be added here deliberately to reach the portal, instead of arriving there by default.
function toPortalWarehouseAssignment(a: {
  warehouse: { name: string };
  quantity: number;
  receivedQuantity: number;
  status: string;
  closureReason?: string | null;
  closedAt?: Date | null;
}): PortalWarehouseAssignment {
  return {
    warehouseName: a.warehouse.name,
    quantity: a.quantity,
    receivedQuantity: a.receivedQuantity,
    status: a.status,
    closureReason: a.closureReason ?? null,
    closedAt: a.closedAt ? a.closedAt.toISOString() : null,
  };
}

function toPortalStockRequest(r: StockRequestRow): PortalStockRequest {
  return {
    id: r.id,
    name: r.name,
    editedName: r.editedName ?? null,
    linkedStockEntryId: r.linkedStockEntryId ?? null,
    quantity: r.quantity,
    reason: r.reason,
    status: r.status,
    // `adminResponse` is written FOR the customer; `reviewedBy` (who wrote it) is not theirs.
    adminResponse: r.adminResponse,
    preferredWarehouseName: r.preferredWarehouse?.name ?? null,
    warehouseAssignments: (r.warehouseAssignments ?? []).map(toPortalWarehouseAssignment),
    createdAt: r.createdAt.toISOString(),
  };
}

function toPublic(
  c: CustomerWithChildren,
  opts: { includeStockRequests?: boolean } = {},
): PublicCustomer {
  return {
    ...toSummary(c),
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
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export interface PagedCustomers {
  customers: PublicCustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listCustomers(params: ListCustomersParams = {}): Promise<PagedCustomers> {
  // Constrain the status filter to the known values; an unknown/typo value is
  // ignored (no filter) rather than silently matching zero rows.
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : undefined;
  const filters = { search: params.search, status };
  const total = await customerRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const customers = await customerRepo.findMany(filters, skip, pageSize, params.sort);
  return { customers: customers.map(toSummary), total, page, pageSize, totalPages };
}

/**
 * The SAME filtered list as a CSV, minus paging. Delegates to listCustomers with one oversized page
 * rather than re-deriving the filters — the status whitelist above is real behaviour (an unknown
 * ?status is ignored, not matched), and a second copy of it would drift.
 */
export async function exportCustomersCsv(
  params: ListCustomersParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  const { customers } = await listCustomers({ ...params, ...EXPORT_PAGING });
  const rows = customers.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const csv = toCsv(
    [
      "Code", "Name", "Legal Name", "Status", "Industry", "Registration No", "Website",
      "Contact", "Job Title", "Email", "Phone", "Alt Phone",
      "Address 1", "Address 2", "City", "County", "Postcode", "Country",
      `Added (${regional.timezone})`,
    ],
    rows.map((c) => [
      c.customerCode,
      c.name,
      c.legalName,
      c.status,
      c.industry,
      c.registrationNumber,
      c.website,
      c.contactPerson,
      c.contactJobTitle,
      c.email,
      c.phone,
      c.altPhone,
      c.addressLine1,
      c.addressLine2,
      c.city,
      c.county,
      c.postcode,
      c.country,
      formatDate(c.createdAt, regional.dateFormat, regional.timezone),
    ]),
  );

  // `notes` and `createdBy` are deliberately absent: internal free text staff write ABOUT the
  // customer, and a staff email — and a spreadsheet is exactly the artifact that gets forwarded on.
  audit.record({ actor, action: "customer.exported", targetType: "customer", targetLabel: `${rows.length} rows` });
  return { csv, capped: customers.length > EXPORT_MAX };
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
function customerColumns(input: CustomerFieldsInput, logo: CloudinaryImageAsset | null) {
  return {
    legalName: trimToNull(input.legalName),
    registrationNumber: trimToNull(input.registrationNumber),
    industry: trimToNull(input.industry),
    website: trimToNull(input.website),
    notes: trimToNull(input.notes),
    logoUrl: logo?.url ?? null,
    logoPublicId: logo?.publicId ?? null,
    logoResourceType: logo?.resourceType ?? null,
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

  const logo = input.logo ? await uploadLogo(input.logo) : null;
  const actorLabel = actor?.email ?? null;
  const fields = {
    name,
    nameLower,
    email,
    ...customerColumns(input, logo),
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

  recordCustomerAudit({
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
  //
  // A logo's public id is a fresh randomUUID, so a replacement does NOT overwrite the old asset — it
  // just stops being referenced. Changing a customer's logo is an ordinary success path, so the file it
  // replaces has to be released explicitly or it stays in the CDN forever.
  let staleLogo: attachmentService.AssetRef | null = null;
  const previousLogo: attachmentService.AssetRef = { publicId: customer.logoPublicId, resourceType: customer.logoResourceType };
  if (input.logo) {
    const logo = await uploadLogo(input.logo);
    data.logoUrl = logo.url;
    data.logoPublicId = logo.publicId;
    data.logoResourceType = logo.resourceType;
    // Only when the id actually moved; a legacy row has no stored id and is skipped.
    if (previousLogo.publicId && previousLogo.publicId !== logo.publicId) staleLogo = previousLogo;
  } else if (input.removeLogo) {
    data.logoUrl = null;
    data.logoPublicId = null;
    data.logoResourceType = null;
    if (previousLogo.publicId) staleLogo = previousLogo;
  }

  if (Object.keys(data).length === 0) throw badRequest("Nothing to update.");

  // Stamp who last changed it (only once we know there IS a change).
  data.updatedBy = actor?.email ?? null;

  const updated = await customerRepo.update(id, data);
  // After the row is written. Never throws — a storage failure cannot fail the customer update.
  if (staleLogo) await attachmentService.releaseAsset(staleLogo, `customer ${updated.name}`);
  recordCustomerAudit({
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

  // A company that still has consignment stock in our warehouses, or work in flight, can't be removed.
  // The delete is soft, so nothing is destroyed — but every read filters deleted customers out, which
  // left their stock sitting in a warehouse with no owner anyone could name, and live jobs pointing at
  // a company that no longer appears anywhere. Deactivate such a customer instead; delete once the
  // stock is out and the work is closed.
  //
  // Their stock is asked about in THREE places, because it lives in three and each one empties into
  // the next: on a warehouse shelf, out in an engineer's van, or in the damaged pool. Issuing to an
  // engineer decrements the shelf quantity, so the entry count alone reads zero for a company whose
  // whole consignment is in the field — and if the job it went out on has since been completed or
  // cancelled, the open-jobs count reads zero too. Checking only the shelf let exactly the stock we
  // are still holding be the stock that no check could see.
  // Stock they've SENT is the fourth place, and the one none of the three above can see: an approved
  // or assigned request that hasn't landed yet has produced no entry, no holding and no damaged unit,
  // so a company with a delivery in transit passes every stock check there is. Counted through
  // countOpenStockRequestsByCustomer so this guard and the "Open submissions" number on their own
  // dashboard resolve `open` from one definition — a guard looser than the count the customer is
  // looking at is a guard that lets you delete work they can see.
  const [entries, engineerHeld, damaged, liveJobs, openRequests] = await Promise.all([
    customerRepo.countStockEntriesWithStockByCustomer(id),
    customerRepo.countEngineerHoldingsByCustomer(id),
    customerRepo.countDamagedByCustomer(id),
    jobRepo.countOpenByCustomer(id),
    customerRepo.countOpenStockRequestsByCustomer(id),
  ]);
  if (entries > 0) {
    throw conflict(
      `${customer.name} still has stock in ${entries} ${entries === 1 ? "entry" : "entries"} in your warehouses. ` +
        `Dispatch or remove the stock before deleting the customer.`,
    );
  }
  if (engineerHeld > 0) {
    throw conflict(
      `${customer.name} still has stock out with an engineer. ` +
        `Have it returned or written off before deleting the customer.`,
    );
  }
  if (damaged > 0) {
    throw conflict(
      `${customer.name} still has stock in the damaged pool. ` +
        `Clear it from Goods Management before deleting the customer.`,
    );
  }
  if (liveJobs > 0) {
    throw conflict(
      `${customer.name} still has ${liveJobs} job${liveJobs === 1 ? "" : "s"} in progress. ` +
        `Complete or cancel them before deleting the customer.`,
    );
  }
  if (openRequests > 0) {
    throw conflict(
      `${customer.name} still has ${openRequests} open stock request${openRequests === 1 ? "" : "s"}. ` +
        `Receive or close them before deleting the customer.`,
    );
  }

  // End every portal user's sessions so a removed company can't keep browsing.
  const users = await customerRepo.findUsersByCustomer(id);
  await customerRepo.softDelete(id);
  await Promise.all(users.map((u) => sessionService.endAll(u.id, "customer")));
  recordCustomerAudit({
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
  recordCustomerAudit({
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
  recordCustomerAudit({
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
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  contactPerson?: string;
  contactNumber?: string;
  status?: string;
}

function toSiteData(input: SiteInput): customerRepo.SiteData {
  const name = input.name.trim();
  if (!name) throw badRequest("Site name is required.");
  return {
    name,
    addressLine1: trimToNull(input.addressLine1),
    addressLine2: trimToNull(input.addressLine2),
    city: trimToNull(input.city),
    county: trimToNull(input.county),
    postcode: trimToNull(input.postcode),
    country: trimToNull(input.country),
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

// --- nested: sites — bulk import ---

// Dedupe identity for a site within a customer: name + postcode, case- and space-insensitive.
// MUST match the frontend's dedupeKey in lib/siteImport.ts exactly.
export function siteDedupeKey(name: string, postcode: string | null | undefined): string {
  return `${name.trim().toLowerCase()}|${(postcode ?? "").toLowerCase().replace(/\s+/g, "")}`;
}

export interface RowNote {
  row: number; // 1-based sheet row number (from the client)
  name: string;
  reason: string;
}
export interface BulkSiteResult {
  createdSites: PublicCustomerSite[];
  skipped: RowNote[];
  failed: RowNote[];
}

// Bulk-import sites for one customer. Partial success: each row is validated with the
// SAME siteSchema as single-add (client is never trusted); invalid rows → `failed`,
// duplicates (existing or in-batch) → `skipped`, the rest are geocoded and created.
export async function bulkAddSites(
  customerId: string,
  rows: unknown[],
  fileName: string | undefined,
  actor?: AuditActor,
): Promise<BulkSiteResult> {
  const startedAt = Date.now();
  const customer = await requireCustomer(customerId);

  const existing = await customerRepo.findSitesByCustomer(customerId);
  const seen = new Set(existing.map((s) => siteDedupeKey(s.name, s.postcode)));

  const skipped: RowNote[] = [];
  const failed: RowNote[] = [];
  const staged: customerRepo.SiteData[] = [];

  rows.forEach((raw, i) => {
    // The client sends each row's original 1-based SHEET row number so `failed`/`skipped`
    // notes point at the user's file (rows are pre-filtered + batched client-side, so the
    // array index is meaningless). siteSchema strips `rowNumber`, so it is never persisted.
    const rawRow = (raw as { rowNumber?: unknown })?.rowNumber;
    const row = typeof rawRow === "number" && Number.isFinite(rawRow) ? rawRow : i + 1;
    const parsed = siteSchema.safeParse(raw);
    if (!parsed.success) {
      const rawName = (raw as { name?: unknown })?.name;
      failed.push({
        row,
        name: typeof rawName === "string" ? rawName : "",
        reason: parsed.error.issues[0]?.message ?? "Invalid row.",
      });
      return;
    }
    const input = parsed.data;
    const key = siteDedupeKey(input.name, input.postcode);
    if (seen.has(key)) {
      skipped.push({ row, name: input.name, reason: "Already exists (name + postcode)." });
      return;
    }
    seen.add(key);
    staged.push(toSiteData(input));
  });

  // Batch-geocode the staged postcodes, attach coords (best-effort; unknown → null).
  const coords = await geocodePostcodesBulk(staged.map((d) => d.postcode));
  for (const d of staged) {
    const c = d.postcode ? coords.get(canonicalPostcode(d.postcode)) : undefined;
    d.latitude = c?.latitude ?? null;
    d.longitude = c?.longitude ?? null;
  }

  const created = await customerRepo.createSitesBulk(customerId, staged);

  recordCustomerAudit({
    actor,
    action: "customer.sites.bulk_imported",
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — imported ${created.length} site(s)`,
    metadata: {
      fileName: fileName ?? null,
      created: created.length,
      skipped: skipped.length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
    },
  });

  return { createdSites: created.map(toSite), skipped, failed };
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
  // Either a free-text new item name OR a link to an existing stock line — the service
  // requires exactly one and derives the stored name from the link when present.
  name?: string;
  linkedStockEntryId?: string;
  quantity: number;
  reason?: string;
  notes?: string;
  // The warehouse the customer would LIKE the stock received at. Optional, advisory, and
  // eligibility-checked below — never the destination (see resolveStockRequestData).
  preferredWarehouseId?: string;
}

// The warehouses a customer may name as their preferred destination: EVERY active, non-deleted
// warehouse. There is deliberately no customer-history filter — the business decided a customer
// may ask for any warehouse we actually operate, and the ask is only ever a preference (a reviewer
// still sets the real destination), so scoping it bought nothing.
//
// `findOptions()` with no argument is the app's existing unrestricted active-warehouse picker
// query — the same one every other warehouse dropdown is built from. Reused rather than
// reimplemented so "active, non-deleted" has ONE definition, and so it already returns only
// id/code/name: no address, contact, notes or operational metadata can reach the portal.
export async function listSelectableWarehouses(): Promise<{ id: string; code: string; name: string }[]> {
  return warehouseRepo.findOptions();
}

// Resolve the optional preferred warehouse for a submission. A client-supplied id is NEVER
// trusted — `findActiveByIds` re-applies the SAME active + non-deleted rule the dropdown was built
// from, so a forged, unknown, inactive or soft-deleted id fails here whatever the UI offered.
// One indexed lookup on the single id, not a fetch of the whole list.
//
// Deliberately a hard 400 rather than a silent drop: silently discarding it would tell the
// customer their preference was recorded when it wasn't, and would hide a probe.
async function resolvePreferredWarehouseId(
  preferredWarehouseId: string | undefined,
): Promise<string | null> {
  const wanted = trimToNull(preferredWarehouseId);
  if (!wanted) return null;
  const [match] = await warehouseRepo.findActiveByIds([wanted]);
  if (!match) throw badRequest("That warehouse isn't available.");
  return wanted;
}

// Turn a portal/admin submission into the row to persist. The item is EITHER a
// free-text new name OR a link to an existing stock line this submission tops up. When
// linked, we load + ownership-check that line and derive the canonical name from it (so
// the link is authoritative and a spoofed/foreign id can't slip through). Scoped to
// `customerId` — never trust a client to point at another customer's stock.
async function resolveStockRequestData(
  customerId: string,
  input: StockRequestInput,
): Promise<customerRepo.StockRequestData> {
  if (!Number.isFinite(input.quantity) || input.quantity < 1) {
    throw badRequest("Quantity must be at least 1.");
  }
  const base = {
    quantity: Math.trunc(input.quantity),
    reason: trimToNull(input.reason),
    notes: trimToNull(input.notes),
    // Stored on the request and nowhere else. Nothing downstream — assignment, receiving,
    // CustomerStockEntry, reporting — reads it; it exists to pre-fill the reviewer's choice.
    preferredWarehouseId: await resolvePreferredWarehouseId(input.preferredWarehouseId),
  };

  const linkedId = trimToNull(input.linkedStockEntryId);
  if (linkedId) {
    const entry = await customerRepo.findStockEntryById(linkedId);
    if (!entry || entry.customerId !== customerId) {
      throw badRequest("The selected existing item could not be found.");
    }
    return { ...base, name: entry.itemName, linkedStockEntryId: entry.id };
  }

  const name = input.name?.trim();
  if (!name) throw badRequest("Item name is required.");
  return { ...base, name, linkedStockEntryId: null };
}

// PORTAL: a customer user submits a stock / replenishment request. Scoped to the
// authenticated customer; the requesting user is recorded. This is the ONE place a
// portal user can write into the customer module — and even then it only queues a
// request for admin review, never the stock or inventory itself.
// PORTAL. Returns the customer-facing shape like the list above — the row is brand new so the
// staff fields are all null anyway, but the portal's boundary is only meaningful if EVERY endpoint
// behind it uses it.
export async function submitStockRequest(
  customerId: string,
  requestedBy: { userId: string; name: string; email: string },
  input: StockRequestInput,
): Promise<PortalStockRequest> {
  const customer = await requireCustomer(customerId);
  const data = await resolveStockRequestData(customerId, input);
  const created = await customerRepo.createStockRequest(
    customerId,
    requestedBy.userId,
    requestedBy.name,
    data,
  );
  recordCustomerAudit({
    actor: { id: requestedBy.userId, type: "customer", email: requestedBy.email },
    action: "customer.stock_request.submitted",
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — ${data.name} ×${data.quantity}`,
  });
  return toPortalStockRequest(created);
}

// ADMIN: create a stock submission on behalf of a customer (e.g. taken over the
// phone). Mirrors the portal submission but records no portal user — the optional
// `requestedByName` captures the customer contact the admin spoke to.
export async function createStockRequestForCustomer(
  customerId: string,
  requestedByName: string | null,
  input: StockRequestInput,
  actor?: AuditActor,
): Promise<PublicStockRequest> {
  const customer = await requireCustomer(customerId);
  const data = await resolveStockRequestData(customerId, input);
  const created = await customerRepo.createStockRequest(customerId, null, requestedByName, data);
  recordCustomerAudit({
    actor,
    action: "customer.stock_request.created_by_admin",
    targetType: "customer",
    targetId: customer.id,
    targetLabel: `${customer.name} — ${data.name} ×${data.quantity}`,
  });
  return toStockRequest(created);
}

// ── Portal paged lists ────────────────────────────────────────────────────────────────────────
// Shared param/clamping shape for the portal's paged lists (same maths as every other paged list).
/** The submission date window for a portal list — resolved in the company timezone, once. */
function portalRaisedWindow(params: { raisedFrom?: string; raisedTo?: string }) {
  return resolveInstantWindow(params.raisedFrom, params.raisedTo, () => settingsService.getCompanyTimezone());
}

export interface PortalListParams {
  search?: string;
  status?: string;
  sort?: string;
  /** Stock lists only — inclusive calendar days on `receivedAt`. */
  receivedFrom?: string;
  receivedTo?: string;
  /** Submissions only — inclusive calendar days on `createdAt`. */
  raisedFrom?: string;
  raisedTo?: string;
  /** Stock lists only — narrows to one warehouse. An id, so a rename can't break a saved link. */
  warehouseId?: string;
  page?: number;
  pageSize?: number;
}
// PORTAL: the authenticated customer's own requests, PAGED (they accumulate forever).
// PORTAL-only (see getOwnStockRequests) — hence the narrower row type. The admin's equivalent is
// listStockRequests, which returns the full PublicStockRequest.
export interface PagedStockRequests {
  requests: PortalStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function getOwnStockRequests(customerId: string, params: PortalListParams = {}): Promise<PagedStockRequests> {
  // ONE filters object for both reads — the count and the page must describe the same set.
  const filters = { status: params.status, search: params.search, raisedWindow: await portalRaisedWindow(params) };
  const total = await customerRepo.countStockRequestsByCustomer(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const requests = await customerRepo.findStockRequestsByCustomer(customerId, filters, { skip, take: pageSize });
  return { requests: requests.map(toPortalStockRequest), total, page, pageSize, totalPages };
}

export interface ListStockRequestsParams {
  status?: string;
  search?: string;
  /** Inclusive calendar days on when the customer SUBMITTED (`createdAt`, an instant). */
  raisedFrom?: string;
  raisedTo?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedAdminStockRequests {
  requests: PublicStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /**
   * Per-status totals for the searched set, IGNORING the status filter — the tab's status menu and
   * its empty-state copy are built from this instead of from the full collection, which is what let
   * the customer detail payload stop carrying every submission.
   */
  statusCounts: Record<string, number>;
}

/**
 * ADMIN: a customer's stock submissions — filtered, counted and PAGED at the database.
 *
 * This is the only internal surface for reviewing submissions, and they accumulate for the life of
 * an account. It used to ride along inside the customer detail payload and be searched, filtered and
 * paged in the browser, which meant the whole history was fetched on every visit to the tab and the
 * "filters" narrowed a set that had already been transferred. The customer's OWN portal view of the
 * same data was already server-paged — the internal review screen was the weaker of the two.
 *
 * ONE filters object for the count and the page, so the paginator can never walk off the end of a
 * set the count did not describe.
 */
export async function listStockRequests(
  customerId: string,
  params: ListStockRequestsParams = {},
): Promise<PagedAdminStockRequests> {
  await requireCustomer(customerId);
  const filters = {
    status: params.status,
    search: params.search,
    // `createdAt` is a real INSTANT, so "submitted on the 3rd" is the COMPANY's 3rd.
    raisedWindow: await resolveInstantWindow(params.raisedFrom, params.raisedTo, () => settingsService.getCompanyTimezone()),
  };
  const [total, statusCounts] = await Promise.all([
    customerRepo.countStockRequestsByCustomer(customerId, filters),
    // WITHOUT the status filter, and stated here rather than stripped inside the repository: the
    // menu these counts build must say what the OTHER statuses hold, so passing the selected one
    // would make every other option read zero and vanish. An argument that the callee silently
    // ignores is a contract nobody can read at the call site.
    customerRepo.countStockRequestsByStatus(customerId, { ...filters, status: undefined }),
  ]);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const requests = await customerRepo.findStockRequestsByCustomer(customerId, filters, { skip, take: pageSize });
  return { requests: requests.map(toStockRequest), total, page, pageSize, totalPages, statusCounts };
}

// ADMIN: approve a pending request. This is a STATUS MOVE ONLY — it records the
// reviewer + an optional admin response note for the customer, and deliberately
// never creates an inventory record. Turning an approved request into real stock
// is a separate internal step (the inventory module, later).
// Fire-and-forget: tell the customer their stock request was reviewed (approved/rejected).
// One template covers both outcomes — the engine has no conditionals, so we pass the {{status}}
// word plus a matching {{decisionDetail}} line. Sent to the company's primary portal login.
// NEVER blocks or rolls back the review.
function notifyStockRequestReviewed(
  company: Customer,
  requestName: string,
  status: "approved" | "rejected",
  note: string | null,
): void {
  void (async () => {
    const primary = await findPrimaryUser(company);
    const to = primary?.email ?? company.email;
    if (!to) return;
    const decisionDetail =
      status === "approved"
        ? note
          ? `Note from our team: ${note}`
          : "Our team will be in touch about the next steps."
        : note
          ? `Reason: ${note}`
          : "Please contact us if you'd like more detail.";
    await sendTemplatedEmail("customer.stock_request.reviewed", to, {
      customerName: company.name,
      contactPerson: primary?.fullName ?? company.name,
      requestName,
      status,
      decisionDetail,
    });
  })().catch((e) =>
    console.error("stock request decision email failed:", e instanceof Error ? e.message : e),
  );
}

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
  notifyStockRequestReviewed(customer, request.name, "approved", trimToNull(note));
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
  notifyStockRequestReviewed(customer, request.name, "rejected", trimToNull(note));
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
  notifyStockRequestReviewed(customer, input.editedName.trim(), "approved", trimToNull(input.note));
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

  // Verify every target warehouse exists AND is still usable before creating assignments (no FK on
  // Mongo, so a stale/foreign id would otherwise create orphan assignments). `findById` already
  // excludes soft-deleted rows; `status` is the part a stale tab can still get wrong — the modal's
  // dropdown holds the warehouses that were active when it OPENED, so one deactivated since then is
  // still selectable in that tab. An assignment written to it strands the customer's stock in the
  // Incoming queue of a warehouse nobody is scoped to any more, with no way to receive or close it.
  const warehouses = await Promise.all([...warehouseIds].map((id) => warehouseRepo.findById(id)));
  if (warehouses.some((w) => !w)) {
    throw badRequest("One or more selected warehouses no longer exist.");
  }
  // Named, not counted: on a split the reviewer has to know WHICH row to change.
  const inactive = warehouses.filter((w) => w && w.status !== "active");
  if (inactive.length) {
    throw badRequest(
      `No longer active: ${inactive.map((w) => w!.name).join(", ")}. Choose another warehouse.`,
    );
  }

  try {
    await customerRepo.createWarehouseAssignments(
      input.assignments.map((a) => ({
        customerStockRequestId: requestId,
        warehouseId: a.warehouseId,
        quantity: a.quantity,
      })),
    );
  } catch (e) {
    // Unique index (customerStockRequestId, warehouseId): a concurrent assign already
    // created these — surface a clean 409 instead of a raw 500.
    if (customerRepo.isUniqueConflictError(e)) {
      throw conflict("This request has already been assigned to warehouses.");
    }
    throw e;
  }
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

type AssignmentWithRequest = NonNullable<Awaited<ReturnType<typeof customerRepo.findAssignmentById>>>;

// On a receive, decide which stock line the newly-received units land on:
//  1. If THIS assignment already produced an entry (an earlier partial receive), keep
//     accumulating into it — one entry per assignment.
//  2. Otherwise, if the submission was explicitly linked to an existing product (a
//     top-up), add to the matching line in THIS warehouse instead of spawning a
//     duplicate — opening a fresh line that carries the linked product's details if the
//     warehouse doesn't hold it yet.
//  3. Otherwise it's a genuinely new product → create a fresh entry.
async function resolveReceivedStockEntry(
  assignment: AssignmentWithRequest,
  assignmentId: string,
  receivedQuantity: number,
  receivedByEmail: string | null,
  tx: Prisma.TransactionClient,
) {
  const now = new Date();

  // (1) Partial receives accumulate into the assignment's own entry.
  const existingEntries = await customerRepo.findStockEntriesByAssignment(assignmentId, tx);
  if (existingEntries.length) {
    return customerRepo.addStockEntryQuantity(existingEntries[0].id, receivedQuantity, receivedByEmail, now, tx);
  }

  const customerId = assignment.stockRequest.customerId;
  const fallbackName = assignment.stockRequest.editedName ?? assignment.stockRequest.name;

  // (2) Explicit top-up of an existing product line.
  const linkedId = assignment.stockRequest.linkedStockEntryId;
  const linked = linkedId ? await customerRepo.findStockEntryById(linkedId, tx) : null;
  if (linked) {
    // When the linked line lives in the SAME warehouse this assignment delivers to, it IS the
    // canonical target — top it up directly. Never re-resolve it by name/sku (a same-named sibling
    // line, e.g. an older one with no SKU, could otherwise be picked and corrupt the wrong product).
    if (linked.warehouseId === assignment.warehouseId) {
      return customerRepo.addStockEntryQuantity(linked.id, receivedQuantity, receivedByEmail, now, tx);
    }
    // Linked line is in a DIFFERENT warehouse → find the matching line in THIS warehouse (same
    // product, identified by name + exact sku) or create a fresh one below.
    const target = await customerRepo.findStockEntryForTopUp(
      customerId,
      assignment.warehouseId,
      linked.itemName,
      linked.sku,
      tx,
    );
    if (target) {
      return customerRepo.addStockEntryQuantity(target.id, receivedQuantity, receivedByEmail, now, tx);
    }
    // Same product, warehouse that doesn't hold it yet → fresh line copying the details.
    return customerRepo.createStockEntry({
      customerId,
      warehouseId: assignment.warehouseId,
      assignmentId,
      itemName: linked.itemName,
      quantity: receivedQuantity,
      receivedBy: receivedByEmail,
      receivedAt: now,
      sku: linked.sku,
      categoryId: linked.categoryId,
      description: linked.description,
      uom: linked.uom,
      serialized: linked.serialized,
      highValue: linked.highValue,
      thresholdQty: linked.thresholdQty,
    }, tx);
  }

  // (3) Genuinely new product.
  return customerRepo.createStockEntry({
    customerId,
    warehouseId: assignment.warehouseId,
    assignmentId,
    itemName: fallbackName,
    quantity: receivedQuantity,
    receivedBy: receivedByEmail,
    receivedAt: now,
  }, tx);
}

// A request's status derived from ALL its assignments, in one place so the receive path and the
// short-close path can never disagree about when a request is finished.
//
// `closed_short` counts as DONE, not as outstanding: the whole point is that nothing more is coming.
// A request whose every assignment is terminal therefore reaches `completed` even if some arrived
// short — "completed" here means "no receiving left to do", which is exactly true. Leaving it at
// `partially_received` instead is what used to strand these requests permanently.
async function recomputeRequestStatusTx(requestId: string, tx: Prisma.TransactionClient): Promise<void> {
  const all = await customerRepo.findAssignmentsByRequest(requestId, tx);
  const isTerminal = (s: string) => s === "received" || s === "closed_short";
  const allDone = all.every((a) => isTerminal(a.status));
  // "Partially received" must mean UNITS ACTUALLY ARRIVED, not merely that a leg is finished.
  // Keying it off terminality instead let a request where one warehouse was closed short having
  // received NOTHING (and another was still pending) report "Partially received" — a status the
  // customer portal renders verbatim, telling someone stock had arrived when none had.
  // Equivalent to the old status check on the receive path: `received`/`partially_received` both
  // imply receivedQuantity > 0, so ordinary receipts behave exactly as before.
  const anyReceived = all.some((a) => a.receivedQuantity > 0);

  if (allDone) {
    await customerRepo.updateStockRequestStatus(requestId, "completed", tx);
  } else if (anyReceived) {
    await customerRepo.updateStockRequestStatus(requestId, "partially_received", tx);
  } else {
    // Leave the STATUS where it is (e.g. `assigned`): a short-close with nothing received and other
    // warehouses still outstanding has not moved the request forward at all. Still write the row,
    // though — the request document has to be touched on EVERY path through here, both so the
    // submission surfaces in the admin's last-touched ordering and so concurrent transactions on
    // sibling assignments collide on it rather than silently deriving a status each from a snapshot
    // that can't see the other. See `touchStockRequest`.
    await customerRepo.touchStockRequest(requestId, tx);
  }
}

export interface CloseAssignmentShortInput {
  reason: string;
}

// Close an assignment whose outstanding balance will never arrive — the customer shipped less than
// they declared, part was lost in transit, or they rescoped the order. Without this, a short
// delivery sat in the warehouse's Incoming queue forever (the queue reads exactly the open statuses)
// and its parent request could never complete.
//
// Deliberately does NOT touch stock: whatever arrived was already posted to the customer's stock
// entry on receipt, and the shortfall was never our stock to write off.
export async function closeAssignmentShort(
  assignmentId: string,
  input: CloseAssignmentShortInput,
  actor?: AuditActor,
): Promise<PublicWarehouseAssignment> {
  const assignment = await customerRepo.findAssignmentById(assignmentId);
  if (!assignment) throw notFound("Assignment not found.");
  assertWarehouseAccess(actor, assignment.warehouseId);

  // Read-time check for a clear message; the repository's status guard is what actually makes this
  // safe against a concurrent receive.
  if (assignment.status === "received") throw badRequest("This assignment is already fully received.");
  if (assignment.status === "closed_short") throw badRequest("This assignment is already closed.");

  const reason = trimToNull(input.reason);
  if (!reason) throw badRequest("A reason is required to close this delivery short.");

  // RETRYING, because `recomputeRequestStatusTx` makes every leg of a request write the same parent
  // document: closing two warehouses of one submission at the same moment is a write-conflict by
  // design. The loser replays from the rolled-back state, this time able to see that its sibling is
  // terminal, and completes the request instead of leaving it one leg short forever. Replay is safe
  // — the status guard below re-arms on rollback and the audit line is written after the commit.
  const { updated } = await withTransactionRetry(async (tx) => {
    const updated = await customerRepo.closeAssignmentShort(assignmentId, reason, actor?.email ?? null, tx);
    // Lost the race with a receive that landed first — roll back rather than close over the top of it.
    if (!updated) {
      throw conflict("This assignment was just updated by someone else. Please refresh and try again.");
    }
    await recomputeRequestStatusTx(assignment.customerStockRequestId, tx);
    return { updated };
  });

  // From `updated` (the post-write row), NOT the pre-transaction read. The repository guard pins the
  // STATUS, which correctly lets a close proceed after a concurrent partial receipt — that receipt
  // leaves the assignment open, and the remaining balance still isn't coming. But it moves
  // receivedQuantity, so the figure read before the transaction is stale by exactly that amount and
  // the audit line would understate what arrived. This label is the whole point of the feature; it
  // has to be the number that is actually true at the moment of closing.
  const outstanding = updated.quantity - updated.receivedQuantity;
  recordCustomerAudit({
    actor,
    action: "customer.stock_request.closed_short",
    targetType: "customer_stock_assignment",
    targetId: assignmentId,
    // The shortfall and the reason are the two things anyone asking "where did the rest go?" needs.
    targetLabel: `${assignment.stockRequest.editedName ?? assignment.stockRequest.name} — ${outstanding} of ${updated.quantity} not received at ${assignment.warehouse.name}: ${reason}`,
  });

  return toWarehouseAssignment({ ...updated, warehouse: assignment.warehouse });
}

export async function receiveStockAssignment(
  assignmentId: string,
  input: ReceiveStockInput,
  actor?: AuditActor,
): Promise<{ assignment: PublicWarehouseAssignment; stockEntryId: string; stockEntryStatus: string }> {
  const assignment = await customerRepo.findAssignmentById(assignmentId);
  if (!assignment) throw notFound("Assignment not found.");
  // Scope to the warehouse this assignment physically lives at.
  assertWarehouseAccess(actor, assignment.warehouseId);
  if (assignment.status === "received") throw badRequest("This assignment is already fully received.");
  // Reopening a short-closed delivery by receiving into it would contradict the closure that was
  // recorded (with a reason) and silently un-complete the parent request. If stock really does turn
  // up later it belongs on a new assignment, not on the one someone signed off as finished.
  if (assignment.status === "closed_short") {
    throw badRequest("This assignment was closed short. Raise a new assignment if more stock arrives.");
  }

  const remaining = assignment.quantity - assignment.receivedQuantity;
  if (input.receivedQuantity > remaining) {
    throw badRequest(`Only ${remaining} remaining to receive. You entered ${input.receivedQuantity}.`);
  }

  // All-or-nothing: the assignment counter bump, the parent request status, and the stock-entry
  // write must commit together. A crash between them would otherwise mark an assignment received
  // with no matching stock line (consigned units lost, and the status guard blocks a re-receive).
  // Mirrors the transactional posting in goods-in/goods-out. Retried for the same reason as the
  // short-close above: two warehouses of one submission receiving at once collide on the parent
  // request, and the loser has to replay to see the sibling before deciding the request's status.
  const { updated, stockEntry } = await withTransactionRetry(async (tx) => {
    const updated = await customerRepo.updateAssignmentReceived(
      assignmentId,
      input.receivedQuantity,
      assignment.receivedQuantity,
      assignment.quantity,
      actor?.email ?? null,
      trimToNull(input.notes),
      tx,
    );
    // Lost the optimistic race — another receive updated this assignment first. Throwing rolls back
    // the whole transaction, so we never double-count or spawn a duplicate entry.
    if (!updated) {
      throw conflict("This assignment was just updated by someone else. Please refresh and try again.");
    }

    await recomputeRequestStatusTx(assignment.customerStockRequestId, tx);

    const stockEntry = await resolveReceivedStockEntry(assignment, assignmentId, input.receivedQuantity, actor?.email ?? null, tx);
    return { updated, stockEntry };
  });

  recordCustomerAudit({
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
    // "draft" = the entry still needs its product details (category + barcode) before it can go
    // active; "active" = a top-up onto an entry the warehouse manager already completed. The caller
    // uses this to decide whether opening the entry form is useful work or a detour — see the
    // Incoming list's receive handler.
    stockEntryStatus: stockEntry.status,
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

export async function getPendingStockForWarehouse(
  warehouseId: string,
  actor?: AuditActor,
): Promise<PendingStockItem[]> {
  // The route param IS the canonical warehouse id (the repo filters on it directly).
  assertWarehouseAccess(actor, warehouseId);
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
export interface PagedCustomerProjects {
  projects: PublicCustomerProject[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function getOwnProjects(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerProjects> {
  const filters = { search: params.search, status: params.status };
  const total = await customerRepo.countProjectsByCustomer(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const rows = await customerRepo.findProjectsByCustomerPaged(customerId, filters, skip, pageSize, params.sort);
  return { projects: rows.map(toProject), total, page, pageSize, totalPages };
}

// PORTAL: the customer's own sites (read-only), PAGED — sites can be bulk-imported in the
// thousands, so this must never ride on findByIdWithChildren's load-everything include.
export interface PagedCustomerSites {
  sites: PublicCustomerSite[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function getOwnSites(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerSites> {
  const filters = { search: params.search, status: params.status };
  const total = await customerRepo.countSitesByCustomer(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const rows = await customerRepo.findSitesByCustomerPaged(customerId, filters, skip, pageSize, params.sort);
  return { sites: rows.map(toSite), total, page, pageSize, totalPages };
}

// ADMIN: paged sites / projects for the customer detail tabs (the detail payload itself no longer
// carries the child sets). Same shapes as the portal lists; requireCustomer 404s a bad id.
export async function listCustomerSites(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerSites> {
  await requireCustomer(customerId);
  return getOwnSites(customerId, params);
}
export async function listCustomerProjects(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerProjects> {
  await requireCustomer(customerId);
  return getOwnProjects(customerId, params);
}
// ADMIN: the lean dedupe-key source for the site-import preview — name + postcode ONLY, so the
// modal never downloads full site rows just to mark duplicates (the server re-checks on import).
export async function listCustomerSiteKeys(customerId: string): Promise<{ name: string; postcode: string | null }[]> {
  await requireCustomer(customerId);
  return customerRepo.findSitesByCustomer(customerId);
}

// PORTAL dashboard summary: company header + live counts + per-warehouse holdings + a few recent
// requests. Everything here is derived from real data — the client renders no placeholders, so any
// field added must actually be computable rather than promised.
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
    /** Submissions still needing something to happen — pending | approved | assigned | partially_received. */
    openRequests: number;
    /** Stock entry ROWS (one per item × warehouse). The link target, My Stock, lists exactly these. */
    stockEntries: number;
    /** UNITS across those rows. The headline figure: a customer asks how much stock we hold, not how
     *  many database rows hold it — 26 entries can be 26 units or 2,600. */
    stockUnits: number;
    /** Units declared on a submission that were short-closed and are never arriving. 0 for almost
     *  every customer, which is why the UI only surfaces it when it isn't. */
    notReceivedUnits: number;
    /** Jobs still happening — scheduled or in progress. Owned by the job module (jobService
     *  decides which statuses those are) so this number and the Jobs page can't disagree. */
    activeJobs: number;
  };
  /** Units per warehouse, biggest holding first. Empty when the customer has no stock with us.
   *  Carries the id so the dashboard row can link straight to My Stock filtered to that warehouse. */
  stockByWarehouse: {
    warehouseId: string;
    warehouseName: string;
    warehouseCode: string;
    units: number;
    entries: number;
  }[];
  recentRequests: PortalStockRequest[];
}

// Turn the grouped-by-warehouseId rows into named, ordered holdings. Pure, and exported for its test.
//
// Two behaviours that matter and are easy to get wrong:
//  - A warehouse that no longer resolves is DROPPED, not rendered with a blank name. Mongo has no
//    foreign keys, so a deleted warehouse leaves entries pointing at nothing; a nameless row with a
//    unit count on the customer's dashboard is worse than the row being absent.
//  - Biggest holding FIRST. The grouping returns whatever order the database chose, and the question
//    this panel answers is "where is most of my stock".
export function shapeStockByWarehouse(
  grouped: readonly { warehouseId: string; units: number; entries: number }[],
  warehouses: readonly ({ id: string; name: string; code: string } | null)[],
): CustomerOverview["stockByWarehouse"] {
  const byId = new Map(
    warehouses.filter((w): w is { id: string; name: string; code: string } => w !== null).map((w) => [w.id, w]),
  );
  return grouped
    .flatMap((g) => {
      const wh = byId.get(g.warehouseId);
      return wh
        ? [{ warehouseId: wh.id, warehouseName: wh.name, warehouseCode: wh.code, units: g.units, entries: g.entries }]
        : [];
    })
    .sort((a, b) => b.units - a.units);
}

export async function getOwnOverview(customerId: string): Promise<CustomerOverview> {
  // Lean header read — the overview needs only 5 scalar fields; the counts + recent list come from
  // the dedicated queries below, so there's no reason to hydrate the users / pending-request children.
  const c = await customerRepo.findById(customerId);
  if (!c) throw notFound("Customer not found.");
  // Counts come from COUNT/SUM/GROUP BY queries (never from loading the child sets — sites/projects
  // can be bulk-imported in the thousands). Recent activity needs only the newest 5 requests.
  const [
    recentRequests,
    openRequests,
    stockEntries,
    stockUnits,
    unitsByWarehouse,
    notReceivedUnits,
    activeProjects,
    totalProjects,
    totalSites,
    activeJobs,
  ] = await Promise.all([
    customerRepo.findStockRequestsByCustomer(customerId, {}, { skip: 0, take: 5 }),
    // OPEN, not just `pending`. "Pending" alone read as 0 for a customer with stock sitting approved
    // and assigned but not yet received — work very much in flight, reported as nothing outstanding.
    customerRepo.countOpenStockRequestsByCustomer(customerId),
    // Count ALL statuses (draft + active). This card links straight to "My Stock", which lists every
    // entry regardless of status, so the number must match what the customer sees when they click through.
    customerRepo.countStockEntriesByCustomer(customerId),
    customerRepo.sumStockUnitsByCustomer(customerId),
    customerRepo.groupStockUnitsByWarehouse(customerId),
    customerRepo.sumNotReceivedUnitsByCustomer(customerId),
    customerRepo.countProjectsByCustomer(customerId, { status: "active" }),
    customerRepo.countProjectsByCustomer(customerId),
    customerRepo.countSitesByCustomer(customerId),
    // Through the job SERVICE, not its repository: which statuses count as "still happening" (and
    // which are hidden from the customer entirely) is the job module's rule, and the Jobs page reads
    // it from the same place. Counted here rather than derived from a list — a customer's job history
    // grows without bound, so this must stay a COUNT, and it rides the existing Promise.all for free.
    jobService.countActiveJobsForCustomer(customerId),
  ]);

  // Only the warehouses actually holding this customer's stock are fetched — the grouping already
  // narrowed it, so this is at most a handful of reads and usually one.
  const warehouses = await Promise.all(
    unitsByWarehouse.map((w) => warehouseRepo.findById(w.warehouseId)),
  );
  const stockByWarehouse = shapeStockByWarehouse(unitsByWarehouse, warehouses);

  return {
    customer: {
      id: c.id,
      customerCode: c.customerCode,
      name: c.name,
      logoUrl: c.logoUrl,
      status: c.status,
    },
    counts: {
      activeProjects,
      totalProjects,
      totalSites,
      openRequests,
      stockEntries,
      stockUnits,
      notReceivedUnits,
      activeJobs,
    },
    stockByWarehouse,
    // PORTAL mapper — this is the customer's own dashboard. Using the admin `toStockRequest` here sent
    // them `reviewedBy` plus every assignment's `receivedBy`/`closedBy`: warehouse staff emails, on a
    // payload nothing on the page renders.
    recentRequests: recentRequests.map(toPortalStockRequest),
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
  assignmentId: string | null;
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

// PORTAL view of one of the customer's own consignment lines. Same reasoning as
// PortalStockRequest: the portal is served the admin row unless something narrows it, so
// `receivedBy` — the warehouse staff email that booked the stock in — was reaching the customer in
// the My Stock payload. The list renders a received DATE, never the person, so nothing was visible;
// it was in the response all the same.
//
// Also DROPPED because they are dead columns, not because they're sensitive: `serialized`,
// `serialNumber`, `highValue`, `thresholdQty` and `attributes` are never collected by any form in
// the app (see the NOTE on CustomerStockEntry in schema.prisma), so they are permanently
// false/null. Sending them invites a UI that renders empty rows and looks broken.
export interface PortalStockEntry {
  id: string;
  warehouseName: string;
  warehouseCode: string;
  itemName: string;
  sku: string | null;
  categoryName: string | null;
  description: string | null;
  uom: string | null;
  quantity: number;
  barcode: string | null;
  status: string;
  receivedAt: string | null;
  createdAt: string;
}

function toPortalStockEntry(e: StockEntryRow): PortalStockEntry {
  return {
    id: e.id,
    warehouseName: e.warehouse.name,
    warehouseCode: e.warehouse.code,
    itemName: e.itemName,
    sku: e.sku ?? null,
    categoryName: e.category?.name ?? null,
    description: e.description ?? null,
    uom: e.uom ?? null,
    quantity: e.quantity,
    // The number, not `barcodeDataUri`: the customer may want to quote it, and shipping the rendered
    // PNG for every row of every page is real payload for an image no portal screen prints.
    barcode: e.barcode ?? null,
    status: e.status,
    receivedAt: e.receivedAt ? e.receivedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
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

export async function getStockEntry(
  entryId: string,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");
  assertWarehouseAccess(actor, entry.warehouseId);
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
  assertWarehouseAccess(actor, entry.warehouseId);

  // Activation = the draft → active transition. A trackable stock entry needs more than just a name
  // before it goes live: enforce a category here (server-side trust boundary, mirrored on the form).
  const activating = entry.status === "draft";
  if (activating && !trimToNull(input.categoryId)) {
    throw badRequest("Select a category before activating this stock entry.");
  }
  // A draft can't go active without a barcode — the warehouse manager generates + prints + attaches
  // the label before activating (front-end mirrors this; this is the trust boundary).
  if (activating && !entry.barcode) {
    throw badRequest("Generate the barcode before activating this stock entry.");
  }

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

  recordCustomerAudit({
    actor,
    action: "customer.stock_entry.updated",
    targetType: "customer_stock_entry",
    targetId: entryId,
    targetLabel: `${updated.itemName} at ${updated.warehouse.name}`,
  });

  // NOTE: the barcode is NOT generated here. The warehouse manager generates it explicitly (from the
  // warehouse Inventory → Customer pool view) so they can print + attach the label to the physical
  // stock before activating — see generateStockEntryBarcode.
  return toStockEntry(updated);
}

// Render a Code128 PNG (base64 data URI) of the given value. The human-readable text is baked in by
// bwip's includetext, so the printed label needs nothing but the image.
async function renderBarcodePng(text: string): Promise<string> {
  const bwipjs = await import("bwip-js");
  const pngBuffer = await bwipjs.default.toBuffer({
    bcid: "code128",
    text,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
  return `data:image/png;base64,${pngBuffer.toString("base64")}`;
}

export async function generateStockEntryBarcode(
  entryId: string,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");
  assertWarehouseAccess(actor, entry.warehouseId);

  const recordGenerated = (barcodeValue: string) =>
    recordCustomerAudit({
      actor,
      action: "customer.stock_entry.barcode_generated",
      targetType: "customer_stock_entry",
      targetId: entryId,
      targetLabel: `${entry.itemName} → ${barcodeValue}`,
    });

  // A value already exists → NEVER allocate another one. That label may already be printed and stuck
  // to the physical stock, so re-issuing would orphan it and leave the sticker pointing at nothing.
  // Nothing to do if the image is there (a double-submit / stale tab is a no-op); if only the image
  // is missing, re-render THAT value. Mirrors irmService.generateBarcode, which re-renders the
  // item's own permanent code rather than minting a new one.
  if (entry.barcode) {
    if (entry.barcodeDataUri) return toStockEntry(entry);
    const updated = await customerRepo.updateStockEntryBarcode(entryId, entry.barcode, await renderBarcodePng(entry.barcode));
    recordGenerated(entry.barcode);
    return toStockEntry(updated);
  }

  const prefix = await getStockCodePrefix();

  // Allocate → render → write, retrying past a unique-index collision (P2002). A collision only
  // happens if the counter has drifted behind the data (e.g. it was restored/recreated), so
  // fast-forward past the highest issued value and try again. Mirrors irmRepo.createWithCode.
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await customerRepo.nextStockEntryBarcodeSeq();
    const barcodeValue = `${prefix}-${String(seq).padStart(5, "0")}`;
    const dataUri = await renderBarcodePng(barcodeValue);

    try {
      const updated = await customerRepo.updateStockEntryBarcode(entryId, barcodeValue, dataUri);
      recordGenerated(barcodeValue);
      return toStockEntry(updated);
    } catch (e) {
      if (!customerRepo.isStockEntryBarcodeConflict(e)) throw e;
      await customerRepo.fastForwardStockEntryBarcodeCounter();
    }
  }
  throw new Error("Could not allocate a unique stock entry barcode.");
}

// Anything that would be left pointing at a missing row. This entry is HARD-deleted — the model has
// no archive state, deliberately — and MongoDB enforces no foreign keys, so nothing but this list
// stands between a delete and a dangling reference. Mirrors the checker registry IRM already uses.
//
// Same class of bug as deleting a job that still had stock out: the record goes, the stock and the
// rows that describe it stay, and nothing joins them up again.
type StockEntryDependency = { count: (entryId: string) => Promise<number>; reason: string };
const STOCK_ENTRY_DELETE_CHECKERS: StockEntryDependency[] = [
  { reason: "units are still out with an engineer", count: (id) => customerRepo.countEngineerHoldingsByStockEntry(id) },
  { reason: "it is planned on a job's kit list", count: (id) => customerRepo.countKitLinesByStockEntry(id) },
  { reason: "it has goods movements recorded against it", count: (id) => customerRepo.countMovementLinesByStockEntry(id) },
  { reason: "units of it are in the damaged pool", count: (id) => customerRepo.countDamagedByStockEntry(id) },
];

export async function deleteStockEntry(
  entryId: string,
  actor?: AuditActor,
): Promise<void> {
  const entry = await customerRepo.findStockEntryById(entryId);
  if (!entry) throw notFound("Stock entry not found.");
  assertWarehouseAccess(actor, entry.warehouseId);

  // Stock still on the shelf goes first: deleting it would remove the units with no ledger entry
  // anywhere, which is the one loss that leaves no trace at all.
  if (entry.quantity > 0) {
    throw conflict(
      `"${entry.itemName}" still has ${entry.quantity} unit${entry.quantity === 1 ? "" : "s"} in stock. ` +
        `Move or dispatch the stock before deleting the entry.`,
    );
  }
  for (const dep of STOCK_ENTRY_DELETE_CHECKERS) {
    if ((await dep.count(entryId)) > 0) {
      throw conflict(`"${entry.itemName}" can't be deleted — ${dep.reason}.`);
    }
  }

  await customerRepo.deleteStockEntry(entryId);

  recordCustomerAudit({
    actor,
    action: "customer.stock_entry.deleted",
    targetType: "customer_stock_entry",
    targetId: entryId,
    targetLabel: `${entry.itemName} (${entry.customer.name})`,
  });
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
  thresholdQty?: number;
  attributes?: Record<string, string>;
}

export async function createDirectStockEntry(
  customerId: string,
  input: DirectStockEntryInput,
  actor?: AuditActor,
): Promise<PublicStockEntry> {
  await requireCustomer(customerId);

  // A direct add creates ACTIVE stock — hold the same invariant as activation: a category is
  // required (so every active customer-stock entry is categorised regardless of the path in).
  if (!trimToNull(input.categoryId)) throw badRequest("Select a category for this stock entry.");

  // Guard against a well-formed-but-nonexistent warehouseId creating an orphan entry
  // (MongoDB has no FK enforcement, so this must be checked explicitly).
  const warehouse = await warehouseRepo.findById(input.warehouseId);
  if (!warehouse) throw badRequest("Selected warehouse no longer exists.");
  assertWarehouseAccess(actor, warehouse.id);

  // Duplicate guard: the receive flow tops up an existing same-warehouse/same-sku line instead of
  // spawning a duplicate — Direct Add must be consistent. Same name + warehouse + exact sku already
  // present ⇒ block (edit that entry to add stock). A different warehouse or sku is legitimately
  // distinct stock and is allowed through. Trust boundary: enforced here, not just on the form.
  const duplicate = await customerRepo.findDuplicateStockEntry(
    customerId,
    input.warehouseId,
    input.itemName,
    input.sku || null,
  );
  if (duplicate) {
    const ref = duplicate.code ? ` (${duplicate.code})` : "";
    throw badRequest(`"${input.itemName.trim()}" already exists in ${warehouse.name}${ref}. Edit that entry to add more stock instead of creating a duplicate.`);
  }

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

  recordCustomerAudit({
    actor,
    action: "customer.stock_entry.created",
    targetType: "customer_stock_entry",
    targetId: entry.id,
    targetLabel: `${input.itemName} (${input.quantity})`,
    metadata: { itemName: input.itemName, quantity: input.quantity, warehouseId: input.warehouseId, direct: true },
  });

  return toStockEntry(entry as StockEntryRow);
}

// ── Customer stock transfer (warehouse → warehouse consignment move) ──────────────────────────

export interface CustomerStockTransferResult {
  source: PublicStockEntry;
  destination: PublicStockEntry;
}

export async function transferCustomerStock(
  entryId: string,
  input: { toWarehouseId: string; quantity: number; notes?: string },
  actor?: AuditActor,
): Promise<CustomerStockTransferResult> {
  // Load source entry to validate it.
  const source = await customerRepo.findStockEntryById(entryId);
  if (!source || source.status !== "active") throw notFound("Customer stock entry not found or inactive.");

  // Guard: destination warehouse must be active.
  const toWarehouse = await warehouseRepo.findById(input.toWarehouseId);
  if (!toWarehouse || toWarehouse.status !== "active") throw badRequest("Destination warehouse not found or inactive.");
  if (toWarehouse.id === source.warehouseId) throw badRequest("Destination warehouse must differ from the source warehouse.");

  // Guard quantity.
  if (input.quantity > source.quantity) throw conflict(`Only ${source.quantity} available — transfer quantity exceeds source.`);

  const { source: updatedSource, destination: updatedDest } = await customerRepo.transferCustomerStockTx(
    entryId,
    input.toWarehouseId,
    input.quantity,
    actor?.email ?? null,
  );

  if (!updatedSource || !updatedDest) throw conflict("Transfer failed — stock changed concurrently. Refresh and try again.");

  recordCustomerAudit({
    actor,
    action: "customer_stock.transferred",
    targetType: "customer_stock_entry",
    targetId: entryId,
    targetLabel: `${source.itemName} (${input.quantity})`,
    metadata: {
      fromWarehouseId: source.warehouseId,
      toWarehouseId: input.toWarehouseId,
      quantity: input.quantity,
      notes: input.notes ?? null,
    },
  });

  return {
    source: toStockEntry(updatedSource as StockEntryRow),
    destination: toStockEntry(updatedDest as StockEntryRow),
  };
}

/** One pickable stock entry: what the job form needs to group by item and cap by quantity. */
export interface PublicStockOption {
  id: string;
  itemName: string;
  sku: string | null;
  quantity: number;
  warehouseId: string;
  warehouseName: string;
}

/**
 * A customer's stock as PICKER OPTIONS — complete, and lean enough to be so.
 *
 * The job form used to build this from `listCustomerStockEntries`, which was unpaged. Paging that
 * read for the LIST view silently capped the picker at 100 entries: options past it were unpickable,
 * and — worse — the per-warehouse quantity sums the form caps against were computed from a partial
 * set, so an edit could accept more than the customer actually has. See the repository for why this
 * one stays complete.
 */
export async function listCustomerStockOptions(customerId: string): Promise<PublicStockOption[]> {
  await requireCustomer(customerId);
  return customerRepo.findStockOptionsByCustomer(customerId);
}

export interface ListStockEntriesParams {
  status?: string;
  search?: string;
  warehouseId?: string;
  /** Inclusive calendar days on when we physically RECEIVED it (`receivedAt`, an instant). */
  receivedFrom?: string;
  receivedTo?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedAdminStockEntries {
  entries: PublicStockEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * ADMIN: a customer's consignment stock — filtered, counted and PAGED at the database.
 *
 * The tab used to fetch every entry for the customer and then search and page it in the browser. A
 * consignment history grows for the life of the account, so that transferred the whole set on every
 * visit and the controls narrowed something already paid for. Same treatment as the portal's own
 * paged view of the same rows, and the same ONE-filters-object rule so count and page agree.
 */
export async function listCustomerStockEntries(
  customerId: string,
  params: ListStockEntriesParams = {},
): Promise<PagedAdminStockEntries> {
  const filters = {
    status: params.status,
    search: params.search,
    warehouseId: params.warehouseId,
    receivedWindow: await resolveInstantWindow(params.receivedFrom, params.receivedTo, () => settingsService.getCompanyTimezone()),
  };
  const total = await customerRepo.countStockEntriesByCustomer(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const rows = await customerRepo.findStockEntriesByCustomer(customerId, filters, { skip, take: pageSize });
  return { entries: rows.map((e) => toStockEntry(e as StockEntryRow)), total, page, pageSize, totalPages };
}

// PORTAL: the customer's own stock entries, PAGED (consignment history grows forever). The
// unpaged variant above stays for the admin detail tab, which loads a single customer's set.
export interface PagedStockEntries {
  entries: PortalStockEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function listCustomerStockEntriesPaged(customerId: string, params: PortalListParams = {}): Promise<PagedStockEntries> {
  // ONE filters object shared by the count and the page read, so the two can never drift apart —
  // counting a different set than you page through gives a paginator that runs off the end.
  const filters = {
    status: params.status,
    search: params.search,
    warehouseId: params.warehouseId,
    receivedWindow: await resolveInstantWindow(params.receivedFrom, params.receivedTo, () => settingsService.getCompanyTimezone()),
  };
  const total = await customerRepo.countStockEntriesByCustomer(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const rows = await customerRepo.findStockEntriesByCustomer(customerId, filters, { skip, take: pageSize });
  return { entries: rows.map((e) => toPortalStockEntry(e as StockEntryRow)), total, page, pageSize, totalPages };
}

// Cap on an export. High enough that no real customer hits it, low enough that a runaway account
// can't ask us to render an unbounded document into memory. Mirrors AUDIT_EXPORT_MAX.
export const PORTAL_EXPORT_MAX = EXPORT_MAX;

// PORTAL: the customer's own stock, as a CSV of the FILTERED set.
//
// Filters are honoured, paging is NOT: the export is "everything matching what I'm looking at", not
// "the twenty rows on screen" — the same contract as the audit and inventory exports. NO price or
// cost anywhere: the portal has never carried them and a spreadsheet is exactly the place a leak
// would go unnoticed.
export async function exportOwnStockCsv(
  customerId: string,
  params: PortalListParams = {},
): Promise<{ csv: string; capped: boolean }> {
  const rows = await customerRepo.findStockEntriesByCustomer(
    customerId,
    { status: params.status, search: params.search, warehouseId: params.warehouseId },
    { skip: 0, take: PORTAL_EXPORT_MAX },
  );
  const entries = rows.map((e) => toPortalStockEntry(e as StockEntryRow));
  const regional = await getRegionalSettings();
  const csv = toCsv(
    ["Item", "Warehouse", "Warehouse code", "SKU", "Quantity", "Unit", "Category", "Barcode", "Status", "Received"],
    entries.map((e) => [
      e.itemName,
      e.warehouseName,
      e.warehouseCode,
      e.sku,
      e.quantity,
      e.uom,
      e.categoryName,
      e.barcode,
      e.status,
      // Date only, no time: the received timestamp's time-of-day is warehouse admin, and a bare date
      // is what a spreadsheet can sort and filter without the reader parsing it first. Rendered in the
      // COMPANY timezone — slicing the ISO string gave the UTC day, so anything received after 23:00
      // during BST was reported to the customer as the day AFTER they actually received it.
      formatDate(e.receivedAt, regional.dateFormat, regional.timezone) || null,
    ]),
  );
  return { csv, capped: entries.length >= PORTAL_EXPORT_MAX };
}

/**
 * ADMIN: one customer's stock as a CSV — the Inventory tab on the customer detail page.
 *
 * Deliberately the SAME builder the customer's own export uses, not a wider admin variant. The two
 * files land side by side in a reconciliation call ("your portal says 648, my sheet says 729"), and
 * the whole value of that comparison is that both sides are looking at identical columns. A wider
 * admin version would make every difference a question about the report rather than the stock.
 *
 * `requireCustomer` first so a bad id 404s rather than quietly exporting an empty file — the same
 * guard listCustomerStockEntries applies.
 */
export async function exportCustomerStockCsv(
  customerId: string,
  params: PortalListParams = {},
): Promise<{ csv: string; capped: boolean }> {
  await requireCustomer(customerId);
  return exportOwnStockCsv(customerId, params);
}

// PORTAL: the customer's submissions, as a CSV of the FILTERED set. One row PER WAREHOUSE LEG for a
// split submission (plus a single row when it was never assigned), because the per-leg received and
// short figures are the whole reason to export this — flattening them into one row would drop the
// detail the customer is reconciling against.
export async function exportOwnStockRequestsCsv(
  customerId: string,
  params: PortalListParams = {},
): Promise<{ csv: string; capped: boolean }> {
  const rows = await customerRepo.findStockRequestsByCustomer(
    customerId,
    // The SAME filters as the list, date window included — an export that quietly held more rows
    // than the screen it was taken from would give no sign of it.
    { status: params.status, search: params.search, raisedWindow: await portalRaisedWindow(params) },
    { skip: 0, take: PORTAL_EXPORT_MAX },
  );
  const requests = rows.map(toPortalStockRequest);
  const regional = await getRegionalSettings();
  const body: (string | number | null)[][] = [];
  for (const r of requests) {
    const base = [
      r.editedName ?? r.name,
      // Only when it differs — repeating the same name in both columns is noise.
      r.editedName && r.editedName !== r.name ? r.name : null,
      r.quantity,
      r.status,
      // Company timezone, not the UTC slice — same off-by-one-day trap as the stock-entry export.
      formatDate(r.createdAt, regional.dateFormat, regional.timezone) || null,
      // Sits immediately before the leg's actual `Warehouse` column so the two read as a pair:
      // what was asked for, then where it went. Without it the export contradicts the detail modal,
      // which shows the preference — and the export is the copy people reconcile against offline.
      r.preferredWarehouseName,
    ];
    if (r.warehouseAssignments.length === 0) {
      body.push([...base, null, null, null, null]);
      continue;
    }
    for (const leg of r.warehouseAssignments) {
      const notReceived = leg.status === "closed_short" ? Math.max(0, leg.quantity - leg.receivedQuantity) : 0;
      body.push([
        ...base,
        leg.warehouseName,
        leg.quantity,
        leg.receivedQuantity,
        // Blank rather than 0 for a leg with nothing missing — a column of zeros reads as "checked and
        // fine" on every row, which buries the ones that aren't.
        notReceived > 0 ? notReceived : null,
      ]);
    }
  }
  const csv = toCsv(
    ["Item", "Submitted as", "Quantity", "Status", "Submitted", "Preferred warehouse", "Warehouse", "Assigned", "Received", "Not received"],
    body,
  );
  return { csv, capped: requests.length >= PORTAL_EXPORT_MAX };
}

// PORTAL: the warehouses holding this customer's stock — the option list for My Stock's warehouse
// filter. Its own endpoint rather than a field on the paged list, because the options must NOT narrow
// as the customer filters: derived from the current page you would lose every warehouse whose stock
// isn't on screen, and picking one would then remove the option you just used.
export async function listOwnStockWarehouses(
  customerId: string,
): Promise<{ id: string; name: string; code: string }[]> {
  return customerRepo.findStockWarehousesByCustomer(customerId);
}

export async function listWarehouseStockEntries(
  warehouseId: string,
  status?: string,
  actor?: AuditActor,
): Promise<PublicStockEntry[]> {
  // The route param IS the canonical warehouse id (the repo filters on it directly).
  assertWarehouseAccess(actor, warehouseId);
  const entries = await customerRepo.findStockEntriesByWarehouse(warehouseId, status);
  return entries.map((e) => toStockEntry(e as StockEntryRow));
}
