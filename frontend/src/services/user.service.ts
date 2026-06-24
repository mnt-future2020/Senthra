import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { User, UserStatus } from "@/types/user";

// Typed wrappers around the backend /users endpoints.

export interface UserListParams {
  search?: string;
  status?: string;
  roleId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedUsers {
  users: User[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Optional profile fields common to create + update. Dates are "YYYY-MM-DD"
// strings; an empty string clears the field on update.
export interface ProfileFieldsPayload {
  phone?: string;
  status?: UserStatus;
  notes?: string;
  profileImage?: string; // data URI
  jobTitle?: string;
  department?: string;
  dateOfJoining?: string;
  gender?: string;
  dateOfBirth?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
}

export interface CreateUserPayload extends ProfileFieldsPayload {
  firstName: string;
  lastName: string;
  email: string;
  // Required for new staff — matches the backend createUserSchema (narrows the
  // optional shared fields so the submit can't pass undefined for these).
  phone: string;
  roleId: string;
  jobTitle: string;
  department: string;
  dateOfJoining: string;
  // Required (≥1) when the chosen role is warehouse-scoped; omitted otherwise.
  warehouseIds?: string[];
}

export interface UpdateUserPayload extends ProfileFieldsPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  roleId?: string | null;
  removeProfileImage?: boolean;
  // Synced (add/remove/keep) when the effective role is warehouse-scoped.
  warehouseIds?: string[];
}

export interface CreateUserResult {
  user: User;
  temporaryPassword: string;
}

function qs(params: UserListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.roleId) sp.set("roleId", params.roleId);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Stale-while-revalidate cache (module-level, survives route navigation), keyed by
// the query, so returning to the list — e.g. right after creating a user — renders
// the previous page instantly instead of flashing a skeleton while it refetches.
const usersListCache = new Map<string, PagedUsers>();
registerClientCache(() => usersListCache.clear());
const listCacheKey = (p: UserListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.roleId ?? ""}|${p.sort ?? ""}`;

export const getCachedUsers = (params: UserListParams = {}): PagedUsers | undefined =>
  usersListCache.get(listCacheKey(params));

export function listUsers(params: UserListParams = {}): Promise<PagedUsers> {
  return api<PagedUsers>(`/users${qs(params)}`).then((r) => {
    usersListCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getUser(id: string): Promise<User> {
  return api<{ user: User }>(`/users/${id}`).then((r) => r.user);
}

// Avatar uploads (Cloudinary) can take longer than a normal call.
export function createUser(payload: CreateUserPayload): Promise<CreateUserResult> {
  return api<CreateUserResult>("/users", { method: "POST", body: payload, timeout: 60_000 });
}

export function updateUser(id: string, payload: UpdateUserPayload): Promise<User> {
  return api<{ user: User }>(`/users/${id}`, {
    method: "PUT",
    body: payload,
    timeout: 60_000,
  }).then((r) => r.user);
}

export function setUserStatus(id: string, status: UserStatus): Promise<User> {
  return api<{ user: User }>(`/users/${id}/status`, {
    method: "PATCH",
    body: { status },
  }).then((r) => r.user);
}

export function resendInvite(id: string): Promise<{ temporaryPassword: string }> {
  return api<{ temporaryPassword: string }>(`/users/${id}/resend-invite`, {
    method: "POST",
  });
}

export function deleteUser(id: string): Promise<void> {
  return api(`/users/${id}`, { method: "DELETE" }).then(() => undefined);
}

// --- Self-service signature (My Account) ---
// Upload the signed-in user's own signature image (data URI). Cloudinary upload → longer timeout.
export function uploadMySignature(signature: string, fileName?: string): Promise<User> {
  return api<{ user: User }>("/users/me/signature", {
    method: "POST",
    body: { signature, fileName },
    timeout: 60_000,
  }).then((r) => r.user);
}

export function removeMySignature(): Promise<User> {
  return api<{ user: User }>("/users/me/signature", { method: "DELETE" }).then((r) => r.user);
}

// --- Self-service profile (My Account) ---
// Read / edit the signed-in user's OWN profile. The backend whitelist accepts only these fields
// (phone, avatar, address) — role/status/email/etc. can never be self-set.
export interface MyProfileUpdate {
  phone?: string;
  profileImage?: string; // data URI
  removeProfileImage?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
}

export function getMyProfile(): Promise<User> {
  return api<{ user: User }>("/users/me").then((r) => r.user);
}

export function updateMyProfile(payload: MyProfileUpdate): Promise<User> {
  return api<{ user: User }>("/users/me", { method: "PUT", body: payload, timeout: 60_000 }).then((r) => r.user);
}
