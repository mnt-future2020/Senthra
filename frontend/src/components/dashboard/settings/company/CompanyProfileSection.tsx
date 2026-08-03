"use client";

import * as React from "react";
import { Building2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import * as settingsService from "@/services/settings.service";
import { SettingsCard } from "@/components/dashboard/settings/ui/SettingsCard";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { SaveBar } from "@/components/dashboard/settings/ui/SaveBar";
import { Notice } from "@/components/ui/Notice";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { PostcodeField } from "@/components/ui/PostcodeField";
import { inputCls } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";
import { useReportDirty } from "@/providers/NavigationGuardProvider";
import type { Settings } from "@/types/settings";

// The legal-identity + regional settings that feed official documents (PO, GRN, etc.).
// The logo is intentionally NOT here — it stays the single Branding logo, reused on documents.
type CompanyForm = {
  companyLegalName: string;
  companyRegNumber: string;
  vatNumber: string;
  companyAddressLine1: string;
  companyAddressLine2: string;
  companyCity: string;
  companyCounty: string;
  companyPostcode: string;
  companyCountry: string;
  companyPhone: string;
  companyEmail: string;
  websiteUrl: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
};

const EMPTY: CompanyForm = {
  companyLegalName: "", companyRegNumber: "", vatNumber: "",
  companyAddressLine1: "", companyAddressLine2: "", companyCity: "", companyCounty: "",
  companyPostcode: "", companyCountry: "", companyPhone: "", companyEmail: "", websiteUrl: "",
  timezone: "", dateFormat: "", timeFormat: "",
};

const pick = (s: Settings): CompanyForm => ({
  companyLegalName: s.companyLegalName, companyRegNumber: s.companyRegNumber, vatNumber: s.vatNumber,
  companyAddressLine1: s.companyAddressLine1, companyAddressLine2: s.companyAddressLine2, companyCity: s.companyCity, companyCounty: s.companyCounty,
  companyPostcode: s.companyPostcode, companyCountry: s.companyCountry, companyPhone: s.companyPhone, companyEmail: s.companyEmail, websiteUrl: s.websiteUrl,
  timezone: s.timezone, dateFormat: s.dateFormat, timeFormat: s.timeFormat,
});

// UK-based app: a deliberately short list (London default, plus close neighbours).
// A stored value outside this list is still preserved & selectable (see tzOptions),
// so future international expansion only needs to extend this array.
const TIMEZONES = ["Europe/London", "Europe/Dublin", "UTC", "Europe/Paris", "Europe/Berlin"];
const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

export function CompanyProfileSection() {
  const { can } = useAuth();
  const canManage = can("settings.manage");

  const [form, setForm] = React.useState<CompanyForm>(EMPTY);
  const [saved, setSaved] = React.useState<CompanyForm>(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);

  const set = (k: keyof CompanyForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // Adapt the single form-object to the (Dispatch<SetStateAction<string>>) setters that
  // PostcodeField expects, so it can fill City/County and invalidate stale autofill.
  const fieldSetter =
    (k: keyof CompanyForm): React.Dispatch<React.SetStateAction<string>> =>
    (action) =>
      setForm((f) => ({ ...f, [k]: typeof action === "function" ? action(f[k]) : action }));
  const isDirty = (Object.keys(form) as (keyof CompanyForm)[]).some((k) => form[k] !== saved[k]);
  useReportDirty("company-profile", isDirty);

  React.useEffect(() => {
    (async () => {
      try {
        const s = await settingsService.getSettings();
        setForm(pick(s));
        setSaved(pick(s));
      } catch {
        // ignore — leave fields blank
      }
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      const s = await settingsService.updateSettings({ ...form });
      setForm(pick(s));
      setSaved(pick(s));
      setMsg({ type: "success", text: "Company profile saved." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  // Keep a non-curated stored timezone selectable so a save never drops it.
  const tzOptions = form.timezone && !TIMEZONES.includes(form.timezone) ? [form.timezone, ...TIMEZONES] : TIMEZONES;

  return (
    <SettingsCard
      icon={Building2}
      title="Company Profile"
      desc="Your legal details, contact and regional formatting — used on official documents like Purchase Orders."
    >
      <form onSubmit={save} className="space-y-5">
        {!canManage && <ReadOnlyNotice />}
        <fieldset disabled={!canManage} className="min-w-0 space-y-5">
          <Field label="Legal name" hint="Registered company name, printed on documents.">
            <input className={inputCls} value={form.companyLegalName} onChange={(e) => set("companyLegalName", e.target.value)} placeholder="Electra Networks Limited" />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Company reg. number">
              <input className={inputCls} value={form.companyRegNumber} onChange={(e) => set("companyRegNumber", e.target.value)} placeholder="01234567" />
            </Field>
            <Field label="VAT number">
              <input className={inputCls} value={form.vatNumber} onChange={(e) => set("vatNumber", e.target.value)} placeholder="GB123456789" />
            </Field>
          </div>

          <Field label="Address line 1">
            <input className={inputCls} value={form.companyAddressLine1} onChange={(e) => set("companyAddressLine1", e.target.value)} placeholder="Unit 4 Enterprise Centre" />
          </Field>
          <Field label="Address line 2" hint="Optional.">
            <input className={inputCls} value={form.companyAddressLine2} onChange={(e) => set("companyAddressLine2", e.target.value)} placeholder="Easthampstead Road" />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="City"><input className={inputCls} value={form.companyCity} onChange={(e) => set("companyCity", e.target.value)} placeholder="Bracknell" /></Field>
            <Field label="County"><input className={inputCls} value={form.companyCounty} onChange={(e) => set("companyCounty", e.target.value)} placeholder="Berkshire" /></Field>
            <PostcodeField
              value={form.companyPostcode}
              onChange={(next) => set("companyPostcode", next)}
              setCity={fieldSetter("companyCity")}
              setCounty={fieldSetter("companyCounty")}
              setCountry={fieldSetter("companyCountry")}
              label="Postcode"
              required={false}
            />
            <Field label="Country" hint="Defaults to United Kingdom; editable for future expansion.">
              <input className={inputCls} value={form.companyCountry} onChange={(e) => set("companyCountry", e.target.value)} placeholder="United Kingdom" />
            </Field>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Phone"><input className={inputCls} value={form.companyPhone} onChange={(e) => set("companyPhone", e.target.value)} placeholder="+44 1344 000000" /></Field>
            <Field label="Company Contact Email" hint="Public business email shown on documents.">
              <input className={inputCls} type="email" value={form.companyEmail} onChange={(e) => set("companyEmail", e.target.value)} placeholder="purchasing@company.co.uk" />
            </Field>
          </div>
          <Field label="Website" hint="Include https://.">
            <input className={inputCls} value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} placeholder="https://www.company.co.uk" />
          </Field>

          <div className="border-t border-[var(--border)] pt-5">
            <h3 className="mb-1 text-sm font-extrabold text-[var(--ink)]">Regional formatting</h3>
            {/* This description is deliberately specific: it previously claimed "documents, exports and
                emails" while exports emitted raw UTC ISO timestamps, so an admin who set DD/MM/YYYY and
                then opened a CSV had no reason to trust anything else on this screen. Say only what
                these fields actually drive, and name the screens they DON'T.

                The on-screen example is a PATTERN ("DD Mon YYYY"), never a sample date. A literal like
                "03 Aug 2026" is a claim about what the app renders, and it silently rots — read in
                2027 it looks like a stale value or a bug, and someone goes hunting for a date that was
                never dynamic. The pattern also matches the notation of the Date format control below,
                so the two read as one vocabulary. */}
            <p className="mb-4 text-xs text-[var(--muted)]">Applies to generated documents, supplier emails and CSV exports. On-screen dates keep the standard UK format (DD Mon YYYY).</p>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="Timezone" hint="Also sets when a day starts and ends — Overdue, Due today and dashboard counts all follow it.">
                <Select
                  value={form.timezone || "Europe/London"}
                  onChange={(v) => set("timezone", v)}
                  options={tzOptions.map((tz) => ({ value: tz, label: tz }))}
                  disabled={!canManage}
                  ariaLabel="Timezone"
                />
              </Field>
              <Field label="Date format">
                <Select
                  value={form.dateFormat || "DD/MM/YYYY"}
                  onChange={(v) => set("dateFormat", v)}
                  options={DATE_FORMATS.map((f) => ({ value: f, label: f }))}
                  disabled={!canManage}
                  ariaLabel="Date format"
                />
              </Field>
              <Field label="Time format">
                <Select
                  value={form.timeFormat || "24h"}
                  onChange={(v) => set("timeFormat", v)}
                  options={[{ value: "24h", label: "24-hour" }, { value: "12h", label: "12-hour (AM/PM)" }]}
                  disabled={!canManage}
                  ariaLabel="Time format"
                />
              </Field>
            </div>
          </div>

          <Notice msg={msg} />
          <SaveBar
            isDirty={isDirty}
            saving={saving}
            label="Save company profile"
            onDiscard={() => { setForm(saved); setMsg(null); }}
          />
        </fieldset>
      </form>
    </SettingsCard>
  );
}
