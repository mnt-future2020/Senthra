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
  // Personal signature (printed on documents the user issues, e.g. Purchase Order PDFs).
  signatureUrl: string | null;
  signatureName: string | null;
  signatureMimeType: string | null;
  signatureFileSize: number | null;
  signatureUploadedAt: string | null;
  signatureUpdatedAt: string | null;
  mustResetPassword: boolean;
  role: UserRoleRef | null;
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
