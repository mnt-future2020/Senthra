import { api } from "@/lib/api";
import type { User, UserStatus } from "@/types/user";

// Typed wrappers around the backend /users endpoints.

export interface UserListParams {
  search?: string;
  status?: string;
  roleId?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedUsers {
  users: User[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateUserPayload {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  roleId?: string;
  status?: UserStatus;
  notes?: string;
  profileImage?: string; // data URI
}

export interface UpdateUserPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  roleId?: string | null;
  status?: UserStatus;
  notes?: string;
  profileImage?: string;
  removeProfileImage?: boolean;
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
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listUsers(params: UserListParams = {}): Promise<PagedUsers> {
  return api<PagedUsers>(`/users${qs(params)}`);
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
