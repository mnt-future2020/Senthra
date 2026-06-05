"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Trash2, Upload } from "lucide-react";

import * as userService from "@/services/user.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { Role } from "@/types/role";
import type { User, UserStatus } from "@/types/user";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/dashboard/settings/ui/styles";
import { Avatar } from "./Avatar";
import { StatusBadge } from "./StatusBadge";
import { FormAsideCard, FormPageHeader, FormSection } from "./FormScaffold";
import { TempPasswordModal } from "./TempPasswordModal";

const USERS_LIST = "/dashboard/users";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

// An ISO timestamp → the "YYYY-MM-DD" a <input type="date"> expects (or "").
const toDateInput = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

// Full-page Add/Edit user form: full-width two-column layout (form + a sticky
// photo/summary aside), nav-guarded against losing edits, and (on create) reveals
// the one-time temporary password before returning to the list.
export function UserForm({
  mode,
  user,
  roles,
}: {
  mode: "create" | "edit";
  user?: User | null;
  roles: Role[];
}) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const [firstName, setFirstName] = React.useState(user?.firstName ?? "");
  const [lastName, setLastName] = React.useState(user?.lastName ?? "");
  const [email, setEmail] = React.useState(user?.email ?? "");
  const [phone, setPhone] = React.useState(user?.phone ?? "");
  const [gender, setGender] = React.useState(user?.gender ?? "");
  const [dateOfBirth, setDateOfBirth] = React.useState(toDateInput(user?.dateOfBirth));
  const [roleId, setRoleId] = React.useState(user?.role?.id ?? "");
  const [status, setStatus] = React.useState<UserStatus>(user?.status ?? "active");
  const [jobTitle, setJobTitle] = React.useState(user?.jobTitle ?? "");
  const [department, setDepartment] = React.useState(user?.department ?? "");
  const [dateOfJoining, setDateOfJoining] = React.useState(toDateInput(user?.dateOfJoining));
  const [addressLine1, setAddressLine1] = React.useState(user?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = React.useState(user?.addressLine2 ?? "");
  const [city, setCity] = React.useState(user?.city ?? "");
  const [postcode, setPostcode] = React.useState(user?.postcode ?? "");
  const [notes, setNotes] = React.useState(user?.notes ?? "");
  const [imageData, setImageData] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(user?.profileImageUrl ?? null);
  const [removeImage, setRemoveImage] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tempPw, setTempPw] = React.useState<{ email: string; password: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const isDirty =
    !saved &&
    (firstName !== (user?.firstName ?? "") ||
      lastName !== (user?.lastName ?? "") ||
      email !== (user?.email ?? "") ||
      phone !== (user?.phone ?? "") ||
      gender !== (user?.gender ?? "") ||
      dateOfBirth !== toDateInput(user?.dateOfBirth) ||
      roleId !== (user?.role?.id ?? "") ||
      status !== (user?.status ?? "active") ||
      jobTitle !== (user?.jobTitle ?? "") ||
      department !== (user?.department ?? "") ||
      dateOfJoining !== toDateInput(user?.dateOfJoining) ||
      addressLine1 !== (user?.addressLine1 ?? "") ||
      addressLine2 !== (user?.addressLine2 ?? "") ||
      city !== (user?.city ?? "") ||
      postcode !== (user?.postcode ?? "") ||
      notes !== (user?.notes ?? "") ||
      imageData !== null ||
      removeImage);

  useReportDirty("user-form", isDirty);

  const goBack = () => guard.attemptLeave(() => router.push(USERS_LIST));

  const pickImage = async (file: File) => {
    setError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Image must be under 2 MB.");
      return;
    }
    const data = await readFileAsDataUrl(file);
    setImageData(data);
    setPreviewUrl(data);
    setRemoveImage(false);
  };

  const removeAvatar = () => {
    setImageData(null);
    setPreviewUrl(null);
    setRemoveImage(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        const result = await userService.createUser({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          roleId: roleId || undefined,
          status,
          gender: gender || undefined,
          dateOfBirth: dateOfBirth || undefined,
          jobTitle: jobTitle.trim() || undefined,
          department: department.trim() || undefined,
          dateOfJoining: dateOfJoining || undefined,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          postcode: postcode.trim() || undefined,
          notes: notes.trim() || undefined,
          profileImage: imageData ?? undefined,
        });
        setSaved(true);
        setTempPw({ email: result.user.email, password: result.temporaryPassword });
      } else if (user) {
        const payload: userService.UpdateUserPayload = {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          roleId: roleId || null,
          status,
          gender,
          dateOfBirth,
          jobTitle: jobTitle.trim(),
          department: department.trim(),
          dateOfJoining,
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim(),
          city: city.trim(),
          postcode: postcode.trim(),
          notes: notes.trim(),
        };
        if (imageData) payload.profileImage = imageData;
        else if (removeImage) payload.removeProfileImage = true;
        await userService.updateUser(user.id, payload);
        setSaved(true);
        pushToast("User updated.", "success");
        router.push(USERS_LIST);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
    }
  };

  const fullName = [firstName, lastName].join(" ").trim();
  const roleName = roles.find((r) => r.id === roleId)?.name ?? "No role";

  const actions = (
    <>
      <button
        type="button"
        onClick={goBack}
        disabled={saving}
        className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
      >
        Cancel
      </button>
      <button type="submit" form="user-form" disabled={saving} className={primaryBtn}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {mode === "create" ? "Create user" : "Save changes"}
      </button>
    </>
  );

  return (
    <div className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "Add user" : "Edit user"}
        subtitle={
          mode === "create"
            ? "Create an account — sign-in details are emailed automatically."
            : (user?.email ?? undefined)
        }
        onBack={goBack}
        actions={actions}
      />

      <form id="user-form" onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Identity" description="Who this person is and how to reach them.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>First name</label>
                <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Alex" />
              </div>
              <div>
                <label className={labelCls}>Last name</label>
                <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Morgan" />
              </div>
              <div>
                <label className={labelCls}>Email address</label>
                <input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alex@company.com" autoComplete="off" />
              </div>
              <div>
                <label className={labelCls}>Phone</label>
                <input type="tel" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 7700 900000" />
              </div>
              <div>
                <label className={labelCls}>Gender</label>
                <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value)}>
                  <option value="">Not specified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Date of birth</label>
                <input type="date" className={inputCls} value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Employment" description="Role, team and joining details.">
            {mode === "edit" && user?.employeeId && (
              <div className="mb-4">
                <label className={labelCls}>Employee ID</label>
                <input className={`${inputCls} cursor-not-allowed opacity-60`} value={user.employeeId} readOnly />
                <p className="mt-1 text-[11px] text-[var(--faint)]">Auto-generated and fixed for this account.</p>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Job title</label>
                <input className={inputCls} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Field Engineer" />
              </div>
              <div>
                <label className={labelCls}>Department</label>
                <input className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Operations" />
              </div>
              <div>
                <label className={labelCls}>Date of joining</label>
                <input type="date" className={inputCls} value={dateOfJoining} onChange={(e) => setDateOfJoining(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Role</label>
                <select className={inputCls} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  <option value="">No role</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as UserStatus)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
            </div>
          </FormSection>

          <FormSection title="Address" description="Optional — UK format.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 1</label>
                <input className={inputCls} value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="1 High Street" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 2</label>
                <input className={inputCls} value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} placeholder="Flat 4 (optional)" />
              </div>
              <div>
                <label className={labelCls}>City / town</label>
                <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="London" />
              </div>
              <div>
                <label className={labelCls}>Postcode</label>
                <input className={inputCls} value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="EC1A 1BB" />
              </div>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal notes about this user.">
            <textarea
              className={inputCls}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional internal notes about this user."
            />
          </FormSection>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-[var(--neg)]/10 px-3.5 py-2.5 text-sm font-semibold text-[var(--neg)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {mode === "create" && (
            <p className="text-[11px] leading-relaxed text-[var(--faint)]">
              A secure temporary password is generated and emailed to the user automatically.
              You&apos;ll also see it once after creating. An employee ID is assigned automatically.
            </p>
          )}
        </div>

        {/* Sticky aside: photo + live summary */}
        <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <FormAsideCard title="Profile photo">
            <div className="flex flex-col items-center gap-3 text-center">
              <Avatar url={previewUrl} firstName={firstName || "?"} lastName={lastName} size={88} />
              <div className="flex gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className={ghostBtn}>
                  <Upload className="h-3.5 w-3.5" />
                  {previewUrl ? "Replace" : "Upload"}
                </button>
                {previewUrl && (
                  <button
                    type="button"
                    onClick={removeAvatar}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-[var(--muted)] transition-all hover:text-[var(--neg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
              </div>
              <span className="text-[11px] text-[var(--faint)]">PNG/JPG, max 2 MB. Optional.</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImage(f);
                e.target.value = "";
              }}
            />
          </FormAsideCard>

          <FormAsideCard title="Summary">
            <div className="flex items-center gap-3">
              <Avatar url={previewUrl} firstName={firstName || "?"} lastName={lastName} size={40} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[var(--ink)]">{fullName || "New user"}</p>
                <p className="truncate text-xs text-[var(--muted)]">{email || "No email yet"}</p>
              </div>
            </div>
            <dl className="mt-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--muted)]">Role</dt>
                <dd className="truncate font-semibold text-[var(--ink)]">{roleName}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--muted)]">Status</dt>
                <dd><StatusBadge status={status} /></dd>
              </div>
              {jobTitle.trim() && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">Job title</dt>
                  <dd className="truncate font-semibold text-[var(--ink)]">{jobTitle}</dd>
                </div>
              )}
              {department.trim() && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">Department</dt>
                  <dd className="truncate font-semibold text-[var(--ink)]">{department}</dd>
                </div>
              )}
            </dl>
          </FormAsideCard>
        </aside>
      </form>

      <TempPasswordModal
        open={tempPw !== null}
        email={tempPw?.email ?? ""}
        password={tempPw?.password ?? ""}
        isResend={false}
        onClose={() => router.push(USERS_LIST)}
      />
    </div>
  );
}
