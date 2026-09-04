"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Building2, KeyRound, Loader2, Trash2, Upload } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { Customer } from "@/types/customer";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { COUNTRY_OPTIONS } from "@/lib/countryOptions";
import { Select } from "@/components/ui/Select";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FieldError, FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { TempPasswordModal } from "@/components/ui/TempPasswordModal";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { EMAIL_RE, UK_POSTCODE_RE, WEBSITE_RE, isPhone } from "@/lib/validation";
import { MAX_IMAGE_BYTES, readFileAsDataUrl, shrinkImage } from "@/lib/image";
import type { UserStatus } from "@/types/user";
import { focusFirstInvalid } from "@/lib/focusFirstInvalid";

const CUSTOMERS_LIST = "/dashboard/customers";

// Suggestions for the (free-text) industry + country pickers. Offered through `SuggestInput`
// rather than a native <datalist> — same "pick one or type your own" behaviour, but the popup is
// the app's, so it follows the theme, accent and corner radius like every other dropdown.
const INDUSTRY_OPTIONS = [
  "Telecoms",
  "Construction",
  "Utilities",
  "Rail",
  "Civil Engineering",
  "Data Centres",
  "Energy",
  "Public Sector",
  "Logistics",
  "Manufacturing",
];
function validate(v: {
  name: string;
  email: string;
  phone: string;
  altPhone: string;
  website: string;
  postcode: string;
}): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!v.name.trim()) errs.name = "Company name is required.";
  else if (v.name.trim().length > 120) errs.name = "Keep this under 120 characters.";

  if (!v.email.trim()) errs.email = "Login email is required.";
  else if (!EMAIL_RE.test(v.email.trim())) errs.email = "Enter a valid email address.";

  if (v.phone.trim() && !isPhone(v.phone.trim())) {
    errs.phone = "Enter a valid UK phone number (e.g. 07700 900000 or +44 7700 900000).";
  }
  if (v.altPhone.trim() && !isPhone(v.altPhone.trim())) {
    errs.altPhone = "Enter a valid UK phone number.";
  }
  if (v.website.trim() && !WEBSITE_RE.test(v.website.trim())) {
    errs.website = "Enter a valid website (e.g. example.com).";
  }
  if (v.postcode.trim() && !UK_POSTCODE_RE.test(v.postcode.trim())) {
    errs.postcode = "Enter a valid UK postcode (e.g. EC1A 1BB).";
  }
  return errs;
}

