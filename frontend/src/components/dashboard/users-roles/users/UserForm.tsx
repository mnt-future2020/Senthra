"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Trash2, Upload } from "lucide-react";

import * as userService from "@/services/user.service";
import { listWarehouseOptions, type WarehouseOption } from "@/services/warehouse.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { Role } from "@/types/role";
import type { User, UserStatus } from "@/types/user";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { Avatar } from "@/components/ui/Avatar";
import { Select } from "@/components/ui/Select";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { EMAIL_RE, UK_POSTCODE_RE, isPhone } from "@/lib/validation";
import { MAX_IMAGE_BYTES, readFileAsDataUrl } from "@/lib/image";
import { DepartmentCombobox } from "@/components/dashboard/users-roles/departments/DepartmentCombobox";
import { JobTitleCombobox } from "@/components/dashboard/users-roles/job-titles/JobTitleCombobox";

const USERS_LIST = "/dashboard/users";

// An ISO timestamp → the "YYYY-MM-DD" a <input type="date"> expects (or "").
const toDateInput = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

function validateUserForm(v: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  roleId: string;
  jobTitle: string;
  department: string;
  dateOfJoining: string;
  dateOfBirth: string;
  postcode: string;
  isWarehouseScoped: boolean;
  warehouseIds: string[];
}): Record<string, string> {
  const errs: Record<string, string> = {};
  const first = v.firstName.trim();
  const last = v.lastName.trim();
  const email = v.email.trim();

  if (!first) errs.firstName = "First name is required.";
  else if (first.length > 50) errs.firstName = "Keep this under 50 characters.";

  if (!last) errs.lastName = "Last name is required.";
  else if (last.length > 50) errs.lastName = "Keep this under 50 characters.";

  if (!email) errs.email = "Email address is required.";
  else if (!EMAIL_RE.test(email)) errs.email = "Enter a valid email address.";

  // Phone: required + UK format (national 07… / 020… or international +44…).
  const phone = v.phone.trim();
  if (!phone) errs.phone = "Phone number is required.";
  else if (!isPhone(phone)) {
    errs.phone = "Enter a valid UK phone number (e.g. 07700 900000 or +44 7700 900000).";
  }

  if (!v.roleId) errs.roleId = "Role is required.";
  // A warehouse-scoped role must be assigned at least one warehouse.
  if (v.isWarehouseScoped && v.warehouseIds.length === 0) {
    errs.warehouseIds = "Select at least one warehouse.";
  }
  if (!v.jobTitle.trim()) errs.jobTitle = "Job title is required.";
  if (!v.department.trim()) errs.department = "Department is required.";
  if (!v.dateOfJoining) errs.dateOfJoining = "Date of joining is required.";

  if (v.dateOfBirth) {
    const dob = new Date(v.dateOfBirth);
    if (Number.isNaN(dob.getTime())) errs.dateOfBirth = "Enter a valid date.";
    else if (dob.getTime() > Date.now()) errs.dateOfBirth = "Date of birth can't be in the future.";
    else if (dob.getFullYear() < 1900) errs.dateOfBirth = "Enter a valid date of birth.";
  }

  if (v.postcode.trim() && !UK_POSTCODE_RE.test(v.postcode.trim())) {
    errs.postcode = "Enter a valid UK postcode (e.g. EC1A 1BB).";
  }

  return errs;
}

