"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import * as supplierService from "@/services/supplier.service";
import { listSupplierTypes, createSupplierType } from "@/services/supplier-type.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuth } from "@/hooks/useAuth";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { Supplier, SupplierOwner } from "@/types/supplier";
import type { SupplierType } from "@/types/supplier-type";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { firstActiveId } from "@/lib/utils";
import { STANDARD_PAYMENT_TERMS, CUSTOM_PAYMENT_TERM } from "@/lib/paymentTerms";
import { NumberInput } from "@/components/ui/NumberInput";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { CreatableSelect } from "@/components/ui/CreatableSelect";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { EMAIL_RE, UK_POSTCODE_RE, isPhone } from "@/lib/validation";
import type { UserStatus } from "@/types/user";

const SUPPLIERS_LIST = "/dashboard/suppliers";

// Constrained lists (matching the backend allow-lists). UK-only for now (consistent with
// the Warehouse module + UK postcode validation).
const COUNTRY_OPTIONS = ["United Kingdom"];
const CURRENCY_OPTIONS = ["GBP", "EUR"];
// Display labels show the symbol; the stored value stays the ISO code (GBP / EUR).
const CURRENCY_LABELS: Record<string, string> = { GBP: "GBP (£)", EUR: "EUR (€)" };
// Standard terms come from the shared source of truth (also used by the PO/PRF forms) so the list
// never drifts between Suppliers and procurement; "Custom" is the supplier-only bespoke escape hatch.
const PAYMENT_TERMS_OPTIONS = [...STANDARD_PAYMENT_TERMS, CUSTOM_PAYMENT_TERM];
// Lenient website check — empty, a bare domain, or a full URL (mirrors the backend).
const WEBSITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
      {message}
    </p>
  );
}

