// A user as returned by the backend. Never includes the password hash or tokens.
export type UserStatus = "active" | "inactive" | "suspended";

export interface UserRoleRef {
  id: string;
  key: string;
  name: string;
}

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  profileImageUrl: string | null;
  notes: string | null;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
  createdAt: string;
  updatedAt: string;
}