// One field's validation message, linked to its input via aria-describedby.
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
      {message}
    </p>
  );
}

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
  // Warehouse assignments — only relevant for warehouse-scoped roles (prefilled on edit).
  const [warehouseIds, setWarehouseIds] = React.useState<string[]>(
    user?.warehouses?.map((w) => w.id) ?? [],
  );
  const [warehouseOptions, setWarehouseOptions] = React.useState<WarehouseOption[]>([]);
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
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [tempPw, setTempPw] = React.useState<{ email: string; password: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Whether the chosen role is warehouse-scoped (drives the conditional "Assigned Warehouses" field).
  // Detected via the role's flag — NOT its display name — so future scoped roles work automatically.
  const selectedRole = roles.find((r) => r.id === roleId) ?? null;
  const isWarehouseScoped = Boolean(selectedRole?.isWarehouseScoped);
  const initialWarehouseIds = (user?.warehouses ?? []).map((w) => w.id);
  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

  // Load active-warehouse options the first time a warehouse-scoped role is selected (lean endpoint;
  // only fetched when the field actually becomes relevant).
  const needWarehouseOptions = isWarehouseScoped && warehouseOptions.length === 0;
  const { isLoading: warehousesLoading } = useReferenceData(
    needWarehouseOptions
      ? [{ label: "warehouses", load: () => listWarehouseOptions(), onData: (opts) => setWarehouseOptions(opts) }]
      : [],
    [isWarehouseScoped, warehouseOptions.length],
  );

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
      removeImage ||
      !sameIds(warehouseIds, initialWarehouseIds));

  useReportDirty("user-form", isDirty);

  const goBack = () => guard.attemptLeave(() => { if (window.history.length > 1) router.back(); else router.push(USERS_LIST); });

  // Surface errors as a toast (instant, scroll-independent) as well as inline — the
  // Save button is in the sticky header, far from the inline message at the bottom.
  const showError = (msg: string) => {
    setError(msg);
    pushToast(msg, "alert");
  };

  // Clear a field's validation error as the user edits it.
  const clearError = (name: string) =>
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

  const pickImage = async (file: File) => {
    setError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      showError("Image must be under 2 MB.");
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
    const fieldErrors = validateUserForm({
      firstName,
      lastName,
      email,
      phone,
      roleId,
      jobTitle,
      department,
      dateOfJoining,
      dateOfBirth,
      postcode,
      isWarehouseScoped,
      warehouseIds,
    });
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (mode === "create") {
        const result = await userService.createUser({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          roleId,
          status,
          gender: gender || undefined,
          dateOfBirth: dateOfBirth || undefined,
          jobTitle: jobTitle.trim(),
          department: department.trim(),
          dateOfJoining,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          postcode: postcode.trim() || undefined,
          notes: notes.trim() || undefined,
          profileImage: imageData ?? undefined,
          // Only send assignments for a warehouse-scoped role (backend requires ≥1 then).
          warehouseIds: isWarehouseScoped ? warehouseIds : undefined,
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
        // Sync assignments only when the effective role is warehouse-scoped (backend never auto-
        // clears them on role change, so a non-scoped role simply omits the field).
        if (isWarehouseScoped) payload.warehouseIds = warehouseIds;
        if (imageData) payload.profileImage = imageData;
        else if (removeImage) payload.removeProfileImage = true;
        await userService.updateUser(user.id, payload);
        setSaved(true);
        pushToast("User updated.", "success");
        router.replace(USERS_LIST);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed.");
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
                <label className={labelCls}>First name<RequiredMark /></label>
                <input
                  className={inputCls}
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                    clearError("firstName");
                  }}
                  placeholder="Alex"
                  maxLength={50}
                  aria-required={true}
                  aria-invalid={Boolean(errors.firstName)}
                  aria-describedby={errors.firstName ? "firstName-error" : undefined}
                />
                <FieldError id="firstName-error" message={errors.firstName} />
              </div>
              <div>
                <label className={labelCls}>Last name<RequiredMark /></label>
                <input
                  className={inputCls}
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                    clearError("lastName");
                  }}
                  placeholder="Morgan"
                  maxLength={50}
                  aria-required={true}
                  aria-invalid={Boolean(errors.lastName)}
                  aria-describedby={errors.lastName ? "lastName-error" : undefined}
                />
                <FieldError id="lastName-error" message={errors.lastName} />
              </div>
              <div>
                <label className={labelCls}>Email address<RequiredMark /></label>
                <input
                  type="email"
                  className={inputCls}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearError("email");
                  }}
                  placeholder="alex@company.com"
                  autoComplete="off"
                  maxLength={120}
                  aria-required={true}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "email-error" : undefined}
                />
                <FieldError id="email-error" message={errors.email} />
              </div>
              <div>
                <label className={labelCls}>Phone<RequiredMark /></label>
                <input
                  type="tel"
                  className={inputCls}
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    clearError("phone");
                  }}
                  placeholder="+44 7700 900000"
                  maxLength={20}
                  aria-required={true}
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={errors.phone ? "phone-error" : undefined}
                />
                <FieldError id="phone-error" message={errors.phone} />
              </div>
              <div>
                <label className={labelCls}>Gender</label>
                <Select
                  value={gender}
                  onChange={(v) => setGender(v)}
                  options={[
                    { value: "male", label: "Male" },
                    { value: "female", label: "Female" },
                    { value: "other", label: "Other" },
                  ]}
                  placeholder="Not specified"
                  ariaLabel="Gender"
                />
              </div>
              <div>
                <label className={labelCls}>Date of birth</label>
                <input
                  type="date"
                  className={inputCls}
                  value={dateOfBirth}
                  onChange={(e) => {
                    setDateOfBirth(e.target.value);
                    clearError("dateOfBirth");
                  }}
                  aria-invalid={Boolean(errors.dateOfBirth)}
                  aria-describedby={errors.dateOfBirth ? "dateOfBirth-error" : undefined}
                />
                <FieldError id="dateOfBirth-error" message={errors.dateOfBirth} />
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
                <label className={labelCls}>Job title<RequiredMark /></label>
                <JobTitleCombobox
                  value={jobTitle}
                  onChange={(name) => {
                    setJobTitle(name);
                    clearError("jobTitle");
                  }}
                  invalid={Boolean(errors.jobTitle)}
                  required
                  describedBy={errors.jobTitle ? "jobTitle-error" : undefined}
                />
                <FieldError id="jobTitle-error" message={errors.jobTitle} />
              </div>
              <div>
                <label className={labelCls}>Department<RequiredMark /></label>
                <DepartmentCombobox
                  value={department}
                  onChange={(name) => {
                    setDepartment(name);
                    clearError("department");
                  }}
                  invalid={Boolean(errors.department)}
                  required
                  describedBy={errors.department ? "department-error" : undefined}
                />
                <FieldError id="department-error" message={errors.department} />
              </div>
              <div>
                <label className={labelCls}>Date of joining<RequiredMark /></label>
                <input
                  type="date"
                  className={inputCls}
                  value={dateOfJoining}
                  onChange={(e) => {
                    setDateOfJoining(e.target.value);
                    clearError("dateOfJoining");
                  }}
                  aria-required={true}
                  aria-invalid={Boolean(errors.dateOfJoining)}
                  aria-describedby={errors.dateOfJoining ? "dateOfJoining-error" : undefined}
                />
                <FieldError id="dateOfJoining-error" message={errors.dateOfJoining} />
              </div>
              <div>
                <label className={labelCls}>Role<RequiredMark /></label>
                <Select
                  value={roleId}
                  onChange={(v) => {
                    setRoleId(v);
                    clearError("roleId");
                  }}
                  options={roles.map((r) => ({ value: r.id, label: r.name }))}
                  placeholder="Select a role…"
                  ariaLabel="Role"
                  required
                  invalid={Boolean(errors.roleId)}
                  describedBy={errors.roleId ? "roleId-error" : undefined}
                />
                <FieldError id="roleId-error" message={errors.roleId} />
              </div>
              {/* Assigned Warehouses — shown only for a warehouse-scoped role (e.g. Warehouse Manager).
                  Required (≥1); the user may then access only these warehouses. */}
              {isWarehouseScoped && (
                <div className="sm:col-span-2">
                  <label className={labelCls}>Assigned warehouses<RequiredMark /></label>
                  <MultiSelect
                    values={warehouseIds}
                    onChange={(v) => {
                      setWarehouseIds(v);
                      clearError("warehouseIds");
                    }}
                    options={warehouseOptions.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
                    placeholder={warehousesLoading && warehouseIds.length === 0 ? "Loading warehouses…" : "Select one or more warehouses…"}
                    disabled={warehousesLoading && warehouseIds.length === 0}
                    ariaLabel="Assigned warehouses"
                    invalid={Boolean(errors.warehouseIds)}
                    describedBy={errors.warehouseIds ? "warehouseIds-error" : undefined}
                    emptyText="No active warehouses found."
                  />
                  <FieldError id="warehouseIds-error" message={errors.warehouseIds} />
                  <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                    This user will only be able to access the warehouses selected here.
                  </p>
                </div>
              )}
              <div>
                <label className={labelCls}>Status</label>
                <Select
                  value={status}
                  onChange={(v) => setStatus(v as UserStatus)}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                    { value: "suspended", label: "Suspended" },
                  ]}
                  ariaLabel="Status"
                />
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
              <PostcodeField
                value={postcode}
                onChange={(v) => {
                  setPostcode(v);
                  clearError("postcode");
                }}
                setCity={setCity}
                error={errors.postcode}
                errorId="postcode-error"
                required={false}
              />
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
              {isWarehouseScoped && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">Warehouses</dt>
                  <dd className="font-semibold text-[var(--ink)]">
                    {warehouseIds.length > 0 ? `${warehouseIds.length} assigned` : "None"}
                  </dd>
                </div>
              )}
            </dl>
          </FormAsideCard>
        </aside>
      </form>

      <TempPasswordModal
        open={tempPw !== null}
        title="User created"
        email={tempPw?.email ?? ""}
        password={tempPw?.password ?? ""}
        onClose={() => router.replace(USERS_LIST)}
      />
    </div>
  );
}
