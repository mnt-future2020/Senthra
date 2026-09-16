// Pure helpers for Settings → Purchase Orders (PO PDF branding + PO custom fields). Kept free of React so
// the rules the screen enforces are unit-testable on their own.

import type { PoCustomFieldDefinition } from "@/types/purchase-order";
import type { Settings } from "@/types/settings";

// Mirrors the backend's PO_ACCENT_COLOR_RE (modules/settings/settings.service.ts) — change BOTH together.
// #RGB / #RRGGBB only: the PDF engine mis-draws the alpha forms the app's brand colour accepts.
export const PO_ACCENT_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The colour a PO PDF will ACTUALLY print for a given app brand colour. That field accepts the CSS
 * alpha forms (#rgba, #rrggbbaa) the PDF engine cannot draw, so the server strips the alpha —
 * mirrors pdfSafeBrandColor in backend settings.service.ts, change BOTH together. Anything else is
 * returned untouched: the server only ever sends a valid 3/4/6/8-digit hex.
 */
export function pdfSafeAccent(hex: string): string {
  const v = hex?.trim() ?? "";
  if (PO_ACCENT_RE.test(v)) return v;
  if (/^#[0-9a-fA-F]{4}$/.test(v)) return `#${[...v.slice(1, 4)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  return v;
}

// Mirror the backend limits in modules/purchase-order/poCustomField.values.ts.
export const PO_CUSTOM_FIELD_LABEL_MAX = 60;
export const PO_CUSTOM_FIELD_MAX_ACTIVE = 20;

/** What the PO PDF actually prints with, and whether each part is the app-branding fallback. */
export interface PoDocBrandingView {
  /** "" = no logo anywhere; the PDF prints the company name instead. */
  logoUrl: string;
  logoIsFallback: boolean;
  color: string;
  colorIsFallback: boolean;
}

export function poDocBrandingView(
  s: Pick<Settings, "poDocLogoUrl" | "poDocAccentColor" | "logoUrl" | "brandColor">,
): PoDocBrandingView {
  const own = s.poDocAccentColor?.trim() ?? "";
  const ownIsValid = PO_ACCENT_RE.test(own);
  return {
    logoUrl: s.poDocLogoUrl || s.logoUrl || "",
    logoIsFallback: !s.poDocLogoUrl,
    color: ownIsValid ? own : pdfSafeAccent(s.brandColor),
    colorIsFallback: !ownIsValid,
  };
}

/** Null when the typed accent is acceptable (blank = use the app colour). */
export function accentColorError(value: string): string | null {
  const v = value.trim();
  if (!v || PO_ACCENT_RE.test(v)) return null;
  return "Use a hex colour like #1f3a8a (3 or 6 digits).";
}

/** `<input type="color">` only accepts #rrggbb — expand #rgb, and fall back for anything else. */
export function toColorInputValue(hex: string, fallback = "#000000"): string {
  const v = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7).toLowerCase();
  return fallback;
}

/**
 * Null when `label` is an acceptable name for a field — the same rules the server applies, checked here
 * so the user gets the answer before a round trip. `selfId` excludes the field being renamed.
 */
export function fieldLabelError(label: string, fields: PoCustomFieldDefinition[], selfId?: string): string | null {
  const l = label.trim();
  if (!l) return "Enter a field name.";
  if (l.length > PO_CUSTOM_FIELD_LABEL_MAX) return `Keep the field name to ${PO_CUSTOM_FIELD_LABEL_MAX} characters or fewer.`;
  const clash = fields.find((f) => f.id !== selfId && f.label.trim().toLowerCase() === l.toLowerCase());
  if (!clash) return null;
  return clash.active
    ? `A field called "${clash.label}" already exists.`
    : `A field called "${clash.label}" already exists but is inactive — reactivate it instead.`;
}

/** The list with field `id` moved one place up (-1) or down (+1). The SAME array when it cannot move. */
export function moveField(fields: PoCustomFieldDefinition[], id: string, dir: -1 | 1): PoCustomFieldDefinition[] {
  const from = fields.findIndex((f) => f.id === id);
  const to = from + dir;
  if (from === -1 || to < 0 || to >= fields.length) return fields;
  const next = [...fields];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