// Full-page Add/Edit customer form — mirrors the staff user form: two-column
// layout (form + a sticky logo/summary aside), nav-guarded against losing edits,
// and (on create) reveals the one-time temporary password before continuing.
export function CustomerForm({ mode, customer }: { mode: "create" | "edit"; customer?: Customer | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();

  const [name, setName] = React.useState(customer?.name ?? "");
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [legalName, setLegalName] = React.useState(customer?.legalName ?? "");
  const [registrationNumber, setRegistrationNumber] = React.useState(customer?.registrationNumber ?? "");
  const [industry, setIndustry] = React.useState(customer?.industry ?? "");
  const [website, setWebsite] = React.useState(customer?.website ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(
    (customer?.status as "active" | "inactive") ?? "active",
  );
  const [contactPerson, setContactPerson] = React.useState(customer?.contactPerson ?? "");
  const [contactJobTitle, setContactJobTitle] = React.useState(customer?.contactJobTitle ?? "");
  const [phone, setPhone] = React.useState(customer?.phone ?? "");
  const [altPhone, setAltPhone] = React.useState(customer?.altPhone ?? "");
  const [addressLine1, setAddressLine1] = React.useState(customer?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = React.useState(customer?.addressLine2 ?? "");
  const [city, setCity] = React.useState(customer?.city ?? "");
  const [county, setCounty] = React.useState(customer?.county ?? "");
  const [postcode, setPostcode] = React.useState(customer?.postcode ?? "");
  const [country, setCountry] = React.useState(customer?.country ?? (customer ? "" : "United Kingdom"));
  const [notes, setNotes] = React.useState(customer?.notes ?? "");
  const [imageData, setImageData] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(customer?.logoUrl ?? null);
  const [removeLogo, setRemoveLogo] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [tempPw, setTempPw] = React.useState<{ email: string; password: string; code: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const o = customer;
  const isDirty =
    !saved &&
    (name !== (o?.name ?? "") ||
      email !== (o?.email ?? "") ||
      legalName !== (o?.legalName ?? "") ||
      registrationNumber !== (o?.registrationNumber ?? "") ||
      industry !== (o?.industry ?? "") ||
      website !== (o?.website ?? "") ||
      status !== ((o?.status as "active" | "inactive") ?? "active") ||
      contactPerson !== (o?.contactPerson ?? "") ||
      contactJobTitle !== (o?.contactJobTitle ?? "") ||
      phone !== (o?.phone ?? "") ||
      altPhone !== (o?.altPhone ?? "") ||
      addressLine1 !== (o?.addressLine1 ?? "") ||
      addressLine2 !== (o?.addressLine2 ?? "") ||
      city !== (o?.city ?? "") ||
      county !== (o?.county ?? "") ||
      postcode !== (o?.postcode ?? "") ||
      country !== (o?.country ?? (o ? "" : "United Kingdom")) ||
      notes !== (o?.notes ?? "") ||
      imageData !== null ||
      removeLogo);

  useReportDirty("customer-form", isDirty);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(CUSTOMERS_LIST);
    });

  const showError = (msg: string) => {
    setError(msg);
    pushToast(msg, "alert");
  };

  const clearError = (field: string) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const pickImage = async (file: File) => {
    setError(null);
    if (!file.type.startsWith("image/")) {
      showError("Please choose an image file (PNG or JPG).");
      return;
    }
    try {
      // Downscale first — a logo exported at print resolution is routinely over the limit, and
      // shrinking it is exactly what the user would otherwise be told to go and do by hand.
      const image = await shrinkImage(file);
      if (image.size > MAX_IMAGE_BYTES) {
        showError("Logo must be under 2 MB.");
        return;
      }
      const data = await readFileAsDataUrl(image);
      setImageData(data);
      setPreviewUrl(data);
      setRemoveLogo(false);
    } catch {
      showError("Could not read that file. Please try another image.");
    }
  };

  const removeImage = () => {
    setImageData(null);
    setPreviewUrl(null);
    setRemoveLogo(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const fieldErrors = validate({ name, email, phone, altPhone, website, postcode });
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const fields = {
        legalName: legalName.trim() || undefined,
        registrationNumber: registrationNumber.trim() || undefined,
        industry: industry.trim() || undefined,
        website: website.trim() || undefined,
        status,
        contactPerson: contactPerson.trim() || undefined,
        contactJobTitle: contactJobTitle.trim() || undefined,
        phone: phone.trim() || undefined,
        altPhone: altPhone.trim() || undefined,
        addressLine1: addressLine1.trim() || undefined,
        addressLine2: addressLine2.trim() || undefined,
        city: city.trim() || undefined,
        county: county.trim() || undefined,
        postcode: postcode.trim() || undefined,
        country: country.trim() || undefined,
        notes: notes.trim() || undefined,
      };

      if (mode === "create") {
        const result = await customerService.createCustomer({
          name: name.trim(),
          email: email.trim(),
          ...fields,
          logo: imageData ?? undefined,
        });
        setSaved(true);
        setTempPw({
          email: result.customer.email,
          password: result.temporaryPassword,
          code: result.customer.customerCode,
        });
      } else if (customer) {
        const payload: customerService.UpdateCustomerPayload = {
          name: name.trim(),
          // The portal login (contact person, login email, phone) lives on the login
          // user — managed in the Portal login tab, never edited here. Company fields
          // are sent as their current value ("" clears) so clearing persists.
          legalName: legalName.trim(),
          registrationNumber: registrationNumber.trim(),
          industry: industry.trim(),
          website: website.trim(),
          status,
          altPhone: altPhone.trim(),
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim(),
          city: city.trim(),
          county: county.trim(),
          postcode: postcode.trim(),
          country: country.trim(),
          notes: notes.trim(),
        };
        if (imageData) payload.logo = imageData;
        else if (removeLogo) payload.removeLogo = true;
        await customerService.updateCustomer(customer.id, payload);
        setSaved(true);
        pushToast("Customer updated.", "success");
        router.replace(`${CUSTOMERS_LIST}/${customer.customerCode}`);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
    }
  };

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
      <button type="submit" form="customer-form" disabled={saving} className={primaryBtn}>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {mode === "create" ? "Create customer" : "Save changes"}
      </button>
    </>
  );

  return (
    <div className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "Add customer" : "Edit customer"}
        subtitle={
          mode === "create"
            ? "Creates a read-only portal login — sign-in details are emailed automatically."
            : (customer?.customerCode ?? undefined)
        }
        onBack={goBack}
        actions={actions}
      />

      <form id="customer-form" onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Company" description="Who the customer is.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Company name<RequiredMark /></label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="BT"
                  maxLength={120}
                  aria-required={true}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "name-error" : undefined}
                />
                <FieldError id="name-error" message={errors.name} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Legal / registered company name</label>
                <input
                  className={inputCls}
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="e.g. British Telecommunications plc"
                  maxLength={160}
                />
              </div>
              {mode === "edit" && customer?.customerCode && (
                <div>
                  <label className={labelCls}>Customer code</label>
                  <input className={`${inputCls} cursor-not-allowed opacity-60`} value={customer.customerCode} readOnly />
                  <p className="mt-1 text-[11px] text-[var(--faint)]">Auto-generated and fixed.</p>
                </div>
              )}
              <div>
                <label className={labelCls}>Company reg. number</label>
                <input className={inputCls} value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} placeholder="e.g. 01234567" maxLength={40} />
              </div>
              <div>
                <label className={labelCls}>Industry / sector</label>
                <SuggestInput
                  ariaLabel="Industry / sector"
                  value={industry}
                  onChange={setIndustry}
                  suggestions={INDUSTRY_OPTIONS}
                  placeholder="e.g. Telecoms"
                  maxLength={80}
                />
              </div>
              <div>
                <label className={labelCls}>Website</label>
                <input
                  className={inputCls}
                  value={website}
                  onChange={(e) => {
                    setWebsite(e.target.value);
                    clearError("website");
                  }}
                  placeholder="example.com"
                  maxLength={200}
                  aria-invalid={Boolean(errors.website)}
                  aria-describedby={errors.website ? "website-error" : undefined}
                />
                <FieldError id="website-error" message={errors.website} />
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <Select
                  value={status}
                  onChange={(v) => setStatus(v as "active" | "inactive")}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                  ariaLabel="Status"
                />
              </div>
              <div>
                <label className={labelCls}>Secondary phone</label>
                <input
                  type="tel"
                  className={inputCls}
                  value={altPhone}
                  onChange={(e) => {
                    setAltPhone(e.target.value);
                    clearError("altPhone");
                  }}
                  placeholder="Optional company number"
                  maxLength={20}
                  aria-invalid={Boolean(errors.altPhone)}
                  aria-describedby={errors.altPhone ? "altPhone-error" : undefined}
                />
                <FieldError id="altPhone-error" message={errors.altPhone} />
              </div>
            </div>
          </FormSection>

          {/* The single portal login IS this person. On create we collect them (they
              get the temp password); on edit it's managed in the Portal login tab, so
              there's one source of truth and the two can never drift apart. */}
          {mode === "create" ? (
            <FormSection
              title="Portal login"
              description="This person becomes the customer's single portal login — they receive the temporary password."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Contact person</label>
                  <input className={inputCls} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="John Smith" maxLength={120} />
                </div>
                <div>
                  <label className={labelCls}>Job title</label>
                  <input className={inputCls} value={contactJobTitle} onChange={(e) => setContactJobTitle(e.target.value)} placeholder="Project Manager" maxLength={80} />
                </div>
                <div>
                  <label className={labelCls}>Login email<RequiredMark /></label>
                  <input
                    type="email"
                    className={inputCls}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError("email");
                    }}
                    placeholder="pm@customer.com"
                    autoComplete="off"
                    maxLength={120}
                    aria-required={true}
                    aria-invalid={Boolean(errors.email)}
                    aria-describedby={errors.email ? "email-error" : undefined}
                  />
                  <FieldError id="email-error" message={errors.email} />
                </div>
                <div>
                  <label className={labelCls}>Phone</label>
                  <input
                    type="tel"
                    className={inputCls}
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      clearError("phone");
                    }}
                    placeholder="020 1234 5678"
                    maxLength={20}
                    aria-invalid={Boolean(errors.phone)}
                    aria-describedby={errors.phone ? "phone-error" : undefined}
                  />
                  <FieldError id="phone-error" message={errors.phone} />
                </div>
              </div>
            </FormSection>
          ) : (
            <FormSection title="Portal login" description="The customer's sign-in.">
              <div className="flex items-start gap-2.5 rounded-xl bg-[var(--surface-2)] px-3.5 py-3 text-xs text-[var(--muted)]">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[var(--faint)]" />
                <span>
                  The portal login — contact person, login email and phone — is managed in the
                  customer&apos;s <strong className="text-[var(--ink)]">Portal login</strong> tab, so
                  it stays the single source of truth.
                </span>
              </div>
            </FormSection>
          )}

          <FormSection title="Address" description="Optional — UK format.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 1</label>
                <input className={inputCls} value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="1 High Street" maxLength={120} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 2</label>
                <input className={inputCls} value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} placeholder="Optional" maxLength={120} />
              </div>
              <div>
                <label className={labelCls}>City / town</label>
                <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="London" maxLength={80} />
              </div>
              <div>
                <label className={labelCls}>County</label>
                <input className={inputCls} value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Optional" maxLength={80} />
              </div>
              <PostcodeField
                value={postcode}
                onChange={(v) => {
                  setPostcode(v);
                  clearError("postcode");
                }}
                setCity={setCity}
                setCounty={setCounty}
                setCountry={setCountry}
                error={errors.postcode}
                errorId="postcode-error"
                required={false}
              />
              <div>
                <label className={labelCls}>Country</label>
                <SuggestInput
                  ariaLabel="Country"
                  value={country}
                  onChange={setCountry}
                  suggestions={COUNTRY_OPTIONS}
                  placeholder="United Kingdom"
                  maxLength={80}
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Internal notes — never shown to the customer.">
            <textarea
              className={inputCls}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional internal notes about this customer."
              maxLength={2000}
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
              A secure temporary password is generated and emailed to the customer automatically.
              You&apos;ll also see it once after creating. A customer code is assigned automatically.
            </p>
          )}
        </div>

        {/* Sticky aside: logo + live summary */}
        <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <FormAsideCard title="Company logo">
            <div className="flex flex-col items-center gap-3 text-center">
              <Avatar url={previewUrl} firstName={name || "?"} lastName="" size={88} />
              <div className="flex gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className={ghostBtn}>
                  <Upload className="h-3.5 w-3.5" />
                  {previewUrl ? "Replace" : "Upload"}
                </button>
                {previewUrl && (
                  <button
                    type="button"
                    onClick={removeImage}
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
              <Avatar url={previewUrl} firstName={name || "?"} lastName="" size={40} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[var(--ink)]">{name.trim() || "New customer"}</p>
                <p className="truncate text-xs text-[var(--muted)]">{email.trim() || "No email yet"}</p>
              </div>
            </div>
            <dl className="mt-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--muted)]">Status</dt>
                <dd><StatusBadge status={status as UserStatus} /></dd>
              </div>
              {industry.trim() && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">Industry</dt>
                  <dd className="truncate font-semibold text-[var(--ink)]">{industry}</dd>
                </div>
              )}
              {contactPerson.trim() && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">Contact</dt>
                  <dd className="truncate font-semibold text-[var(--ink)]">{contactPerson}</dd>
                </div>
              )}
            </dl>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--muted)]">
              <Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--faint)]" />
              Read-only portal access — the customer sees only their own stock.
            </div>
          </FormAsideCard>
        </aside>
      </form>

      {tempPw && (
        <TempPasswordModal
          open
          title="Customer created"
          portal
          email={tempPw.email}
          password={tempPw.password}
          onClose={() => router.replace(`${CUSTOMERS_LIST}/${tempPw.code}`)}
        />
      )}
    </div>
  );
}
