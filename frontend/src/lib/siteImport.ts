import { UK_POSTCODE_RE, isPhone } from "@/lib/validation";
import type { SitePayload } from "@/services/customer.service";

// One raw spreadsheet row (header → cell), as produced by SheetJS sheet_to_json.
export type RawRow = Record<string, unknown>;

// A normalised, string-only draft of a site row (pre-validation).
export type SiteDraft = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  county: string;
  postcode: string;
  country: string;
  contactPerson: string;
  contactNumber: string;
  status: string;
};

// The canonical column order for the template and the report.
export const EXPORT_COLUMNS = [
  "name", "addressLine1", "addressLine2", "city", "county",
  "postcode", "country", "contactPerson", "contactNumber", "status",
] as const satisfies readonly (keyof SiteDraft)[];

// Header aliases → SiteDraft field. Keys are lower-cased + separator-stripped at match time.
const HEADER_ALIASES: Record<string, keyof SiteDraft> = {
  name: "name", sitename: "name", site: "name",
  addressline1: "addressLine1", address1: "addressLine1", address: "addressLine1", addressline: "addressLine1",
  addressline2: "addressLine2", address2: "addressLine2",
  city: "city", town: "city", citytown: "city",
  county: "county",
  postcode: "postcode", postalcode: "postcode", zip: "postcode",
  country: "country",
  contactperson: "contactPerson", contact: "contactPerson", contactname: "contactPerson",
  contactnumber: "contactNumber", phone: "contactNumber", telephone: "contactNumber", tel: "contactNumber",
  status: "status",
};

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, "");
const cell = (v: unknown) => (v == null ? "" : String(v).trim());

// Map a raw row's arbitrary headers onto a SiteDraft, applying blank-field defaults.
export function mapColumns(raw: RawRow): SiteDraft {
  const draft: SiteDraft = {
    name: "", addressLine1: "", addressLine2: "", city: "", county: "",
    postcode: "", country: "", contactPerson: "", contactNumber: "", status: "",
  };
  for (const [header, value] of Object.entries(raw)) {
    const field = HEADER_ALIASES[normHeader(header)];
    if (field && !draft[field]) draft[field] = cell(value);
  }
  if (!draft.country) draft.country = "United Kingdom";
  if (!draft.status) draft.status = "active";
  return draft;
}

// Validate a draft, mirroring the backend siteSchema. Returns a ready-to-send SitePayload
// on success. (Phone format is left to the backend — it re-validates everything.)
export function validateRow(
  draft: SiteDraft,
): { ok: true; value: SitePayload } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Site name is required." };
  if (name.length > 120) return { ok: false, error: "Site name is too long (max 120)." };
  if (draft.addressLine1.length > 200 || draft.addressLine2.length > 200)
    return { ok: false, error: "Address line is too long (max 200)." };
  for (const [label, v] of [["City", draft.city], ["County", draft.county], ["Country", draft.country], ["Contact person", draft.contactPerson]] as const)
    if (v.length > 120) return { ok: false, error: `${label} is too long (max 120).` };
  if (draft.postcode && !UK_POSTCODE_RE.test(draft.postcode.trim()))
    return { ok: false, error: `Invalid UK postcode "${draft.postcode}".` };
  if (draft.postcode.trim().length > 12)
    return { ok: false, error: `Postcode is too long (max 12): "${draft.postcode}".` };
  // Phone uses the SAME regex + normalization as the backend (isPhone), so this never
  // false-rejects. Catches, in the preview, a spreadsheet number that lost its leading 0.
  if (draft.contactNumber && !isPhone(draft.contactNumber))
    return { ok: false, error: `Invalid phone number "${draft.contactNumber}" (a leading 0 may have been dropped — format the phone column as text).` };
  const status = draft.status.trim().toLowerCase();
  if (status !== "active" && status !== "inactive")
    return { ok: false, error: `Status must be "active" or "inactive" (got "${draft.status}").` };

  return {
    ok: true,
    value: {
      name,
      addressLine1: draft.addressLine1 || undefined,
      addressLine2: draft.addressLine2 || undefined,
      city: draft.city || undefined,
      county: draft.county || undefined,
      postcode: draft.postcode.trim() || undefined,
      country: draft.country || undefined,
      contactPerson: draft.contactPerson || undefined,
      contactNumber: draft.contactNumber || undefined,
      status: status as "active" | "inactive",
    },
  };
}

// MUST match backend siteDedupeKey exactly.
export function dedupeKey(name: string, postcode: string): string {
  return `${name.trim().toLowerCase()}|${postcode.toLowerCase().replace(/\s+/g, "")}`;
}

export type PreviewRow = {
  rowNumber: number;
  draft: SiteDraft;
  status: "new" | "duplicate" | "error";
  reason?: string;
};

// Classify every draft for the preview: error (fails validation) > duplicate (matches an
// existing site OR an earlier NEW row in this file) > new. rowNumber is 1-based.
export function classifyRows(drafts: SiteDraft[], existingKeys: Set<string>): PreviewRow[] {
  const seen = new Set(existingKeys);
  return drafts.map((draft, i) => {
    const rowNumber = i + 1;
    const v = validateRow(draft);
    if (!v.ok) return { rowNumber, draft, status: "error" as const, reason: v.error };
    const key = dedupeKey(draft.name, draft.postcode);
    if (seen.has(key)) return { rowNumber, draft, status: "duplicate" as const, reason: "Already exists (name + postcode)." };
    seen.add(key);
    return { rowNumber, draft, status: "new" as const };
  });
}

// ── SheetJS-backed helpers (dynamic import so xlsx stays out of the initial bundle) ──

// Parse the first worksheet of an .xlsx/.xls/.csv File into raw rows.
export async function parseSheet(file: File): Promise<RawRow[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  // raw:false returns each cell's FORMATTED text — so a phone/postcode stored as text in an
  // .xlsx keeps its leading zero instead of arriving as a coerced number.
  return XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[first], { defval: "", raw: false });
}

// A downloadable .xlsx template: the canonical header row + one example row.
export async function buildTemplateBlob(): Promise<Blob> {
  const XLSX = await import("xlsx");
  const example: Record<string, string> = {
    name: "Leeds Basinghall", addressLine1: "1 Basinghall Street", addressLine2: "",
    city: "Leeds", county: "West Yorkshire", postcode: "LS1 4DY", country: "United Kingdom",
    contactPerson: "Sam Taylor", contactNumber: "07700 900111", status: "active",
  };
  const ws = XLSX.utils.json_to_sheet([example], { header: EXPORT_COLUMNS as unknown as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sites");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// A downloadable .xlsx report: every processed row, original columns + status + reason.
export async function buildReportBlob(rows: PreviewRow[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  const data = rows.map((r) => {
    const rec: Record<string, string> = {};
    for (const col of EXPORT_COLUMNS) rec[col] = r.draft[col];
    // The report is generated post-import from rows already overlaid with the server outcome,
    // so a surviving "new" row is one that was actually created — label it as such.
    rec.status = r.status === "new" ? "created" : r.status;
    rec.reason = r.reason ?? "";
    return rec;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: [...EXPORT_COLUMNS, "status", "reason"] as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Import report");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
