"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { COUNTRY_OPTIONS } from "@/lib/countryOptions";
import { Select } from "@/components/ui/Select";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import { UK_POSTCODE_RE } from "@/lib/validation";
import type { CustomerSite } from "@/types/customer";

// Add / edit a customer site / delivery location — name, code (read-only,
// auto-allocated), address, postcode, on-site contact and status. Coordinates
// are geocoded from the postcode on the server, not entered here.
export function SiteModal({
  customerId,
  site,
  onClose,
  onSaved,
}: {
  customerId: string;
  site: CustomerSite | null; // null = create
  onClose: () => void;
  onSaved: (s: CustomerSite) => void;
}) {
  const isEdit = Boolean(site);
  const [name, setName] = React.useState(site?.name ?? "");
  const [addressLine1, setAddressLine1] = React.useState(site?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = React.useState(site?.addressLine2 ?? "");
  const [city, setCity] = React.useState(site?.city ?? "");
  const [county, setCounty] = React.useState(site?.county ?? "");
  const [postcode, setPostcode] = React.useState(site?.postcode ?? "");
  const [country, setCountry] = React.useState(site?.country ?? (site ? "" : "United Kingdom"));
  const [contactPerson, setContactPerson] = React.useState(site?.contactPerson ?? "");
  const [contactNumber, setContactNumber] = React.useState(site?.contactNumber ?? "");
  const [status, setStatus] = React.useState<"active" | "inactive">(site?.status ?? "active");
  const [busy, setBusy] = React.useState(false);
  const [errs, setErrs] = React.useState<{ name?: string; postcode?: string }>({});
  const [error, setError] = React.useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errs = {};
    if (!name.trim()) next.name = "Site name is required.";
    if (postcode.trim() && !UK_POSTCODE_RE.test(postcode.trim())) {
      next.postcode = "Enter a valid UK postcode (e.g. EC1A 1BB).";
    }
    setErrs(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        addressLine1: addressLine1.trim() || undefined,
        addressLine2: addressLine2.trim() || undefined,
        city: city.trim() || undefined,
        county: county.trim() || undefined,
        postcode: postcode.trim() || undefined,
        country: country.trim() || undefined,
        contactPerson: contactPerson.trim() || undefined,
        contactNumber: contactNumber.trim() || undefined,
        status,
      };
      const saved =
        isEdit && site
          ? await customerService.updateSite(customerId, site.id, payload)
          : await customerService.addSite(customerId, payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the site.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? "Edit site" : "Add site"}
      subtitle={site?.code ?? "A delivery / installation location."}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="site-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save changes" : "Add site"}
          </button>
        </>
      }
    >
      <form id="site-form" onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Site name<RequiredMark /></label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrs((p) => ({ ...p, name: undefined }));
              }}
              placeholder="e.g. Leeds Basinghall"
              maxLength={120}
              autoFocus
              aria-invalid={Boolean(errs.name)}
            />
            {errs.name && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{errs.name}</p>}
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Address line 1</label>
            <input
              className={inputCls}
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              placeholder="e.g. 1 Basinghall Street"
              maxLength={200}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Address line 2</label>
            <input
              className={inputCls}
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
              placeholder="Optional"
              maxLength={200}
            />
          </div>
          <div>
            <label className={labelCls}>City / town</label>
            <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Leeds" maxLength={120} />
          </div>
          <div>
            <label className={labelCls}>County</label>
            <input className={inputCls} value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Optional" maxLength={120} />
          </div>
          <div>
            <PostcodeField
              value={postcode}
              onChange={(v) => {
                setPostcode(v);
                setErrs((p) => ({ ...p, postcode: undefined }));
              }}
              setCity={setCity}
              setCounty={setCounty}
              setCountry={setCountry}
              required={false}
              error={errs.postcode}
            />
            {!errs.postcode && (
              <p className="mt-1.5 text-[11px] text-[var(--faint)]">
                Use Find to fill City &amp; County. Map coordinates are set automatically from the postcode on save.
              </p>
            )}
          </div>
          <div>
            <label className={labelCls}>Country</label>
            <SuggestInput
              ariaLabel="Country"
              value={country}
              onChange={setCountry}
              suggestions={COUNTRY_OPTIONS}
              placeholder="United Kingdom"
              maxLength={120}
            />
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
            <label className={labelCls}>Contact person</label>
            <input
              className={inputCls}
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="On-site contact"
              maxLength={120}
            />
          </div>
          <div>
            <label className={labelCls}>Contact number</label>
            <input
              type="tel"
              className={inputCls}
              value={contactNumber}
              onChange={(e) => setContactNumber(e.target.value)}
              placeholder="Optional"
              maxLength={20}
            />
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
