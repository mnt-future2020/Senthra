"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin } from "lucide-react";

import * as warehouseService from "@/services/warehouse.service";
import { listWarehouseTypes, createWarehouseType } from "@/services/warehouse-type.service";
import { useDashboard } from "@/hooks/useDashboard";
import { useReportDirty, useNavigationGuard } from "@/providers/NavigationGuardProvider";
import type { Warehouse, WarehouseManager } from "@/types/warehouse";
import type { WarehouseType } from "@/types/warehouse-type";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { firstActiveId } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { CreatableSelect } from "@/components/ui/CreatableSelect";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormAsideCard, FormPageHeader, FormSection, RequiredMark } from "@/components/ui/FormScaffold";
import { EMAIL_RE, UK_POSTCODE_RE, isPhone } from "@/lib/validation";
import type { UserStatus } from "@/types/user";

const WAREHOUSES_LIST = "/dashboard/warehouses";

// Constrained lists (matching the backend allow-lists). UK-only: UK postcode
// validation + postcodes.io geocoding are UK-specific.
const COUNTRY_OPTIONS = ["United Kingdom"];
const TIMEZONE_OPTIONS = ["Europe/London", "Europe/Dublin", "UTC"];

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">
      {message}
    </p>
  );
}

// Full-page Add/Edit warehouse form — mirrors the customer/user forms: a titled set of
// sections plus a sticky summary aside, nav-guarded against losing edits. Code is
// auto-assigned and coordinates are derived from the postcode, so neither is an input.
export function WarehouseForm({ mode, warehouse }: { mode: "create" | "edit"; warehouse?: Warehouse | null }) {
  const router = useRouter();
  const guard = useNavigationGuard();
  const { pushToast } = useDashboard();
  const { can } = useAuth();

  const o = warehouse;
  const [name, setName] = React.useState(o?.name ?? "");
  const [typeId, setTypeId] = React.useState(o?.typeId ?? "");
  const [description, setDescription] = React.useState(o?.description ?? "");
  const [isDefault, setIsDefault] = React.useState(o?.isDefault ?? false);
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
  const [contactEmail, setContactEmail] = React.useState(o?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = React.useState(o?.contactPhone ?? "");
  const [operatingHours, setOperatingHours] = React.useState(o?.operatingHours ?? "");
  const [timezone, setTimezone] = React.useState(o?.timezone ?? "Europe/London");
  const [notes, setNotes] = React.useState(o?.notes ?? "");
  const [managerUserId, setManagerUserId] = React.useState(o?.managerUserId ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(o?.status ?? "active");

  const [managers, setManagers] = React.useState<WarehouseManager[]>([]);
  const [types, setTypes] = React.useState<WarehouseType[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Load the active-user list (manager picker) + the warehouse-type master (type picker).
  React.useEffect(() => {
    let active = true;
    warehouseService.listManagerOptions().then(
      (m) => active && setManagers(m),
      () => {},
    );
    listWarehouseTypes().then(
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

  // Only ACTIVE types are selectable, but keep the warehouse's current type visible even
  // if it's since been deactivated, so an edit doesn't silently drop it (mirrors manager).
  const typeOptions = React.useMemo(() => {
    const activeTypes = types.filter((t) => t.status === "active");
    if (o?.type && !activeTypes.some((t) => t.id === o.type!.id)) {
      return [{ id: o.type.id, name: `${o.type.name} (inactive)`, status: "inactive" } as WarehouseType, ...activeTypes];
    }
    return activeTypes;
  }, [types, o]);

  // Keep a deactivated manager visible on edit (same reasoning as types).
  const managerOptions = React.useMemo(() => {
    if (o?.manager && !managers.some((m) => m.id === o.manager!.id)) {
      return [
        { id: o.manager.id, name: `${o.manager.name} (inactive)`, email: o.manager.email, jobTitle: o.manager.jobTitle },
        ...managers,
      ];
    }
    return managers;
  }, [managers, o]);

  // On create the Type is auto-preselected to the first active option, so the baseline
  // must hold that same default — otherwise the preselect alone would read as a user edit.
  const baselineTypeId = mode === "create" ? firstActiveId(types) : (o?.typeId ?? "");
  const isDirty =
    !saved &&
    (name !== (o?.name ?? "") ||
      typeId !== baselineTypeId ||
      description !== (o?.description ?? "") ||
      isDefault !== (o?.isDefault ?? false) ||
      addressLine1 !== (o?.addressLine1 ?? "") ||
      addressLine2 !== (o?.addressLine2 ?? "") ||
      city !== (o?.city ?? "") ||
      county !== (o?.county ?? "") ||
      postcode !== (o?.postcode ?? "") ||
      country !== (o?.country ?? "United Kingdom") ||
      contactPerson !== (o?.contactPerson ?? "") ||
      contactEmail !== (o?.contactEmail ?? "") ||
      contactPhone !== (o?.contactPhone ?? "") ||
      operatingHours !== (o?.operatingHours ?? "") ||
      timezone !== (o?.timezone ?? "Europe/London") ||
      notes !== (o?.notes ?? "") ||
      managerUserId !== (o?.managerUserId ?? "") ||
      status !== (o?.status ?? "active"));

  useReportDirty("warehouse-form", isDirty);

  const goBack = () => guard.attemptLeave(() => router.push(WAREHOUSES_LIST));

  const clearError = (field: string) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Warehouse name is required.";
    else if (name.trim().length > 120) errs.name = "Keep this under 120 characters.";
    if (!typeId) errs.typeId = "Select a warehouse type.";
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
    return errs;
  };

  // After a save, if a postcode was provided but no coordinates came back, tell the
  // user it's fine — the warehouse is saved and coordinates can be added later.
  const notifyGeocode = (result: Warehouse) => {
    if (postcode.trim() && result.latitude == null) {
      pushToast(
        "Unable to find coordinates. The warehouse is saved — coordinates can be added later.",
        "info",
      );
    }
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
        const created = await warehouseService.createWarehouse({
          name: name.trim(),
          typeId,
          description: description.trim() || undefined,
          isDefault,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          county: county.trim() || undefined,
          postcode: postcode.trim() || undefined,
          country: country.trim() || undefined,
          contactPerson: contactPerson.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          operatingHours: operatingHours.trim() || undefined,
          timezone,
          notes: notes.trim() || undefined,
          managerUserId: managerUserId || undefined,
          status,
        });
        setSaved(true);
        pushToast(`Warehouse ${created.code} created.`, "success");
        notifyGeocode(created);
        router.replace(`/dashboard/warehouses/${created.code}`);
      } else if (o) {
        // Update sends fields as their current value ("" clears).
        const updated = await warehouseService.updateWarehouse(o.id, {
          name: name.trim(),
          typeId,
          description: description.trim(),
          isDefault,
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim(),
          city: city.trim(),
          county: county.trim(),
          postcode: postcode.trim(),
          country: country.trim(),
          contactPerson: contactPerson.trim(),
          contactEmail: contactEmail.trim(),
          contactPhone: contactPhone.trim(),
          operatingHours: operatingHours.trim(),
          timezone,
          notes: notes.trim(),
          managerUserId, // "" clears the manager
          status,
        });
        setSaved(true);
        pushToast("Warehouse updated.", "success");
        notifyGeocode(updated);
        router.replace(`/dashboard/warehouses/${o.code}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the warehouse.";
      setError(msg);
      pushToast(msg, "alert");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormPageHeader
        title={mode === "create" ? "Add warehouse" : `Edit ${o?.name ?? "warehouse"}`}
        subtitle={mode === "edit" && o ? o.code : "A new physical stock location"}
        onBack={goBack}
        actions={
          <>
            <button type="button" onClick={goBack} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "create" ? "Create warehouse" : "Save changes"}
            </button>
          </>
        }
      />

      {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <FormSection title="Basic information" description="Name and how this location is used.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={labelCls}>
                  Warehouse name<RequiredMark />
                </label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="e.g. Leeds Depot"
                  maxLength={120}
                  autoFocus
                  aria-invalid={Boolean(errors.name)}
                />
                <FieldError id="err-name" message={errors.name} />
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
                    const t = await createWarehouseType({ name });
                    setTypes((prev) => [...prev, t]);
                    return { id: t.id, name: t.name };
                  }}
                  canCreate={can("warehouse_types.create") || can("warehouse.create") || can("warehouse.edit")}
                  canManage={can("warehouse_types.edit") || can("warehouse_types.delete")}
                  manageHref="/dashboard/warehouses?tab=types"
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
                  placeholder="Optional — what this location is for."
                  maxLength={2000}
                />
              </div>
              <label className="sm:col-span-2 flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--ink)]">
                  <span className="font-bold">Default warehouse</span> — the default destination for
                  future goods-in. Only one can be the default.
                </span>
              </label>
            </div>
          </FormSection>

          <FormSection
            title="Location"
            description="Coordinates are derived from the postcode automatically — no need to enter them."
          >
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

          <FormSection title="Contact" description="Primary contact details for this warehouse.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Contact person</label>
                <input className={inputCls} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} maxLength={120} />
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
              <div className="sm:col-span-2">
                <label className={labelCls}>Contact email</label>
                <input
                  className={inputCls}
                  type="email"
                  value={contactEmail}
                  onChange={(e) => {
                    setContactEmail(e.target.value);
                    clearError("contactEmail");
                  }}
                  placeholder="e.g. depot.leeds@example.com"
                  maxLength={160}
                  aria-invalid={Boolean(errors.contactEmail)}
                />
                <FieldError id="err-contactEmail" message={errors.contactEmail} />
              </div>
            </div>
          </FormSection>

          <FormSection title="Operations" description="Operational details for this location.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Operating hours</label>
                <input
                  className={inputCls}
                  value={operatingHours}
                  onChange={(e) => setOperatingHours(e.target.value)}
                  placeholder="e.g. Mon–Fri 08:00–18:00"
                  maxLength={200}
                />
                <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                  Example: Mon–Fri 08:00–18:00, Sat 09:00–13:00
                </p>
              </div>
              <div>
                <label className={labelCls}>Timezone</label>
                <Select
                  value={timezone}
                  onChange={(v) => setTimezone(v)}
                  ariaLabel="Timezone"
                  options={TIMEZONE_OPTIONS.map((tz) => ({ value: tz, label: tz }))}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional — access instructions, parking, etc."
                  maxLength={2000}
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="Warehouse Management" description="The staff member who manages this warehouse.">
            <div>
              <label className={labelCls}>Warehouse manager</label>
              <Select
                value={managerUserId}
                onChange={(v) => setManagerUserId(v)}
                ariaLabel="Warehouse manager"
                placeholder="— No manager assigned —"
                options={managerOptions.map((m) => ({
                  value: m.id,
                  label: m.jobTitle ? `${m.name} — ${m.jobTitle}` : m.name,
                }))}
              />
              <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                Optional — you can assign or change this at any time.
              </p>
            </div>
          </FormSection>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <FormAsideCard title="Summary">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Code</p>
                <p className="font-mono text-[var(--ink)]">{mode === "edit" && o ? o.code : "Auto-assigned (WH-####)"}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Status</p>
                <div className="mt-1">
                  <StatusBadge status={status as UserStatus} />
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-[11px] text-[var(--muted)]">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                <span>Map coordinates are looked up from the postcode when you save.</span>
              </div>
            </div>
          </FormAsideCard>
        </aside>
      </div>
    </form>
  );
}
