"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import type { User } from "@/types/user";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormAsideCard, FormPageHeader, FormSection } from "@/components/ui/FormScaffold";

const USERS_LIST = "/dashboard/users";

// ISO / "YYYY-MM-DD" → "05 Jun 2026" (or an em dash when empty/invalid).
function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// One read-only label/value pair. Falls back to a muted em dash when empty.
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-[var(--ink)]">
        {empty ? <span className="text-[var(--faint)]">—</span> : value}
      </dd>
    </div>
  );
}

// Read-only user profile page: same two-column chrome as the edit form, but pure
// display (no inputs). Reached from the Users list "View" action; gated by users.view.
export function UserDetail({ user }: { user: User }) {
  const router = useRouter();
  const { can } = useAuth();
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  const hasAddress =
    user.addressLine1 || user.addressLine2 || user.city || user.postcode;

  return (
    <div className="space-y-6">
      <FormPageHeader
        title="User details"
        subtitle={user.email}
        onBack={() => router.push(USERS_LIST)}
        actions={
          can("users.edit") ? (
            <button
              onClick={() => router.push(`/dashboard/users/${user.employeeId ?? user.id}/edit`)}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Profile">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="First name" value={user.firstName} />
              <Field label="Last name" value={user.lastName} />
              <Field label="Email" value={user.email} />
              <Field label="Phone" value={user.phone} />
              <Field label="Role" value={user.role?.name} />
              <Field label="Status" value={<StatusBadge status={user.status} />} />
            </dl>
          </FormSection>

          <FormSection title="Employment">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="Employee ID" value={user.employeeId} />
              <Field label="Job title" value={user.jobTitle} />
              <Field label="Department" value={user.department} />
              <Field label="Date of joining" value={fmtDate(user.dateOfJoining)} />
            </dl>
          </FormSection>

          <FormSection title="Personal">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="Gender" value={user.gender ? titleCase(user.gender) : null} />
              <Field label="Date of birth" value={fmtDate(user.dateOfBirth)} />
            </dl>
          </FormSection>

          {hasAddress && (
            <FormSection title="Address">
              <dl className="grid gap-5 sm:grid-cols-2">
                <Field label="Address line 1" value={user.addressLine1} />
                <Field label="Address line 2" value={user.addressLine2} />
                <Field label="City" value={user.city} />
                <Field label="Postcode" value={user.postcode} />
              </dl>
            </FormSection>
          )}

          {user.notes && (
            <FormSection title="Notes">
              <p className="whitespace-pre-wrap text-sm text-[var(--ink)]">{user.notes}</p>
            </FormSection>
          )}
        </div>

        {/* Sticky summary aside */}
        <div className="space-y-6">
          <FormAsideCard title="Profile">
            <div className="flex flex-col items-center text-center">
              <Avatar
                url={user.profileImageUrl}
                firstName={user.firstName}
                lastName={user.lastName}
                size={80}
              />
              <h2 className="mt-3 text-base font-extrabold tracking-tight text-[var(--ink)]">
                {fullName}
              </h2>
              <p className="w-full truncate text-xs text-[var(--muted)]">{user.email}</p>
              <div className="mt-3">
                <StatusBadge status={user.status} />
              </div>
            </div>
            <dl className="mt-5 space-y-3 border-t border-[var(--border-2)] pt-4">
              <Field label="Role" value={user.role?.name} />
              <Field label="Employee ID" value={user.employeeId} />
              <Field label="Department" value={user.department} />
              <Field label="Added" value={fmtDate(user.createdAt)} />
            </dl>
          </FormAsideCard>
        </div>
      </div>
    </div>
  );
}
