// A user as returned by the backend. Never includes the password hash or tokens.
export type UserStatus = "active" | "inactive" | "suspended";

export interface UserRoleRef {
  id: string;
  key: string;
  name: string;
}

// A warehouse a (warehouse-scoped) user is assigned to. Populated only for warehouse-scoped roles.
export interface AssignedWarehouse {
  id: string;
  code: string;
  name: string;
}

/**
 * One row of the staff DIRECTORY — what `GET /users` returns.
 *
 * Deliberately narrower than `User`: the list is read by anyone with `users.view`, so it carries
 * who someone is and what they can do, and none of the personnel record (date of birth, gender,
 * home address, notes, phone) or anything about their credentials. The full record comes from the
 * single-user read, `getUser(id)`.
 */
export interface DirectoryUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: UserStatus;
  profileImageUrl: string | null;
  role: UserRoleRef | null;
  employeeId: string | null;
  createdAt: string;
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
  // Personal signature (printed on documents the user issues, e.g. Purchase Order PDFs).
  signatureUrl: string | null;
  signatureName: string | null;
  signatureMimeType: string | null;
  signatureFileSize: number | null;
  signatureUploadedAt: string | null;
  signatureUpdatedAt: string | null;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
  // Warehouses explicitly assigned to this user (only populated for warehouse-scoped roles).
  warehouses: AssignedWarehouse[];
  // Employment
  employeeId: string | null;
  jobTitle: string | null;
  department: string | null;
  dateOfJoining: string | null;
  // Personal
  gender: string | null;
  dateOfBirth: string | null;
  // Address (UK)
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  createdAt: string;
  updatedAt: string;
}