// Full-page Add/Edit supplier form — mirrors the warehouse/customer forms: titled
// sections plus a sticky summary aside, nav-guarded against losing edits. Code is
// auto-assigned, so it isn't an input. No geocoding (suppliers aren't mapped).
export function SupplierForm({ mode, supplier }: { mode: "create" | "edit"; supplier?: Supplier | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();
  const { can } = useAuth();

  const o = supplier;
  const [name, setName] = React.useState(o?.name ?? "");
  const [legalName, setLegalName] = React.useState(o?.legalName ?? "");
  const [typeId, setTypeId] = React.useState(o?.typeId ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(o?.status ?? "active");
  const [companyRegistrationNumber, setCompanyRegistrationNumber] = React.useState(
    o?.companyRegistrationNumber ?? "",
  );
  const [vatNumber, setVatNumber] = React.useState(o?.vatNumber ?? "");
  const [website, setWebsite] = React.useState(o?.website ?? "");
  const [addressLine1, setAddressLine1] = React.useState(o?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = React.useState(o?.addressLine2 ?? "");
  const [city, setCity] = React.useState(o?.city ?? "");
  const [county, setCounty] = React.useState(o?.county ?? "");
  const [postcode, setPostcode] = React.useState(o?.postcode ?? "");
  // Default to United Kingdom; fall back to it if a legacy value isn't in the allow-list.
  const [country, setCountry] = React.useState(
    o?.country && COUNTRY_OPTIONS.includes(o.country) ? o.country : "United Kingdom",
  );
  const [contactPerson, setContactPerson] = React.useState(o?.contactPerson ?? "");
  const [contactJobTitle, setContactJobTitle] = React.useState(o?.contactJobTitle ?? "");
  const [contactEmail, setContactEmail] = React.useState(o?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = React.useState(o?.contactPhone ?? "");
  const [paymentTerms, setPaymentTerms] = React.useState(o?.paymentTerms ?? "");
  const [customPaymentTerms, setCustomPaymentTerms] = React.useState(o?.customPaymentTerms ?? "");
  const [currency, setCurrency] = React.useState(o?.currency ?? "GBP");
  const [leadTimeDays, setLeadTimeDays] = React.useState(
    o?.leadTimeDays != null ? String(o.leadTimeDays) : "",
  );
  const [notes, setNotes] = React.useState(o?.notes ?? "");
  const [ownerUserId, setOwnerUserId] = React.useState(o?.ownerUserId ?? "");

  const [owners, setOwners] = React.useState<SupplierOwner[]>([]);
  const [types, setTypes] = React.useState<SupplierType[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Load the active-user list (owner picker) + the supplier-type master (type picker).
  React.useEffect(() => {
    let active = true;
    supplierService.listOwnerOptions().then(
      (m) => active && setOwners(m),
      () => {},
    );
    listSupplierTypes().then(
      (t) => {
        if (!active) return;
        setTypes(t);
        // On create, preselect the first ACTIVE type so the required field starts valid.
        if (mode === "create") {
          setTypeId((cur) => cur || firstActiveId(t));
        }
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [mode]);

  // Only ACTIVE types are selectable, but keep the supplier's current type visible even
  // if it's since been deactivated, so an edit doesn't silently drop it (mirrors owner).
  const typeOptions = React.useMemo(() => {
    const activeTypes = types.filter((t) => t.status === "active");
    if (o?.type && !activeTypes.some((t) => t.id === o.type!.id)) {
      return [{ id: o.type.id, name: `${o.type.name} (inactive)`, status: "inactive" } as SupplierType, ...activeTypes];
    }
    return activeTypes;
  }, [types, o]);

  // Keep a deactivated owner visible on edit (same reasoning as types).
  const ownerOptions = React.useMemo(() => {
    if (o?.owner && !owners.some((m) => m.id === o.owner!.id)) {
      return [
        { id: o.owner.id, name: `${o.owner.name} (inactive)`, email: o.owner.email, jobTitle: o.owner.jobTitle },
        ...owners,
      ];
    }
    return owners;
  }, [owners, o]);

  // On create the Type is auto-preselected to the first active option, so the baseline
  // must hold that same default — otherwise the preselect alone would read as a user edit.
  const baselineTypeId = mode === "create" ? firstActiveId(types) : (o?.typeId ?? "");
  const isDirty =
    !saved &&
    (name !== (o?.name ?? "") ||
      legalName !== (o?.legalName ?? "") ||
      typeId !== baselineTypeId ||
      description !== (o?.description ?? "") ||
      status !== (o?.status ?? "active") ||
      companyRegistrationNumber !== (o?.companyRegistrationNumber ?? "") ||
      vatNumber !== (o?.vatNumber ?? "") ||
      website !== (o?.website ?? "") ||
      addressLine1 !== (o?.addressLine1 ?? "") ||
      addressLine2 !== (o?.addressLine2 ?? "") ||
      city !== (o?.city ?? "") ||
      county !== (o?.county ?? "") ||
      postcode !== (o?.postcode ?? "") ||
      country !== (o?.country ?? "United Kingdom") ||
      contactPerson !== (o?.contactPerson ?? "") ||
      contactJobTitle !== (o?.contactJobTitle ?? "") ||
      contactEmail !== (o?.contactEmail ?? "") ||
      contactPhone !== (o?.contactPhone ?? "") ||
      paymentTerms !== (o?.paymentTerms ?? "") ||
      customPaymentTerms !== (o?.customPaymentTerms ?? "") ||
      currency !== (o?.currency ?? "GBP") ||
      leadTimeDays !== (o?.leadTimeDays != null ? String(o.leadTimeDays) : "") ||
      notes !== (o?.notes ?? "") ||
      ownerUserId !== (o?.ownerUserId ?? ""));

  useReportDirty("supplier-form", isDirty);

  const goBack = () =>
    guard.attemptLeave(() => {
      if (window.history.length > 1) router.back();
      else router.push(SUPPLIERS_LIST);
    });

  const clearError = (field: string) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Supplier name is required.";
    else if (name.trim().length > 150) errs.name = "Keep this under 150 characters.";
    if (!typeId) errs.typeId = "Select a supplier type.";
    if (!addressLine1.trim()) errs.addressLine1 = "Address line 1 is required.";
    else if (addressLine1.trim().length > 150) errs.addressLine1 = "Keep this under 150 characters.";
    if (!city.trim()) errs.city = "City is required.";
    if (!postcode.trim()) errs.postcode = "Postcode is required.";
    else if (!UK_POSTCODE_RE.test(postcode.trim())) {
      errs.postcode = "Enter a valid UK postcode (e.g. EC1A 1BB).";
    }
    if (!country.trim()) errs.country = "Country is required.";
    if (contactEmail.trim() && !EMAIL_RE.test(contactEmail.trim())) {
      errs.contactEmail = "Enter a valid email address.";
    }
    if (contactPhone.trim() && !isPhone(contactPhone.trim())) {
      errs.contactPhone = "Enter a valid UK phone number.";
    }
    if (website.trim() && !WEBSITE_RE.test(website.trim())) {
      errs.website = "Enter a valid website (e.g. example.com).";
    }
    if (leadTimeDays.trim()) {
      const n = Number(leadTimeDays.trim());
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        errs.leadTimeDays = "Lead time must be a whole number from 0 to 365.";
      }
    }
    if (paymentTerms === "Custom" && !customPaymentTerms.trim()) {
      errs.customPaymentTerms = "Enter the custom payment terms.";
    }
    return errs;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      pushToast("Please fix the highlighted fields.", "alert");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (mode === "create") {
        const created = await supplierService.createSupplier({
          name: name.trim(),
          legalName: legalName.trim() || undefined,
          typeId,
          description: description.trim() || undefined,
          status,
          companyRegistrationNumber: companyRegistrationNumber.trim() || undefined,
          vatNumber: vatNumber.trim() || undefined,
          website: website.trim() || undefined,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          county: county.trim() || undefined,
          postcode: postcode.trim() || undefined,
          country: country.trim() || undefined,
          contactPerson: contactPerson.trim() || undefined,
          contactJobTitle: contactJobTitle.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          paymentTerms: paymentTerms || undefined,
          customPaymentTerms: paymentTerms === "Custom" ? customPaymentTerms.trim() : undefined,
          currency,
          leadTimeDays: leadTimeDays.trim() || undefined,
          notes: notes.trim() || undefined,
          ownerUserId: ownerUserId || undefined,
        });
        setSaved(true);
        pushToast(`Supplier ${created.code} created.`, "success");
        router.replace(`/dashboard/suppliers/${created.code}`);
      } else if (o) {
        // Update sends fields as their current value ("" clears).
        await supplierService.updateSupplier(o.id, {
          name: name.trim(),
          legalName: legalName.trim(),
          typeId,
          description: description.trim(),
          status,
          companyRegistrationNumber: companyRegistrationNumber.trim(),
          vatNumber: vatNumber.trim(),
          website: website.trim(),
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim(),
          city: city.trim(),
          county: county.trim(),
          postcode: postcode.trim(),
          country: country.trim(),
          contactPerson: contactPerson.trim(),
          contactJobTitle: contactJobTitle.trim(),
          contactEmail: contactEmail.trim(),
          contactPhone: contactPhone.trim(),
          // Send the raw value: "" explicitly clears the payment terms (undefined would
          // be treated as "no change"). Selecting "— None —" on edit now persists as null.
          paymentTerms,
          customPaymentTerms: paymentTerms === "Custom" ? customPaymentTerms.trim() : "",
          currency,
          leadTimeDays: leadTimeDays.trim(),
          notes: notes.trim(),
          ownerUserId, // "" clears the owner
        });
        setSaved(true);
        pushToast("Supplier updated.", "success");
        router.replace(`/dashboard/suppliers/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the supplier.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "Add supplier" : `Edit ${o?.name ?? "supplier"}`}
        subtitle={mode === "edit" && o ? o.code : "A new supplier organisation"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create supplier" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Basic information" description="Name and how this supplier is classified.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>
                  Supplier name<RequiredMark />
                </label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="e.g. Corning Ltd"
                  maxLength={150}
                  autoFocus
                  aria-invalid={Boolean(errors.name)}
                />
                <FieldError id="err-name" message={errors.name} />
              </div>
              <div>
                <label className={labelCls}>Legal business name</label>
                <input
                  className={inputCls}
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="Optional — registered company name"
                  maxLength={160}
                />
              </div>
              <div>
                <label className={labelCls}>
                  Type<RequiredMark />
                </label>
                <CreatableSelect
                  value={typeId}
                  onChange={(id) => {
                    setTypeId(id);
                    clearError("typeId");
                  }}
                  options={typeOptions}
                  onCreate={async (name) => {
                    const t = await createSupplierType({ name });
                    setTypes((prev) => [...prev, t]);
                    return { id: t.id, name: t.name };
                  }}
                  canCreate={can("supplier_types.create") || can("suppliers.create") || can("suppliers.edit")}
                  canManage={can("supplier_types.edit") || can("supplier_types.delete")}
                  manageHref="/dashboard/suppliers?tab=types"
                  noun="type"
                  required
                  invalid={Boolean(errors.typeId)}
                  describedBy={errors.typeId ? "err-typeId" : undefined}
                />
                <FieldError id="err-typeId" message={errors.typeId} />
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <Select
                  value={status}
                  onChange={(v) => setStatus(v as "active" | "inactive")}
                  ariaLabel="Status"
                  options={[
                    { value: "active", label: "Active" },
                    { value: "inactive", label: "Inactive" },
                  ]}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Description</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional — what this supplier provides."
                  maxLength={2000}
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="Business information" description="Registration and tax details.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Company reg. number</label>
                <input
                  className={inputCls}
                  value={companyRegistrationNumber}
                  onChange={(e) => setCompanyRegistrationNumber(e.target.value)}
                  maxLength={50}
                />
              </div>
              <div>
                <label className={labelCls}>VAT number</label>
                <input className={inputCls} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} maxLength={50} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Website</label>
                <input
                  className={inputCls}
                  value={website}
                  onChange={(e) => {
                    setWebsite(e.target.value);
                    clearError("website");
                  }}
                  placeholder="e.g. corning.com"
                  maxLength={200}
                  aria-invalid={Boolean(errors.website)}
                />
                <FieldError id="err-website" message={errors.website} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Address" description="The supplier's primary business address.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>
                  Address line 1<RequiredMark />
                </label>
                <input
                  className={inputCls}
                  value={addressLine1}
                  onChange={(e) => {
                    setAddressLine1(e.target.value);
                    clearError("addressLine1");
                  }}
                  maxLength={150}
                  aria-invalid={Boolean(errors.addressLine1)}
                />
                <FieldError id="err-addressLine1" message={errors.addressLine1} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Address line 2</label>
                <input className={inputCls} value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} maxLength={120} />
              </div>
              <div>
                <label className={labelCls}>
                  City<RequiredMark />
                </label>
                <input
                  className={inputCls}
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                    clearError("city");
                  }}
                  maxLength={80}
                  aria-invalid={Boolean(errors.city)}
                />
                <FieldError id="err-city" message={errors.city} />
              </div>
              <div>
                <label className={labelCls}>County</label>
                <input className={inputCls} value={county} onChange={(e) => setCounty(e.target.value)} maxLength={80} />
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
                onResolved={() => {
                  clearError("city");
                  clearError("country");
                }}
                error={errors.postcode}
              />
              <div>
                <label className={labelCls}>
                  Country<RequiredMark />
                </label>
                <Select
                  value={country}
                  onChange={(v) => {
                    setCountry(v);
                    clearError("country");
                  }}
                  ariaLabel="Country"
                  invalid={Boolean(errors.country)}
                  options={COUNTRY_OPTIONS.map((c) => ({ value: c, label: c }))}
                />
                <FieldError id="err-country" message={errors.country} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Contact" description="Primary contact details for this supplier.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Contact person</label>
                <input className={inputCls} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} maxLength={120} />
              </div>
              <div>
                <label className={labelCls}>Job title</label>
                <input className={inputCls} value={contactJobTitle} onChange={(e) => setContactJobTitle(e.target.value)} maxLength={80} />
              </div>
              <div>
                <label className={labelCls}>Contact email</label>
                <input
                  className={inputCls}
                  type="email"
                  value={contactEmail}
                  onChange={(e) => {
                    setContactEmail(e.target.value);
                    clearError("contactEmail");
                  }}
                  placeholder="e.g. sales@corning.com"
                  maxLength={160}
                  aria-invalid={Boolean(errors.contactEmail)}
                />
                <FieldError id="err-contactEmail" message={errors.contactEmail} />
              </div>
              <div>
                <label className={labelCls}>Contact phone</label>
                <input
                  className={inputCls}
                  value={contactPhone}
                  onChange={(e) => {
                    setContactPhone(e.target.value);
                    clearError("contactPhone");
                  }}
                  placeholder="e.g. 0113 496 0000"
                  maxLength={32}
                  aria-invalid={Boolean(errors.contactPhone)}
                />
                <FieldError id="err-contactPhone" message={errors.contactPhone} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Payment" description="How this supplier is paid.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Payment terms</label>
                <Select
                  value={paymentTerms}
                  onChange={(v) => {
                    setPaymentTerms(v);
                    clearError("customPaymentTerms");
                  }}
                  ariaLabel="Payment terms"
                  placeholder="— None —"
                  options={PAYMENT_TERMS_OPTIONS.map((t) => ({ value: t, label: t }))}
                />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <Select
                  value={currency}
                  onChange={(v) => setCurrency(v)}
                  ariaLabel="Currency"
                  options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: CURRENCY_LABELS[c] ?? c }))}
                />
              </div>
              {paymentTerms === "Custom" && (
                <div className="sm:col-span-2">
                  <label className={labelCls}>
                    Custom payment terms<RequiredMark />
                  </label>
                  <input
                    className={inputCls}
                    value={customPaymentTerms}
                    onChange={(e) => {
                      setCustomPaymentTerms(e.target.value);
                      clearError("customPaymentTerms");
                    }}
                    placeholder="e.g. Net 10 days end of month"
                    maxLength={100}
                    aria-invalid={Boolean(errors.customPaymentTerms)}
                  />
                  <FieldError id="err-customPaymentTerms" message={errors.customPaymentTerms} />
                </div>
              )}
            </div>
          </FormSection>

          <FormSection title="Operations" description="Lead time, internal owner and notes.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Lead time (days)</label>
                <NumberInput
                  className={inputCls}
                  min={0}
                  max={365}
                  value={leadTimeDays}
                  onChange={(e) => {
                    setLeadTimeDays(e.target.value);
                    clearError("leadTimeDays");
                  }}
                  placeholder="e.g. 14 days"
                  aria-invalid={Boolean(errors.leadTimeDays)}
                />
                <FieldError id="err-leadTimeDays" message={errors.leadTimeDays} />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  Typical delivery lead time in days.
                </p>
              </div>
              <div>
                <label className={labelCls}>Internal owner</label>
                <Select
                  value={ownerUserId}
                  onChange={(v) => setOwnerUserId(v)}
                  ariaLabel="Internal owner"
                  placeholder="— No owner assigned —"
                  options={ownerOptions.map((m) => ({
                    value: m.id,
                    label: m.jobTitle ? `${m.name} — ${m.jobTitle}` : m.name,
                  }))}
                />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  Optional — the staff member responsible for this supplier.
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional — internal notes about this supplier."
                  maxLength={2000}
                />
              </div>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Code</p>
                <p className="font-mono text-[var(--ink)]">{mode === "edit" && o ? o.code : "Auto-assigned (SUP-####)"}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Status</p>
                <div className="mt-1">
                  <StatusBadge status={status as UserStatus} />
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">
                An inactive supplier can&apos;t be used for new items, purchase orders or goods-in once
                those modules ship — historical records stay intact.
              </div>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
